import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenerateContentResponse, GoogleGenAI } from '@google/genai';
import { UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import type { MockInstance } from 'vitest';
import { GeminiClient } from '../ai/gemini.client.js';
import { multiSectionAssessment } from './__fixtures__/assessments.js';
import { DocumentAiService } from './ai/document-ai.service.js';
import { isScoredBlock, type ScoredBlock } from './blocks/registry.js';
import { assignIds } from './build/assign-ids.js';
import { applyPatch } from './patch/apply-patch.js';
import { PdfRendererService } from './pdf/pdf-renderer.service.js';
import { renderAnswerKey } from './render/render-answer-key.js';
import { renderDocumentDocx } from './render/render-docx.js';
import { renderDocumentHtml } from './render/render-html.js';
import { DOCUMENT_SCHEMA_VERSION, type StoredDocument } from './schemas/document.schema.js';
import { headerSchema } from './schemas/header.schema.js';
import type { PatchOp } from './schemas/patch.schema.js';
import { themeSchema } from './schemas/theme.schema.js';
import { assessmentType } from './types/assessment.type.js';

// Whole document pipeline with only the Gemini client faked:
// AI JSON → Zod → assignIds → HTML → PDF (real Chromium) → DOCX → answer key
// → valid patch → invalid patch rejected. No database, no HTTP.
// Every output is written to .tmp/assessment-flow to be checked by eye.
const OUTPUT_DIR = join(process.cwd(), '.tmp', 'assessment-flow');

const AI_OPTIONS = { model: 'gemini-test', thinkingLevel: 'DEFAULT' } as const;

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

async function readPdf(pdf: Buffer): Promise<{ text: string; pages: number }> {
  const parser = new PDFParse({ data: new Uint8Array(pdf) });

  try {
    const result = await parser.getText();
    return { text: normalize(result.text), pages: result.total };
  } finally {
    await parser.destroy();
  }
}

async function readDocx(docx: Buffer): Promise<string> {
  const { value } = await mammoth.extractRawText({ buffer: docx });
  return normalize(value);
}

function aiAnswer(json: unknown): GenerateContentResponse {
  return { text: JSON.stringify(json) } as unknown as GenerateContentResponse;
}

const questionsOf = (document: StoredDocument): ScoredBlock[] =>
  document.content.sections.flatMap((section) => section.blocks).filter(isScoredBlock);

/** Text that only the answer key may show. */
function answersOf(document: StoredDocument): string[] {
  return questionsOf(document).flatMap((question) =>
    question.kind === 'open_ended'
      ? [question.expectedAnswer]
      : question.explanation
        ? [question.explanation]
        : [],
  );
}

describe('Assessment flow (fake AI, real Chromium)', () => {
  let ai: DocumentAiService;
  let generateContent: MockInstance<GoogleGenAI['models']['generateContent']>;
  let pdfRenderer: PdfRendererService;

  const header = headerSchema.parse({
    institutionName: 'Escola Exemplo',
    teacherName: 'Prof. Exemplo',
    subject: 'Matemática',
  });
  const theme = themeSchema.parse({});

  /** Same steps as DocumentsService.generate, minus the database. */
  async function generateDocument(): Promise<StoredDocument> {
    const generated = await ai.generate(assessmentType, 'Prova de matemática', AI_OPTIONS);
    if (generated.kind !== 'document') {
      throw new Error(`Expected a document, got a clarification: ${generated.question}`);
    }
    const content = assignIds(generated.content);

    return assessmentType.schemas.document.parse({
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      content,
      header,
      theme,
    });
  }

  async function save(name: string, data: string | Buffer): Promise<void> {
    await writeFile(join(OUTPUT_DIR, name), data);
  }

  beforeAll(async () => {
    await mkdir(OUTPUT_DIR, { recursive: true });
    pdfRenderer = new PdfRendererService();
    ai = new DocumentAiService(
      new GeminiClient(new ConfigService({ GEMINI_API_KEY: 'test-key' })),
    );
    // The client is private; only its network call is replaced.
    const { client } = ai as unknown as { client: GoogleGenAI };
    generateContent = vi.spyOn(client.models, 'generateContent');
  });

  beforeEach(() => {
    generateContent.mockResolvedValue(aiAnswer(multiSectionAssessment));
  });

  afterEach(() => {
    generateContent.mockReset();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await pdfRenderer.onModuleDestroy();
  });

  it('should turn the AI answer into a valid document with unique ids when the AI returns a valid assessment', async () => {
    const document = await generateDocument();

    const ids = [
      ...document.content.sections.map((section) => section.id),
      ...questionsOf(document).map((question) => question.id),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(questionsOf(document)).toHaveLength(6);
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('should retry once with the validation errors when the AI first returns an invalid assessment', async () => {
    const invalid = structuredClone(multiSectionAssessment);
    const [firstQuestion] = invalid.sections[0].blocks;
    if (firstQuestion.kind === 'multiple_choice') {
      firstQuestion.correctIndex = 9;
    }
    generateContent
      .mockResolvedValueOnce(aiAnswer(invalid))
      .mockResolvedValueOnce(aiAnswer(multiSectionAssessment));

    const document = await generateDocument();

    expect(generateContent).toHaveBeenCalledTimes(2);
    const retry = JSON.stringify(generateContent.mock.calls[1][0].contents);
    expect(retry).toContain('correctIndex');
    expect(document.content.title).toBe(multiSectionAssessment.title);
  });

  it('should render the HTML and PDF with every statement and no answers when the document is generated', async () => {
    const document = await generateDocument();
    const html = renderDocumentHtml(document.content, document.header, document.theme, assessmentType);

    const pdf = await pdfRenderer.render(html);
    await save('test.html', html);
    await save('test.pdf', pdf);
    const { text, pages } = await readPdf(pdf);

    expect(pages).toBeGreaterThanOrEqual(1);
    expect(text).toContain(normalize(document.content.title));
    expect(text).toContain('Escola Exemplo');
    for (const question of questionsOf(document)) {
      expect(html).toContain(question.statement);
      expect(text).toContain(normalize(question.statement));
    }
    for (const answer of answersOf(document)) {
      expect(html).not.toContain(answer);
      expect(text).not.toContain(normalize(answer));
    }
  }, 60_000);

  it('should render the DOCX with the same statements as the PDF and no answers when the document is generated', async () => {
    const document = await generateDocument();

    const docx = await renderDocumentDocx(
      document.content,
      document.header,
      document.theme,
      assessmentType,
    );
    await save('test.docx', docx);
    const text = await readDocx(docx);

    expect(text).toContain(normalize(document.content.title));
    expect(text).toContain('Escola Exemplo');
    for (const section of document.content.sections) {
      expect(text).toContain(normalize(section.title));
    }
    for (const question of questionsOf(document)) {
      expect(text).toContain(normalize(question.statement));
    }
    for (const answer of answersOf(document)) {
      expect(text).not.toContain(normalize(answer));
    }
  });

  it('should render the answer key PDF with the correct letters and expected answers when the document is generated', async () => {
    const document = await generateDocument();

    const pdf = await pdfRenderer.render(renderAnswerKey(document.content, document.theme));
    await save('answer-key.pdf', pdf);
    const { text } = await readPdf(pdf);

    expect(text).toContain(`Gabarito: ${document.content.title}`);
    expect(text).toContain('a) Sim');
    expect(text).toContain('b) 3');
    expect(text).toContain('c) 6');
    expect(text).toContain('c) 180°');
    expect(text).toContain('15 cm²');
    expect(text).toContain('1024');
  }, 60_000);

  it('should show the change in the HTML, PDF and DOCX and keep the original intact when the AI returns a valid patch', async () => {
    const document = await generateDocument();
    const original = structuredClone(document);
    const hexagon = document.content.sections[1].blocks[0];
    const ops: PatchOp[] = [
      { op: 'set_title', title: 'Avaliação de Matemática (revisada)' },
      {
        op: 'replace_block',
        blockId: hexagon.id,
        block: {
          kind: 'multiple_choice',
          statement: 'Quantos lados tem um octógono?',
          points: 1.5,
          alternatives: ['4', '6', '8', '10'],
          correctIndex: 2,
          explanation: 'Octógono vem do grego "oito ângulos".',
        },
      },
    ];
    generateContent.mockResolvedValueOnce(aiAnswer({ ops }));

    const { document: revised } = await ai.revise(
      assessmentType,
      document,
      'Troque o hexágono por um octógono',
      AI_OPTIONS,
    );
    const html = renderDocumentHtml(revised.content, revised.header, revised.theme, assessmentType);
    const pdf = await pdfRenderer.render(html);
    const docx = await renderDocumentDocx(
      revised.content,
      revised.header,
      revised.theme,
      assessmentType,
    );
    await save('revised.pdf', pdf);
    await save('revised.docx', docx);
    const pdfText = (await readPdf(pdf)).text;
    const docxText = await readDocx(docx);

    expect(document).toEqual(original);
    expect(revised.content.sections[1].blocks[0].id).toBe(hexagon.id);
    for (const text of [normalize(html), pdfText, docxText]) {
      expect(text).toContain('Avaliação de Matemática (revisada)');
      expect(text).toContain('Quantos lados tem um octógono?');
      expect(text).not.toContain('hexágono');
    }
  }, 60_000);

  it('should reject the patch and leave the document untouched when an operation points to an unknown id', async () => {
    const document = await generateDocument();
    const original = structuredClone(document);

    const result = applyPatch(
      document,
      [
        { op: 'set_title', title: 'Novo título' },
        { op: 'remove_block', blockId: 'q_does_not_exist' },
      ],
      assessmentType,
    );

    expect(result).toEqual({
      success: false,
      errors: [{ opIndex: 1, message: expect.stringContaining('q_does_not_exist') }],
    });
    expect(document).toEqual(original);
  });

  it('should reject the patch and leave the document untouched when the result would leave a section empty', async () => {
    const document = await generateDocument();
    const original = structuredClone(document);
    const problems = document.content.sections[2];

    const result = applyPatch(
      document,
      problems.blocks.map((block) => ({
        op: 'remove_block' as const,
        blockId: block.id,
      })),
      assessmentType,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.every((issue) => issue.opIndex === null)).toBe(true);
    }
    expect(document).toEqual(original);
  });

  it('should throw 422 after one retry and leave the document untouched when the AI patch is invalid twice', async () => {
    const document = await generateDocument();
    const original = structuredClone(document);
    generateContent.mockClear();
    generateContent.mockResolvedValue(
      aiAnswer({ ops: [{ op: 'remove_section', sectionId: 'sec_does_not_exist' }] }),
    );

    await expect(
      ai.revise(assessmentType, document, 'Remova a seção inexistente', AI_OPTIONS),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(document).toEqual(original);
  });
});
