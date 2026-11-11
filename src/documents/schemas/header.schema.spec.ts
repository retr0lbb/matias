import { MAX_LOGO_LENGTH, headerSchema } from './header.schema.js';

const PNG_LOGO = 'data:image/png;base64,iVBORw0KGgo=';

describe('headerSchema', () => {
  it('should show every student field when given an empty object', () => {
    const result = headerSchema.parse({});

    expect(result).toEqual({
      fields: { studentName: true, date: true, className: true, score: true },
    });
  });

  it('should default the other fields when only some are configured', () => {
    const result = headerSchema.parse({ fields: { score: false } });

    expect(result.fields).toEqual({
      studentName: true,
      date: true,
      className: true,
      score: false,
    });
  });

  it('should keep institution and teacher data when they are provided', () => {
    const header = {
      institutionName: 'Escola Exemplo',
      logo: PNG_LOGO,
      teacherName: 'Prof. Exemplo',
      subject: 'Biologia',
      className: '8º B',
      fields: { studentName: true, date: false, className: false, score: true },
    };

    const result = headerSchema.parse(header);

    expect(result).toEqual(header);
  });

  it('should accept a JPEG data URI as logo', () => {
    const result = headerSchema.safeParse({
      logo: 'data:image/jpeg;base64,/9j/4AAQ',
    });

    expect(result.success).toBe(true);
  });

  it.each([
    ['an https URL', 'https://example.com/logo.png'],
    ['an SVG data URI', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URI that closes the attribute', `${PNG_LOGO}" onerror="alert(1)`],
    ['an empty payload', 'data:image/png;base64,'],
  ])('should reject the logo when it is %s', (_name, logo) => {
    const result = headerSchema.safeParse({ logo });

    expect(result.success).toBe(false);
  });

  it('should reject the logo when it is longer than the limit', () => {
    const prefix = 'data:image/png;base64,';
    const logo = prefix + 'A'.repeat(MAX_LOGO_LENGTH - prefix.length + 1);

    const result = headerSchema.safeParse({ logo });

    expect(result.success).toBe(false);
  });

  it.each(['institutionName', 'teacherName', 'subject', 'className'])(
    'should reject %s when it is empty',
    (key) => {
      const result = headerSchema.safeParse({ [key]: '' });

      expect(result.success).toBe(false);
    },
  );

  it('should reject a field toggle when it is not a boolean', () => {
    const result = headerSchema.safeParse({ fields: { date: 'no' } });

    expect(result.success).toBe(false);
  });
});
