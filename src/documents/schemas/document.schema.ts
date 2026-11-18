import { z } from 'zod/v4';
import { BLOCK_KINDS } from '../blocks/registry.js';
import { type ContentSchemas, createContentSchemas } from './content.schema.js';
import { headerSchema } from './header.schema.js';
import { themeSchema } from './theme.schema.js';

// v1: sections held `questions`. v2: sections hold `blocks` (any block kind).
export const DOCUMENT_SCHEMA_VERSION = 2;

/**
 * The stored document: the single source of truth for HTML, PDF and DOCX.
 * Built per document type, because the type decides which block kinds it may hold.
 */
export function createDocumentSchema(content: ContentSchemas['content']) {
  return z.object({
    schemaVersion: z.literal(DOCUMENT_SCHEMA_VERSION),
    content,
    header: headerSchema,
    theme: themeSchema,
  });
}

export type DocumentSchema = ReturnType<typeof createDocumentSchema>;

// Only for the static types: they cover every block kind. Validation always
// goes through the schema of the document's own type.
const anyDocumentSchema = createDocumentSchema(createContentSchemas(BLOCK_KINDS).content);

export type StoredDocument = z.infer<typeof anyDocumentSchema>;
export type StoredDocumentInput = z.input<typeof anyDocumentSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Brings a stored document up to the current version before it is parsed.
 * Pure: the input is not mutated. Anything it does not recognise is returned
 * as is, so the schema reports it. v1 → v2 renames `questions` to `blocks`.
 */
export function upgradeDocument(raw: unknown): unknown {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.content)) {
    return raw;
  }

  const { sections } = raw.content;
  if (!Array.isArray(sections)) {
    return raw;
  }

  return {
    ...raw,
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    content: {
      ...raw.content,
      sections: sections.map((section: unknown) => {
        if (!isRecord(section) || !('questions' in section)) {
          return section;
        }

        const { questions, ...rest } = section;
        return { ...rest, blocks: questions };
      }),
    },
  };
}
