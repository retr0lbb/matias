import { z } from 'zod/v4';
import { escapeHtml } from '../render/escape-html.js';
import { defineContentBlock } from './block.js';
import { renderBlockTitle, renderLabelledItems } from './shared.js';

const item = z.string().min(1).max(300);

/**
 * What a group has to research. The students see the question, topics,
 * guiding questions and suggested sources; `expectedFindings` is the teacher's.
 */
export const researchTaskBlock = defineContentBlock({
  kind: 'research_task',
  shape: {
    title: z.string().min(1).max(200).optional(),
    question: z.string().min(1).max(500),
    topics: z.array(item).min(1).max(10),
    guidingQuestions: z.array(item).max(10).optional(),
    suggestedSources: z.array(item).max(8).optional(),
    // e.g. "ABNT"
    citationStyle: z.string().min(1).max(100).optional(),
    // Teacher only: what a good research should find. Shown in the correction guide.
    expectedFindings: z.string().max(3000).optional(),
  },
  renderHtml: (block) =>
    [
      '<div class="block block-research">',
      renderBlockTitle(block.title),
      `<p class="research-question"><strong>Questão de pesquisa:</strong> ${escapeHtml(block.question)}</p>`,
      renderLabelledItems('Pesquise sobre:', block.topics),
      renderLabelledItems('Perguntas para orientar a pesquisa:', block.guidingQuestions, true),
      renderLabelledItems('Fontes sugeridas:', block.suggestedSources),
      block.citationStyle
        ? `<p class="research-citation"><strong>Citação das fontes:</strong> ${escapeHtml(block.citationStyle)}</p>`
        : '',
      '</div>',
    ].join(''),
  renderAnswer: (block) => {
    const findings = block.expectedFindings?.trim();
    if (!findings) {
      return '';
    }

    return [
      '<div class="block block-research">',
      `<p class="research-question"><strong>Questão de pesquisa:</strong> ${escapeHtml(block.question)}</p>`,
      `<p class="research-findings"><strong>O que se espera encontrar:</strong> ${escapeHtml(findings)}</p>`,
      '</div>',
    ].join('');
  },
  css: `
.block-research { border-left: 3px solid var(--accent); padding-left: 0.8em; }
.research-question, .research-findings { white-space: pre-wrap; margin-bottom: 0.3em; }
.research-citation { margin-top: 0.4em; }
`,
  aiGuide: `
- "research_task": what the students research. "question" is the research question; "topics" (1 to 10) is what to look into; optional "guidingQuestions" (up to 10), "suggestedSources" (up to 8) and "citationStyle" (for example "ABNT"). Suggest only sources you are certain exist (official sites, public institutions, well-known books); otherwise describe the kind of source to look for. Never invent links. "expectedFindings" is for the teacher only: what a good research should find.
`.trim(),
});
