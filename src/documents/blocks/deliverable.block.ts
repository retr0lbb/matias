import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { defineContentBlock } from './block.js';
import { renderBlockTitle, renderLabelledItems } from './shared.js';

export const DELIVERABLE_FORMATS = [
  'written_report',
  'presentation',
  'poster',
  'video',
  'model',
  'infographic',
  'other',
] as const;

const FORMAT_LABELS: Record<(typeof DELIVERABLE_FORMATS)[number], string> = {
  written_report: 'Trabalho escrito',
  presentation: 'Apresentação',
  poster: 'Cartaz',
  video: 'Vídeo',
  model: 'Maquete',
  infographic: 'Infográfico',
  other: 'Outro formato',
};

const outlineEntry = z.object({
  section: z.string().min(1).max(150),
  expected: z.string().min(1).max(1000),
});

/**
 * The document the group hands in as its answer: format, what it must contain,
 * its structure. `expectedOutline` is the teacher's: what a good one contains.
 */
export const deliverableBlock = defineContentBlock({
  kind: 'deliverable',
  shape: {
    title: z.string().min(1).max(200).optional(),
    format: z.enum(DELIVERABLE_FORMATS),
    description: z.string().min(1).max(2000),
    // e.g. "5 a 8 páginas", "10 minutos"
    length: z.string().min(1).max(100).optional(),
    requiredSections: z.array(z.string().min(1).max(150)).max(12).optional(),
    // e.g. "Normas ABNT, Arial 12"
    formatting: z.string().min(1).max(300).optional(),
    // Teacher only. Shown in the correction guide.
    expectedOutline: z.array(outlineEntry).max(12).optional(),
  },
  renderHtml: (block) => {
    const length = block.length ? ` (${escapeHtml(block.length)})` : '';

    return [
      '<div class="block block-deliverable">',
      renderBlockTitle(block.title),
      `<p class="deliverable-format"><strong>Entrega:</strong> ${FORMAT_LABELS[block.format]}${length}</p>`,
      `<div class="deliverable-description">${escapeHtml(block.description)}</div>`,
      renderLabelledItems('Estrutura obrigatória:', block.requiredSections, true),
      block.formatting
        ? `<p class="deliverable-formatting"><strong>Formatação:</strong> ${escapeHtml(block.formatting)}</p>`
        : '',
      '</div>',
    ].join('');
  },
  renderAnswer: (block) => {
    const outline = block.expectedOutline ?? [];
    if (outline.length === 0) {
      return '';
    }

    const entries = outline
      .map(
        ({ section, expected }) =>
          `<li><strong>${escapeHtml(section)}:</strong> ${escapeHtml(expected)}</li>`,
      )
      .join('');

    return [
      '<div class="block block-deliverable">',
      `<p class="deliverable-format"><strong>Entrega esperada:</strong> ${FORMAT_LABELS[block.format]}</p>`,
      `<ul class="block-items">${entries}</ul>`,
      '</div>',
    ].join('');
  },
  css: `
.block-deliverable { border: 1px solid var(--accent); padding: 0.6em 0.8em; break-inside: avoid; }
.deliverable-description { white-space: pre-wrap; margin: 0.3em 0; }
.deliverable-formatting { margin-top: 0.4em; }
`,
  aiGuide: `
- "deliverable": the document the group hands in as its answer. "format" is one of written_report, presentation, poster, video, model, infographic, other; "description" says what it must contain; optional "length" (for example "5 a 8 páginas" or "10 minutos"), "requiredSections" (the structure the students must follow, in order) and "formatting" (for example "Normas ABNT, Arial 12"). "expectedOutline" is for the teacher only: for each part, what a good deliverable contains.
`.trim(),
});
