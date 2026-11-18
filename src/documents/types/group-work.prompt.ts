import type { TypePrompt } from './document-type.js';

// Draft: edit freely. A group project (trabalho em grupo) is take-home work whose answer is a
// document the group researches and produces; the teacher gets a correction guide instead of a key.
export const groupWorkPrompt: TypePrompt = {
  generation:
    'You write group research projects for teachers: take-home work in which students research a topic together and hand in a document (a written report, a presentation, a poster...) as their answer. Return one project as JSON that follows the response schema.',
  rules: [
    'Follow the request for subject, grade level, topic, group size, kind of deliverable, deadline and points. When something is not specified, choose sensible values for a school group project.',
    'Include exactly one "research_task" (what to research), one "deliverable" (what to hand in) and one "rubric" (how it is graded). The points of the rubric criteria are the value of the project.',
    'Use sections such as "Apresentação", "Pesquisa", "Entrega", "Organização do grupo", "Cronograma" and "Avaliação". Use a "list" for group roles and a "table" for the schedule (columns such as Etapa and Prazo) only when the request gives dates or durations; never invent dates.',
    'Fill the teacher-only fields ("expectedFindings", "expectedOutline" and each criterion\'s "guidance"): they form the teacher\'s correction guide and are never shown to the students.',
  ],
  noun: 'group project',
  revision: 'You edit an existing group project.',
};
