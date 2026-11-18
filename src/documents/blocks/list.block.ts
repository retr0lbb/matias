import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { defineContentBlock } from './block.js';
import { renderBlockTitle } from './shared.js';

export const MAX_LIST_ITEMS = 30;

export const LIST_STYLES = ['bulleted', 'numbered'] as const;

/** Objectives, materials, steps. Not numbered as a question, no points. */
export const listBlock = defineContentBlock({
  kind: 'list',
  shape: {
    title: z.string().min(1).max(200).optional(),
    style: z.enum(LIST_STYLES).default('bulleted'),
    items: z.array(z.string().min(1).max(500)).min(1).max(MAX_LIST_ITEMS),
  },
  renderHtml: (block) => {
    const tag = block.style === 'numbered' ? 'ol' : 'ul';
    const items = block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');

    return `<div class="block block-list">${renderBlockTitle(block.title)}<${tag} class="block-list-items">${items}</${tag}></div>`;
  },
  css: `
.block-list-items { margin: 0; padding-left: 1.4em; }
.block-list-items li { margin-bottom: 0.2em; white-space: pre-wrap; }
`,
  aiGuide: `
- "list": "items" is 1 to 30 short strings; "style" is "bulleted", or "numbered" for ordered steps. Optional "title". It is not a question: no points.
`.trim(),
});
