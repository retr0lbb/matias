import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFParse } from 'pdf-parse';
import {
  allAssessmentFixtures,
  shortAssessment,
} from '../__fixtures__/assessments.js';
import { assignIds } from '../build/assign-ids.js';
import {
  aiAssessmentSchema,
  type AiAssessmentInput,
} from '../schemas/content.schema.js';
import { headerSchema } from '../schemas/header.schema.js';
import {
  themeSchema,
  type AssessmentThemeInput,
} from '../schemas/theme.schema.js';
import { renderAnswerKey } from '../render/render-answer-key.js';
import { renderAssessmentHtml } from '../render/render-html.js';
import { PdfRendererService } from './pdf-renderer.service.js';

// Real Chromium, no mocks. Every PDF (and its HTML) is also written to
// .tmp/assessment-pdf so page breaks and layout can be checked by eye.
const OUTPUT_DIR = join(process.cwd(), '.tmp', 'assessment-pdf');

const header = headerSchema.parse({
  institutionName: 'Escola Exemplo',
  teacherName: 'Prof. Exemplo',
  subject: 'Ciências',
});

const longAssessment: AiAssessmentInput = {
  title: 'Avaliação longa',
  instructions: 'Responda todas as questões.',
  sections: ['Parte A', 'Parte B', 'Parte C'].map((title) => ({
    title,
    questions: Array.from({ length: 10 }, (_unused, index) =>
      index % 2 === 0
        ? {
            kind: 'multiple_choice' as const,
            statement: `${title}, objetiva ${index + 1}: qual alternativa está correta?`,
            points: 1,
            alternatives: ['Primeira', 'Segunda', 'Terceira', 'Quarta'],
            correctIndex: 2,
          }
        : {
            kind: 'open_ended' as const,
            statement: `${title}, discursiva ${index + 1}: justifique a sua resposta.`,
            points: 2,
            expectedAnswer: `Resposta esperada ${index + 1}`,
            lines: 6,
          },
    ),
  })),
};

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

describe('PdfRendererService (real Chromium)', () => {
  let service: PdfRendererService;

  const build = (fixture: AiAssessmentInput, theme: AssessmentThemeInput = {}) => {
    const content = assignIds(aiAssessmentSchema.parse(fixture));
    const parsedTheme = themeSchema.parse(theme);

    return {
      content,
      theme: parsedTheme,
      html: renderAssessmentHtml(content, header, parsedTheme),
    };
  };

  const renderAndSave = async (name: string, html: string) => {
    const pdf = await service.render(html);
    await writeFile(join(OUTPUT_DIR, `${name}.html`), html);
    await writeFile(join(OUTPUT_DIR, `${name}.pdf`), pdf);
    return readPdf(pdf);
  };

  beforeAll(async () => {
    await mkdir(OUTPUT_DIR, { recursive: true });
    service = new PdfRendererService();
  });

  afterAll(async () => {
    await service.onModuleDestroy();
  });

  it.each(Object.entries(allAssessmentFixtures))(
    'should render the %s fixture with every statement and no answers',
    async (name, fixture) => {
      const { content, html } = build(fixture);

      const { text, pages } = await renderAndSave(name, html);

      expect(pages).toBe(1);
      expect(text).toContain(normalize(content.title));
      for (const question of content.sections.flatMap((s) => s.questions)) {
        expect(text).toContain(normalize(question.statement));
        if (question.kind === 'open_ended' && question.expectedAnswer) {
          expect(text).not.toContain(normalize(question.expectedAnswer));
        }
      }
    },
    60_000,
  );

  it('should paginate when the assessment does not fit on one page', async () => {
    const { content, html } = build(longAssessment);

    const { text, pages } = await renderAndSave('long', html);

    expect(pages).toBeGreaterThan(1);
    for (const question of content.sections.flatMap((s) => s.questions)) {
      expect(text).toContain(normalize(question.statement));
    }
  }, 60_000);

  it('should start each section on a new page when pageBreakPerSection is on', async () => {
    const { html } = build(shortAssessment, { pageBreakPerSection: true });

    const { pages } = await renderAndSave('page-break-per-section', html);

    expect(pages).toBe(2);
  }, 60_000);

  it('should render with the other theme tokens when they are changed', async () => {
    const { html } = build(longAssessment, {
      fontFamily: 'times_new_roman',
      baseFontSizePt: 14,
      accentColor: '#b91c1c',
      marginsMm: { top: 30, right: 30, bottom: 30, left: 30 },
      paperSize: 'Letter',
      numbering: 'continuous',
    });

    const { text, pages } = await renderAndSave('long-letter-continuous', html);

    expect(pages).toBeGreaterThan(1);
    expect(text).toContain('30.');
  }, 60_000);

  it('should render the answer key with the expected answers', async () => {
    const { content, theme } = build(shortAssessment);

    const { text } = await renderAndSave(
      'answer-key',
      renderAnswerKey(content, theme),
    );

    expect(text).toContain('Gabarito: Avaliação de Biologia');
    expect(text).toContain('b) Mitocôndria');
    expect(text).toContain(
      'Base da cadeia alimentar, produz oxigênio e fixa carbono.',
    );
  }, 60_000);

  it('should render every PDF when more requests arrive than concurrent slots', async () => {
    const { html } = build(shortAssessment);

    const pdfs = await Promise.all(
      Array.from({ length: 6 }, () => service.render(html)),
    );

    expect(pdfs).toHaveLength(6);
    for (const pdf of pdfs) {
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }
  }, 60_000);
});
