import { z } from 'zod/v4';
import { aiBlockUnion, type BlockKind, storedBlockUnion } from '../blocks/registry.js';
import { aiHeaderSchema } from './header.schema.js';

export type { AiBlock, AiBlockInput, Block } from '../blocks/registry.js';

const idShape = { id: z.string().min(1) };

/**
 * Content schemas for the given block kinds. Every kind is one self-contained
 * file in `blocks/`; a document type (see `types/`) only chooses which ones it allows.
 */
export function createContentSchemas(kinds: readonly BlockKind[]) {
  // What the AI generates: no ids, no numbering, no totals.
  const aiBlock = aiBlockUnion(kinds);
  const aiSection = z.object({
    title: z.string().min(1),
    blocks: z.array(aiBlock).min(1),
  });
  const aiContent = z
    .object({
      title: z.string().min(1),
      instructions: z.string().optional(),
      sections: z.array(aiSection),
      // Instead of a document: one question for the teacher when neither the
      // request nor the conversation says what the document is about.
      clarification: z.string().min(1).max(500).optional(),
    })
    .superRefine((value, context) => {
      if (value.sections.length === 0 && !value.clarification) {
        context.addIssue({
          code: 'custom',
          message: 'Write at least one section, or a clarification question when the subject is unknown',
          path: ['sections'],
        });
      }
    });

  /** What generation returns: the content plus any header text the teacher gave. */
  const aiDraft = aiContent.safeExtend({
    header: aiHeaderSchema.optional(),
  });

  // What the server stores: the same content plus server-generated ids.
  const block = storedBlockUnion(kinds);
  const section = z.object({
    ...idShape,
    title: z.string().min(1),
    blocks: z.array(block).min(1),
  });
  const content = z
    .object({
      title: z.string().min(1),
      instructions: z.string().optional(),
      sections: z.array(section).min(1),
    })
    .superRefine((value, context) => {
      const seen = new Set<string>();

      const check = (id: string, path: PropertyKey[]) => {
        if (seen.has(id)) {
          context.addIssue({
            code: 'custom',
            message: `Id duplicado: ${id}`,
            path,
          });
        }
        seen.add(id);
      };

      value.sections.forEach((entry, sectionIndex) => {
        check(entry.id, ['sections', sectionIndex, 'id']);
        entry.blocks.forEach((item, blockIndex) => {
          check(item.id, ['sections', sectionIndex, 'blocks', blockIndex, 'id']);
        });
      });
    });

  return { aiBlock, aiSection, aiContent, aiDraft, block, section, content };
}

export type ContentSchemas = ReturnType<typeof createContentSchemas>;

/** AI output after validation (defaults applied). */
export type AiContent = z.infer<ContentSchemas['aiContent']>;
export type AiDraft = z.infer<ContentSchemas['aiDraft']>;
/** AI output before validation (`lines` may be missing). */
export type AiContentInput = z.input<ContentSchemas['aiContent']>;
export type AiSection = z.infer<ContentSchemas['aiSection']>;

export type DocumentContent = z.infer<ContentSchemas['content']>;
export type Section = z.infer<ContentSchemas['section']>;
