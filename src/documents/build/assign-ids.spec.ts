import {
  allAssessmentFixtures,
  multiSectionAssessment,
  shortAssessment,
} from '../__fixtures__/assessments.js';
import {
  aiAssessmentSchema,
  assessmentContentSchema,
  type AiQuestion,
} from '../schemas/content.schema.js';
import {
  assignIds,
  assignQuestionId,
  assignSectionIds,
  type IdGenerator,
} from './assign-ids.js';

const createSequentialId = (): IdGenerator => {
  let counter = 0;
  return (prefix) => `${prefix}_${++counter}`;
};

const multipleChoice: AiQuestion = {
  kind: 'multiple_choice',
  statement: 'Statement',
  points: 1,
  alternatives: ['A', 'B'],
  correctIndex: 1,
};

const openEnded: AiQuestion = {
  kind: 'open_ended',
  statement: 'Statement',
  points: 2,
  expectedAnswer: 'Answer',
  lines: 4,
};

describe('assign-ids', () => {
  describe('assignIds', () => {
    it.each(Object.entries(allAssessmentFixtures))(
      'should produce valid stored content when given the %s fixture',
      (_name, fixture) => {
        const ai = aiAssessmentSchema.parse(fixture);

        const content = assignIds(ai);

        expect(assessmentContentSchema.safeParse(content).success).toBe(true);
      },
    );

    it('should generate unique prefixed ids when no generator is given', () => {
      const ai = aiAssessmentSchema.parse(multiSectionAssessment);

      const content = assignIds(ai);

      const sectionIds = content.sections.map((section) => section.id);
      const questionIds = content.sections.flatMap((section) =>
        section.questions.map((question) => question.id),
      );
      expect(new Set([...sectionIds, ...questionIds]).size).toBe(9);
      expect(sectionIds.every((id) => id.startsWith('sec_'))).toBe(true);
      expect(questionIds.every((id) => id.startsWith('q_'))).toBe(true);
    });

    it('should use the given generator when one is provided', () => {
      const ai = aiAssessmentSchema.parse(shortAssessment);

      const content = assignIds(ai, createSequentialId());

      expect(content.sections.map((section) => section.id)).toEqual([
        'sec_1',
        'sec_3',
      ]);
      expect(content.sections[0].questions[0].id).toBe('q_2');
      expect(content.sections[1].questions[0].id).toBe('q_4');
    });

    it('should preserve content and order when ids are removed again', () => {
      const ai = aiAssessmentSchema.parse(multiSectionAssessment);

      const content = assignIds(ai);

      const withoutIds = {
        title: content.title,
        sections: content.sections.map((section) => ({
          title: section.title,
          questions: section.questions.map(({ id: _id, ...question }) => question),
        })),
      };
      expect(withoutIds).toEqual(ai);
    });

    it('should not mutate the input when assigning ids', () => {
      const ai = aiAssessmentSchema.parse(shortAssessment);
      const before = structuredClone(ai);

      assignIds(ai);

      expect(ai).toEqual(before);
    });

    it('should copy instructions when they are present', () => {
      const ai = aiAssessmentSchema.parse(shortAssessment);

      const content = assignIds(ai);

      expect(content.instructions).toBe('Leia as questões com atenção.');
    });

    it('should omit the instructions key when they are absent', () => {
      const ai = aiAssessmentSchema.parse(multiSectionAssessment);

      const content = assignIds(ai);

      expect('instructions' in content).toBe(false);
    });
  });

  describe('assignSectionIds', () => {
    it('should give the section and each question an id when called', () => {
      const section = { title: 'Section', questions: [multipleChoice, openEnded] };

      const result = assignSectionIds(section, createSequentialId());

      expect(result).toEqual({
        id: 'sec_1',
        title: 'Section',
        questions: [
          { id: 'q_2', ...multipleChoice },
          { id: 'q_3', ...openEnded },
        ],
      });
    });
  });

  describe('assignQuestionId', () => {
    it('should copy the alternatives array when the question is multiple choice', () => {
      const result = assignQuestionId(multipleChoice, createSequentialId());

      expect(result).toEqual({ id: 'q_1', ...multipleChoice });
      expect(result.kind === 'multiple_choice' && result.alternatives).not.toBe(
        multipleChoice.kind === 'multiple_choice' && multipleChoice.alternatives,
      );
    });

    it('should keep every field when the question is open ended', () => {
      const result = assignQuestionId(openEnded, createSequentialId());

      expect(result).toEqual({ id: 'q_1', ...openEnded });
    });

    it('should generate a prefixed id when no generator is given', () => {
      const result = assignQuestionId(openEnded);

      expect(result.id).toMatch(/^q_[0-9a-f-]{36}$/);
    });
  });
});
