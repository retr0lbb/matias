import { z } from 'zod/v4';

// A block kind is one self-contained definition: its fields, how it renders,
// what the AI is told about it. Adding a kind = one file + one line in
// registry.ts. The AI schema (no id) and the stored schema (with id) are both
// derived from the same `shape`, so they cannot drift apart.

const idShape = { id: z.string().min(1) };

/** Fields every scored block (a numbered question) has. */
export const scoredShape = {
  statement: z.string().min(1),
  points: z.number().positive(),
  // Named exam the question comes from, e.g. "ENEM 2019". Printed after the statement.
  reference: z.string().min(1).max(80).optional(),
  // Where the reasoning of the answer comes from. Shown only in the answer key.
  sources: z.array(z.string().min(1).max(200)).max(5).optional(),
};

type ShapeOf<Kind extends string, Shape extends z.ZodRawShape> = {
  kind: z.ZodLiteral<Kind>;
} & Shape;
type StoredShapeOf<Kind extends string, Shape extends z.ZodRawShape> = {
  id: z.ZodString;
} & ShapeOf<Kind, Shape>;

/** A block as stored: its fields plus the server-generated id. */
export type StoredOf<Kind extends string, Shape extends z.ZodRawShape> = z.output<
  z.ZodObject<StoredShapeOf<Kind, Shape>>
>;

/** Reports a cross-field problem on a path; turned into a Zod issue. */
export type Report = (message: string, path: (string | number)[]) => void;

/** Just enough of a stored block for the registry to dispatch on. */
export interface BlockLike {
  id: string;
  kind: string;
}

/**
 * What the registry sees. Rendering is type-erased on purpose: the registry
 * dispatches by `block.kind`, and each definition narrows its own block.
 */
export interface BlockDefinition<
  Kind extends string = string,
  AiSchema extends z.ZodType = z.ZodType,
  StoredSchema extends z.ZodType = z.ZodType,
> {
  readonly kind: Kind;
  /** True = a numbered question with a statement and points. */
  readonly scored: boolean;
  readonly aiSchema: AiSchema;
  readonly storedSchema: StoredSchema;
  /** CSS for this block only; the page and header CSS live in render/styles.ts. */
  readonly css: string;
  /** The lines the AI prompt needs about this kind. */
  readonly aiGuide: string;
  /** `number` is set for scored blocks and null for content blocks. */
  renderHtml(block: BlockLike, number: number | null): string;
  /** Absent = the block is left out of the answer key. */
  renderAnswer?(block: BlockLike, number: number | null): string;
  /** Points this block adds to the document's value. Absent = none. Scored blocks: their `points`. */
  pointsOf?(block: BlockLike): number;
}

interface DefinitionInput<Kind extends string, Shape extends z.ZodRawShape> {
  kind: Kind;
  scored: boolean;
  shape: Shape;
  /** Rules across fields (e.g. `correctIndex` must point at an alternative). */
  refine?: (value: z.output<z.ZodObject<Shape>>, report: Report) => void;
  css: string;
  aiGuide: string;
  renderHtml: (block: StoredOf<Kind, Shape>, number: number | null) => string;
  renderAnswer?: (block: StoredOf<Kind, Shape>, number: number | null) => string;
  pointsOf?: (block: StoredOf<Kind, Shape>) => number;
}

function defineBlock<const Kind extends string, Shape extends z.ZodRawShape>(
  definition: DefinitionInput<Kind, Shape>,
): BlockDefinition<
  Kind,
  z.ZodObject<ShapeOf<Kind, Shape>>,
  z.ZodObject<StoredShapeOf<Kind, Shape>>
> {
  const aiShape = { kind: z.literal(definition.kind), ...definition.shape } as ShapeOf<Kind, Shape>;
  const storedShape = { ...idShape, ...aiShape } as StoredShapeOf<Kind, Shape>;

  const withRefine = <S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<S> => {
    const { refine } = definition;
    if (!refine) {
      return schema;
    }

    return schema.superRefine((value, context) => {
      refine(value as unknown as z.output<z.ZodObject<Shape>>, (message, path) =>
        context.addIssue({ code: 'custom', message, path }),
      );
    });
  };

  const { renderHtml, renderAnswer, pointsOf } = definition;

  return {
    kind: definition.kind,
    scored: definition.scored,
    aiSchema: withRefine(z.object(aiShape)),
    storedSchema: withRefine(z.object(storedShape)),
    css: definition.css,
    aiGuide: definition.aiGuide,
    renderHtml: (block, number) => renderHtml(block as StoredOf<Kind, Shape>, number),
    renderAnswer: renderAnswer
      ? (block, number) => renderAnswer(block as StoredOf<Kind, Shape>, number)
      : undefined,
    pointsOf: pointsOf ? (block) => pointsOf(block as StoredOf<Kind, Shape>) : undefined,
  };
}

interface ContentInput<Kind extends string, Shape extends z.ZodRawShape> {
  kind: Kind;
  shape: Shape;
  refine?: DefinitionInput<Kind, Shape>['refine'];
  css: string;
  aiGuide: string;
  renderHtml: (block: StoredOf<Kind, Shape>) => string;
  /** Pass `renderHtml` again when the answer key needs the block (e.g. code a question refers to). */
  renderAnswer?: (block: StoredOf<Kind, Shape>) => string;
  /** For content that carries points without being a question (e.g. a rubric). */
  pointsOf?: (block: StoredOf<Kind, Shape>) => number;
}

/** A block that is shown as is: not numbered, no points, not a question. */
export function defineContentBlock<const Kind extends string, Shape extends z.ZodRawShape>(
  input: ContentInput<Kind, Shape>,
) {
  const { renderHtml, renderAnswer } = input;

  return defineBlock<Kind, Shape>({
    ...input,
    scored: false,
    renderHtml: (block) => renderHtml(block),
    renderAnswer: renderAnswer ? (block) => renderAnswer(block) : undefined,
  });
}

type ScoredFull<Shape extends z.ZodRawShape> = typeof scoredShape & Shape;

interface ScoredInput<Kind extends string, Shape extends z.ZodRawShape> {
  kind: Kind;
  /** The fields of this kind; `statement`, `points`, `reference` and `sources` are added. */
  shape: Shape;
  refine?: DefinitionInput<Kind, ScoredFull<Shape>>['refine'];
  css: string;
  aiGuide: string;
  renderHtml: (block: StoredOf<Kind, ScoredFull<Shape>>, number: number) => string;
  renderAnswer: (block: StoredOf<Kind, ScoredFull<Shape>>, number: number) => string;
}

/** A numbered question. Every scored kind has an entry in the answer key. */
export function defineScoredBlock<const Kind extends string, Shape extends z.ZodRawShape>(
  input: ScoredInput<Kind, Shape>,
) {
  const { renderHtml, renderAnswer } = input;

  return defineBlock<Kind, ScoredFull<Shape>>({
    ...input,
    shape: { ...scoredShape, ...input.shape },
    scored: true,
    // The layout always numbers scored blocks.
    renderHtml: (block, number) => renderHtml(block, number as number),
    renderAnswer: (block, number) => renderAnswer(block, number as number),
    // `scoredShape` always adds `points`; TypeScript can't see it through the generic Shape.
    pointsOf: (block) => (block as unknown as z.output<z.ZodObject<typeof scoredShape>>).points,
  });
}
