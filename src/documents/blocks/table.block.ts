import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { defineContentBlock } from './block.js';

export const MAX_TABLE_COLUMNS = 6;
export const MAX_TABLE_ROWS = 40;

const cell = z.string().max(500);

/** Schedules, timelines, comparisons. Not numbered, no points. */
export const tableBlock = defineContentBlock({
  kind: 'table',
  shape: {
    caption: z.string().min(1).max(200).optional(),
    columns: z.array(z.string().min(1).max(100)).min(1).max(MAX_TABLE_COLUMNS),
    rows: z.array(z.array(cell)).min(1).max(MAX_TABLE_ROWS),
  },
  refine: ({ columns, rows }, report) => {
    rows.forEach((row, index) => {
      if (row.length !== columns.length) {
        report(`A linha ${index + 1} tem ${row.length} células, mas a tabela tem ${columns.length} colunas`, [
          'rows',
          index,
        ]);
      }
    });
  },
  renderHtml: (block) => {
    const caption = block.caption ? `<caption>${escapeHtml(block.caption)}</caption>` : '';
    const head = block.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('');
    const body = block.rows
      .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`)
      .join('');

    return `<div class="block block-table"><table>${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  },
  css: `
.block-table table { width: 100%; border-collapse: collapse; }
.block-table caption { text-align: left; font-weight: bold; margin-bottom: 0.3em; }
.block-table th, .block-table td { border: 1px solid #555; padding: 0.3em 0.5em; text-align: left; vertical-align: top; white-space: pre-wrap; }
.block-table th { background: #f3f4f6; }
.block-table tr { break-inside: avoid; }
`,
  aiGuide: `
- "table": "columns" is 1 to 6 headers and "rows" is a list of rows with exactly one string per column. Optional "caption". Use it for schedules, timelines and comparisons. It is not a question: no points.
`.trim(),
});
