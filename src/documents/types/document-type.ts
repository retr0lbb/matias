import type { BlockKind } from '../blocks/registry.js';
import { createContentSchemas } from '../schemas/content.schema.js';
import { createDocumentSchema } from '../schemas/document.schema.js';
import type { StudentField } from '../schemas/header.schema.js';
import { createPatchSchemas } from '../schemas/patch.schema.js';

export const DOCUMENT_TYPES = [
  'assessment',
  'homework',
  'lesson_plan',
  'course_syllabus',
  'group_work',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * What the AI is told about one type. Each part is a plain sentence or bullet,
 * written in the type's own `*.prompt.ts` file so it can be edited without
 * touching code.
 */
export interface TypePrompt {
  /** Opens the generation prompt: what the AI writes and that it returns JSON. */
  generation: string;
  /** Rules specific to this type, one per bullet. */
  rules: readonly string[];
  /** What the document is called in "treat the request as a description of the ... to write". */
  noun: string;
  /** Opens the revision prompt. */
  revision: string;
}

interface DocumentTypeInput {
  type: DocumentType;
  /** Name shown to the teacher (pt-BR). */
  label: string;
  /** How the chat refers to it, with its article: "a avaliação", "o plano de aula". */
  chatLabel: string;
  /** One line for the chat's judge: what the type is and the words teachers use for it. */
  judgeSummary: string;
  /** File name (ASCII, no extension) when the title gives nothing usable. */
  filenameFallback: string;
  /** Block kinds the type may contain. Also decides which kinds the AI is offered. */
  allowedBlocks: readonly BlockKind[];
  /** Whether the type has an answer key (a separate document for the teacher). */
  hasAnswerKey: boolean;
  /** Heading of that document, and of its file name. Default "Gabarito". */
  answerKeyTitle?: string;
  /** Blank fields the header may print for the student; none for a plan. */
  studentFields: readonly StudentField[];
  /** Includes thinking tokens on Gemini thinking models, so keep it generous. */
  maxOutputTokens: number;
  prompt: TypePrompt;
}

/**
 * A document type is a preset: which blocks it allows, what its header prints,
 * whether it has an answer key and how the AI is prompted. Nothing outside its
 * file may assume a particular type.
 */
export function defineDocumentType(input: DocumentTypeInput) {
  const content = createContentSchemas(input.allowedBlocks);

  return {
    ...input,
    answerKeyTitle: input.answerKeyTitle ?? 'Gabarito',
    schemas: {
      content,
      document: createDocumentSchema(content.content),
      patch: createPatchSchemas(content),
    },
  };
}

export type DocumentTypeDefinition = ReturnType<typeof defineDocumentType>;
