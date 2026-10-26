import { z } from 'zod/v4';

const multipleChoice = z.object({
  kind: z.literal('multiple_choice'),
  statement: z.string().min(1),
  points: z.number().positive(),
  alternatives: z.array(z.string().min(1)).min(2).max(5),
  correctIndex: z.number().int().min(0),
}).superRefine((value, context) => {
  if(value.correctIndex > (value.alternatives.length -1)){
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A resposta correta esta fora da posição maxima do array",
      path: ["correctIndex"]
    })
  }
});

const openEnded = z.object({
  kind: z.literal('open_ended'),
  statement: z.string().min(1),
  points: z.number().positive(),
  expectedAnswer: z.string(),
});

const question = z.discriminatedUnion('kind', [multipleChoice, openEnded]);

const section = z.object({
  title: z.string().min(1),
  questions: z.array(question).min(1),
});

export const aiAssessmentSchema = z.object({
  title: z.string().min(1),
  instructions: z.string().optional(),
  sections: z.array(section).min(1),
});

export type AiAssessment = z.infer<typeof aiAssessmentSchema>;
