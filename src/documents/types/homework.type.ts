import { defineDocumentType } from './document-type.js';
import { homeworkPrompt } from './homework.prompt.js';

export const homeworkType = defineDocumentType({
  type: 'homework',
  label: 'Tarefa',
  chatLabel: 'a tarefa',
  filenameFallback: 'tarefa',
  allowedBlocks: ['multiple_choice', 'open_ended', 'text', 'list', 'code'],
  hasAnswerKey: true,
  studentFields: ['studentName', 'date', 'className'],
  maxOutputTokens: 16_384,
  prompt: homeworkPrompt,
});
