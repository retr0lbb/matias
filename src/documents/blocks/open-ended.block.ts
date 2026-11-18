import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { defineScoredBlock } from './block.js';
import { renderAnswerEntry, renderQuestionHead } from './shared.js';

export const DEFAULT_OPEN_ENDED_LINES = 5;
export const MAX_OPEN_ENDED_LINES = 30;

export const openEndedBlock = defineScoredBlock({
  kind: 'open_ended',
  shape: {
    expectedAnswer: z.string(),
    lines: z.number().int().min(0).max(MAX_OPEN_ENDED_LINES).default(DEFAULT_OPEN_ENDED_LINES),
  },
  renderHtml: (block, number) => {
    const lines = '<div class="answer-line"></div>'.repeat(block.lines);

    return `<article class="question">${renderQuestionHead(number, block)}<div class="answer-lines">${lines}</div></article>`;
  },
  renderAnswer: (block, number) =>
    renderAnswerEntry(number, block, {
      answer: escapeHtml(block.expectedAnswer),
      sources: block.sources,
    }),
  css: `
.answer-lines { margin-top: 0.3em; }
.answer-line { height: 2em; border-bottom: 1px solid #555; }
`,
  aiGuide: `
- "open_ended": "expectedAnswer" is the answer key for the teacher, with the reasoning; "lines" is how many blank lines the student gets (0 to 30).
`.trim(),
});
