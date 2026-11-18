import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { defineContentBlock } from './block.js';
import { renderBlockTitle } from './shared.js';

export const MAX_TEXT_LENGTH = 6000;

/** A passage, notice or paragraph. Not numbered, no points. */
export const textBlock = defineContentBlock({
  kind: 'text',
  shape: {
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(MAX_TEXT_LENGTH),
  },
  renderHtml: (block) =>
    `<div class="block block-text">${renderBlockTitle(block.title)}<div class="block-text-body">${escapeHtml(block.body)}</div></div>`,
  css: `
.block-text-body { white-space: pre-wrap; }
`,
  aiGuide: `
- "text": a passage, notice or paragraph. Optional "title"; "body" is plain text, paragraphs separated by a blank line. It is not numbered and has no points.
`.trim(),
});
