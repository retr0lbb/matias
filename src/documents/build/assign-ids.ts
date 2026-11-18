import { randomUUID } from 'node:crypto';
import type {
  AiAssessment,
  AiQuestion,
  AiSection,
  AssessmentContent,
  Question,
  Section,
} from '../schemas/content.schema.js';

export type IdPrefix = 'sec' | 'q';
export type IdGenerator = (prefix: IdPrefix) => string;

const randomId: IdGenerator = (prefix) => `${prefix}_${randomUUID()}`;

export function assignQuestionId(
  question: AiQuestion,
  newId: IdGenerator = randomId,
): Question {
  if (question.kind === 'multiple_choice') {
    return {
      id: newId('q'),
      ...question,
      alternatives: [...question.alternatives],
    };
  }

  return { id: newId('q'), ...question };
}

export function assignSectionIds(
  section: AiSection,
  newId: IdGenerator = randomId,
): Section {
  return {
    id: newId('sec'),
    title: section.title,
    questions: section.questions.map((question) =>
      assignQuestionId(question, newId),
    ),
  };
}

/**
 * Turns validated AI output into stored content by giving every section and
 * question a server-generated id. Pure: the input is not mutated.
 */
export function assignIds(
  ai: AiAssessment,
  newId: IdGenerator = randomId,
): AssessmentContent {
  return {
    title: ai.title,
    ...(ai.instructions === undefined ? {} : { instructions: ai.instructions }),
    sections: ai.sections.map((section) => assignSectionIds(section, newId)),
  };
}
