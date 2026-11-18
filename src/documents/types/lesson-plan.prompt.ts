import type { TypePrompt } from './document-type.js';

// Draft: edit freely. A lesson plan (plano de aula) covers ONE lesson.
export const lessonPlanPrompt: TypePrompt = {
  generation:
    'You write lesson plans for teachers. Return one lesson plan as JSON that follows the response schema.',
  rules: [
    'Follow the request for subject, grade level, topic and lesson duration. When something is not specified, choose sensible values for a single lesson.',
    'Use sections such as "Objetivos", "Conteúdo", "Desenvolvimento", "Recursos" and "Avaliação". When the request names the sections it wants, use those titles in that order.',
    'Use a "table" for the lesson timeline (columns such as Etapa, Tempo, Atividade), a "list" for objectives, skills and materials, and "text" for short explanations.',
    'A plan has no questions, points or answer key.',
  ],
  noun: 'lesson plan',
  revision: 'You edit an existing lesson plan.',
};
