import type { TypePrompt } from './document-type.js';

// Draft: edit freely. A course syllabus (plano de ensino) covers a whole term or course.
export const courseSyllabusPrompt: TypePrompt = {
  generation:
    'You write course syllabi for teachers. Return one syllabus as JSON that follows the response schema.',
  rules: [
    'Follow the request for subject, grade level, workload and period. When something is not specified, choose sensible values for a school term.',
    'Use sections such as "Ementa", "Objetivos", "Conteúdo programático", "Metodologia", "Avaliação" and "Bibliografia". When the request names the sections it wants, use those titles in that order.',
    'Use a "table" for the schedule (columns such as Semana, Unidade, Conteúdo, Avaliação), a "list" for goals and references, and "text" for descriptions.',
    'A syllabus has no questions, points or answer key.',
  ],
  noun: 'syllabus',
  revision: 'You edit an existing course syllabus.',
};
