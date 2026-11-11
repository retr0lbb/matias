import { z } from 'zod/v4';
import { assessmentContentSchema } from './content.schema.js';
import { headerSchema } from './header.schema.js';
import { themeSchema } from './theme.schema.js';

export const ASSESSMENT_SCHEMA_VERSION = 1;

/** The stored document: the single source of truth for HTML, PDF and DOCX. */
export const assessmentDocumentSchema = z.object({
  schemaVersion: z.literal(ASSESSMENT_SCHEMA_VERSION),
  content: assessmentContentSchema,
  header: headerSchema,
  theme: themeSchema,
});

export type AssessmentDocument = z.infer<typeof assessmentDocumentSchema>;
export type AssessmentDocumentInput = z.input<typeof assessmentDocumentSchema>;
