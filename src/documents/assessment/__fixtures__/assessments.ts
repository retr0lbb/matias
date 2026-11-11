import type { AiAssessmentInput } from '../schemas/content.schema.js';

/** Raw AI-shaped payloads (before validation) shared by the assessment specs. */

export const shortAssessment: AiAssessmentInput = {
  title: 'Avaliação de Biologia',
  instructions: 'Leia as questões com atenção.',
  sections: [
    {
      title: 'Parte A: Objetivas',
      questions: [
        {
          kind: 'multiple_choice',
          statement: 'Qual organela celular produz energia?',
          points: 2,
          alternatives: [
            'Ribossomo',
            'Mitocôndria',
            'Lisossomo',
            'Complexo golgiense',
          ],
          correctIndex: 1,
        },
      ],
    },
    {
      title: 'Parte B: Discursivas',
      questions: [
        {
          kind: 'open_ended',
          statement:
            'Explique a importância da fotossíntese para os ecossistemas.',
          points: 8,
          expectedAnswer:
            'Base da cadeia alimentar, produz oxigênio e fixa carbono.',
          lines: 8,
        },
      ],
    },
  ],
};

export const multiSectionAssessment: AiAssessmentInput = {
  title: 'Avaliação de Matemática',
  sections: [
    {
      title: 'Aritmética',
      questions: [
        {
          kind: 'multiple_choice',
          statement: 'O número 7 é primo?',
          points: 0.5,
          alternatives: ['Sim', 'Não'],
          correctIndex: 0,
        },
        {
          kind: 'multiple_choice',
          statement: 'Quanto é 12 dividido por 4?',
          points: 1,
          alternatives: ['2', '3', '4'],
          correctIndex: 1,
        },
      ],
    },
    {
      title: 'Geometria',
      questions: [
        {
          kind: 'multiple_choice',
          statement: 'Quantos lados tem um hexágono?',
          points: 1.5,
          alternatives: ['4', '5', '6', '8'],
          correctIndex: 2,
        },
        {
          kind: 'multiple_choice',
          statement: 'Qual é a soma dos ângulos internos de um triângulo?',
          points: 2,
          alternatives: ['90°', '120°', '180°', '270°', '360°'],
          correctIndex: 2,
        },
      ],
    },
    {
      title: 'Problemas',
      questions: [
        {
          kind: 'open_ended',
          statement: 'Calcule a área de um retângulo de lados 3 cm e 5 cm.',
          points: 2.5,
          expectedAnswer: '15 cm²',
          lines: 3,
        },
        {
          kind: 'open_ended',
          statement: 'Escreva apenas o resultado de 2 elevado a 10.',
          points: 2.5,
          expectedAnswer: '1024',
          lines: 0,
        },
      ],
    },
  ],
};

export const hostileTextAssessment: AiAssessmentInput = {
  title: '<script>alert("título")</script> & Cia',
  instructions: 'Use "aspas" & \'apóstrofos\' <b>sem</b> medo.',
  sections: [
    {
      title: 'Seção <img src=x onerror=alert(1)>',
      questions: [
        {
          kind: 'multiple_choice',
          statement: 'Qual tag executa código? </style><script>alert(1)</script>',
          points: 1,
          alternatives: ['<script>', '"quoted" & \'single\'', 'a < b && b > c'],
          correctIndex: 0,
        },
        {
          kind: 'open_ended',
          statement: 'Explique o que faz <iframe src="javascript:alert(1)">.',
          points: 1,
          expectedAnswer: '</div><script>alert("gabarito")</script>',
          lines: 2,
        },
      ],
    },
  ],
};

export const openEndedWithoutLinesAssessment: AiAssessmentInput = {
  title: 'Redação',
  sections: [
    {
      title: 'Produção de texto',
      questions: [
        {
          kind: 'open_ended',
          statement: 'Descreva o seu bairro em poucas palavras.',
          points: 10,
          expectedAnswer: 'Resposta pessoal.',
        },
      ],
    },
  ],
};

export const allAssessmentFixtures = {
  shortAssessment,
  multiSectionAssessment,
  hostileTextAssessment,
  openEndedWithoutLinesAssessment,
};
