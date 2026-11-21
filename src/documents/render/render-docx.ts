import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  Document,
  ImageRun,
  LeaderType,
  LineRuleType,
  Packer,
  Paragraph,
  Table,
  TableBorders,
  TableCell,
  TableLayoutType,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
  type IBorderOptions,
  type IRunOptions,
} from 'docx';
import type {
  AssessmentContent,
  Question,
} from '../schemas/content.schema.js';
import type { AssessmentHeader } from '../schemas/header.schema.js';
import type { AssessmentTheme } from '../schemas/theme.schema.js';
import { readImageSize } from './image-size.js';
import {
  alternativeLabel,
  formatNumber,
  formatPoints,
  numberQuestions,
  totalPoints,
  type NumberedQuestion,
  type NumberedSection,
} from './layout.js';

// Mirrors render-html.ts + styles.ts with the theme tokens Word understands.
// Numbers and letters are plain text from layout.ts (not Word lists), so they
// match the PDF and the answer key. Known gaps with the PDF: Word paginates on
// its own (keepNext/keepLines only approximate break-inside/break-after),
// fonts depend on the reader's machine, and spacing is close but not equal.

type Block = Paragraph | Table;
type MultipleChoice = Extract<Question, { kind: 'multiple_choice' }>;
type OpenEnded = Extract<Question, { kind: 'open_ended' }>;

const FONTS: Record<AssessmentTheme['fontFamily'], string> = {
  arial: 'Arial',
  times_new_roman: 'Times New Roman',
};

// Twips (1/20 pt), portrait.
const PAPER_SIZES: Record<
  AssessmentTheme['paperSize'],
  { width: number; height: number }
> = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
};

const TEXT_COLOR = '111111';
const MUTED_COLOR = '444444';
const LINE_HEIGHT = 1.4;
// Same box as `.header-logo` in styles.ts.
const LOGO_MAX_WIDTH_MM = 40;
const LOGO_MAX_HEIGHT_MM = 18;
const PX_PER_MM = 96 / 25.4;
// Right padding of a header field cell, so blanks in a row do not touch.
const FIELD_GAP_TWIPS = 240;

// Characters XML 1.0 forbids; one of them would make Word refuse the file.
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

interface DocxContext {
  theme: AssessmentTheme;
  accent: string;
  /** Usable width between the page margins, in twips. */
  contentWidth: number;
}

/** Twips for a multiple of the base font size (the CSS `em`). */
function em(context: DocxContext, value: number): number {
  return Math.round(value * context.theme.baseFontSizePt * 20);
}

/** Run size in half-points for a multiple of the base font size. */
function fontSize(context: DocxContext, scale: number): number {
  return Math.round(context.theme.baseFontSizePt * scale * 2);
}

/** One run per line; line breaks in the JSON become Word line breaks. */
function textRuns(text: string, options: Omit<IRunOptions, 'text'> = {}) {
  return text
    .replace(INVALID_XML_CHARS, '')
    .split(/\r?\n/)
    .map(
      (line, index) =>
        new TextRun({ ...options, text: line, break: index > 0 ? 1 : undefined }),
    );
}

function line(color: string, eighthsOfPoint: number): IBorderOptions {
  return { style: BorderStyle.SINGLE, color, size: eighthsOfPoint, space: 1 };
}

function renderLogo(dataUri: string): ImageRun | null {
  const match = /^data:image\/(png|jpeg);base64,(.+)$/.exec(dataUri);
  if (!match) {
    return null;
  }
  const data = Buffer.from(match[2], 'base64');
  // Unknown size: assume square so the logo still fits the box.
  const size = readImageSize(data) ?? { width: 1, height: 1 };
  const maxWidth = LOGO_MAX_WIDTH_MM * PX_PER_MM;
  const maxHeight = LOGO_MAX_HEIGHT_MM * PX_PER_MM;
  const scale = Math.min(1, maxWidth / size.width, maxHeight / size.height);

  return new ImageRun({
    type: match[1] === 'png' ? 'png' : 'jpg',
    data,
    transformation: {
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    },
  });
}

/** "Label: ______ suffix", the blank stretching to `width` (twips). */
function blankField(
  label: string,
  width: number,
  suffix?: string,
): Paragraph {
  return new Paragraph({
    tabStops: [
      { type: TabStopType.RIGHT, position: width, leader: LeaderType.UNDERSCORE },
    ],
    children: [
      new TextRun(`${label}: `),
      new TextRun({ text: suffix ? `\t ${suffix}` : '\t' }),
    ],
  });
}

function filledField(label: string, value: string): Paragraph {
  return new Paragraph({
    children: [new TextRun(`${label}: `), ...textRuns(value)],
  });
}

type FieldCell = (width: number) => Paragraph;

/** Borderless one-row table, one equal column per field. */
function fieldRow(context: DocxContext, cells: FieldCell[]): Table {
  const cellWidth = Math.floor(context.contentWidth / cells.length);

  return new Table({
    width: { size: cellWidth * cells.length, type: WidthType.DXA },
    columnWidths: cells.map(() => cellWidth),
    layout: TableLayoutType.FIXED,
    borders: TableBorders.NONE,
    rows: [
      new TableRow({
        children: cells.map(
          (cell) =>
            new TableCell({
              width: { size: cellWidth, type: WidthType.DXA },
              margins: { left: 0, right: FIELD_GAP_TWIPS, top: 0, bottom: 0 },
              children: [cell(cellWidth - FIELD_GAP_TWIPS)],
            }),
        ),
      }),
    ],
  });
}

function renderHeader(
  context: DocxContext,
  header: AssessmentHeader,
  title: string,
  total: number,
): Block[] {
  const blocks: Block[] = [];

  const brand: (ImageRun | TextRun)[] = [];
  const logo = header.logo ? renderLogo(header.logo) : null;
  if (logo) {
    brand.push(logo);
  }
  if (header.institutionName) {
    brand.push(
      ...textRuns(`${logo ? '   ' : ''}${header.institutionName}`, {
        bold: true,
        size: fontSize(context, 1.1),
      }),
    );
  }
  if (brand.length > 0) {
    blocks.push(
      new Paragraph({ spacing: { after: em(context, 0.6) }, children: brand }),
    );
  }

  blocks.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: em(context, 0.5) },
      children: textRuns(title, {
        bold: true,
        color: context.accent,
        size: fontSize(context, 1.4),
      }),
    }),
  );

  const meta: string[] = [];
  if (header.teacherName) {
    meta.push(`Professor(a): ${header.teacherName}`);
  }
  if (header.subject) {
    meta.push(`Disciplina: ${header.subject}`);
  }
  meta.push(`Valor: ${formatPoints(total)}`);
  blocks.push(
    new Paragraph({
      spacing: { after: em(context, 0.8) },
      children: textRuns(meta.join('  ')),
    }),
  );

  if (header.fields.studentName) {
    blocks.push(
      blankField('Nome', context.contentWidth),
      new Paragraph({ spacing: { after: em(context, 0.3) }, children: [] }),
    );
  }

  const cells: FieldCell[] = [];
  const { className } = header;
  if (className) {
    cells.push(() => filledField('Turma', className));
  } else if (header.fields.className) {
    cells.push((width) => blankField('Turma', width));
  }
  if (header.fields.date) {
    cells.push((width) => blankField('Data', width));
  }
  if (header.fields.score) {
    cells.push((width) =>
      blankField('Nota', width, `/ ${formatNumber(total)}`),
    );
  }
  if (cells.length > 0) {
    blocks.push(fieldRow(context, cells));
  }

  // The accent rule under the header (`.header` border-bottom).
  blocks.push(
    new Paragraph({
      border: { bottom: line(context.accent, 16) },
      spacing: { after: em(context, 1) },
      children: [],
    }),
  );

  return blocks;
}

function renderInstructions(
  context: DocxContext,
  instructions: string,
): Paragraph {
  const box = line('999999', 4);

  return new Paragraph({
    border: { top: box, bottom: box, left: box, right: box },
    indent: { left: em(context, 0.4), right: em(context, 0.4) },
    spacing: { after: em(context, 1.2) },
    children: textRuns(instructions),
  });
}

function renderQuestionHead(
  context: DocxContext,
  number: number,
  question: Question,
): Paragraph {
  const indent = em(context, 1.6);

  return new Paragraph({
    // Hanging indent: the number sits in the margin, wrapped lines align with
    // the statement.
    indent: { left: indent, hanging: indent },
    spacing: { before: em(context, 0.6) },
    keepNext: true,
    keepLines: true,
    children: [
      new TextRun({ text: `${number}.\t`, bold: true }),
      ...textRuns(question.statement),
      new TextRun({
        text: ` (${formatPoints(question.points)})`,
        size: fontSize(context, 0.85),
        color: MUTED_COLOR,
      }),
    ],
  });
}

function renderMultipleChoice(
  context: DocxContext,
  question: MultipleChoice,
  number: number,
): Paragraph[] {
  const labelWidth = em(context, 1.6);
  const last = question.alternatives.length - 1;

  return [
    renderQuestionHead(context, number, question),
    ...question.alternatives.map(
      (alternative, index) =>
        new Paragraph({
          indent: { left: labelWidth * 2, hanging: labelWidth },
          spacing: { after: em(context, index === last ? 0.6 : 0.25) },
          keepNext: index < last,
          keepLines: true,
          children: [
            new TextRun(`${alternativeLabel(index)})\t`),
            ...textRuns(alternative),
          ],
        }),
    ),
  ];
}

function renderOpenEnded(
  context: DocxContext,
  question: OpenEnded,
  number: number,
): Paragraph[] {
  const rule = line('555555', 4);
  // Same border on consecutive paragraphs makes Word group them; `between`
  // draws the rule under every line of the group, `bottom` under the last.
  const lines = Array.from(
    { length: question.lines },
    (_, index) =>
      new Paragraph({
        indent: { left: em(context, 1.6) },
        spacing: {
          line: em(context, 2),
          lineRule: LineRuleType.EXACT,
          after: index === question.lines - 1 ? em(context, 0.6) : 0,
        },
        border: { bottom: rule, between: rule },
        keepNext: index < question.lines - 1,
        children: [],
      }),
  );

  return [renderQuestionHead(context, number, question), ...lines];
}

function renderQuestion(
  context: DocxContext,
  { question, number }: NumberedQuestion,
): Paragraph[] {
  return question.kind === 'multiple_choice'
    ? renderMultipleChoice(context, question, number)
    : renderOpenEnded(context, question, number);
}

function renderSection(
  context: DocxContext,
  { section, questions }: NumberedSection,
  index: number,
): Paragraph[] {
  return [
    new Paragraph({
      pageBreakBefore: context.theme.pageBreakPerSection && index > 0,
      border: { bottom: line(context.accent, 8) },
      spacing: {
        before: index > 0 ? em(context, 1.4) : 0,
        after: em(context, 0.4),
      },
      keepNext: true,
      keepLines: true,
      children: textRuns(section.title, {
        bold: true,
        color: context.accent,
        size: fontSize(context, 1.15),
      }),
    }),
    ...questions.flatMap((numbered) => renderQuestion(context, numbered)),
  ];
}

/**
 * Deterministic JSON → .docx for the student's test, from the same layout
 * helpers as the HTML/PDF. Never includes answers.
 */
export async function renderAssessmentDocx(
  content: AssessmentContent,
  header: AssessmentHeader,
  theme: AssessmentTheme,
): Promise<Buffer> {
  const paper = PAPER_SIZES[theme.paperSize];
  const margins = {
    top: convertMillimetersToTwip(theme.marginsMm.top),
    right: convertMillimetersToTwip(theme.marginsMm.right),
    bottom: convertMillimetersToTwip(theme.marginsMm.bottom),
    left: convertMillimetersToTwip(theme.marginsMm.left),
  };
  const context: DocxContext = {
    theme,
    accent: theme.accentColor.slice(1).toUpperCase(),
    contentWidth: paper.width - margins.left - margins.right,
  };

  const children: Block[] = [
    ...renderHeader(context, header, content.title, totalPoints(content)),
    ...(content.instructions
      ? [renderInstructions(context, content.instructions)]
      : []),
    ...numberQuestions(content, theme.numbering).flatMap((section, index) =>
      renderSection(context, section, index),
    ),
  ];

  const document = new Document({
    title: content.title.replace(INVALID_XML_CHARS, ''),
    styles: {
      default: {
        document: {
          run: {
            font: FONTS[theme.fontFamily],
            size: fontSize(context, 1),
            color: TEXT_COLOR,
          },
          paragraph: {
            spacing: { line: Math.round(240 * LINE_HEIGHT), after: 0 },
          },
        },
      },
    },
    sections: [
      {
        properties: { page: { size: paper, margin: margins } },
        children,
      },
    ],
  });

  return Packer.toBuffer(document);
}
