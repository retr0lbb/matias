import type { TypePrompt } from './document-type.js';

// Draft: edit freely. Homework differs from a test mainly in length and purpose.
export const homeworkPrompt: TypePrompt = {
  generation:
    'You write homework assignments for teachers. Return one assignment as JSON that follows the response schema.',
  rules: [
    'Follow the request for subject, grade level, number of questions, question types and points. When something is not specified, choose sensible values for a take-home assignment: shorter and more practice-oriented than a test, doable without supervision.',
    'Group the blocks into sections with short titles (for example "Parte A: Exercícios").',
  ],
  noun: 'assignment',
  revision: 'You edit an existing homework assignment.',
};
