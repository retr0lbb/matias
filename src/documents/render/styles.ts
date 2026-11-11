import type { AssessmentTheme } from '../schemas/theme.schema.js';

// The Liberation fonts are metric-compatible with Arial and Times New Roman,
// so a Linux server without the Microsoft fonts paginates the same way.
const FONT_STACKS: Record<AssessmentTheme['fontFamily'], string> = {
  arial: 'Arial, "Liberation Sans", Helvetica, sans-serif',
  times_new_roman: '"Times New Roman", "Liberation Serif", Times, serif',
};

const PAPER_WIDTHS_MM: Record<AssessmentTheme['paperSize'], number> = {
  A4: 210,
  Letter: 215.9,
};

/**
 * Builds the stylesheet shared by the preview and the PDF. Only validated
 * theme tokens are interpolated; no text from the document reaches the CSS.
 */
export function buildCss(theme: AssessmentTheme): string {
  const { top, right, bottom, left } = theme.marginsMm;

  return `
:root {
  --font: ${FONT_STACKS[theme.fontFamily]};
  --base-size: ${theme.baseFontSizePt}pt;
  --accent: ${theme.accentColor};
  --page-width: ${PAPER_WIDTHS_MM[theme.paperSize]}mm;
  --margin-top: ${top}mm;
  --margin-right: ${right}mm;
  --margin-bottom: ${bottom}mm;
  --margin-left: ${left}mm;
}
@page {
  size: ${theme.paperSize};
  margin: ${top}mm ${right}mm ${bottom}mm ${left}mm;
}
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  font-family: var(--font);
  font-size: var(--base-size);
  line-height: 1.4;
  color: #111;
}
h1, h2, p, ol { margin: 0; padding: 0; }

.header { border-bottom: 2px solid var(--accent); padding-bottom: 0.8em; margin-bottom: 1em; }
.header-brand { display: flex; align-items: center; gap: 1em; margin-bottom: 0.6em; }
.header-logo { max-height: 18mm; max-width: 40mm; }
.header-institution { font-weight: bold; font-size: 1.1em; }
.header-title { font-size: 1.4em; text-align: center; color: var(--accent); margin-bottom: 0.5em; }
.header-meta, .header-fields { display: flex; flex-wrap: wrap; gap: 0.4em 1.5em; }
.header-fields { margin-top: 0.8em; }
.header-field { display: flex; align-items: flex-end; gap: 0.4em; flex: 1 1 30%; white-space: nowrap; }
.header-field--wide { flex-basis: 100%; }
.header-blank { flex: 1; min-width: 2.5em; border-bottom: 1px solid #111; height: 1.2em; }

.instructions { margin-bottom: 1.2em; padding: 0.6em 0.8em; border: 1px solid #999; white-space: pre-wrap; }

.section { margin-bottom: 1.4em; }
.section-title {
  font-size: 1.15em;
  color: var(--accent);
  border-bottom: 1px solid var(--accent);
  padding-bottom: 0.2em;
  margin-bottom: 0.8em;
  break-after: avoid;
}
${theme.pageBreakPerSection ? '.section + .section { break-before: page; }' : ''}

.question { margin-bottom: 1.2em; break-inside: avoid; }
.question-head { display: flex; gap: 0.5em; align-items: baseline; }
.question-number { font-weight: bold; }
.question-statement { flex: 1; white-space: pre-wrap; }
.question-points { font-size: 0.85em; white-space: nowrap; color: #444; }
.alternatives { list-style: none; margin: 0.5em 0 0 1.6em; }
.alternative { display: flex; gap: 0.5em; margin-bottom: 0.25em; }
.alternative-text { flex: 1; white-space: pre-wrap; }
.answer-lines { margin-top: 0.3em; }
.answer-line { height: 2em; border-bottom: 1px solid #555; }

.answer-key-answer { margin: 0.3em 0 0 1.6em; white-space: pre-wrap; }

@media screen {
  body { background: #e5e7eb; padding: 16px; }
  .sheet {
    width: var(--page-width);
    max-width: 100%;
    margin: 0 auto;
    padding: var(--margin-top) var(--margin-right) var(--margin-bottom) var(--margin-left);
    background: #fff;
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.25);
  }
}
`;
}
