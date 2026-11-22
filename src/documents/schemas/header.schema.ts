import { z } from 'zod/v4';

// Roughly 220 KB of image once decoded; keeps the document row small.
export const MAX_LOGO_LENGTH = 300_000;

// Only embedded PNG/JPEG. No URLs (the PDF renderer never touches the network)
// and no SVG (it can carry scripts).
const LOGO_PATTERN = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

const text = z.string().min(1).max(200);

export const DEFAULT_HEADER_FIELDS = {
  studentName: true,
  date: true,
  className: true,
  score: true,
};

/** Blank fields printed for the student to fill in. */
export const headerFieldsSchema = z.object({
  studentName: z.boolean().default(DEFAULT_HEADER_FIELDS.studentName),
  date: z.boolean().default(DEFAULT_HEADER_FIELDS.date),
  className: z.boolean().default(DEFAULT_HEADER_FIELDS.className),
  score: z.boolean().default(DEFAULT_HEADER_FIELDS.score),
});

/**
 * The AI may only fill the text fields, and only with values the teacher
 * wrote in the conversation. The logo and the visible fields stay out of its reach.
 */
export const headerSchema = z.object({
  institutionName: text.optional(),
  logo: z.string().max(MAX_LOGO_LENGTH).regex(LOGO_PATTERN).optional(),
  teacherName: text.optional(),
  subject: text.optional(),
  className: text.optional(),
  fields: headerFieldsSchema.default(DEFAULT_HEADER_FIELDS),
});

/** Header text the document AI copies from the conversation; every field optional. */
export const aiHeaderSchema = headerSchema.pick({
  institutionName: true,
  teacherName: true,
  subject: true,
  className: true,
});

export const AI_HEADER_FIELDS = ['institutionName', 'teacherName', 'subject', 'className'] as const;
export type AiHeaderField = (typeof AI_HEADER_FIELDS)[number];

export type AssessmentHeader = z.infer<typeof headerSchema>;
export type AiHeader = z.infer<typeof aiHeaderSchema>;
export type AssessmentHeaderInput = z.input<typeof headerSchema>;
