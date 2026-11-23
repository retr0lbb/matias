import {
  BorderStyle,
  type IBorderOptions,
  type IRunOptions,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { DocumentTheme } from '../schemas/theme.schema.js';
import { formatPoints } from './format.js';

// Word building blocks shared by the page (render-docx.ts) and the block kinds
// (blocks/*.block.ts), so every kind renders with the same spacing and colors.
// Mirrors the CSS in styles.ts and blocks/shared.ts with what Word understands.

export type DocxBlock = Paragraph | Table;

export interface DocxContext {
  theme: DocumentTheme;
  /** Accent color without "#", upper case. */
  accent: string;
  /** Usable width between the page margins, in twips. */
  contentWidth: number;
}

export const TEXT_COLOR = '111111';
export const MUTED_COLOR = '444444';
const TABLE_BORDER_COLOR = '555555';
const TABLE_HEAD_FILL = 'F3F4F6';
const CODE_BORDER_COLOR = 'D1D5DB';

// Characters XML 1.0 forbids; one of them would make Word refuse the file.
// eslint-disable-next-line no-control-regex
export const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Twips for a multiple of the base font size (the CSS `em`). */
export function em(context: DocxContext, value: number): number {
  return Math.round(value * context.theme.baseFontSizePt * 20);
}

/** Run size in half-points for a multiple of the base font size. */
export function fontSize(context: DocxContext, scale: number): number {
  return Math.round(context.theme.baseFontSizePt * scale * 2);
}

/** One run per line; line breaks in the JSON become Word line breaks. */
export function textRuns(text: string, options: Omit<IRunOptions, 'text'> = {}): TextRun[] {
  return text
    .replace(INVALID_XML_CHARS, '')
    .split(/\r?\n/)
    .map((line, index) => new TextRun({ ...options, text: line, break: index > 0 ? 1 : undefined }));
}

export function line(color: string, eighthsOfPoint: number): IBorderOptions {
  return { style: BorderStyle.SINGLE, color, size: eighthsOfPoint, space: 1 };
}

/** Hanging indent of a question: the number sits in it, wrapped lines align with the statement. */
export function questionIndent(context: DocxContext): number {
  return em(context, 1.6);
}

interface QuestionHead {
  statement: string;
  points: number;
  reference?: string;
}

/** "1. Statement (ENEM 2019) (2 pontos)", kept with what follows it. */
export function questionHead(
  context: DocxContext,
  number: number,
  question: QuestionHead,
): Paragraph {
  const indent = questionIndent(context);

  return new Paragraph({
    indent: { left: indent, hanging: indent },
    spacing: { before: em(context, 0.6) },
    keepNext: true,
    keepLines: true,
    children: [
      new TextRun({ text: `${number}.\t`, bold: true }),
      ...textRuns(question.statement),
      ...(question.reference
        ? textRuns(` (${question.reference})`, { color: MUTED_COLOR })
        : []),
      new TextRun({
        text: ` (${formatPoints(question.points)})`,
        size: fontSize(context, 0.85),
        color: MUTED_COLOR,
      }),
    ],
  });
}

/** A block's own title (`.block-title`). */
export function blockTitle(context: DocxContext, title: string | undefined): Paragraph[] {
  if (!title) {
    return [];
  }

  return [
    new Paragraph({
      spacing: { before: em(context, 0.6), after: em(context, 0.3) },
      keepNext: true,
      children: textRuns(title, { bold: true, size: fontSize(context, 1.05) }),
    }),
  ];
}

/** "**Label** value" in one paragraph. */
export function labelled(
  context: DocxContext,
  label: string,
  value: string,
  options: { after?: number } = {},
): Paragraph {
  return new Paragraph({
    spacing: { after: em(context, options.after ?? 0.3) },
    children: [new TextRun({ text: `${label} `, bold: true }), ...textRuns(value)],
  });
}

/** Plain paragraph text (`white-space: pre-wrap`). */
export function body(context: DocxContext, text: string, after = 0.3): Paragraph {
  return new Paragraph({ spacing: { after: em(context, after) }, children: textRuns(text) });
}

/**
 * A list with its markers as text ("•", "1."), like the numbers and letters
 * elsewhere: Word lists would need a numbering definition per document.
 */
export function items(
  context: DocxContext,
  entries: readonly string[] | undefined,
  ordered = false,
): Paragraph[] {
  if (!entries || entries.length === 0) {
    return [];
  }

  const indent = em(context, 1.4);
  const last = entries.length - 1;

  return entries.map(
    (entry, index) =>
      new Paragraph({
        indent: { left: indent, hanging: indent },
        spacing: { after: em(context, index === last ? 0.6 : 0.2) },
        children: [new TextRun(ordered ? `${index + 1}.\t` : '•\t'), ...textRuns(entry)],
      }),
  );
}

/** A bold label followed by its list, or nothing when the list is empty. */
export function labelledItems(
  context: DocxContext,
  label: string,
  entries: readonly string[] | undefined,
  ordered = false,
): Paragraph[] {
  const list = items(context, entries, ordered);
  if (list.length === 0) {
    return [];
  }

  return [
    new Paragraph({
      spacing: { before: em(context, 0.4), after: em(context, 0.2) },
      keepNext: true,
      children: textRuns(label, { bold: true }),
    }),
    ...list,
  ];
}

/** A run of text written as a bold cell value, a plain one or a centered number. */
export interface DocxCell {
  text: string;
  bold?: boolean;
  center?: boolean;
}

/** A bordered table across the content width; the first row is the shaded head. */
export function borderedTable(
  context: DocxContext,
  rows: readonly (readonly (string | DocxCell)[])[],
  options: { columnWeights?: readonly number[]; headRows?: number } = {},
): Table {
  const columns = rows[0]?.length ?? 1;
  const weights = options.columnWeights ?? Array.from({ length: columns }, () => 1);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const widths = weights.map((weight) => Math.floor((context.contentWidth * weight) / totalWeight));
  const border = line(TABLE_BORDER_COLOR, 4);
  const headRows = options.headRows ?? 1;

  return new Table({
    width: { size: widths.reduce((sum, width) => sum + width, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
    rows: rows.map(
      (row, rowIndex) =>
        new TableRow({
          tableHeader: rowIndex < headRows,
          cantSplit: true,
          children: row.map((value, columnIndex) => {
            const cell = typeof value === 'string' ? { text: value } : value;
            const head = rowIndex < headRows;

            return new TableCell({
              width: { size: widths[columnIndex], type: WidthType.DXA },
              margins: {
                top: em(context, 0.15),
                bottom: em(context, 0.15),
                left: em(context, 0.4),
                right: em(context, 0.4),
              },
              shading: head
                ? { type: ShadingType.CLEAR, color: 'auto', fill: TABLE_HEAD_FILL }
                : undefined,
              children: [
                new Paragraph({
                  alignment: cell.center ? 'center' : undefined,
                  children: textRuns(cell.text, { bold: head || cell.bold }),
                }),
              ],
            });
          }),
        }),
    ),
  });
}

/** A caption above a table (`caption` / `.block-title`). */
export function caption(context: DocxContext, text: string | undefined): Paragraph[] {
  if (!text) {
    return [];
  }

  return [
    new Paragraph({
      spacing: { before: em(context, 0.4), after: em(context, 0.3) },
      keepNext: true,
      children: textRuns(text, { bold: true }),
    }),
  ];
}

/** Space after a block that ends in a table (Word has no margin on tables). */
export function spacer(context: DocxContext, after = 0.6): Paragraph {
  return new Paragraph({ spacing: { after: em(context, after) }, children: [] });
}

/** Monospace box (`.block-code pre`). */
export function codeBox(context: DocxContext, code: string, language?: string): Paragraph[] {
  const border = line(CODE_BORDER_COLOR, 4);

  return [
    ...(language
      ? [
          new Paragraph({
            spacing: { before: em(context, 0.4), after: em(context, 0.1) },
            keepNext: true,
            children: textRuns(language.toUpperCase(), {
              size: fontSize(context, 0.75),
              color: MUTED_COLOR,
            }),
          }),
        ]
      : []),
    new Paragraph({
      border: { top: border, bottom: border, left: border, right: border },
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: TABLE_HEAD_FILL },
      spacing: { after: em(context, 0.8) },
      children: textRuns(code, { font: 'Courier New', size: fontSize(context, 0.85) }),
    }),
  ];
}

/**
 * Content inside a one-cell table, so it can carry a frame: `left` draws only
 * the accent bar on the left (`border-left`), `box` a thin accent border all round.
 */
export function framed(context: DocxContext, children: Paragraph[], frame: 'left' | 'box'): Table {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const accent = line(context.accent, frame === 'left' ? 18 : 6);
  const borders =
    frame === 'left'
      ? { top: none, bottom: none, right: none, left: accent }
      : { top: accent, bottom: accent, right: accent, left: accent };

  return new Table({
    width: { size: context.contentWidth, type: WidthType.DXA },
    columnWidths: [context.contentWidth],
    layout: TableLayoutType.FIXED,
    borders: { ...borders, insideHorizontal: none, insideVertical: none },
    rows: [
      new TableRow({
        cantSplit: frame === 'box',
        children: [
          new TableCell({
            width: { size: context.contentWidth, type: WidthType.DXA },
            margins: {
              top: em(context, 0.3),
              bottom: em(context, 0.1),
              left: em(context, 0.8),
              right: em(context, frame === 'box' ? 0.8 : 0),
            },
            children: children.length > 0 ? children : [new Paragraph({ children: [] })],
          }),
        ],
      }),
    ],
  });
}
