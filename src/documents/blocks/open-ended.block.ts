import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { defineScoredBlock } from './block.js';
import { renderAnswerEntry, renderQuestionHead } from './shared.js';
import { LineRuleType, Paragraph } from 'docx';
import { em, line, questionHead, questionIndent } from '../render/docx-kit.js';

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
  renderDocx: (block, number, context) => {
    const rule = line('555555', 4);
    // Same border on consecutive paragraphs makes Word group them; `between`
    // draws the rule under every line of the group, `bottom` under the last.
    const lines = Array.from(
      { length: block.lines },
      (_, index) =>
        new Paragraph({
          indent: { left: questionIndent(context) },
          spacing: {
            line: em(context, 2),
            lineRule: LineRuleType.EXACT,
            after: index === block.lines - 1 ? em(context, 0.6) : 0,
          },
          border: { bottom: rule, between: rule },
          keepNext: index < block.lines - 1,
          children: [],
        }),
    );

    return [questionHead(context, number, block), ...lines];
  },
  css: `
.answer-lines { margin-top: 0.3em; }
.answer-line { height: 2em; border-bottom: 1px solid #555; }
`,
  aiGuide: `
- "open_ended": "expectedAnswer" is the answer key for the teacher, with the reasoning; "lines" is how many blank lines the student gets (0 to 30).
`.trim(),
});
