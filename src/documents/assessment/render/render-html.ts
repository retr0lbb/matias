import type {
  AssessmentContent,
  Question,
} from '../schemas/content.schema.js';
import type { AssessmentHeader } from '../schemas/header.schema.js';
import type { AssessmentTheme } from '../schemas/theme.schema.js';
import { escapeHtml } from './escape-html.js';
import {
  alternativeLabel,
  formatNumber,
  formatPoints,
  numberQuestions,
  totalPoints,
  type NumberedQuestion,
  type NumberedSection,
} from './layout.js';
import { buildCss } from './styles.js';

type MultipleChoice = Extract<Question, { kind: 'multiple_choice' }>;
type OpenEnded = Extract<Question, { kind: 'open_ended' }>;

/** Wraps a rendered body in the page shell shared by the test and its answer key. */
export function renderPage(
  title: string,
  body: string,
  theme: AssessmentTheme,
): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${buildCss(theme)}</style>`,
    '</head>',
    '<body>',
    `<main class="sheet">${body}</main>`,
    '</body>',
    '</html>',
  ].join('\n');
}

function renderBlankField(label: string, wide = false): string {
  const className = wide ? 'header-field header-field--wide' : 'header-field';
  return `<div class="${className}"><span>${label}:</span><span class="header-blank"></span></div>`;
}

function renderFilledField(label: string, value: string): string {
  return `<div class="header-field"><span>${label}:</span><span>${escapeHtml(value)}</span></div>`;
}

export function renderHeader(
  header: AssessmentHeader,
  title: string,
  total: number,
): string {
  const brand: string[] = [];
  if (header.logo) {
    brand.push(
      `<img class="header-logo" src="${escapeHtml(header.logo)}" alt="">`,
    );
  }
  if (header.institutionName) {
    brand.push(
      `<span class="header-institution">${escapeHtml(header.institutionName)}</span>`,
    );
  }

  const meta: string[] = [];
  if (header.teacherName) {
    meta.push(renderFilledField('Professor(a)', header.teacherName));
  }
  if (header.subject) {
    meta.push(renderFilledField('Disciplina', header.subject));
  }
  meta.push(
    `<div class="header-field"><span>Valor:</span><span>${formatPoints(total)}</span></div>`,
  );

  const fields: string[] = [];
  if (header.fields.studentName) {
    fields.push(renderBlankField('Nome', true));
  }
  if (header.className) {
    fields.push(renderFilledField('Turma', header.className));
  } else if (header.fields.className) {
    fields.push(renderBlankField('Turma'));
  }
  if (header.fields.date) {
    fields.push(renderBlankField('Data'));
  }
  if (header.fields.score) {
    fields.push(
      `<div class="header-field"><span>Nota:</span><span class="header-blank"></span><span>/ ${formatNumber(total)}</span></div>`,
    );
  }

  return [
    '<header class="header">',
    brand.length > 0 ? `<div class="header-brand">${brand.join('')}</div>` : '',
    `<h1 class="header-title">${escapeHtml(title)}</h1>`,
    `<div class="header-meta">${meta.join('')}</div>`,
    fields.length > 0 ? `<div class="header-fields">${fields.join('')}</div>` : '',
    '</header>',
  ].join('');
}

function renderQuestionHead(number: number, question: Question): string {
  return [
    '<div class="question-head">',
    `<span class="question-number">${number}.</span>`,
    `<div class="question-statement">${escapeHtml(question.statement)}</div>`,
    `<span class="question-points">(${formatPoints(question.points)})</span>`,
    '</div>',
  ].join('');
}

export function renderMultipleChoice(
  question: MultipleChoice,
  number: number,
): string {
  const alternatives = question.alternatives
    .map(
      (alternative, index) =>
        `<li class="alternative"><span class="alternative-label">${alternativeLabel(index)})</span><span class="alternative-text">${escapeHtml(alternative)}</span></li>`,
    )
    .join('');

  return `<article class="question">${renderQuestionHead(number, question)}<ol class="alternatives">${alternatives}</ol></article>`;
}

export function renderOpenEnded(question: OpenEnded, number: number): string {
  const lines = '<div class="answer-line"></div>'.repeat(question.lines);

  return `<article class="question">${renderQuestionHead(number, question)}<div class="answer-lines">${lines}</div></article>`;
}

function renderQuestion({ question, number }: NumberedQuestion): string {
  return question.kind === 'multiple_choice'
    ? renderMultipleChoice(question, number)
    : renderOpenEnded(question, number);
}

export function renderSection({ section, questions }: NumberedSection): string {
  return [
    '<section class="section">',
    `<h2 class="section-title">${escapeHtml(section.title)}</h2>`,
    questions.map(renderQuestion).join(''),
    '</section>',
  ].join('');
}

/**
 * Deterministic JSON → HTML for the student's test. Never includes answers:
 * the answer key is a separate document (see render-answer-key.ts).
 */
export function renderAssessmentHtml(
  content: AssessmentContent,
  header: AssessmentHeader,
  theme: AssessmentTheme,
): string {
  const body = [
    renderHeader(header, content.title, totalPoints(content)),
    content.instructions
      ? `<p class="instructions">${escapeHtml(content.instructions)}</p>`
      : '',
    numberQuestions(content, theme.numbering).map(renderSection).join(''),
  ].join('');

  return renderPage(content.title, body, theme);
}
