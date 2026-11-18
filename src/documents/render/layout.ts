import { definitionOf, isScoredBlock } from '../blocks/registry.js';
import type { DocumentContent, Block, Section } from '../schemas/content.schema.js';
import type { DocumentTheme } from '../schemas/theme.schema.js';

// Everything derived from the content (numbers, totals) is computed here and
// shared by the HTML, DOCX and answer-key renderers, so the outputs cannot
// disagree. None of it is stored in the document. Formatting helpers (letters,
// pt-BR numbers) live in format.ts.

export interface NumberedBlock {
  /** Set for scored blocks (questions); null for content blocks. */
  number: number | null;
  block: Block;
}

export interface NumberedSection {
  section: Section;
  blocks: NumberedBlock[];
}

export function numberBlocks(
  content: DocumentContent,
  numbering: DocumentTheme['numbering'],
): NumberedSection[] {
  let counter = 0;

  return content.sections.map((section) => {
    if (numbering === 'per_section') {
      counter = 0;
    }

    return {
      section,
      blocks: section.blocks.map((block) => ({
        number: isScoredBlock(block) ? ++counter : null,
        block,
      })),
    };
  });
}

/** The document's value: the points every block contributes (questions, a rubric's criteria). */
export function totalPoints(content: DocumentContent): number {
  const sum = content.sections
    .flatMap((section) => section.blocks)
    .reduce((total, block) => total + (definitionOf(block.kind).pointsOf?.(block) ?? 0), 0);

  // Avoids float noise such as 0.1 + 0.2 = 0.30000000000000004.
  return Math.round(sum * 1000) / 1000;
}
