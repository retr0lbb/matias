import { courseSyllabusPrompt } from './course-syllabus.prompt.js';
import { defineDocumentType } from './document-type.js';

export const courseSyllabusType = defineDocumentType({
  type: 'course_syllabus',
  label: 'Plano de ensino',
  chatLabel: 'o plano de ensino',
  filenameFallback: 'plano-de-ensino',
  allowedBlocks: ['text', 'list', 'table'],
  hasAnswerKey: false,
  studentFields: [],
  maxOutputTokens: 16_384,
  prompt: courseSyllabusPrompt,
});
