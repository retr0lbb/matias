# Plano: geração de documentos por template (módulo de avaliações)

## Contexto

O professor pede uma avaliação, a IA devolve JSON validado por Zod, o servidor deriva HTML (preview), PDF e DOCX desse JSON, e ajustes posteriores chegam como patches de JSON. O JSON é a única fonte da verdade. Hoje o repositório tem só o schema inicial e uma rota de debug; todo o resto é novo. Nada será implementado antes da sua aprovação.

---

## 1. O que encontrei no repositório

**Stack e convenções**

- NestJS 12, ESM (`"type": "module"`, `nodenext`, imports com sufixo `.js`), TypeScript 6 strict, Zod 4.6 importado como `zod/v4`, Drizzle + Postgres (pgvector), pnpm.
- Um módulo por pasta em `src/` (`ai`, `rag`, `auth`, `usage`, `documents`), com controller → service → Drizzle injetado por `@InjectDrizzle()`. Tabelas em `src/db/schemas/*.ts`, migrations geradas em `drizzle/`.
- Auth por `@Authenticate({ verifiedEmail: true })` + `@CurrentUser()`; checagem de dono feita no service (ex.: `src/ai/ai.service.ts`).
- Validação de entrada com `ZodValidationPipe` (`src/shared/pipes/zodValidationPipe.ts`).
- Testes: Vitest com globals, specs ao lado do código, regras em `AGENTS.md` e `specs/TEST.md`. Lint com `oxlint --type-aware`.

**Módulo `documents` hoje**

- `src/documents/schemas/test-schemas.ts`: idêntico ao schema que você colou (inclusive o `z.ZodIssueCode.custom`).
- `src/documents/documents.controller.ts`: uma rota `GET /documents` pública (`@Public()`), de debug, que valida um JSON fixo e faz `console.log`. Será substituída.
- Não há renderer, tabela, service nem testes.

**IA hoje**

- A IA **não gera avaliações ainda**. Existem só o chat em texto (`AiProvider.generate/generateStream`, `maxOutputTokens: 2048`, sem modo JSON) e o `JudgeModel`, que é o único uso de saída estruturada (`responseMimeType: 'application/json'` + `responseJsonSchema` escrito à mão + `schema.parse`).
- Os três tiers (`CHEAP/NORMAL/EXPENSIVE`) saem de `AiExpensesFactory`; a cota (`UsageService.assertCanChat`) conta mensagens por tier na tabela `messages`.

**Infra**

- Um único processo Nest. Sem fila, sem Redis, sem storage de objetos (o RAG grava em disco local). `docker-compose` só sobe o Postgres. Deploy via `nest deploy` / `@nestjs/mau`.
- `pdf-parse` e `mammoth` já são dependências (extratores do RAG) e servem para conferir PDF e DOCX nos testes sem instalar nada.

**Contradições com o seu briefing** (detalhes e recomendação na seção 5)

1. `specs/document-builder.md` descreve um modelo diferente: numeração **contínua** e gravada no documento, alternativas com `id` + `correctAlternativeId`, `responseLines` fixo em 5, `templateId`, `metadata.totalPoints` gravado. Também afirma que `finalDocumentSchema` já existe, e ele não existe.
2. Não existe cadastro de instituição: a tabela `users` só tem nome, e-mail e plano. Escola e logo não têm de onde vir.
3. Não há front-end neste repositório; só consigo definir o contrato do preview.
4. `AGENTS.md`/`TEST.md` proíbem e2e, acesso a filesystem e novas libs de teste sem pedir, e snapshots "salvo se pedido". Você pediu snapshot (ok), mas o teste de fluxo com Chromium real é um e2e.
5. Minha memória de 06/11 diz que `npm test` estava quebrado pelos specs de `auth` e que você pediu para não rodá-lo. Confirmo o estado atual antes de começar.

---

## 2. Estrutura proposta

```
src/documents/
  documents.module.ts                 (editar: registrar providers/controller)
  documents.controller.ts             (remover a rota de debug)
  assessment/
    schemas/
      content.schema.ts               aiAssessmentSchema (o que a IA gera) + assessmentContentSchema (com ids)
      header.schema.ts                cabeçalho: escola, logo, campos visíveis
      theme.schema.ts                 tokens visuais com defaults
      document.schema.ts              envelope { schemaVersion, content, header, theme }
      patch.schema.ts                 operações de patch
    build/assign-ids.ts               AiAssessment → content com ids (função pura)
    render/
      escape-html.ts                  único ponto de escape
      layout.ts                       numeração, letras, total e formatação de pontos (usado por HTML, DOCX e gabarito)
      styles.ts                       tema → CSS custom properties + CSS de impressão
      render-html.ts                  renderAssessmentHtml, renderHeader, renderSection, renderMultipleChoice, renderOpenEnded
      render-answer-key.ts            renderAnswerKey
      render-docx.ts                  JSON → Buffer .docx
    patch/apply-patch.ts              aplica operações e revalida (função pura)
    pdf/pdf-renderer.service.ts       Chromium reaproveitado, limite de concorrência, timeout
    ai/assessment-ai.service.ts       prompts de geração e de patch, chamada estruturada
    assessments.service.ts            orquestra banco, IA, patch, export
    assessments.controller.ts         rotas /documents/assessments
    __fixtures__/*.ts                 fixtures de teste
src/db/schemas/assessment.ts          tabela assessments
drizzle/<nova migration>
```

`test-schemas.ts` é movido para `content.schema.ts`. Tudo fica sob `assessment/`, sem abstração de "tipo de documento": `escape-html.ts`, `styles.ts` e o serviço de PDF não conhecem avaliação, então extrair depois é mover arquivos.

---

## 3. Fases

### Fase 0: schemas

**Objetivo:** três camadas validadas e ids estáveis.

- `content.schema.ts`
  - `code: "custom"` no lugar de `z.ZodIssueCode.custom`; a regra do `correctIndex` continua igual.
  - `lines: z.number().int().min(0).max(30).default(5)` em `open_ended`. O default fica no schema, então o documento salvo sempre tem o valor e os renderers não repetem a regra.
  - Dois schemas a partir das mesmas shapes: `aiAssessmentSchema` (sem ids) e `assessmentContentSchema` (seção e questão com `id`). As shapes base ficam sem refinamento e o `superRefine` é aplicado por último, porque no Zod 4 estender um objeto já refinado dá erro.
- `assign-ids.ts`: `assignIds(ai, newId = randomUUID)` devolve `content` novo, sem mutar a entrada. O gerador de id é injetável para os testes terem ids previsíveis.
- `header.schema.ts`: `institutionName?`, `logo?` (só `data:image/png|jpeg;base64,...`, com limite de tamanho), `teacherName?`, `subject?`, `className?`, e `fields: { studentName, date, className, score }` booleanos com default `true`.
- `theme.schema.ts`, tudo com default, de modo que `themeSchema.parse({})` é o tema padrão:
  `fontFamily` (enum de chaves mapeadas para font stacks), `baseFontSizePt` (9 a 16), `accentColor` (regex `#rrggbb`), `marginsMm` (cada lado 5 a 40), `paperSize` (`A4 | Letter`), `pageBreakPerSection` (boolean), `numbering` (`per_section | continuous`, default `per_section`).
- `document.schema.ts`: `{ schemaVersion: 1, content, header, theme }`.
- Fixtures: prova curta; várias seções com 2, 3, 4 e 5 alternativas; texto com `<script>`, aspas e `&`; dissertativa sem `lines`.

**Pronto quando:** as fixtures validam, entradas inválidas (correctIndex fora, `lines` 31, cor inválida, fonte fora da lista) são rejeitadas, e `assignIds` gera ids únicos sem mutar a entrada.
**Testes:** `content.schema.spec.ts`, `theme.schema.spec.ts`, `header.schema.spec.ts`, `assign-ids.spec.ts`.

### Fase 1: renderer HTML e gabarito

**Objetivo:** `renderAssessmentHtml(content, header, theme)` e `renderAnswerKey(content, numbering)` determinísticos.

- Funções que retornam string, sem engine de template. Concordo com a sua escolha: o único engine do repo é o de e-mail (`@nestjs/mail`), e funções tipadas quebram na compilação quando o schema muda.
- `escapeHtml` em todo valor vindo do JSON. Valores do tema não passam por escape, e sim pela validação do schema (enum, regex, faixa numérica), e o renderer só aceita o tipo já validado.
- `layout.ts` concentra numeração (por seção ou contínua), letra da alternativa, total de pontos e formatação pt-BR ("0,5 ponto"). Nada disso é gravado no JSON, então não fica desatualizado depois de um patch.
- Dissertativa: `lines` divs com borda inferior.
- Gabarito: mesma numeração da prova, letra correta nas objetivas e `expectedAnswer` nas dissertativas. Proponho o segundo parâmetro `numbering` (difere da assinatura `renderAnswerKey(content)` que você pediu) porque, sem ele, o gabarito não sabe se a prova foi numerada por seção ou de forma contínua.

**Pronto quando:** o HTML das fixtures bate com o snapshot, a fixture maliciosa não produz nenhuma tag além das do renderer, e o HTML da prova não contém `expectedAnswer` nem marca a alternativa correta.
**Testes:** `escape-html.spec.ts`, `layout.spec.ts`, `render-html.spec.ts`, `render-answer-key.spec.ts`. Snapshots com `toMatchFileSnapshot('*.html')`, que geram arquivos abríveis no navegador.

### Fase 2: CSS de impressão e PDF

**Objetivo:** validar o layout paginado cedo.

- `styles.ts`: `:root { --font, --base-size, --accent, ... }`, `@page { size; margin }` vindos do tema, `break-inside: avoid` nas questões, `break-after: avoid` nos títulos de seção, `break-before: page` quando `pageBreakPerSection`. Um único bloco `<style>` serve ao preview e ao PDF; um trecho `@media screen` só desenha a "folha" (largura do papel e sombra).
- `PdfRendererService`:
  - Um Chromium por processo, aberto no primeiro uso e reaberto se cair (`disconnected`); fechado em `onModuleDestroy`.
  - Um contexto novo por PDF, fechado em `finally`, com JavaScript desligado e todas as requisições de rede bloqueadas (a logo entra como data URI). Isso evita SSRF e execução de script mesmo se o escape falhasse.
  - Semáforo em memória (2 PDFs simultâneos), fila curta com limite, timeout de 15 s por PDF. Fila cheia ou timeout respondem 503.
  - Sem fila externa: a infra não tem Redis nem worker, e um PDF de poucas páginas com o navegador já aberto leva algumas centenas de ms. Subir o navegador por requisição custaria 1 a 2 s e uns 300 MB de pico a cada chamada.
  - `preferCSSPageSize: true` e `printBackground: true`, para o `@page` do tema mandar.

**Pronto quando:** as fixtures viram PDF com o texto esperado e a contagem de páginas esperada, e a checagem visual da seção "Testes" passa.
**Testes:** `styles.spec.ts` (unitário); `pdf-renderer.service.spec.ts` com o Playwright mockado (reuso, fechamento em erro, timeout, limite de fila); PDF real só no teste de fluxo (Fase 6).

### Fase 3: persistência, geração e preview

**Objetivo:** avaliação identificável por id, gerada pela IA e visível no preview.

- Tabela `assessments`: `id`, `userId` (FK com cascade), `conversationId` (opcional), `document` (jsonb), `version` (int, para concorrência otimista), `createdAt`, `updatedAt`. Migration via drizzle-kit.
- `assessment-ai.service.ts`: chamada estruturada no padrão do `JudgeModel`, com `responseJsonSchema` gerado por `z.toJSONSchema(aiAssessmentSchema)` em vez de escrito à mão, seguida de `safeParse`. Em falha de validação, uma nova tentativa enviando os erros; depois disso, erro 502.
- Rotas (todas autenticadas, com checagem de dono):
  - `POST /documents/assessments` `{ prompt }` → gera, valida, atribui ids, salva.
  - `GET /documents/assessments/:id` → JSON.
  - `GET /documents/assessments/:id/preview` → `text/html` com `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:`.
  - `GET /documents/assessments/:id/pdf` e `/answer-key`.
- Front (fora deste repo): buscar o HTML com a sessão e exibir em `<iframe sandbox="" srcdoc={html}>`. `srcdoc` evita depender de cookie no `src` do iframe; `sandbox` vazio bloqueia script, formulário e navegação.

**Pronto quando:** dá para gerar, reabrir o preview e baixar o PDF de uma avaliação pelo `_test.http`, e outro usuário recebe 403/404.
**Testes:** `assessments.service.spec.ts` e `assessment-ai.service.spec.ts` com colaboradores mockados (JSON inválido da IA, retry, dono errado, não encontrado).

### Fase 4: patch

**Objetivo:** ajustes baratos, atômicos e revalidados.

Formato: lista de operações em união discriminada por `op`, sempre referenciando `id`.

| op                     | campos                                                                    |
| ---------------------- | ------------------------------------------------------------------------- |
| `set_title`            | `title`                                                                   |
| `set_instructions`     | `instructions` (string ou `null`)                                         |
| `update_section`       | `sectionId`, `title`                                                      |
| `insert_section`       | `afterSectionId` (ou `null` = início), `section` (formato da IA, sem ids) |
| `remove_section`       | `sectionId`                                                               |
| `replace_question`     | `questionId`, `question` (inteira; mantém o id)                           |
| `insert_question`      | `sectionId`, `afterQuestionId` (ou `null`), `question`                    |
| `remove_question`      | `questionId`                                                              |
| `move_question`        | `questionId`, `toSectionId`, `afterQuestionId`                            |
| `update_theme`         | `theme` (parcial)                                                         |
| `update_header_fields` | `fields` (parcial)                                                        |

- `applyPatch(document, ops)` é pura: clona, aplica em ordem, falha se um id não existe (apontando o índice da operação), dá ids novos ao que for inserido e, no fim, roda `assessmentDocumentSchema.safeParse` no documento inteiro. Isso pega casos como remover a última questão de uma seção. Qualquer falha devolve erros e o original intacto.
- Validação em duas etapas: `patchSchema` valida a forma de cada operação (a questão dentro de `replace_question` usa o mesmo schema da geração); o schema do documento valida o resultado.
- Os três níveis usam o mesmo motor:
  1. Manual: `PATCH /documents/assessments/:id` `{ version, ops }`, sem IA.
  2. IA: `POST /documents/assessments/:id/revise` `{ version, instruction }`. A IA recebe o JSON atual e devolve `ops`. Patch inválido volta uma vez para a IA com os erros; se falhar de novo, 422 e nada muda.
  3. Regeneração: `POST /documents/assessments/:id/regenerate`, que refaz o `content` e preserva `header` e `theme`.
- Gravação com `where version = :version`; versão desatualizada responde 409.
- A IA não altera escola, logo nem professor: não existe operação para isso.

**Pronto quando:** cada operação tem teste de sucesso e de falha, e um patch inválido deixa o documento e a linha do banco idênticos.
**Testes:** `patch.schema.spec.ts`, `apply-patch.spec.ts` (inclui comparação profunda do original antes e depois), casos de retry e 409 no spec do service.

### Fase 5: DOCX

**Objetivo:** `renderAssessmentDocx(content, header, theme): Promise<Buffer>` com a lib `docx`, mais `GET /documents/assessments/:id/docx`.

- Reusa `layout.ts`, então numeração, letras e total são os mesmos do PDF. A numeração vai como texto, não como lista automática do Word, para não divergir.
- Limites de paridade com o PDF:
  - Quebras de página: `keepLines`/`keepNext` aproximam `break-inside`/`break-after`, mas o Word repagina por conta própria; o número de páginas pode diferir.
  - Fontes dependem do que está instalado na máquina de quem abre.
  - Linhas de resposta viram parágrafos com borda inferior; o espaçamento não fica idêntico.
  - Só os tokens do tema têm equivalente; não há CSS.

**Pronto quando:** o arquivo abre no Word e no LibreOffice e o texto extraído contém todas as questões.
**Testes:** `render-docx.spec.ts`, que lê o buffer com `mammoth` (já instalado) e confere o número de enunciados e a ausência do gabarito.

### Fase 6: teste de fluxo ponta a ponta

`src/documents/assessment/assessment-flow.e2e-spec.ts`, rodado por `npm run test:e2e` (a config já existe e ainda não tem nenhum arquivo). IA mockada devolvendo a fixture → Zod → `assignIds` → HTML → PDF real (páginas e texto conferidos com `pdf-parse`) → DOCX (abre com `mammoth`, mesmo número de questões) → gabarito → patch válido → patch inválido rejeitado. Sem banco e sem HTTP.

**Só dá para validar olhando:** onde a página quebra, título de seção órfão no fim da página, margens reais, A4 contra Letter, aparência das linhas de resposta, logo, e a semelhança entre preview e PDF. O teste e2e grava os PDFs das fixtures em `.tmp/` (já ignorado pelo git), incluindo uma fixture longa feita para forçar quebras. Checklist manual a cada mudança de CSS: nenhuma questão cortada, nenhum título sozinho no rodapé, flag de quebra por seção funcionando, e o DOCX aberto no Word.

**Verificação em toda fase:** `npx vitest run <spec>`, `npm run lint`, `npx tsc --noEmit`, e `npm test` se os specs de `auth` já estiverem corrigidos.

---

## 4. Decisões e trade-offs

- **Numeração e total calculados na renderização, não gravados.** Gravar (como no spec antigo) exigiria recalcular a cada patch e abriria espaço para divergência. O custo é que HTML, DOCX e gabarito precisam usar o mesmo helper, e por isso existe `layout.ts`.
- **`correctIndex` mantido, sem ids de alternativa.** O spec antigo usa `correctAlternativeId` pensando em embaralhamento, que está fora do escopo. O patch troca a questão inteira, então o índice nunca fica solto. Quando o embaralhamento entrar, a migração é local ao schema de conteúdo.
- **Patch próprio em vez de JSON Patch (RFC 6902).** JSON Patch endereça por índice de array, justamente o que os ids evitam, e permite escrever em qualquer caminho. Operações nomeadas limitam o que a IA pode tocar e dão erros legíveis para devolver a ela.
- **Trocar a questão inteira em vez de campo a campo.** Uma questão tem poucas dezenas de tokens; em troca, some uma família de operações e de estados parciais inválidos.
- **Playwright em vez de Puppeteer.** São equivalentes para este uso. Prefiro o Playwright porque a instalação do navegador é um passo explícito (`playwright install chromium`), há imagem Docker oficial e o contexto isolado por requisição é a API padrão. O Puppeteer baixa o Chrome no `postinstall`, que o `pnpm-workspace.yaml` deste repo hoje não libera.
- **Preview em HTML, não em PDF.** É instantâneo e não gasta Chromium a cada ajuste. O custo: o iframe mostra tipografia e espaçamento iguais, mas em fluxo contínuo, sem as quebras de página reais. Quem quiser ver as quebras baixa o PDF.
- **PDF e DOCX gerados sob demanda, sem armazenar.** Não há storage de objetos e o JSON já é a fonte; armazenar criaria cópias que envelhecem.
- **Geração por rota dedicada, não dentro do chat.** O chat hoje é texto em streaming e o roteamento por `tools` do judge ainda não executa nada. Ligar a geração ao chat fica como passo seguinte.

---

## 5. Riscos e perguntas em aberto

1. **`specs/document-builder.md` conflita com este plano** (numeração contínua gravada, `correctAlternativeId`, `responseLines`, `templateId`, `metadata`). Recomendo que o briefing atual prevaleça e que eu atualize o spec ao final da Fase 0. Confirma?
   R: ultilize o novo plano sempre que possivel, a numeração continua de multipla escolha esta la pois a maioria dos professores quando faz uma prova inteira de multipla escolha sempre escolhem o mesmo tamanho.

2. **Cadastro de instituição não existe.** Recomendo que as Fases 0 a 5 tratem `institutionName` e `logo` como opcionais no `header`, preenchidos manualmente, e que a tabela de instituição seja uma tarefa separada. Ou você prefere incluir a tabela agora?
   R: Esses dados posteriormente serão atrelados ao usuario, como os professores podem estar em 1 ou mais escolas, vamos deixar sem por enquanto.

3. **O Chromium roda no seu ambiente de deploy?** Ele precisa de cerca de 300 a 500 MB de RAM e de bibliotecas do sistema. Se o deploy (`mau`) não permitir, o PDF teria de ir para um serviço à parte. Preciso saber onde a API roda.
   R: Não Rodaremos no deploy mau, o deploy do app sera em uma VPS de minimo de 4 gb de memoria ram, ou seja esperamos memoria de sobra, entretanto veja se é melhor criar um servico a parte para isso.

4. **Fontes no servidor.** O PDF usa as fontes instaladas na máquina do Chromium. Para o resultado ser igual em todo lugar, o ideal é embutir 2 ou 3 fontes livres no repo. Quais fontes você quer na lista permitida?
   R: Vamos permitir as fontes basicas, arial e times new roman.

5. **Cota.** Geração e patch por IA contam em `advancedMessagesPerCycle`, ganham cota própria, ou ficam sem limite por enquanto?
   R: Ganham cota sim, vamos ainda fazer o calculo de preco ideial mas por enquanto limite a 30 docs por mes e ate 7 modificações por doc, se passar de 7 conta como -1 documento para gerar

6. **Teste de fluxo com Chromium real** contraria a regra "sem e2e" do `TEST.md`. Proponho mantê-lo isolado em `*.e2e-spec.ts`, fora do `npm test`. Autoriza essa exceção?
   R: Sim abra apenas esse endpoint como exeção
7. **`npm test` continua quebrado pelos specs de `auth`?** Se sim, sigo verificando com specs individuais, lint e `tsc`.
   R: Deixe a parte dos testes comigo, a principio nao teste nada alem do chromium

8. **`z.toJSONSchema` e o Gemini.** A união discriminada vira `anyOf`; se o Gemini recusar, escrevo o JSON Schema à mão como no `JudgeModel`. O `safeParse` continua sendo a validação real nos dois casos.
   R:Sim, mas prioriza automatizar a importação do schema para o gemini.

9. **Histórico e desfazer.** O plano guarda só a versão atual. Guardar versões anteriores permitiria "desfazer" sem IA; quer isso já?
   R: por enquanto não.

10. **Front-end.** Onde ele fica, e a sessão viaja por cookie ou por header? Isso só afeta a orientação do `iframe`.
    R: o login use cookies com o Id da sessão do servidor, ele fica em um repositorio separado e usa o nextjs, se eu nao me engano esta apenas por cookies

---

## 6. Dependências novas

| Pacote       | Tipo     | Motivo                                                                                 |
| ------------ | -------- | -------------------------------------------------------------------------------------- |
| `playwright` | produção | HTML → PDF com Chromium. Exige `npx playwright install chromium` no build e no deploy. |
| `docx`       | produção | JSON → DOCX direto, sem passar por HTML.                                               |

Nenhuma lib de teste nova: `pdf-parse` e `mammoth` já estão instalados. Nenhuma lib de patch nem de template.

---

Posso começar pela Fase 0?
