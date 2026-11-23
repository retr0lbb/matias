/**
 * Document types the chat can create. The judge's prompt and response schema
 * are built from this list, so a new type (a preset from
 * specs/document-blocks.md) is offered to the judge once it is added here.
 */
export const DOCUMENT_TYPES = ["assessment"] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** One line per type, for the judge prompt. */
export const DOCUMENT_TYPE_SUMMARIES: Record<DocumentType, string> = {
	assessment:
		"a printable school test with questions and an answer key: prova, avaliação, simulado, lista de exercícios, atividade avaliativa",
};

/** Name shown to the teacher (Portuguese). */
export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
	assessment: "avaliação",
};
