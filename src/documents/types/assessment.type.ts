import { assessmentPrompt } from './assessment.prompt.js';
import { defineDocumentType } from './document-type.js';

export const assessmentType = defineDocumentType({
  type: 'assessment',
  label: 'Avaliação',
  chatLabel: 'a avaliação',
  filenameFallback: 'avaliacao',
  allowedBlocks: ['multiple_choice', 'open_ended', 'text', 'code'],
  hasAnswerKey: true,
  studentFields: ['studentName', 'date', 'className', 'score'],
  maxOutputTokens: 16_384,
  prompt: assessmentPrompt,
});
