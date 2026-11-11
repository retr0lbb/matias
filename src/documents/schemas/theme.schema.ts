import { z } from 'zod/v4';

// Keys only: the renderer maps each key to a font stack. The AI can pick a key
// but can never inject a font name or any CSS.
export const FONT_FAMILIES = ['arial', 'times_new_roman'] as const;
export const PAPER_SIZES = ['A4', 'Letter'] as const;
export const NUMBERING_MODES = ['per_section', 'continuous'] as const;

const DEFAULT_MARGIN_MM = 20;
const DEFAULT_MARGINS_MM = {
  top: DEFAULT_MARGIN_MM,
  right: DEFAULT_MARGIN_MM,
  bottom: DEFAULT_MARGIN_MM,
  left: DEFAULT_MARGIN_MM,
};

const marginMm = z.number().min(5).max(40).default(DEFAULT_MARGIN_MM);

/** Every token has a default, so `themeSchema.parse({})` is the default theme. */
export const themeSchema = z.object({
  fontFamily: z.enum(FONT_FAMILIES).default('arial'),
  baseFontSizePt: z.number().min(9).max(16).default(12),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#1f2937'),
  marginsMm: z
    .object({
      top: marginMm,
      right: marginMm,
      bottom: marginMm,
      left: marginMm,
    })
    .default(DEFAULT_MARGINS_MM),
  paperSize: z.enum(PAPER_SIZES).default('A4'),
  pageBreakPerSection: z.boolean().default(false),
  numbering: z.enum(NUMBERING_MODES).default('per_section'),
});

export type AssessmentTheme = z.infer<typeof themeSchema>;
export type AssessmentThemeInput = z.input<typeof themeSchema>;
