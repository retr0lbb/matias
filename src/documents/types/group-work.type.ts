import { defineDocumentType } from './document-type.js';
import { groupWorkPrompt } from './group-work.prompt.js';

/**
 * Trabalho em grupo: homework whose answer is a document the group researches
 * and produces. Its value comes from the rubric; its "answer key" is a
 * correction guide (expected findings, expected outline, grading guidance).
 */
export const groupWorkType = defineDocumentType({
  type: 'group_work',
  label: 'Trabalho em grupo',
  chatLabel: 'o trabalho em grupo',
  judgeSummary:
    'a research project done by a group of students, with deliverable, rubric and correction guide: trabalho em grupo, seminário, projeto de pesquisa',
  filenameFallback: 'trabalho-em-grupo',
  allowedBlocks: ['text', 'list', 'table', 'research_task', 'deliverable', 'rubric'],
  hasAnswerKey: true,
  answerKeyTitle: 'Guia de correção',
  studentFields: ['groupMembers', 'className', 'date', 'score'],
  maxOutputTokens: 16_384,
  prompt: groupWorkPrompt,
});
