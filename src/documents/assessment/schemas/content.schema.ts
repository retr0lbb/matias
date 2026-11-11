import { z } from 'zod/v4';

export const DEFAULT_OPEN_ENDED_LINES = 5;
export const MAX_OPEN_ENDED_LINES = 30;

// Shapes are kept unrefined so the AI schema (no ids) and the stored schema
// (with ids) are built from the same fields; refinements are applied last.
const multipleChoiceShape = {
  kind: z.literal('multiple_choice'),
  statement: z.string().min(1),
  points: z.number().positive(),
  alternatives: z.array(z.string().min(1)).min(2).max(5),
  correctIndex: z.number().int().min(0),
};

const openEndedShape = {
  kind: z.literal('open_ended'),
  statement: z.string().min(1),
  points: z.number().positive(),
  expectedAnswer: z.string(),
  lines: z
    .number()
    .int()
    .min(0)
    .max(MAX_OPEN_ENDED_LINES)
    .default(DEFAULT_OPEN_ENDED_LINES),
};

const idShape = { id: z.string().min(1) };

function withValidCorrectIndex<
  T extends z.ZodType<{ correctIndex: number; alternatives: string[] }>,
>(schema: T) {
  return schema.superRefine((value, context) => {
    if (value.correctIndex > value.alternatives.length - 1) {
      context.addIssue({
        code: 'custom',
        message: 'A resposta correta esta fora da posição maxima do array',
        path: ['correctIndex'],
      });
    }
  });
}

// What the AI generates: no ids, no numbering, no totals.

export const aiQuestionSchema = z.discriminatedUnion('kind', [
  withValidCorrectIndex(z.object(multipleChoiceShape)),
  z.object(openEndedShape),
]);

export const aiSectionSchema = z.object({
  title: z.string().min(1),
  questions: z.array(aiQuestionSchema).min(1),
});

export const aiAssessmentSchema = z.object({
  title: z.string().min(1),
  instructions: z.string().optional(),
  sections: z.array(aiSectionSchema).min(1),
});

// What the server stores: the same content plus server-generated ids.

export const questionSchema = z.discriminatedUnion('kind', [
  withValidCorrectIndex(z.object({ ...idShape, ...multipleChoiceShape })),
  z.object({ ...idShape, ...openEndedShape }),
]);

export const sectionSchema = z.object({
  ...idShape,
  title: z.string().min(1),
  questions: z.array(questionSchema).min(1),
});

export const assessmentContentSchema = z
  .object({
    title: z.string().min(1),
    instructions: z.string().optional(),
    sections: z.array(sectionSchema).min(1),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>();

    const check = (id: string, path: PropertyKey[]) => {
      if (seen.has(id)) {
        context.addIssue({
          code: 'custom',
          message: `Id duplicado: ${id}`,
          path,
        });
      }
      seen.add(id);
    };

    value.sections.forEach((section, sectionIndex) => {
      check(section.id, ['sections', sectionIndex, 'id']);
      section.questions.forEach((question, questionIndex) => {
        check(question.id, [
          'sections',
          sectionIndex,
          'questions',
          questionIndex,
          'id',
        ]);
      });
    });
  });

/** AI output after validation (defaults applied). */
export type AiAssessment = z.infer<typeof aiAssessmentSchema>;
/** AI output before validation (`lines` may be missing). */
export type AiAssessmentInput = z.input<typeof aiAssessmentSchema>;
export type AiQuestion = z.infer<typeof aiQuestionSchema>;
export type AiSection = z.infer<typeof aiSectionSchema>;

export type AssessmentContent = z.infer<typeof assessmentContentSchema>;
export type Question = z.infer<typeof questionSchema>;
export type Section = z.infer<typeof sectionSchema>;
