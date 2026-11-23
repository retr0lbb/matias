import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { defineContentBlock } from './block.js';
import { codeBox } from '../render/docx-kit.js';

export const MAX_CODE_LENGTH = 4000;

function renderCode(block: { language?: string; code: string }): string {
  const language = block.language
    ? `<div class="block-code-language">${escapeHtml(block.language)}</div>`
    : '';

  return `<div class="block block-code">${language}<pre><code>${escapeHtml(block.code)}</code></pre></div>`;
}

/**
 * Source code or terminal output, shown as is in monospace. No highlighting.
 * Questions refer to it ("considere o código acima"), so the answer key keeps it.
 */
export const codeBlock = defineContentBlock({
  kind: 'code',
  shape: {
    language: z.string().min(1).max(30).optional(),
    code: z.string().min(1).max(MAX_CODE_LENGTH),
  },
  renderHtml: renderCode,
  renderAnswer: renderCode,
  renderDocx: (block, context) => codeBox(context, block.code, block.language),
  css: `
.block-code-language { font-size: 0.75em; color: #444; text-transform: uppercase; margin-bottom: 0.2em; }
.block-code pre { margin: 0; padding: 0.6em 0.8em; background: #f3f4f6; border: 1px solid #d1d5db; font-family: "Courier New", "Liberation Mono", monospace; font-size: 0.85em; white-space: pre-wrap; overflow-wrap: anywhere; }
`,
  aiGuide: `
- "code": source code or terminal output shown exactly as written, in monospace. Optional "language" (for example "java"). Put it right before the question that refers to it. Never use Markdown fences.
`.trim(),
});
