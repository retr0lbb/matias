import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { formatNumber } from '../render/format.js';
import { defineContentBlock } from './block.js';
import { renderBlockTitle } from './shared.js';
import { blockTitle, borderedTable, spacer } from '../render/docx-kit.js';

export const MAX_RUBRIC_CRITERIA = 10;

const criterionSchema = z.object({
  criterion: z.string().min(1).max(150),
  // What is evaluated; the students see it.
  description: z.string().max(500).optional(),
  points: z.number().positive(),
  // Teacher only: how to grade it (full, partial, no credit). Shown in the correction guide.
  guidance: z.string().max(800).optional(),
});

function sumPoints(criteria: readonly { points: number }[]): number {
  const sum = criteria.reduce((total, { points }) => total + points, 0);
  return Math.round(sum * 1000) / 1000;
}

/**
 * Evaluation criteria with points. Not a question, but its points are the
 * document's value: the header's "Valor" and "Nota" come from it.
 */
export const rubricBlock = defineContentBlock({
  kind: 'rubric',
  shape: {
    title: z.string().min(1).max(200).optional(),
    criteria: z.array(criterionSchema).min(1).max(MAX_RUBRIC_CRITERIA),
  },
  pointsOf: (block) => sumPoints(block.criteria),
  renderHtml: (block) => {
    const rows = block.criteria
      .map(
        ({ criterion, description, points }) =>
          `<tr><td>${escapeHtml(criterion)}</td><td>${escapeHtml(description ?? '')}</td><td class="rubric-points">${formatNumber(points)}</td></tr>`,
      )
      .join('');

    return [
      '<div class="block block-table block-rubric">',
      renderBlockTitle(block.title),
      '<table>',
      '<thead><tr><th>Critério</th><th>O que será avaliado</th><th class="rubric-points">Pontos</th></tr></thead>',
      `<tbody>${rows}</tbody>`,
      `<tfoot><tr><td colspan="2">Total</td><td class="rubric-points">${formatNumber(sumPoints(block.criteria))}</td></tr></tfoot>`,
      '</table>',
      '</div>',
    ].join('');
  },
  renderAnswer: (block) => {
    const rows = block.criteria
      .map(
        ({ criterion, points, guidance }) =>
          `<tr><td>${escapeHtml(criterion)}</td><td class="rubric-points">${formatNumber(points)}</td><td>${escapeHtml(guidance ?? '')}</td></tr>`,
      )
      .join('');

    return [
      '<div class="block block-table block-rubric">',
      renderBlockTitle(block.title),
      '<table>',
      '<thead><tr><th>Critério</th><th class="rubric-points">Pontos</th><th>Como corrigir</th></tr></thead>',
      `<tbody>${rows}</tbody>`,
      '</table>',
      '</div>',
    ].join('');
  },
  renderDocx: (block, context) => [
    ...blockTitle(context, block.title),
    borderedTable(
      context,
      [
        ['Critério', 'O que será avaliado', { text: 'Pontos', center: true }],
        ...block.criteria.map(({ criterion, description, points }) => [
          criterion,
          description ?? '',
          { text: formatNumber(points), center: true },
        ]),
        [
          { text: 'Total', bold: true },
          '',
          { text: formatNumber(sumPoints(block.criteria)), bold: true, center: true },
        ],
      ],
      { columnWeights: [3, 5, 1.2] },
    ),
    spacer(context, 1.2),
  ],
  css: `
.block-rubric .rubric-points { text-align: center; white-space: nowrap; width: 4.5em; }
.block-rubric tfoot td { font-weight: bold; border: 1px solid #555; padding: 0.3em 0.5em; }
`,
  aiGuide: `
- "rubric": the evaluation criteria (1 to 10). Each has "criterion", "points", an optional "description" of what is evaluated (the students see it) and "guidance" for the teacher on how to grade it (full, partial and no credit). The points of all criteria are the document's value.
`.trim(),
});
