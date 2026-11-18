import { definitionOf } from '../blocks/registry.js';
import type { DocumentContent } from '../schemas/content.schema.js';
import type { DocumentHeader, StudentField } from '../schemas/header.schema.js';
import type { DocumentTheme } from '../schemas/theme.schema.js';
import { escapeHtml } from './escape-html.js';
import { formatNumber, formatPoints } from './format.js';
import {
  numberBlocks,
  totalPoints,
  type NumberedBlock,
  type NumberedSection,
} from './layout.js';
import { buildCss } from './styles.js';

/** Wraps a rendered body in the page shell shared by the test and its answer key. */
export function renderPage(
  title: string,
  body: string,
  theme: DocumentTheme,
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
  return `<div class="${className}"><span>${escapeHtml(label)}:</span><span class="header-blank"></span></div>`;
}

function renderFilledField(label: string, value: string): string {
  return `<div class="header-field"><span>${escapeHtml(label)}:</span><span>${escapeHtml(value)}</span></div>`;
}

/** Blank lines printed for the names of a group. */
const GROUP_MEMBER_LINES = 5;

/** What a document type allows in the header. */
export interface HeaderLayout {
  /** Blank fields the student may be asked to fill in; none for a plan. */
  studentFields: readonly StudentField[];
}

export function renderHeader(
  header: DocumentHeader,
  title: string,
  total: number,
  layout: HeaderLayout,
): string {
  const has = (field: StudentField) => layout.studentFields.includes(field);

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
  // A document without student fields has nowhere else to show the class.
  if (!has('className') && header.className) {
    meta.push(renderFilledField('Turma', header.className));
  }
  for (const { label, value } of header.extra ?? []) {
    meta.push(renderFilledField(label, value));
  }
  // Only documents with questions have a value.
  if (total > 0) {
    meta.push(
      `<div class="header-field"><span>Valor:</span><span>${formatPoints(total)}</span></div>`,
    );
  }

  const fields: string[] = [];
  if (has('studentName') && header.fields.studentName) {
    fields.push(renderBlankField('Nome', true));
  }
  if (has('groupMembers') && header.fields.groupMembers !== false) {
    const lines = '<span class="header-blank"></span>'.repeat(GROUP_MEMBER_LINES);
    fields.push(
      `<div class="header-field header-field--wide header-members"><span>Integrantes:</span><div class="header-member-lines">${lines}</div></div>`,
    );
  }
  if (has('className')) {
    if (header.className) {
      fields.push(renderFilledField('Turma', header.className));
    } else if (header.fields.className) {
      fields.push(renderBlankField('Turma'));
    }
  }
  if (has('date') && header.fields.date) {
    fields.push(renderBlankField('Data'));
  }
  if (has('score') && header.fields.score && total > 0) {
    fields.push(
      `<div class="header-field"><span>Nota:</span><span class="header-blank"></span><span>/ ${formatNumber(total)}</span></div>`,
    );
  }

  return [
    '<header class="header">',
    brand.length > 0 ? `<div class="header-brand">${brand.join('')}</div>` : '',
    `<h1 class="header-title">${escapeHtml(title)}</h1>`,
    meta.length > 0 ? `<div class="header-meta">${meta.join('')}</div>` : '',
    fields.length > 0 ? `<div class="header-fields">${fields.join('')}</div>` : '',
    '</header>',
  ].join('');
}

function renderBlock({ block, number }: NumberedBlock): string {
  return definitionOf(block.kind).renderHtml(block, number);
}

export function renderSection({ section, blocks }: NumberedSection): string {
  return [
    '<section class="section">',
    `<h2 class="section-title">${escapeHtml(section.title)}</h2>`,
    blocks.map(renderBlock).join(''),
    '</section>',
  ].join('');
}

/**
 * Deterministic JSON → HTML for the student's document. Never includes answers:
 * the answer key is a separate document (see render-answer-key.ts).
 */
export function renderDocumentHtml(
  content: DocumentContent,
  header: DocumentHeader,
  theme: DocumentTheme,
  layout: HeaderLayout,
): string {
  const body = [
    renderHeader(header, content.title, totalPoints(content), layout),
    content.instructions
      ? `<p class="instructions">${escapeHtml(content.instructions)}</p>`
      : '',
    numberBlocks(content, theme.numbering).map(renderSection).join(''),
  ].join('');

  return renderPage(content.title, body, theme);
}
