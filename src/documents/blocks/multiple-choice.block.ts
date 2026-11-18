import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { alternativeLabel } from '../render/format.js';
import { defineScoredBlock } from './block.js';
import { renderAnswerEntry, renderQuestionHead } from './shared.js';

export const MAX_EXPLANATION_LENGTH = 1000;

export const multipleChoiceBlock = defineScoredBlock({
  kind: 'multiple_choice',
  shape: {
    alternatives: z.array(z.string().min(1)).min(2).max(5),
    correctIndex: z.number().int().min(0),
    // Why the correct alternative is right; shown only in the answer key.
    // Optional so manual edits and older documents stay valid; the AI is told
    // to always write it.
    explanation: z.string().max(MAX_EXPLANATION_LENGTH).optional(),
  },
  refine: ({ alternatives, correctIndex }, report) => {
    if (correctIndex > alternatives.length - 1) {
      report('A resposta correta esta fora da posição maxima do array', ['correctIndex']);
    }
  },
  renderHtml: (block, number) => {
    const alternatives = block.alternatives
      .map(
        (alternative, index) =>
          `<li class="alternative"><span class="alternative-label">${alternativeLabel(index)})</span><span class="alternative-text">${escapeHtml(alternative)}</span></li>`,
      )
      .join('');

    return `<article class="question">${renderQuestionHead(number, block)}<ol class="alternatives">${alternatives}</ol></article>`;
  },
  renderAnswer: (block, number) =>
    renderAnswerEntry(number, block, {
      answer: `${alternativeLabel(block.correctIndex)}) ${escapeHtml(block.alternatives[block.correctIndex])}`,
      explanation: block.explanation,
      sources: block.sources,
    }),
  css: `
.alternatives { list-style: none; margin: 0.5em 0 0 1.6em; }
.alternative { display: flex; gap: 0.5em; margin-bottom: 0.25em; }
.alternative-text { flex: 1; white-space: pre-wrap; }
`,
  aiGuide: `
- "multiple_choice": 2 to 5 alternatives, exactly one correct; "correctIndex" is the zero-based position of the correct alternative. Do not prefix alternatives with letters or numbers.
- "multiple_choice": always write "explanation": one to three sentences on why the correct alternative is right (and, when useful, why the most tempting wrong one is wrong). Do not refer to alternatives by letter: letters are added later. It appears only in the teacher's answer key. When a change affects the alternatives or the correct one, rewrite the explanation to match.
`.trim(),
});
