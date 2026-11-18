import { z } from 'zod/v4';
import type { BlockDefinition } from './block.js';
import { codeBlock } from './code.block.js';
import { deliverableBlock } from './deliverable.block.js';
import { listBlock } from './list.block.js';
import { multipleChoiceBlock } from './multiple-choice.block.js';
import { openEndedBlock } from './open-ended.block.js';
import { researchTaskBlock } from './research-task.block.js';
import { rubricBlock } from './rubric.block.js';
import { contentCss, scoredCss, scoredGuide } from './shared.js';
import { tableBlock } from './table.block.js';
import { textBlock } from './text.block.js';

// The only list of block kinds. Adding one = a new *.block.ts file + one line here.
const definitions = [
  multipleChoiceBlock,
  openEndedBlock,
  textBlock,
  listBlock,
  tableBlock,
  codeBlock,
  researchTaskBlock,
  deliverableBlock,
  rubricBlock,
] as const;

type AnyDefinition = (typeof definitions)[number];

export type BlockKind = AnyDefinition['kind'];
/** What the AI generates: no id. Defaults are applied. */
export type AiBlock = z.output<AnyDefinition['aiSchema']>;
/** What the AI generates, before validation (defaults may be missing). */
export type AiBlockInput = z.input<AnyDefinition['aiSchema']>;
/** A block as stored, with its id. */
export type Block = z.output<AnyDefinition['storedSchema']>;
/** A numbered question: has a statement and points. */
export type ScoredBlock = Extract<Block, { points: number }>;

export const BLOCK_KINDS: readonly BlockKind[] = definitions.map(({ kind }) => kind);

const byKind: ReadonlyMap<string, BlockDefinition> = new Map(
  definitions.map((definition) => [definition.kind, definition]),
);

export function definitionOf(kind: string): BlockDefinition {
  const definition = byKind.get(kind);
  if (!definition) {
    throw new Error(`Unknown block kind: ${kind}`);
  }
  return definition;
}

export function isScoredBlock(block: Block): block is ScoredBlock {
  return definitionOf(block.kind).scored;
}

function pick(kinds: readonly BlockKind[]): AnyDefinition[] {
  const picked = definitions.filter(({ kind }) => kinds.includes(kind));
  if (picked.length === 0) {
    throw new Error('At least one block kind is required');
  }
  return picked;
}

type ObjectSchema = z.ZodObject;
type Union = z.ZodDiscriminatedUnion<ObjectSchema[]>;

function union(schemas: ObjectSchema[]): Union {
  return z.discriminatedUnion('kind', schemas as [ObjectSchema, ...ObjectSchema[]]);
}

/** Union of the AI shapes of `kinds`. The static type covers every kind; the runtime one only these. */
export function aiBlockUnion(kinds: readonly BlockKind[]): z.ZodType<AiBlock, AiBlockInput> {
  return union(pick(kinds).map(({ aiSchema }) => aiSchema)) as unknown as z.ZodType<
    AiBlock,
    AiBlockInput
  >;
}

/** Union of the stored shapes (with id) of `kinds`. */
export function storedBlockUnion(kinds: readonly BlockKind[]): z.ZodType<Block> {
  return union(pick(kinds).map(({ storedSchema }) => storedSchema)) as unknown as z.ZodType<Block>;
}

/** CSS of every block kind; appended to the page CSS. */
export function blockCss(): string {
  return [scoredCss, contentCss, ...definitions.map(({ css }) => css)].join('');
}

/** The lines of the AI prompt about `kinds` (and about scored fields, if any is scored). */
export function aiGuideFor(kinds: readonly BlockKind[]): string {
  const picked = pick(kinds);

  return [
    picked.some(({ scored }) => scored) ? scoredGuide : null,
    ...picked.map(({ aiGuide }) => aiGuide),
  ]
    .filter(Boolean)
    .join('\n');
}
