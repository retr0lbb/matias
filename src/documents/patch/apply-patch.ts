import {
  assignQuestionId,
  assignSectionIds,
  type IdGenerator,
} from '../build/assign-ids.js';
import type {
  AssessmentContent,
  Question,
  Section,
} from '../schemas/content.schema.js';
import {
  assessmentDocumentSchema,
  type AssessmentDocument,
} from '../schemas/document.schema.js';
import type { PatchOp } from '../schemas/patch.schema.js';

export interface PatchIssue {
  /** Index of the failing operation; null when the resulting document is invalid. */
  opIndex: number | null;
  message: string;
}

export type ApplyPatchResult =
  | { success: true; document: AssessmentDocument }
  | { success: false; errors: PatchIssue[] };

class PatchOpError extends Error {}

function findSection(content: AssessmentContent, sectionId: string): Section {
  const section = content.sections.find(({ id }) => id === sectionId);
  if (!section) {
    throw new PatchOpError(`Section "${sectionId}" does not exist`);
  }
  return section;
}

function findQuestion(
  content: AssessmentContent,
  questionId: string,
): { section: Section; index: number } {
  for (const section of content.sections) {
    const index = section.questions.findIndex(({ id }) => id === questionId);
    if (index !== -1) {
      return { section, index };
    }
  }
  throw new PatchOpError(`Question "${questionId}" does not exist`);
}

/** Inserts after the item with `afterId`, or at the start when it is null. */
function insertAfter<T extends { id: string }>(
  list: T[],
  afterId: string | null,
  item: T,
  where: string,
): void {
  if (afterId === null) {
    list.unshift(item);
    return;
  }

  const index = list.findIndex(({ id }) => id === afterId);
  if (index === -1) {
    throw new PatchOpError(`"${afterId}" does not exist in ${where}`);
  }
  list.splice(index + 1, 0, item);
}

function applyOp(
  document: AssessmentDocument,
  op: PatchOp,
  newId: IdGenerator | undefined,
): void {
  const { content } = document;

  switch (op.op) {
    case 'set_title':
      content.title = op.title;
      return;

    case 'set_instructions':
      if (op.instructions === null) {
        delete content.instructions;
      } else {
        content.instructions = op.instructions;
      }
      return;

    case 'update_section':
      findSection(content, op.sectionId).title = op.title;
      return;

    case 'insert_section':
      insertAfter(
        content.sections,
        op.afterSectionId,
        assignSectionIds(op.section, newId),
        'the assessment',
      );
      return;

    case 'remove_section': {
      findSection(content, op.sectionId);
      content.sections = content.sections.filter(
        ({ id }) => id !== op.sectionId,
      );
      return;
    }

    case 'replace_question': {
      const { section, index } = findQuestion(content, op.questionId);
      const replacement: Question = { ...op.question, id: op.questionId };
      section.questions[index] = replacement;
      return;
    }

    case 'insert_question': {
      const section = findSection(content, op.sectionId);
      insertAfter(
        section.questions,
        op.afterQuestionId,
        assignQuestionId(op.question, newId),
        `section "${op.sectionId}"`,
      );
      return;
    }

    case 'remove_question': {
      const { section, index } = findQuestion(content, op.questionId);
      section.questions.splice(index, 1);
      return;
    }

    case 'move_question': {
      if (op.afterQuestionId === op.questionId) {
        throw new PatchOpError('A question cannot be placed after itself');
      }

      const source = findQuestion(content, op.questionId);
      const target = findSection(content, op.toSectionId);
      const [question] = source.section.questions.splice(source.index, 1);
      insertAfter(
        target.questions,
        op.afterQuestionId,
        question,
        `section "${op.toSectionId}"`,
      );
      return;
    }

    case 'update_theme': {
      const { marginsMm, ...tokens } = op.theme;
      // Keys are optional in the patch, so undefined values must not overwrite.
      const defined = <T extends object>(value: T) =>
        Object.fromEntries(
          Object.entries(value).filter(([, entry]) => entry !== undefined),
        );

      Object.assign(document.theme, defined(tokens));
      if (marginsMm) {
        Object.assign(document.theme.marginsMm, defined(marginsMm));
      }
      return;
    }

    case 'update_header_fields':
      for (const [field, visible] of Object.entries(op.fields)) {
        if (visible !== undefined) {
          document.header.fields[field as keyof typeof op.fields] = visible;
        }
      }
      return;

    default: {
      const unknown: never = op;
      throw new PatchOpError(`Unknown operation: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Applies the operations in order to a copy of the document and validates the
 * result as a whole. All or nothing: on any failure the errors are returned
 * and the input is left untouched. Pure.
 */
export function applyPatch(
  document: AssessmentDocument,
  ops: readonly PatchOp[],
  newId?: IdGenerator,
): ApplyPatchResult {
  const draft = structuredClone(document);

  for (const [opIndex, op] of ops.entries()) {
    try {
      applyOp(draft, op, newId);
    } catch (error) {
      if (error instanceof PatchOpError) {
        return { success: false, errors: [{ opIndex, message: error.message }] };
      }
      throw error;
    }
  }

  // Catches what no single operation can see, like a section left empty.
  const result = assessmentDocumentSchema.safeParse(draft);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((issue) => ({
        opIndex: null,
        message: `${issue.path.join('.')}: ${issue.message}`,
      })),
    };
  }

  return { success: true, document: result.data };
}

export function formatPatchIssues(issues: readonly PatchIssue[]): string {
  return issues
    .map(({ opIndex, message }) =>
      opIndex === null
        ? `Resulting document: ${message}`
        : `Operation ${opIndex}: ${message}`,
    )
    .join('\n');
}
