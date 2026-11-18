import { definitionOf } from '../blocks/registry.js';
import type { DocumentContent } from '../schemas/content.schema.js';
import { themeSchema, type DocumentTheme } from '../schemas/theme.schema.js';
import { escapeHtml } from './escape-html.js';
import { formatPoints } from './format.js';
import { numberBlocks, totalPoints, type NumberedSection } from './layout.js';
import { renderPage } from './render-html.js';

function renderSectionAnswers({ section, blocks }: NumberedSection): string {
  // A block without `renderAnswer` is left out; a section left empty is left out too.
  const entries = blocks
    .map(({ block, number }) => definitionOf(block.kind).renderAnswer?.(block, number) ?? '')
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) {
    return '';
  }

  return [
    '<section class="section">',
    `<h2 class="section-title">${escapeHtml(section.title)}</h2>`,
    entries.join(''),
    '</section>',
  ].join('');
}

/**
 * Answer key derived from the same JSON as the test, with no AI cost. It takes
 * the theme so its numbering matches the printed test; it is delivered apart
 * from the student's document.
 */
export function renderAnswerKey(
  content: DocumentContent,
  theme: DocumentTheme = themeSchema.parse({}),
  heading = 'Gabarito',
): string {
  const title = `${heading}: ${content.title}`;

  const sections = numberBlocks(content, theme.numbering).map(renderSectionAnswers).join('');
  const total = totalPoints(content);

  const body = [
    '<header class="header">',
    `<h1 class="header-title">${escapeHtml(title)}</h1>`,
    total > 0
      ? `<div class="header-meta"><div class="header-field"><span>Valor:</span><span>${formatPoints(total)}</span></div></div>`
      : '',
    '</header>',
    sections,
  ].join('');

  return renderPage(title, body, theme);
}
