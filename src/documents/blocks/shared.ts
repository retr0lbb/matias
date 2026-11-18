import { escapeHtml } from '../render/escape-html.js';
import { formatPoints } from '../render/format.js';

// Pieces shared by the scored kinds (question head, answer-key entry) and by
// the content kinds (title), kept apart so each block file stays small.

interface Question {
  statement: string;
  points: number;
  reference?: string;
}

export function renderQuestionHead(number: number, question: Question): string {
  const reference = question.reference
    ? ` <span class="question-reference">(${escapeHtml(question.reference)})</span>`
    : '';

  return [
    '<div class="question-head">',
    `<span class="question-number">${number}.</span>`,
    `<div class="question-statement">${escapeHtml(question.statement)}${reference}</div>`,
    `<span class="question-points">(${formatPoints(question.points)})</span>`,
    '</div>',
  ].join('');
}

interface AnswerEntry {
  /** Already escaped HTML for the answer itself. */
  answer: string;
  /** Plain text; escaped here. */
  explanation?: string;
  sources?: string[];
}

/** One question in the answer key: the answer, its justification and its sources. */
export function renderAnswerEntry(
  number: number,
  question: Question,
  entry: AnswerEntry,
): string {
  const explanation = entry.explanation?.trim();
  const sources = entry.sources?.filter((source) => source.trim().length > 0) ?? [];

  return [
    '<article class="question">',
    renderQuestionHead(number, question),
    `<p class="answer-key-answer"><strong>Resposta:</strong> ${entry.answer}</p>`,
    explanation
      ? `<p class="answer-key-explanation"><strong>Justificativa:</strong> ${escapeHtml(explanation)}</p>`
      : '',
    sources.length > 0
      ? `<p class="answer-key-sources"><strong>Fontes:</strong> ${sources.map(escapeHtml).join('; ')}</p>`
      : '',
    '</article>',
  ].join('');
}

export function renderBlockTitle(title: string | undefined): string {
  return title ? `<h3 class="block-title">${escapeHtml(title)}</h3>` : '';
}

/** CSS used by every scored kind. */
export const scoredCss = `
.question { margin-bottom: 1.2em; break-inside: avoid; }
.question-head { display: flex; gap: 0.5em; align-items: baseline; }
.question-number { font-weight: bold; }
.question-statement { flex: 1; white-space: pre-wrap; }
.question-reference { color: #444; }
.question-points { font-size: 0.85em; white-space: nowrap; color: #444; }
.answer-key-answer { margin: 0.3em 0 0 1.6em; white-space: pre-wrap; }
.answer-key-explanation { margin: 0.2em 0 0 1.6em; white-space: pre-wrap; font-size: 0.95em; }
.answer-key-sources { margin: 0.2em 0 0 1.6em; white-space: pre-wrap; font-size: 0.85em; color: #444; }
`;

/** CSS used by every content kind. */
export const contentCss = `
.block { margin-bottom: 1.2em; }
.block-title { margin: 0 0 0.3em; font-size: 1.05em; break-after: avoid; }
.block-label { font-weight: bold; margin: 0.4em 0 0.2em; }
.block ul.block-items, .block ol.block-items { margin: 0; padding-left: 1.4em; }
.block-items li { margin-bottom: 0.2em; white-space: pre-wrap; }
`;

/** An escaped list; `ordered` for steps and questions. Empty input renders nothing. */
export function renderItems(items: readonly string[] | undefined, ordered = false): string {
  if (!items || items.length === 0) {
    return '';
  }
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag} class="block-items">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`;
}

/** A bold label followed by its list, or nothing when the list is empty. */
export function renderLabelledItems(
  label: string,
  items: readonly string[] | undefined,
  ordered = false,
): string {
  const list = renderItems(items, ordered);
  return list ? `<p class="block-label">${escapeHtml(label)}</p>${list}` : '';
}

/** What the AI is told about the fields every scored kind has. */
export const scoredGuide = `
- Scored questions ("multiple_choice", "open_ended"): always "statement" and "points". Do not number questions and do not write point values inside statements.
- "reference": only when the question really comes from a named exam, for example "ENEM 2019"; otherwise leave it out. It is printed after the statement.
- "sources": where the reasoning of the answer comes from (the documents provided, the exam, a reference work). It appears only in the teacher's answer key. Leave it out when there is nothing to cite.
`.trim();
