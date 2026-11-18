import { themeSchema } from './theme.schema.js';

describe('themeSchema', () => {
  it('should return the default theme when given an empty object', () => {
    const result = themeSchema.parse({});

    expect(result).toEqual({
      fontFamily: 'arial',
      baseFontSizePt: 12,
      accentColor: '#1f2937',
      marginsMm: { top: 20, right: 20, bottom: 20, left: 20 },
      paperSize: 'A4',
      pageBreakPerSection: false,
      numbering: 'per_section',
    });
  });

  it('should keep every token when all of them are provided', () => {
    const theme = {
      fontFamily: 'times_new_roman',
      baseFontSizePt: 14,
      accentColor: '#AB12ef',
      marginsMm: { top: 5, right: 40, bottom: 10, left: 15 },
      paperSize: 'Letter',
      pageBreakPerSection: true,
      numbering: 'continuous',
    };

    const result = themeSchema.parse(theme);

    expect(result).toEqual(theme);
  });

  it('should default the missing margins when only some sides are provided', () => {
    const result = themeSchema.parse({ marginsMm: { top: 10 } });

    expect(result.marginsMm).toEqual({
      top: 10,
      right: 20,
      bottom: 20,
      left: 20,
    });
  });

  it.each([
    ['a font outside the allowed list', { fontFamily: 'Comic Sans MS' }],
    ['a font stack with CSS', { fontFamily: 'arial; } body { display: none' }],
    ['a font size below the minimum', { baseFontSizePt: 8.9 }],
    ['a font size above the maximum', { baseFontSizePt: 16.1 }],
    ['a named color', { accentColor: 'red' }],
    ['a short hex color', { accentColor: '#fff' }],
    ['a color carrying CSS', { accentColor: '#ffffff; background: url(x)' }],
    ['a margin below the minimum', { marginsMm: { top: 4.9 } }],
    ['a margin above the maximum', { marginsMm: { left: 40.1 } }],
    ['an unknown paper size', { paperSize: 'A3' }],
    ['a non-boolean page break flag', { pageBreakPerSection: 'yes' }],
    ['an unknown numbering mode', { numbering: 'roman' }],
  ])('should reject the theme when it has %s', (_name, theme) => {
    const result = themeSchema.safeParse(theme);

    expect(result.success).toBe(false);
  });

  it.each([
    ['baseFontSizePt', { baseFontSizePt: 9 }],
    ['baseFontSizePt', { baseFontSizePt: 16 }],
    ['marginsMm', { marginsMm: { top: 5, bottom: 40 } }],
  ])('should accept %s when it is on the boundary', (_name, theme) => {
    const result = themeSchema.safeParse(theme);

    expect(result.success).toBe(true);
  });
});
