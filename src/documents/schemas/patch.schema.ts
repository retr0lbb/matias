import { z } from 'zod/v4';
import { BLOCK_KINDS } from '../blocks/registry.js';
import { type ContentSchemas, createContentSchemas } from './content.schema.js';
import { themeSchema } from './theme.schema.js';

export const MAX_PATCH_OPS = 50;

const id = z.string().min(1);

// Same rules as the theme, without the defaults: a missing token must mean
// "leave it alone", not "reset it".
const theme = themeSchema.shape;
const margins = theme.marginsMm.unwrap().shape;

export const themePatchSchema = z
  .object({
    fontFamily: theme.fontFamily.unwrap(),
    baseFontSizePt: theme.baseFontSizePt.unwrap(),
    accentColor: theme.accentColor.unwrap(),
    marginsMm: z
      .object({
        top: margins.top.unwrap(),
        right: margins.right.unwrap(),
        bottom: margins.bottom.unwrap(),
        left: margins.left.unwrap(),
      })
      .partial(),
    paperSize: theme.paperSize.unwrap(),
    pageBreakPerSection: theme.pageBreakPerSection.unwrap(),
    numbering: theme.numbering.unwrap(),
  })
  .partial();

export const headerFieldsPatchSchema = z
  .object({
    studentName: z.boolean(),
    date: z.boolean(),
    className: z.boolean(),
    score: z.boolean(),
    groupMembers: z.boolean(),
  })
  .partial();

/**
 * Patch schemas for the block kinds of `schemas`. One change to a stored
 * document is addressed by id, never by position. There is no operation for
 * school, logo or teacher on purpose.
 */
export function createPatchSchemas({ aiBlock, aiSection }: ContentSchemas) {
  const patchOp = z.discriminatedUnion('op', [
    z.object({ op: z.literal('set_title'), title: z.string().min(1) }),
    z.object({
      op: z.literal('set_instructions'),
      // null removes the instructions.
      instructions: z.string().min(1).nullable(),
    }),
    z.object({
      op: z.literal('update_section'),
      sectionId: id,
      title: z.string().min(1),
    }),
    z.object({
      op: z.literal('insert_section'),
      // null inserts at the start.
      afterSectionId: id.nullable(),
      section: aiSection,
    }),
    z.object({ op: z.literal('remove_section'), sectionId: id }),
    z.object({
      op: z.literal('replace_block'),
      blockId: id,
      // The whole block; it keeps its id.
      block: aiBlock,
    }),
    z.object({
      op: z.literal('insert_block'),
      sectionId: id,
      // null inserts at the start of the section.
      afterBlockId: id.nullable(),
      block: aiBlock,
    }),
    z.object({ op: z.literal('remove_block'), blockId: id }),
    z.object({
      op: z.literal('move_block'),
      blockId: id,
      toSectionId: id,
      // null moves it to the start of the section.
      afterBlockId: id.nullable(),
    }),
    z.object({ op: z.literal('update_theme'), theme: themePatchSchema }),
    z.object({
      op: z.literal('update_header_fields'),
      fields: headerFieldsPatchSchema,
    }),
  ]);

  const patch = z.array(patchOp).min(1).max(MAX_PATCH_OPS);

  /** What the AI returns for a revision. Empty `ops` means "nothing to change". */
  const aiPatch = z.object({
    ops: z.array(patchOp).max(MAX_PATCH_OPS),
  });

  return { patchOp, patch, aiPatch };
}

export type PatchSchemas = ReturnType<typeof createPatchSchemas>;

// The request body is validated before the document (and so its type) is
// known, so it accepts every block kind; the document's own schema rejects
// the ones its type does not allow when the patch is applied.
const anyPatch = createPatchSchemas(createContentSchemas(BLOCK_KINDS));

export const patchSchema = anyPatch.patch;

export type PatchOp = z.infer<PatchSchemas['patchOp']>;
export type DocumentPatch = z.infer<typeof patchSchema>;
