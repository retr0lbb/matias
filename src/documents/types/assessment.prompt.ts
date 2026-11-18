import type { TypePrompt } from './document-type.js';

// Kept word for word from the prompt the module used before document types existed.
export const assessmentPrompt: TypePrompt = {
  generation:
    'You write school assessments for teachers. Return one assessment as JSON that follows the response schema.',
  rules: [
    'Follow the request for subject, grade level, number of questions, question types and points. When something is not specified, choose sensible values for a school test.',
    'Group the blocks into sections with short titles (for example "Parte A: Objetivas").',
  ],
  noun: 'assessment',
  revision: 'You edit an existing school assessment.',
};
