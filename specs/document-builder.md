# Especificação: função `buildDocument`

## Contexto

Estamos construindo a geração de documentos de um SaaS de IA para professores (API em Node.js/TypeScript, LLM Gemini). O foco atual é **provas** (`documentType: 'assessment'`).

O fluxo de geração é:

```
Controller (valida o pedido do professor com Zod pipe)
  ↓
Service:
  1. busca usuário e template (banco)
  2. chama o Gemini → JSON bruto
  3. aiAssessmentSchema.safeParse(json)      ← valida a saída da IA
  4. buildDocument(...)                      ← ESTA FUNÇÃO
  5. finalDocumentSchema.safeParse(result)   ← valida o resultado desta função
  6. salva / envia ao renderizador HTML → PDF
```

A IA gera apenas o que exige inteligência (título, seções, questões, gabarito). Tudo o que o sistema já sabe (escola, professor, layout, ids, numeração, soma de pontos) é acrescentado por `buildDocument`.

## O que a função é

Uma **função pura** que junta quatro fontes de dados em um único documento final:

- o JSON validado da IA (`AiAssessment`)
- os parâmetros do pedido do professor
- os dados do usuário logado
- o id do template escolhido

## O que a função NÃO deve fazer

- Não chamar a IA, o banco, a rede nem o sistema de arquivos. Só transforma entrada em saída.
- Não embaralhar alternativas nem questões (isso é uma etapa posterior, com seed fixa, que opera sobre o documento final).
- Não validar a si mesma com `finalDocumentSchema` (quem valida é o service, no passo 5).
- Não confiar em `totalPoints` vindo da IA: ele não existe no schema da IA e deve ser calculado.
- Não usar estado global. O contador de numeração deve ser local à chamada.
- Não lançar exceção por dado vindo da IA: a entrada já foi validada. Se algo impossível acontecer (ex.: `correctIndex` fora do intervalo), lançar um `Error` claro, pois indica bug.

## Assinatura

```ts
import type { AiAssessment } from './ai-assessment.schema';
import type { FinalDocument } from './final-document.schema';

export interface BuildDocumentInput {
  ai: AiAssessment;                 // já validado por aiAssessmentSchema
  request: {
    subject: string;                // ex.: "Biologia"
    grade: string;                  // ex.: "8º ano do Ensino Fundamental"
    durationMinutes?: number;
  };
  user: {
    teacherName: string;
    institutionName: string;
  };
  templateId: string;
}

export function buildDocument(input: BuildDocumentInput): FinalDocument;
```

Recebe **um único objeto** (não argumentos posicionais) para evitar troca de ordem.

Ajuste os caminhos de import conforme a estrutura do projeto. Os schemas `aiAssessmentSchema` e `finalDocumentSchema` já existem; os tipos são inferidos com `z.infer`.

## Tipos de entrada e saída (resumo)

### Entrada da IA (`AiAssessment`)

```
{
  title: string
  instructions?: string
  sections: [{
    title: string
    questions: Array<
      | { kind: 'multiple_choice', statement, points, alternatives: string[], correctIndex: number }
      | { kind: 'open_ended', statement, points, expectedAnswer: string }
    >
  }]
}
```

### Saída (`FinalDocument`)

```
{
  schemaVersion: '1.0'
  id: string
  documentType: 'assessment'
  templateId: string
  metadata: {
    title, subject, grade, teacherName, institutionName,
    durationMinutes?, totalPoints
  }
  instructions?: string
  sections: [{
    id: string
    title: string
    questions: Array<
      | { id, number, kind: 'multiple_choice', statement, points,
          alternatives: [{ id, text }], correctAlternativeId }
      | { id, number, kind: 'open_ended', statement, points,
          expectedAnswer, responseLines }
    >
  }]
}
```

## Mapeamento campo a campo

| Campo do documento final | Origem |
|---|---|
| `schemaVersion` | constante `'1.0'` |
| `documentType` | constante `'assessment'` |
| `id` | gerado com `crypto.randomUUID()` |
| `templateId` | `input.templateId` |
| `metadata.title` | `ai.title` |
| `metadata.subject`, `metadata.grade`, `metadata.durationMinutes` | `input.request` |
| `metadata.teacherName`, `metadata.institutionName` | `input.user` |
| `metadata.totalPoints` | **calculado**: soma de `points` de todas as questões de todas as seções |
| `instructions` | `ai.instructions` (omitir se ausente) |
| `sections[].id` | gerado |
| `sections[].title` | `ai.sections[].title` |
| `questions[].id` | gerado |
| `questions[].number` | contador contínuo (ver regra 1) |
| `questions[].kind`, `statement`, `points` | copiados da IA |
| `alternatives[].id` | gerado |
| `alternatives[].text` | string correspondente de `ai...alternatives[i]` |
| `correctAlternativeId` | convertido de `correctIndex` (ver regra 2) |
| `expectedAnswer` | copiado da IA |
| `responseLines` | constante padrão `5` (futuramente pode vir do template) |

## Regras obrigatórias

1. **Numeração contínua entre seções.** O contador começa em 1 e atravessa todas as seções (a seção B continua de onde a A parou). Declare o contador fora dos `map`s, ou numere em uma passada separada.

2. **Conversão de `correctIndex` para `correctAlternativeId`.** Primeiro crie a lista de alternativas já com ids gerados, e só depois obtenha `alternatives[correctIndex].id`. O motivo: depois do embaralhamento (etapa futura) o índice deixaria de apontar para a alternativa certa; o id continua válido em qualquer ordem. Se `correctIndex` estiver fora do intervalo, lançar `Error` descritivo.

3. **Ids únicos.** Todo id de seção, questão e alternativa deve ser único no documento inteiro. `crypto.randomUUID()` garante isso na prática. Pode-se usar prefixos legíveis por tipo (`sec_`, `q_`, `alt_`) se desejado, desde que continuem únicos.

4. **`totalPoints`** é a soma dos `points` de todas as questões. Cuidado com números decimais (a validação final usa tolerância de 0.001).

5. **Imutabilidade.** Não mutar o objeto `ai` recebido. Construir e retornar um objeto novo.

6. **Campos opcionais ausentes** (`instructions`, `durationMinutes`) não devem aparecer como `undefined` explícito no resultado se isso quebrar a serialização ou os testes; prefira omitir a chave.

7. **Preservar a ordem** de seções, questões e alternativas exatamente como vieram da IA.

## Exemplo

### Entrada

```ts
buildDocument({
  ai: {
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
            alternatives: ['Ribossomo', 'Mitocôndria', 'Lisossomo', 'Complexo golgiense'],
            correctIndex: 1,
          },
        ],
      },
      {
        title: 'Parte B: Discursivas',
        questions: [
          {
            kind: 'open_ended',
            statement: 'Explique a importância da fotossíntese para os ecossistemas.',
            points: 8,
            expectedAnswer: 'Base da cadeia alimentar, produz oxigênio e fixa carbono.',
          },
        ],
      },
    ],
  },
  request: { subject: 'Biologia', grade: '1º ano do Ensino Médio', durationMinutes: 50 },
  user: { teacherName: 'Prof. Exemplo', institutionName: 'Escola Exemplo' },
  templateId: 'default',
});
```

### Saída esperada (ids ilustrativos)

```json
{
  "schemaVersion": "1.0",
  "id": "doc_8f2c...",
  "documentType": "assessment",
  "templateId": "default",
  "metadata": {
    "title": "Avaliação de Biologia",
    "subject": "Biologia",
    "grade": "1º ano do Ensino Médio",
    "teacherName": "Prof. Exemplo",
    "institutionName": "Escola Exemplo",
    "durationMinutes": 50,
    "totalPoints": 10
  },
  "instructions": "Leia as questões com atenção.",
  "sections": [
    {
      "id": "sec_a1...",
      "title": "Parte A: Objetivas",
      "questions": [
        {
          "id": "q_b2...",
          "number": 1,
          "kind": "multiple_choice",
          "statement": "Qual organela celular produz energia?",
          "points": 2,
          "alternatives": [
            { "id": "alt_c1...", "text": "Ribossomo" },
            { "id": "alt_c2...", "text": "Mitocôndria" },
            { "id": "alt_c3...", "text": "Lisossomo" },
            { "id": "alt_c4...", "text": "Complexo golgiense" }
          ],
          "correctAlternativeId": "alt_c2..."
        }
      ]
    },
    {
      "id": "sec_d1...",
      "title": "Parte B: Discursivas",
      "questions": [
        {
          "id": "q_e1...",
          "number": 2,
          "kind": "open_ended",
          "statement": "Explique a importância da fotossíntese para os ecossistemas.",
          "points": 8,
          "expectedAnswer": "Base da cadeia alimentar, produz oxigênio e fixa carbono.",
          "responseLines": 5
        }
      ]
    }
  ]
}
```

## Testes esperados (unitários, sem mocks)

Por ser função pura, basta chamá-la com objetos de exemplo. Cobrir:

1. O resultado passa em `finalDocumentSchema.safeParse` (teste principal).
2. Numeração contínua entre seções (ex.: seção A com 2 questões e seção B com 1 → números 1, 2, 3).
3. `totalPoints` igual à soma dos pontos (incluindo caso com decimais).
4. `correctAlternativeId` aponta para a alternativa cujo `text` era `alternatives[correctIndex]` da entrada.
5. Todos os ids são únicos no documento.
6. A entrada `ai` não é mutada (comparar com cópia profunda feita antes).
7. Ordem de seções, questões e alternativas preservada.
8. Metadados vêm de `request` e `user`, e título/instruções vêm da IA.
9. `instructions` e `durationMinutes` ausentes não geram chaves `undefined`.
10. `correctIndex` fora do intervalo lança `Error` (caso defensivo).

## Organização sugerida

- `build-document.ts`: a função e `BuildDocumentInput`.
- `build-document.spec.ts`: os testes acima.
- Funções auxiliares pequenas e internas (ex.: `buildQuestion`, `buildAlternatives`) são bem-vindas, desde que o contador de numeração permaneça controlado em um único lugar.

## Fora do escopo desta tarefa

- Chamada ao Gemini e retry em caso de JSON inválido.
- Embaralhamento e geração de versões A/B.
- Renderização HTML/PDF/DOCX.
- Persistência no banco.
- Outros tipos de documento (plano de aula, rubrica) e outros tipos de questão (verdadeiro/falso, associação, lacunas).