import { z } from 'zod/v4';
import { aiQuestionSchema, aiSectionSchema } from './content.schema.js';
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
  })
  .partial();

/**
 * One change to a stored assessment. Everything is addressed by id, never by
 * position. There is no operation for school, logo or teacher on purpose.
 */
export const patchOpSchema = z.discriminatedUnion('op', [
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
    section: aiSectionSchema,
  }),
  z.object({ op: z.literal('remove_section'), sectionId: id }),
  z.object({
    op: z.literal('replace_question'),
    questionId: id,
    // The whole question; it keeps its id.
    question: aiQuestionSchema,
  }),
  z.object({
    op: z.literal('insert_question'),
    sectionId: id,
    // null inserts at the start of the section.
    afterQuestionId: id.nullable(),
    question: aiQuestionSchema,
  }),
  z.object({ op: z.literal('remove_question'), questionId: id }),
  z.object({
    op: z.literal('move_question'),
    questionId: id,
    toSectionId: id,
    // null moves it to the start of the section.
    afterQuestionId: id.nullable(),
  }),
  z.object({ op: z.literal('update_theme'), theme: themePatchSchema }),
  z.object({
    op: z.literal('update_header_fields'),
    fields: headerFieldsPatchSchema,
  }),
]);

export const patchSchema = z.array(patchOpSchema).min(1).max(MAX_PATCH_OPS);

/** What the AI returns for a revision. Empty `ops` means "nothing to change". */
export const aiPatchSchema = z.object({
  ops: z.array(patchOpSchema).max(MAX_PATCH_OPS),
});

export type PatchOp = z.infer<typeof patchOpSchema>;
export type AssessmentPatch = z.infer<typeof patchSchema>;
