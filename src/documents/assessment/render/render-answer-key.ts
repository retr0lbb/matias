import type { AssessmentContent } from '../schemas/content.schema.js';
import { themeSchema, type AssessmentTheme } from '../schemas/theme.schema.js';
import { escapeHtml } from './escape-html.js';
import {
  alternativeLabel,
  formatPoints,
  numberQuestions,
  totalPoints,
  type NumberedQuestion,
} from './layout.js';
import { renderPage } from './render-html.js';

function renderAnswer({ question, number }: NumberedQuestion): string {
  const answer =
    question.kind === 'multiple_choice'
      ? `${alternativeLabel(question.correctIndex)}) ${escapeHtml(question.alternatives[question.correctIndex])}`
      : escapeHtml(question.expectedAnswer);

  return [
    '<article class="question">',
    '<div class="question-head">',
    `<span class="question-number">${number}.</span>`,
    `<div class="question-statement">${escapeHtml(question.statement)}</div>`,
    `<span class="question-points">(${formatPoints(question.points)})</span>`,
    '</div>',
    `<p class="answer-key-answer"><strong>Resposta:</strong> ${answer}</p>`,
    '</article>',
  ].join('');
}

/**
 * Answer key derived from the same JSON as the test, with no AI cost. It takes
 * the theme so its numbering matches the printed test; it is delivered apart
 * from the student's document.
 */
export function renderAnswerKey(
  content: AssessmentContent,
  theme: AssessmentTheme = themeSchema.parse({}),
): string {
  const title = `Gabarito: ${content.title}`;

  const sections = numberQuestions(content, theme.numbering)
    .map(({ section, questions }) =>
      [
        '<section class="section">',
        `<h2 class="section-title">${escapeHtml(section.title)}</h2>`,
        questions.map(renderAnswer).join(''),
        '</section>',
      ].join(''),
    )
    .join('');

  const body = [
    '<header class="header">',
    `<h1 class="header-title">${escapeHtml(title)}</h1>`,
    `<div class="header-meta"><div class="header-field"><span>Valor:</span><span>${formatPoints(totalPoints(content))}</span></div></div>`,
    '</header>',
    sections,
  ].join('');

  return renderPage(title, body, theme);
}
