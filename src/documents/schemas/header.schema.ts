import { z } from 'zod/v4';

// Roughly 220 KB of image once decoded; keeps the document row small.
export const MAX_LOGO_LENGTH = 300_000;

// Only embedded PNG/JPEG. No URLs (the PDF renderer never touches the network)
// and no SVG (it can carry scripts).
const LOGO_PATTERN = /^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

const text = z.string().min(1).max(200);

/** The blank fields a student can be asked to fill in. A document type picks which ones exist. */
export const STUDENT_FIELDS = ['studentName', 'groupMembers', 'date', 'className', 'score'] as const;
export type StudentField = (typeof STUDENT_FIELDS)[number];

export const MAX_EXTRA_FIELDS = 6;

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
  // Blank lines for the names of a group. Optional with no default (shown unless false), so
  // documents saved before it existed parse unchanged; only types that list it print it.
  groupMembers: z.boolean().optional(),
});

// A labelled value for what the fixed fields don't cover, e.g. "Carga horária: 60 h".
const extraFieldSchema = z.object({
  label: z.string().min(1).max(40),
  value: z.string().min(1).max(100),
});

/** Never produced by the AI: comes from the institution/teacher records. */
export const headerSchema = z.object({
  institutionName: text.optional(),
  logo: z.string().max(MAX_LOGO_LENGTH).regex(LOGO_PATTERN).optional(),
  teacherName: text.optional(),
  subject: text.optional(),
  className: text.optional(),
  // Optional with no default, so documents saved before it existed parse unchanged.
  extra: z.array(extraFieldSchema).max(MAX_EXTRA_FIELDS).optional(),
  fields: headerFieldsSchema.default(DEFAULT_HEADER_FIELDS),
});

export type DocumentHeader = z.infer<typeof headerSchema>;
export type DocumentHeaderInput = z.input<typeof headerSchema>;
