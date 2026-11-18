import { assessmentType } from './assessment.type.js';
import { courseSyllabusType } from './course-syllabus.type.js';
import { type DocumentType, type DocumentTypeDefinition } from './document-type.js';
import { groupWorkType } from './group-work.type.js';
import { homeworkType } from './homework.type.js';
import { lessonPlanType } from './lesson-plan.type.js';

export { DOCUMENT_TYPES, type DocumentType, type DocumentTypeDefinition } from './document-type.js';

// The only list of document types. Adding one = a new *.type.ts (+ *.prompt.ts) and a line here
// and in DOCUMENT_TYPES.
export const documentTypes = {
  assessment: assessmentType,
  homework: homeworkType,
  lesson_plan: lessonPlanType,
  course_syllabus: courseSyllabusType,
  group_work: groupWorkType,
} satisfies Record<DocumentType, DocumentTypeDefinition>;

export function getDocumentType(type: DocumentType): DocumentTypeDefinition {
  return documentTypes[type];
}
