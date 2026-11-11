import type {
  AssessmentContent,
  Question,
  Section,
} from '../schemas/content.schema.js';
import type { AssessmentTheme } from '../schemas/theme.schema.js';

// Everything derived from the content (numbers, letters, totals) is computed
// here and shared by the HTML, DOCX and answer-key renderers, so the outputs
// cannot disagree. None of it is stored in the document.

export interface NumberedQuestion {
  number: number;
  question: Question;
}

export interface NumberedSection {
  section: Section;
  questions: NumberedQuestion[];
}

export function numberQuestions(
  content: AssessmentContent,
  numbering: AssessmentTheme['numbering'],
): NumberedSection[] {
  let counter = 0;

  return content.sections.map((section) => {
    if (numbering === 'per_section') {
      counter = 0;
    }

    return {
      section,
      questions: section.questions.map((question) => ({
        number: ++counter,
        question,
      })),
    };
  });
}

/** 0 → "a", 1 → "b"... */
export function alternativeLabel(index: number): string {
  return String.fromCharCode('a'.charCodeAt(0) + index);
}

export function totalPoints(content: AssessmentContent): number {
  const sum = content.sections
    .flatMap((section) => section.questions)
    .reduce((total, question) => total + question.points, 0);

  // Avoids float noise such as 0.1 + 0.2 = 0.30000000000000004.
  return Math.round(sum * 1000) / 1000;
}

export function formatNumber(value: number): string {
  return value.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

/** "0,5 ponto", "1 ponto", "2 pontos". */
export function formatPoints(points: number): string {
  return `${formatNumber(points)} ${points < 2 ? 'ponto' : 'pontos'}`;
}
