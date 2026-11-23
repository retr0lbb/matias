import {
  AlignmentType,
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
} from 'docx';
import { definitionOf } from '../blocks/registry.js';
import type { DocumentContent } from '../schemas/content.schema.js';
import type { DocumentHeader, StudentField } from '../schemas/header.schema.js';
import type { DocumentTheme } from '../schemas/theme.schema.js';
import {
  type DocxBlock,
  type DocxContext,
  em,
  fontSize,
  INVALID_XML_CHARS,
  line,
  TEXT_COLOR,
  textRuns,
} from './docx-kit.js';
import { formatNumber, formatPoints } from './format.js';
import { readImageSize } from './image-size.js';
import { numberBlocks, type NumberedSection, totalPoints } from './layout.js';
import type { HeaderLayout } from './render-html.js';

// Mirrors render-html.ts + styles.ts with the theme tokens Word understands.
// Each block kind renders itself (`renderDocx` in blocks/*.block.ts) with the
// helpers in docx-kit.ts. Numbers and letters are plain text from layout.ts
// (not Word lists), so they match the PDF and the answer key. Known gaps with the PDF: Word paginates on
// its own (keepNext/keepLines only approximate break-inside/break-after),
// fonts depend on the reader's machine, and spacing is close but not equal.

const FONTS: Record<DocumentTheme['fontFamily'], string> = {
  arial: 'Arial',
  times_new_roman: 'Times New Roman',
};

// Twips (1/20 pt), portrait.
const PAPER_SIZES: Record<
  DocumentTheme['paperSize'],
  { width: number; height: number }
> = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
};

const LINE_HEIGHT = 1.4;
// Same box as `.header-logo` in styles.ts.
const LOGO_MAX_WIDTH_MM = 40;
const LOGO_MAX_HEIGHT_MM = 18;
const PX_PER_MM = 96 / 25.4;
// Right padding of a header field cell, so blanks in a row do not touch.
const FIELD_GAP_TWIPS = 240;

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

/** Blank lines printed for the names of a group (same as the HTML). */
const GROUP_MEMBER_LINES = 5;

function renderHeader(
  context: DocxContext,
  header: DocumentHeader,
  title: string,
  total: number,
  layout: HeaderLayout,
): DocxBlock[] {
  const has = (field: StudentField) => layout.studentFields.includes(field);
  const blocks: DocxBlock[] = [];

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
  // A document without student fields has nowhere else to show the class.
  if (!has('className') && header.className) {
    meta.push(`Turma: ${header.className}`);
  }
  for (const { label, value } of header.extra ?? []) {
    meta.push(`${label}: ${value}`);
  }
  // Only documents with points have a value.
  if (total > 0) {
    meta.push(`Valor: ${formatPoints(total)}`);
  }
  if (meta.length > 0) {
    blocks.push(
      new Paragraph({
        spacing: { after: em(context, 0.8) },
        children: textRuns(meta.join('  ')),
      }),
    );
  }

  if (has('studentName') && header.fields.studentName) {
    blocks.push(
      blankField('Nome', context.contentWidth),
      new Paragraph({ spacing: { after: em(context, 0.3) }, children: [] }),
    );
  }

  if (has('groupMembers') && header.fields.groupMembers !== false) {
    const blankLine = () =>
      new Paragraph({
        spacing: { line: em(context, 1.8), lineRule: LineRuleType.EXACT },
        tabStops: [
          { type: TabStopType.RIGHT, position: context.contentWidth, leader: LeaderType.UNDERSCORE },
        ],
        children: [new TextRun({ text: '\t' })],
      });

    blocks.push(
      new Paragraph({ spacing: { after: em(context, 0.2) }, children: [new TextRun('Integrantes:')] }),
      ...Array.from({ length: GROUP_MEMBER_LINES }, blankLine),
      new Paragraph({ spacing: { after: em(context, 0.3) }, children: [] }),
    );
  }

  const cells: FieldCell[] = [];
  if (has('className')) {
    const { className } = header;
    if (className) {
      cells.push(() => filledField('Turma', className));
    } else if (header.fields.className) {
      cells.push((width) => blankField('Turma', width));
    }
  }
  if (has('date') && header.fields.date) {
    cells.push((width) => blankField('Data', width));
  }
  if (has('score') && header.fields.score && total > 0) {
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

function renderSection(
  context: DocxContext,
  { section, blocks }: NumberedSection,
  index: number,
): DocxBlock[] {
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
    ...blocks.flatMap(({ block, number }) =>
      definitionOf(block.kind).renderDocx(block, number, context),
    ),
  ];
}

/**
 * Deterministic JSON → .docx for the student's document, from the same layout
 * helpers as the HTML/PDF. Never includes answers.
 */
export async function renderDocumentDocx(
  content: DocumentContent,
  header: DocumentHeader,
  theme: DocumentTheme,
  layout: HeaderLayout,
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

  const children: DocxBlock[] = [
    ...renderHeader(context, header, content.title, totalPoints(content), layout),
    ...(content.instructions
      ? [renderInstructions(context, content.instructions)]
      : []),
    ...numberBlocks(content, theme.numbering).flatMap((section, index) =>
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
