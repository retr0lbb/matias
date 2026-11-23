import { defineDocumentType } from './document-type.js';
import { lessonPlanPrompt } from './lesson-plan.prompt.js';

export const lessonPlanType = defineDocumentType({
  type: 'lesson_plan',
  label: 'Plano de aula',
  chatLabel: 'o plano de aula',
  judgeSummary:
    'the plan for one class: plano de aula (objectives, materials, steps, assessment)',
  filenameFallback: 'plano-de-aula',
  allowedBlocks: ['text', 'list', 'table'],
  hasAnswerKey: false,
  studentFields: [],
  maxOutputTokens: 8192,
  prompt: lessonPlanPrompt,
});
