import {
  allAssessmentFixtures,
  openEndedWithoutLinesAssessment,
  shortAssessment,
} from '../__fixtures__/assessments.js';
import {
  DEFAULT_OPEN_ENDED_LINES,
  MAX_OPEN_ENDED_LINES,
  aiAssessmentSchema,
  assessmentContentSchema,
} from './content.schema.js';

const buildMultipleChoice = (overrides: Record<string, unknown> = {}) => ({
  kind: 'multiple_choice',
  statement: 'Statement',
  points: 1,
  alternatives: ['A', 'B', 'C'],
  correctIndex: 0,
  ...overrides,
});

const buildOpenEnded = (overrides: Record<string, unknown> = {}) => ({
  kind: 'open_ended',
  statement: 'Statement',
  points: 1,
  expectedAnswer: 'Answer',
  ...overrides,
});

const buildAi = (question: Record<string, unknown>) => ({
  title: 'Title',
  sections: [{ title: 'Section', questions: [question] }],
});

const buildContent = (
  sections: Array<{ id: string; questionIds: string[] }>,
) => ({
  title: 'Title',
  sections: sections.map((section) => ({
    id: section.id,
    title: 'Section',
    questions: section.questionIds.map((id) => ({ id, ...buildOpenEnded() })),
  })),
});

describe('aiAssessmentSchema', () => {
  it.each(Object.entries(allAssessmentFixtures))(
    'should accept the %s fixture',
    (_name, fixture) => {
      const result = aiAssessmentSchema.safeParse(fixture);

      expect(result.success).toBe(true);
    },
  );

  it('should keep text with markup untouched when it is valid content', () => {
    const fixture = allAssessmentFixtures.hostileTextAssessment;

    const result = aiAssessmentSchema.parse(fixture);

    expect(result.title).toBe(fixture.title);
  });

  it('should reject the assessment when the title is empty', () => {
    const result = aiAssessmentSchema.safeParse({
      ...shortAssessment,
      title: '',
    });

    expect(result.success).toBe(false);
  });

  it('should reject the assessment when there are no sections', () => {
    const result = aiAssessmentSchema.safeParse({
      ...shortAssessment,
      sections: [],
    });

    expect(result.success).toBe(false);
  });

  it('should reject a section when it has no questions', () => {
    const result = aiAssessmentSchema.safeParse({
      title: 'Title',
      sections: [{ title: 'Section', questions: [] }],
    });

    expect(result.success).toBe(false);
  });

  it('should reject a question when the kind is unknown', () => {
    const result = aiAssessmentSchema.safeParse(
      buildAi(buildOpenEnded({ kind: 'true_false' })),
    );

    expect(result.success).toBe(false);
  });

  it.each([0, -1])(
    'should reject a question when points is %s',
    (points) => {
      const result = aiAssessmentSchema.safeParse(
        buildAi(buildOpenEnded({ points })),
      );

      expect(result.success).toBe(false);
    },
  );

  describe('multiple_choice', () => {
    it.each([
      ['one alternative', ['A']],
      ['six alternatives', ['A', 'B', 'C', 'D', 'E', 'F']],
      ['an empty alternative', ['A', '']],
    ])('should reject the question when it has %s', (_name, alternatives) => {
      const result = aiAssessmentSchema.safeParse(
        buildAi(buildMultipleChoice({ alternatives })),
      );

      expect(result.success).toBe(false);
    });

    it('should accept correctIndex when it points to the last alternative', () => {
      const result = aiAssessmentSchema.safeParse(
        buildAi(buildMultipleChoice({ correctIndex: 2 })),
      );

      expect(result.success).toBe(true);
    });

    it('should report a custom issue on correctIndex when it is past the last alternative', () => {
      const result = aiAssessmentSchema.safeParse(
        buildAi(buildMultipleChoice({ correctIndex: 3 })),
      );

      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({
          code: 'custom',
          path: ['sections', 0, 'questions', 0, 'correctIndex'],
        }),
      ]);
    });

    it.each([-1, 1.5])(
      'should reject the question when correctIndex is %s',
      (correctIndex) => {
        const result = aiAssessmentSchema.safeParse(
          buildAi(buildMultipleChoice({ correctIndex })),
        );

        expect(result.success).toBe(false);
      },
    );
  });

  describe('open_ended', () => {
    it('should default lines when the AI omits it', () => {
      const result = aiAssessmentSchema.parse(openEndedWithoutLinesAssessment);

      expect(result.sections[0].questions[0]).toMatchObject({
        kind: 'open_ended',
        lines: DEFAULT_OPEN_ENDED_LINES,
      });
    });

    it.each([0, 1, MAX_OPEN_ENDED_LINES])(
      'should keep lines when it is %s',
      (lines) => {
        const result = aiAssessmentSchema.parse(
          buildAi(buildOpenEnded({ lines })),
        );

        expect(result.sections[0].questions[0]).toMatchObject({ lines });
      },
    );

    it.each([-1, MAX_OPEN_ENDED_LINES + 1, 2.5])(
      'should reject the question when lines is %s',
      (lines) => {
        const result = aiAssessmentSchema.safeParse(
          buildAi(buildOpenEnded({ lines })),
        );

        expect(result.success).toBe(false);
      },
    );

    it('should accept an empty expectedAnswer', () => {
      const result = aiAssessmentSchema.safeParse(
        buildAi(buildOpenEnded({ expectedAnswer: '' })),
      );

      expect(result.success).toBe(true);
    });
  });
});

describe('assessmentContentSchema', () => {
  it('should accept content when every section and question has a unique id', () => {
    const result = assessmentContentSchema.safeParse(
      buildContent([
        { id: 'sec_1', questionIds: ['q_1', 'q_2'] },
        { id: 'sec_2', questionIds: ['q_3'] },
      ]),
    );

    expect(result.success).toBe(true);
  });

  it('should reject a section when its id is missing', () => {
    const content = {
      title: 'Title',
      sections: [
        {
          title: 'Section',
          questions: [{ id: 'q_1', ...buildOpenEnded() }],
        },
      ],
    };

    const result = assessmentContentSchema.safeParse(content);

    expect(result.success).toBe(false);
  });

  it('should reject a question when its id is missing', () => {
    const content = {
      title: 'Title',
      sections: [{ id: 'sec_1', title: 'Section', questions: [buildOpenEnded()] }],
    };

    const result = assessmentContentSchema.safeParse(content);

    expect(result.success).toBe(false);
  });

  it('should reject a question when its id is empty', () => {
    const result = assessmentContentSchema.safeParse(
      buildContent([{ id: 'sec_1', questionIds: [''] }]),
    );

    expect(result.success).toBe(false);
  });

  it('should report the duplicate when two questions in different sections share an id', () => {
    const result = assessmentContentSchema.safeParse(
      buildContent([
        { id: 'sec_1', questionIds: ['q_1'] },
        { id: 'sec_2', questionIds: ['q_1'] },
      ]),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        code: 'custom',
        path: ['sections', 1, 'questions', 0, 'id'],
      }),
    ]);
  });

  it('should report the duplicate when two sections share an id', () => {
    const result = assessmentContentSchema.safeParse(
      buildContent([
        { id: 'sec_1', questionIds: ['q_1'] },
        { id: 'sec_1', questionIds: ['q_2'] },
      ]),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ code: 'custom', path: ['sections', 1, 'id'] }),
    ]);
  });

  it('should still validate correctIndex when the question has an id', () => {
    const content = {
      title: 'Title',
      sections: [
        {
          id: 'sec_1',
          title: 'Section',
          questions: [{ id: 'q_1', ...buildMultipleChoice({ correctIndex: 3 }) }],
        },
      ],
    };

    const result = assessmentContentSchema.safeParse(content);

    expect(result.success).toBe(false);
  });
});
