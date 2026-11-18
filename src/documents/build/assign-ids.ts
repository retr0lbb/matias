import { randomUUID } from 'node:crypto';
import type {
  AiContent,
  AiBlock,
  AiSection,
  DocumentContent,
  Block,
  Section,
} from '../schemas/content.schema.js';

export type IdPrefix = 'sec' | 'b';
export type IdGenerator = (prefix: IdPrefix) => string;

const randomId: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;

/** Gives a block its id. The block is copied, so the input is never shared with the result. */
export function assignBlockId(block: AiBlock, newId: IdGenerator = randomId): Block {
  return { id: newId('b'), ...structuredClone(block) };
}

export function assignSectionIds(section: AiSection, newId: IdGenerator = randomId): Section {
  return {
    id: newId('sec'),
    title: section.title,
    blocks: section.blocks.map((block) => assignBlockId(block, newId)),
  };
}

/**
 * Turns validated AI output into stored content by giving every section and
 * block a server-generated id. Pure: the input is not mutated.
 */
export function assignIds(ai: AiContent, newId: IdGenerator = randomId): DocumentContent {
  return {
    title: ai.title,
    ...(ai.instructions === undefined ? {} : { instructions: ai.instructions }),
    sections: ai.sections.map((section) => assignSectionIds(section, newId)),
  };
}
