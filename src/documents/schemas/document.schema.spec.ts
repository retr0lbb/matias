import { assessmentDocumentSchema } from './document.schema.js';

const buildDocument = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  content: {
    title: 'Title',
    sections: [
      {
        id: 'sec_1',
        title: 'Section',
        questions: [
          {
            id: 'q_1',
            kind: 'open_ended',
            statement: 'Statement',
            points: 1,
            expectedAnswer: 'Answer',
            lines: 3,
          },
        ],
      },
    ],
  },
  header: {},
  theme: {},
  ...overrides,
});

describe('assessmentDocumentSchema', () => {
  it('should fill header and theme defaults when they are empty', () => {
    const result = assessmentDocumentSchema.parse(buildDocument());

    expect(result.header.fields.studentName).toBe(true);
    expect(result.theme.numbering).toBe('per_section');
  });

  it('should return the same document when it is parsed twice', () => {
    const first = assessmentDocumentSchema.parse(buildDocument());

    const second = assessmentDocumentSchema.parse(first);

    expect(second).toEqual(first);
  });

  it.each([
    ['the schema version is unknown', { schemaVersion: 2 }],
    ['the content is missing', { content: undefined }],
    ['the header is missing', { header: undefined }],
    ['the theme is missing', { theme: undefined }],
    ['the theme is invalid', { theme: { paperSize: 'A3' } }],
    ['the header is invalid', { header: { logo: 'https://example.com/a.png' } }],
    ['the content has no sections', { content: { title: 'Title', sections: [] } }],
  ])('should reject the document when %s', (_name, overrides) => {
    const result = assessmentDocumentSchema.safeParse(buildDocument(overrides));

    expect(result.success).toBe(false);
  });
});
