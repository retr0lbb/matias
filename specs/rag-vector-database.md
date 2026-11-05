# Especificação: RAG com PGVector (upload de PDF/DOCX → top 5 chunks)

## Contexto

API NestJS v12 + TypeScript, PostgreSQL com `pgvector` (imagem `pgvector/pgvector:pg16` já no `docker-compose.yaml`), Drizzle ORM e SDK `@google/genai`.

Objetivo: endpoints onde o usuário autenticado (e-mail confirmado) envia documentos (PDF e DOCX), o sistema extrai o texto, divide em chunks, gera embeddings com Gemini e armazena no PGVector. Uma consulta recebe um texto e devolve os **5 chunks mais similares** (top 5 fixo).

**Fronteira de módulos:** todo o parsing/processamento de documentos desta feature vive em `src/rag/`. O `DocumentsModule` continua dono da geração de documentos a partir de JSON (o handler `memeMax` permanece **intocado**). O RAG não mexe em `src/documents/`.

Este documento é o plano de implementação. O núcleo foi implementado (ver "Status da implementação"); as melhorias pendentes estão em "Fase 2 — melhorias de velocidade".

## Status da implementação (verificado em 2026-11-05)

| Item | Status | Observação |
|---|---|---|
| Schemas `rag_documents` / `rag_chunks` + `conversationId` | ✅ | `src/db/schemas/rag-*.ts` |
| Migration com `CREATE EXTENSION vector` e índice HNSW | ✅ | `drizzle/20261105142834_steep_skin`, `20261105154318_slow_sharon_carter` |
| Chunker local (~4 chars/token, 512/128) | ✅ | `src/rag/chunker.ts` |
| Embedding (768 dims, lote 10, pacing, retry 429) | ✅ | `src/rag/embedding.service.ts` |
| Extratores PDF (`pdf-parse` v2) e DOCX (`mammoth`) | ✅ | `src/rag/extractors/` |
| Upload único / batch / status, validação + magic bytes | ✅ | `src/rag/rag-documents.*` |
| Busca top 5 com `INNER JOIN` + `userId` + `READY` | ✅ | `src/rag/rag.service.ts` |
| Auth `verifiedEmail` em todas as rotas RAG | ✅ | nível de classe nos dois controllers |
| Integração com `POST /ai/chat` (contexto + histórico 20) | ✅ | `src/ai/ai.service.ts`; busca é best-effort |
| `DocumentsModule` intocado | ✅ | |
| `tsc` / `lint` nos arquivos do RAG | ✅ | sem erros/avisos em `src/rag/` e `src/ai/ai.service.ts` |
| **Testes unitários do RAG** | ❌ | `chunker.spec.ts`, `rag.service.spec.ts`, `rag-documents.service.spec.ts` **não existem** |

Desvios do plano (aceitáveis, documentados aqui):
- Upload usa `multer({ dest })` em vez de `diskStorage` com `randomUUID()+ext`. O multer já gera um nome aleatório (hex, sem extensão), então não há path traversal; a extensão é lida de `filename`. Manter.
- Magic bytes do PDF checa `%PDF` (4 bytes), não `%PDF-` (5). Suficiente.
- `RagDocumentsService` encadeia o processamento numa promise global (não só "sem await").

Fora do RAG, mas bloqueia o "done" da suíte completa: `src/auth/auth.controller.spec.ts` e `src/auth/auth.service.spec.ts` falham (9 testes) e têm erros de `tsc` (`googleSubject` / `undefined` no `User`). Não foram tocados; decidir separadamente.

Problemas encontrados na revisão:
1. **Query embedada com `taskType: "RETRIEVAL_DOCUMENT"`.** `search()` reusa `embed()`, então a pergunta usa o mesmo task type dos chunks. O correto para a query é `RETRIEVAL_QUERY` (mesmo modelo e dimensão — regra 8 continua valendo). Custo zero, melhora a busca.
2. **A busca no chat pode travar por até minutos.** `search()` passa pelo `embedBatchWithRetry`: em 429 durante uma ingestão, o `POST /ai/chat` espera o `retryDelay` (~57s) até 5 vezes antes do fallback "sem contexto". O best-effort existe, mas só depois da espera.
3. **HNSW + filtro pode devolver menos de 5 (ou 0) resultados.** O HNSW pega os ~40 vizinhos globais (`hnsw.ef_search` padrão) e só depois aplica `userId`/`conversationId`. Quando a tabela tiver muitos chunks de outros usuários, uma conversa com poucos documentos tende a voltar vazia. Não acontece hoje (volume baixo), acontece quando crescer.
4. **Documento pode ficar `PROCESSING` para sempre** se o processo reiniciar no meio (a regra 5 só vale dentro do processo). O arquivo em `matias-rag/` também fica órfão.

## Decisões já tomadas (Q&A)

| Tema | Decisão |
|---|---|
| Stack | NestJS + Drizzle + PostgreSQL/pgvector (já existente) |
| Módulo | Tudo em `src/rag/`; `DocumentsModule` intocado |
| Rotas | `POST /rag/documents`, `POST /rag/documents/batch`, `GET /rag/documents/:id`, `GET /rag/search` |
| Autenticação | `@Authenticate({ verifiedEmail: true })` + `@CurrentUser()` em **todas** as rotas |
| Vector store | PGVector, coluna `vector` via Drizzle |
| Modelo de embedding | `gemini-embedding-001`, **768 dimensões** |
| Chunking | **Token-based** com `@google/genai` (`countTokens`) |
| Chunk size / overlap | **512 tokens / 64 de overlap** (era 128; ver Fase 2.2) |
| Armazenamento dos chunks | Tabela separada `rag_chunks` ligada a `rag_documents` |
| Resultado da busca | **Top 5 fixo** (sem paginação) |
| Processamento | **Assíncrono** (upload retorna `documentId`; processa em background) |
| Persistência do arquivo | **Disco temporário**, apagado no `finally` |
| Upload | 1 arquivo até **200 MB**; lote até **10 arquivos × 20 MB** |
| Metadados do chunk | Apenas `content` + `chunkIndex` (sem página/seção) |
| Deleção | Fora do escopo por agora |
| Escopo da busca | Sempre `INNER JOIN rag_documents` + `userId` do `@CurrentUser()` e `status = READY`; `documentId` é filtro opcional |
| conversationId | Campo opcional (UUID) que particiona documentos por chat. Documentos do mesmo usuário em conversas diferentes ficam isolados por `WHERE conversation_id = :cid` quando informado. Sem ele, o comportamento anterior (todos os documentos do usuário) se aplica. |

## Correções pós-teste (quota 429 e lentidão)

Problemas observados em produção (free tier):

1. **`429 RESOURCE_EXHAUSTED`** — limite de 30 000 `embed_content` tokens/minuto em `gemini-embedding-001`. Um PDF de 2,9 MB gera muitos chunks e estoura a quota em segundos.
2. **~7 minutos para um DOCX pequeno** — a causa **não** é o embedding em si, é o chunker: ele chamava `countTokens` (uma requisição HTTP cada) para **cada sentença candidata**, centenas de vezes por documento. O gargalo era a rede, não o modelo.

Correções:

- **Chunker 100% local.** O empacotamento e o `token_count` usam uma estimativa (`~4 caracteres/token`). O `countTokens` do Gemini **não** é mais chamado durante a ingestão — era ele, uma requisição HTTP por sentença candidata, que fazia um DOCX pequeno levar minutos.
- **Lote de embedding menor e com pacing.** `EMBEDDING_BATCH_SIZE = 10` e um intervalo mínimo entre lotes calculado por `tokensDoLote / EMBEDDING_TOKENS_PER_MINUTE * 60s` (default 30 000), mantendo-se abaixo da quota por minuto. Ajuste a env `EMBEDDING_TOKENS_PER_MINUTE` se o plano tiver quota maior.
- **Retry com backoff.** Em `429`, respeitar o `retryDelay` da API; se ausente, backoff exponencial (1s → 2s → 4s → … → 60s, máx. 5 tentativas).
- **`conversationId` propagado** do upload até os chunks e disponível como filtro em `GET /rag/search` e `GET /rag/documents/:id`.
- **Processamento serializado por processo.** `RagDocumentsService` encadeia os `processDocument` em uma única promise, para que um upload em lote não dispare vários embeddings concorrentes e estoure a quota compartilhada.

## O que está fora do escopo

- Endpoint de chat dedicado ao RAG. A geração usa a rota existente `POST /ai/chat`.
- OCR de PDF escaneado (sem camada de texto). PDFs de imagem retornam erro de extração.
- Fila distribuída / retry persistente (BullMQ, Redis). Ver "Shortcuts".
- Endpoint de deleção de documentos/chunks.
- Metadados de citação (página do PDF, seção/heading do DOCX).
- Suporte a outros formatos (TXT, XLSX, PPTX, imagens) e a `.doc` antigo (só `.docx`).
- Alterar o `DocumentsModule` ou o handler `memeMax`.
- Interface de UI. Apenas API.

## Arquitetura do fluxo

```
POST /rag/documents (1 arquivo)        POST /rag/documents/batch (N arquivos)
        │                                      │
        ▼                                      ▼
RagDocumentsService.upload()  ──► insere row em rag_documents (status=PROCESSING)
        │                              │  arquivo já gravado em disco pelo multer
        │  retorna { documentId, status } (sem await no processamento)
        ▼                              ▼
   (background) RagService.processDocument(documentId)
        1. extrai texto do arquivo temporário (pdf-parse | mammoth)
        2. chunker (512/128, token-aware)
        3. embeddings (gemini-embedding-001, 768 dims)
        4. insere rag_chunks (com vector)
        5. atualiza rag_documents.status = READY | FAILED(+error)
        6. apaga o arquivo temporário (finally)

GET /rag/search?query=...  ──► embed da query ──► ORDER BY cosine distance LIMIT 5
GET /rag/documents/:id     ──► status do processamento

POST /ai/chat?conversationId=...  ──► busca chunks da conversa ──► prompt (contexto + histórico) ──► LLM
                                  └─► persiste mensagem USER e IA em conversations/messages
```

## Dependências a adicionar

Runtime:
- `pdf-parse` — extração de texto de PDF.
- `mammoth` — extração de texto de DOCX.

Dev:
- `@types/multer` — tipo `Express.Multer.File` e `diskStorage`.

> Gotchas conhecidos: a API do `pdf-parse` mudou entre v1 (`pdf(buffer)`) e v2; fixar a versão e escrever o extrator conforme ela. Algumas versões do `pdf-parse` executam um bloco de debug ao importar o entrypoint — se acontecer, importar `pdf-parse/lib/pdf-parse.js`. `mammoth` não suporta `.doc` antigo.

Nada de fila, Redis ou tokenizer externo: o chunking usa estimativa local (`~4 caracteres/token`).

## Autenticação (referência: `src/auth/` e `src/ai/ai.controller.ts`)

Todas as rotas RAG exigem usuário autenticado **com e-mail confirmado**:

```ts
import { Authenticate, CurrentUser } from '@nestjs/authentication';
import { type User } from '../db/schemas/user.js';

@Authenticate({ verifiedEmail: true })
@Controller('rag')
export class RagDocumentsController {
  // @CurrentUser() user: User
}
```

- `@Authenticate({ verifiedEmail: true })` no **nível da classe** cobre todas as rotas do controller.
- Sem credenciais → `401`. E-mail não verificado → `403 email_unverified` (comportamento do guard).
- Toda query no banco filtra por `user.id`. Nunca confiar em id vindo do cliente.
- Não usar `@Public()` em nenhuma rota desta feature.

## Modelo de dados (Drizzle)

Seguir a convenção existente: um arquivo por tabela em `src/db/schemas/`, tipos `$inferSelect`/`$inferInsert`.

### `src/db/schemas/rag-document.ts`

```
ragDocumentStatusEnum = pgEnum("rag_document_status", ["PROCESSING", "READY", "FAILED"])

ragDocumentsTable "rag_documents"
  id              uuid pk defaultRandom
  userId          uuid ("user_id") references userTable.id onDelete cascade notNull
  conversationId  uuid ("conversation_id") nullable   // partição por chat; nunca exposto como storagePath
  filename        varchar notNull
  mimeType        varchar ("mime_type") notNull
  sizeBytes       integer ("size_bytes") notNull
  storagePath     varchar ("storage_path") notNull   // caminho no tmp; NUNCA exposto na API
  status          ragDocumentStatusEnum notNull default "PROCESSING"
  error           text nullable
  createdAt       timestamp defaultNow notNull
  updatedAt       timestamp $onUpdateFn(new Date()) defaultNow

  index ("rag_documents_user_status_index").on(userId, status)
  index ("rag_documents_user_conversation_index").on(userId, conversationId)
```

### `src/db/schemas/rag-chunk.ts`

```
ragChunksTable "rag_chunks"
  id              uuid pk defaultRandom
  documentId      uuid ("document_id") references ragDocumentsTable.id onDelete cascade notNull
  conversationId  uuid ("conversation_id") nullable   // cópia do documento, para filtro sem join
  chunkIndex      integer ("chunk_index") notNull
  content         text notNull
  tokenCount      integer ("token_count") notNull
  embedding       vector("embedding", { dimensions: 768 }) notNull
  createdAt       timestamp defaultNow notNull

  index ("rag_chunks_document_id_index").on(documentId)
  index ("rag_chunks_embedding_hnsw_index")
        .using("hnsw", tb.embedding.op("vector_cosine_ops"))
```

Notas:
- `conversationId` fica em `rag_documents` (fonte da verdade) e é copiado para `rag_chunks` para permitir filtrar sem join adicional. A busca continua exigindo `INNER JOIN rag_documents` + `userId`; o `conversationId` é só mais uma cláusula do `WHERE`.
- `vector` vem de `drizzle-orm/pg-core`. 768 dimensões porque `gemini-embedding-001` suporta `outputDimensionality` e 768 é um bom custo/qualidade.
- A extensão precisa existir no banco: `CREATE EXTENSION IF NOT EXISTS vector;`. O Drizzle não cria extensões pelo schema. Adicionar essa linha no topo do `migration.sql` gerado (ou rodar uma vez no banco).
- O índice HNSW é opcional para o volume inicial, mas evita full scan quando crescer. Se o `drizzle-kit generate` não emitir o `USING hnsw`, criar via SQL na migration.
- Tabelas prefixadas com `rag_` para não colidir com o domínio de documentos gerados do `DocumentsModule`.
- **Por que o escopo por usuário funciona no schema:** `rag_documents.userId` é `notNull` e `rag_chunks.documentId` tem FK `onDelete: cascade` para `rag_documents`. Todo chunk pertence a exatamente um documento e, por transitividade, a um único usuário. Por isso **não** é necessário duplicar `user_id` em `rag_chunks`; a validação é feita pelo join obrigatório na leitura. RLS no banco fica fora de escopo agora (exigiria setar `app.user_id` por conexão/transação).

### Migration

```bash
npx drizzle-kit generate
# editar o migration.sql gerado: adicionar CREATE EXTENSION IF NOT EXISTS vector;
# aplicar conforme o fluxo atual do projeto (não há script db:migrate no package.json)
```

## Contratos da API

Base: `/rag`. Autenticação obrigatória com e-mail verificado em todas as rotas.

### `POST /rag/documents` — upload de 1 arquivo

- `multipart/form-data`, campo `file`.
- `FileInterceptor("file", { storage: diskStorage(...), limits: { fileSize: 200 * 1024 * 1024 } })`.
- Aceita `.pdf` e `.docx`.
- Validação (fronteira de confiança), **antes** de inserir no banco:
  1. arquivo presente;
  2. extensão em `.pdf`/`.docx`;
  3. mimetype coerente;
  4. **magic bytes**: PDF começa com `%PDF-`; DOCX é ZIP e começa com `PK\x03\x04`. Ler os 4 primeiros bytes do arquivo já gravado.
- Em qualquer rejeição, apagar o arquivo temporário e responder `400`.
- Campo opcional `conversationId` (UUID) no multipart. Sem ele, `null`.
- Retorno `201`:

```json
{ "documentId": "uuid", "filename": "prova.pdf", "status": "PROCESSING", "conversationId": "uuid" }
```

### `POST /rag/documents/batch` — upload de N arquivos

- `multipart/form-data`, campo `files`.
- `FilesInterceptor("files", 10, { storage: diskStorage(...), limits: { fileSize: 20 * 1024 * 1024 } })`.
- Até **10 arquivos**, **20 MB por arquivo**.
- Processa cada arquivo de forma independente: um inválido não derruba o lote.
- Arquivo inválido é apagado do disco e marcado `REJECTED` na resposta.
- Campo opcional `conversationId` (UUID) no multipart, aplicado a todos os arquivos do lote.
- Retorno `201`:

```json
{
  "documents": [
    { "documentId": "uuid", "filename": "a.pdf", "status": "PROCESSING", "conversationId": "uuid" },
    { "documentId": null, "filename": "b.txt", "status": "REJECTED", "error": "Unsupported file type" }
  ]
}
```

### `GET /rag/documents/:id` — status

- Retorna `{ id, filename, status, error, chunkCount, createdAt, conversationId }`.
- `404` se não existir **ou** não pertencer ao usuário (não revelar existência de terceiros).

### `GET /rag/search` — top 5 chunks

- Query params: `query` (obrigatório, string não vazia), `documentId` (opcional), `conversationId` (opcional).
- **Escopo obrigatório:** toda busca é `rag_chunks INNER JOIN rag_documents` e filtra `rag_documents.userId = user.id` **e** `rag_documents.status = 'READY'`. Não existe caminho de query que leia chunks sem esse join.
- Se `conversationId` for informado, adiciona `rag_documents.conversationId = :conversationId` ao mesmo `WHERE`.
- Se `documentId` for informado, ele entra no mesmo `WHERE` (`rag_documents.id = documentId`). Um id de outro usuário não retorna erro nem dados: retorna `results: []` (não vaza existência).
- Embeda a query com o mesmo modelo/dimensão e ordena por distância de cosseno.
- Retorno `200`:

```json
{
  "query": "fotossíntese",
  "results": [
    {
      "chunkId": "uuid",
      "documentId": "uuid",
      "filename": "biologia.pdf",
      "chunkIndex": 3,
      "content": "...",
      "similarity": 0.87
    }
  ]
}
```

`similarity = 1 - cosineDistance` (arredondar para 4 casas). `limit` fixo em 5, não aceito do cliente.

## Geração de resposta (`POST /ai/chat`)

A geração não cria rota nova: usa o `AiController`/`AiService` existentes.

- `conversationId` continua vindo de `@Query("conversationId")`, opcional.
- Se o `conversationId` informado não existir, a conversa é criada com esse id (permite enviar documentos antes da primeira mensagem). Se existir e for de outro usuário → `403`.
- Antes de gerar, busca os top 5 chunks com `ragService.search(prompt, user.id, { conversationId: conversation.id })`.
- Busca as últimas 20 mensagens da conversa (`ORDER BY createdAt DESC LIMIT 20`, depois invertidas) e envia como histórico.
- Prompt enviado ao modelo: instrução → contexto numerado (arquivo, chunk, similaridade, conteúdo) → histórico → pergunta do usuário.
- Persiste `USER` (prompt) e `IA` (`output_text`, tokens, `interactionId`) em `messages` como o fluxo atual.
- Retorna `output_text` (string).
- Sem documentos/chunks na conversa, o prompt é só instrução + histórico + pergunta: o chat continua funcionando.

```json
POST /ai/chat?conversationId=uuid
{ "expense": "NORMAL", "prompt": "resuma o capítulo 3" }
```

## Armazenamento temporário

- Pasta: `join(os.tmpdir(), 'matias-rag')`; criar com `mkdirSync(..., { recursive: true })` na inicialização do módulo/controller.
- Nome no disco: `${randomUUID()}${extname(originalname).toLowerCase()}`. **Nunca** usar o nome original no caminho (evita path traversal/colisão). O nome original fica só na coluna `filename`.
- Usar `diskStorage` do `multer` para gravar direto em disco (evita 200 MB em RAM no upload).
- `storagePath` é gravado em `rag_documents` e nunca retornado pela API.
- `RagService.processDocument` apaga o arquivo no `finally`, em sucesso **e** falha.
- Arquivo rejeitado na validação também é apagado imediatamente.

## Algoritmo de chunking (token-aware, 512/128)

Problema: `countTokens` retorna só o total de tokens, não offsets por token. Não dá para cortar exatamente no token 512 sem um tokenizer com offsets (que não será adicionado).

Solução preguiçosa e correta o suficiente (`src/rag/chunker.ts`, função pura exceto pelo `countTokens` injetado):

1. Normalizar espaços em branco e quebrar o texto em unidades (parágrafos → sentenças). Manter separadores.
2. Empacotar unidades em um chunk usando uma **estimativa local** de tokens (`~4 caracteres/token`). Nenhuma chamada de rede no chunker.
3. Quando a estimativa estourar 512, fechar o chunk na unidade anterior.
4. Overlap: o próximo chunk começa repetindo as últimas unidades do chunk anterior até somar ~128 tokens estimados.
5. Unidade única maior que 512 tokens: cortar por caracteres proporcionalmente (`512 / tokensEstimados * length`) para não gerar chunk infinito. Documentar como `shortcut`.
6. `tokenCount` gravado é a estimativa local (suficiente para metadado; não é usado na busca).
7. Ignorar chunks vazios/só whitespace.
8. Retornar `Array<{ content: string; tokenCount: number; index: number }>`.

Assinatura:

```ts
export interface ChunkOptions { maxTokens: number; overlapTokens: number; }
export function chunkText(
  text: string,
  options?: Partial<ChunkOptions>, // default { maxTokens: 512, overlapTokens: 128 }
): Array<{ content: string; tokenCount: number; index: number }>;
```

## Embedding (`src/rag/embedding.service.ts`)

Encapsula o `GoogleGenAI` (mesmo padrão do `AiExpensesFactory`: instanciar com `ConfigService.getOrThrow("GEMINI_API_KEY")`).

```ts
const ai = new GoogleGenAI({ apiKey });
const res = await ai.models.embedContent({
  model: "gemini-embedding-001",
  contents: texts,                     // string[]
  config: { outputDimensionality: 768 },
});
// res.embeddings[i].values -> number[]
```

- `countTokens` **não é usado**: o chunker é local (estimativa de caracteres). Isso elimina centenas de chamadas HTTP por documento.
- **Lote de 10** chunks por chamada (antes 20), para ficar bem abaixo da quota de 30 000 tokens/min.
- **Pacing:** após cada lote, aguardar `tokensDoLote / EMBEDDING_TOKENS_PER_MINUTE * 60s` antes do próximo. Isso evita o 429 em vez de pagar o `retryDelay` de ~57s.
- **Retry:** em `429 RESOURCE_EXHAUSTED`, respeitar `retryDelay` retornado; se ausente, backoff exponencial (1s, 2s, 4s, 8s, 16s, máx. 5 tentativas). Erros não-429 sobem direto.
- Validar que o tamanho do vetor retornado é 768 antes de inserir; erro claro se não for.
- A query de busca usa exatamente o mesmo modelo e dimensão dos chunks.

## Serviços e módulos

Tudo dentro de `src/rag/`:

```
src/rag/
  rag.module.ts
  rag.controller.ts            // GET /rag/search
  rag.service.ts               // processDocument, search
  rag-documents.controller.ts  // POST /rag/documents, /batch, GET /:id
  rag-documents.service.ts     // upload, batch, status, orquestração async
  embedding.service.ts         // embedContent + pacing/retry
  chunker.ts                   // função pura de chunking
  extractors/pdf.extractor.ts
  extractors/docx.extractor.ts
```

### `rag-documents.service.ts`
- `uploadOne(file, userId, conversationId?)` → valida tipo/magic bytes, insere `rag_documents` (com `conversationId`), dispara processamento sem await, retorna `{ documentId, filename, status, conversationId }`.
- `uploadMany(files, userId, conversationId?)` → loop independente, retorna resultado por arquivo.
- `getStatus(id, userId)` → row + `chunkCount` (count dos chunks), incluindo `conversationId`.
- Processamento em background:
  ```ts
  void this.rag.processDocument(documentId).catch((err) =>
    this.markFailed(documentId, err)
  );
  ```
  `markFailed` grava `status=FAILED` e `error` (mensagem curta). Nunca deixar a promise rejeitada sem catch.

### `rag.service.ts`
- `processDocument(documentId)`:
  1. carrega o documento (incluindo `storagePath`, `conversationId`);
  2. extrai texto (PDF → buffer + `pdf-parse`; DOCX → `mammoth.extractRawText({ path })`);
  3. chunk + embed;
  4. insere chunks (copiando `conversationId` do documento);
  5. `status=READY`;
  6. `finally`: apaga o arquivo temporário.
- `search(query, userId, documentId?, conversationId?)` → top 5, com join obrigatório:

  ```ts
  db.select({ /* chunk + document */ })
    .from(ragChunksTable)
    .innerJoin(ragDocumentsTable, eq(ragChunksTable.documentId, ragDocumentsTable.id))
    .where(and(
      eq(ragDocumentsTable.userId, userId),
      eq(ragDocumentsTable.status, 'READY'),
      documentId ? eq(ragDocumentsTable.id, documentId) : undefined,
      conversationId ? eq(ragDocumentsTable.conversationId, conversationId) : undefined,
    ))
    .orderBy(cosineDistance(ragChunksTable.embedding, queryVector))
    .limit(5)
  ```

  `userId` vem sempre de `@CurrentUser()`, nunca do cliente. `documentId` e `conversationId` opcionais são filtrados no mesmo `WHERE` — ids de outro usuário resultam em lista vazia.

### Controllers
- `rag-documents.controller.ts`: `@Authenticate({ verifiedEmail: true })` na classe; `POST /rag/documents`, `POST /rag/documents/batch`, `GET /rag/documents/:id`.
- `rag.controller.ts`: `@Authenticate({ verifiedEmail: true })` na classe; `GET /rag/search`.

### Módulos
- `RagModule`: controllers `[RagController, RagDocumentsController]`; providers `[RagService, RagDocumentsService, EmbeddingService]`; exports `[RagService, EmbeddingService]`.
- `AiModule`: importa `RagModule` para injetar `RagService` no `AiService`.
- `DocumentsModule`: **não alterar**. O `memeMax` continua como está.
- `app.module.ts` já importa `RagModule` e `DocumentsModule` — nada a mudar.

## Regras obrigatórias

1. **Autenticação + e-mail verificado** em todas as rotas (`@Authenticate({ verifiedEmail: true })`). Nenhuma rota `@Public()`.
2. **Escopo por usuário (obrigatório).** `rag_chunks` não tem `user_id` próprio: o dono é sempre o `userId` do `rag_documents` pai. Toda leitura de chunk passa por `INNER JOIN rag_documents` e filtra `rag_documents.userId = user.id`. `userId` vem de `@CurrentUser()`, nunca do cliente. `GET /:id` de terceiro → `404`; `documentId` de terceiro na busca → `results: []`.
3. **Validação de upload** é fronteira de confiança: presença, extensão, mimetype e **magic bytes**. Não confiar só no `Content-Type` (é enviado pelo cliente).
4. **Falha não derruba o lote.** No batch, cada arquivo tem seu próprio try/catch e o inválido é apagado.
5. **Nenhum documento fica `PROCESSING` para sempre.** Todo caminho de erro atualiza `FAILED` + `error`.
6. **Apagar arquivo temporário** no `finally`, inclusive em erro e em rejeição de validação.
7. **Não logar conteúdo de documento nem embeddings** (dados do usuário). Logar apenas id/status.
8. **Embedding da query e dos chunks usa o mesmo modelo e a mesma dimensão.**
9. **`limit` fixo em 5**, sem aceitar valor do cliente.
10. **Sem `any`** para silenciar tipos; seguir os tipos do Drizzle e do SDK.

## Testes (seguir `specs/TEST.md`)

Unitários, sem I/O real, com `Test.createTestingModule` e `vi.*`.

- `src/rag/chunker.spec.ts` (função pura, `countTokens` mockado):
  - texto vazio → `[]`
  - texto menor que 512 → 1 chunk
  - texto maior → múltiplos chunks, cada um ≤ 512 (pelo mock)
  - overlap de ~128 tokens entre chunks consecutivos
  - unidade gigante (> 512) é cortada, não gera chunk infinito
  - `index` sequencial a partir de 0
- `src/rag/rag.service.spec.ts` (db, extrator, embedding, fs mockados):
  - processamento feliz: extrai → chunka → embeda → insere → `status=READY`
  - extração vazia/erro → `status=FAILED` + `error`
  - arquivo temporário é apagado em sucesso e em falha
  - busca: filtra por `userId` e `status=READY`, `limit` 5, ordena por distância
  - busca com `documentId` adiciona o filtro
  - busca com `documentId` de outro usuário retorna `[]` (não vaza dados)
- `src/rag/rag-documents.service.spec.ts`:
  - upload de tipo válido insere row e dispara processamento (mock)
  - tipo/magic bytes inválidos lançam `BadRequestException`, **não** inserem e apagam o temp
  - batch com 1 inválido retorna `REJECTED` e processa os válidos
  - `getStatus` de documento de outro usuário → `NotFoundException`
  - falha no processamento marca `FAILED`

Rodar: `npx vitest run <arquivo>`, `npm test`, `npm run lint`, `npx tsc --noEmit`.

## Passos de implementação (ordem)

1. Adicionar dependências (`pdf-parse`, `mammoth`, `@types/multer`) e criar os schemas `rag-document.ts` / `rag-chunk.ts`.
2. Gerar migration; adicionar `CREATE EXTENSION IF NOT EXISTS vector;`; aplicar.
3. `src/rag/chunker.ts` + `chunker.spec.ts`.
4. `src/rag/embedding.service.ts` (embed + pacing/retry).
5. `src/rag/extractors/pdf.extractor.ts` e `docx.extractor.ts`.
6. `src/rag/rag.service.ts` (`processDocument`, `search`).
7. `src/rag/rag-documents.service.ts` (upload, batch, status, tmp disk, background).
8. `src/rag/rag.controller.ts` e `src/rag/rag-documents.controller.ts` (com `@Authenticate({ verifiedEmail: true })`).
9. Wire do `RagModule` e testes dos serviços.
10. Rodar suíte completa + lint + tsc.

## Fase 2 — melhorias de velocidade (prioridade: velocidade > precisão)

**Status (2026-11-05):** 2.1–2.6 implementados; 2.7 adiado (conforme abaixo). Problemas 1, 2 e 4 da revisão resolvidos; o 3 depende do 2.7. Testes da Fase 2 **ainda não escritos**.

| Item | Onde |
|---|---|
| 2.1 Janela deslizante de 60s (90% da quota), compartilhada | `EmbeddingService.acquire()` / `record()` |
| 2.2 Overlap 64 | `DEFAULT_OPTIONS` em `chunker.ts` (`estimateTokens` agora exportado) |
| 2.3 Lotes até 100 textos / 8 000 tokens | `buildBatches()` em `embedding.service.ts` |
| 2.4 `embedQuery` (`RETRIEVAL_QUERY`, 1 retry de 1s, não espera na janela); `hasReadyDocuments`; `Promise.all`; sem `similarity` no prompt; conversa recém-criada pula a busca | `embedding.service.ts`, `rag.service.ts`, `ai.service.ts` |
| 2.5 Dedupe por conteúdo normalizado (descarta repetidos; `chunkIndex` mantém o índice original, pode ter lacunas) | `dedupeChunks()` em `rag.service.ts` |
| 2.6 `onModuleInit`: `PROCESSING` com `updatedAt` > 15 min → `FAILED`; arquivos > 1h em `matias-rag/` não referenciados por `PROCESSING` são apagados | `RagDocumentsService`; pasta em `rag.constants.ts` |

Limitação do 2.6: documento enviado < 15 min antes de um restart fica `PROCESSING` até o próximo boot. Aceito para não derrubar processamento de outra instância.

No free tier, o tempo de ingestão é dominado pela quota de 30 000 tokens/min, não pela CPU nem pelo banco. Então ganhar velocidade = **esperar menos** e **mandar menos tokens**. Itens em ordem de prioridade (ganho ÷ esforço).

### 2.1 Rate limiter por janela (token bucket) no lugar do sleep fixo — maior ganho
Hoje, **depois de cada lote** o serviço dorme `tokensDoLote / 30k × 60s` (~10s por lote de 10×512), mesmo que nada tenha sido gasto no último minuto. Um DOCX de ~20k tokens (~27k com overlap) paga ~40s de espera sem precisar.

- Trocar `pacingDelayMs` por um limitador de janela deslizante de 60s dentro do `EmbeddingService` (singleton): registra `(timestamp, tokens)` de cada chamada e só espera quando a soma da janela + o próximo lote passar de `EMBEDDING_TOKENS_PER_MINUTE`.
- Documentos abaixo de ~30k tokens passam a ser processados **sem nenhuma espera**; documentos grandes ficam no mesmo teto de hoje.
- O limitador é **compartilhado** por ingestão e busca, então a busca também conta na quota e não provoca 429 na ingestão.
- Margem de segurança: usar 90% da quota (a estimativa de 4 chars/token pode errar para cima ou para baixo).
- Sem dependência nova (~30 linhas).

### 2.2 Reduzir o overlap de 128 → 64 tokens
O overlap de 128/512 faz cada token do texto ser embedado ~1,33×. Com 64 cai para ~1,14× → **~14% menos tokens e ~14% menos tempo** em documentos grandes. A perda de precisão é pequena (frases cortadas na borda ainda aparecem em um dos dois chunks). `overlapTokens: 0` dá −25% se quisermos ir mais longe.
- Mudar só o `DEFAULT_OPTIONS` do chunker; atualizar a tabela de decisões.

### 2.3 Lotes maiores, limitados por tokens
Com o limitador do 2.1, o `EMBEDDING_BATCH_SIZE = 10` deixa de proteger a quota e só gera mais requisições HTTP. Montar lotes até **100 textos** (limite por request da API) **ou** até um teto de tokens (ex.: 8 000), o que vier primeiro. Menos round-trips, mesmo consumo de quota.

### 2.4 Busca do chat: falhar rápido e pular quando não há documentos
O `POST /ai/chat` é o caminho que o usuário sente a cada mensagem.
- **Query sem retry longo:** a busca usa um caminho do `EmbeddingService` com no máximo 1 tentativa extra de ~1s; em 429 cai direto para "sem contexto" (resolve o problema 2).
- **Pular a busca** quando a conversa não tem documento `READY` (um `SELECT 1 ... LIMIT 1` em `rag_documents` pelo índice `user_id, conversation_id`). Economiza uma chamada de embedding (~200–500ms) por mensagem nas conversas sem arquivo, que devem ser a maioria.
- **Paralelizar** histórico e busca com `Promise.all` (hoje são sequenciais).
- **`taskType: "RETRIEVAL_QUERY"`** na query (resolve o problema 1).
- Tirar `similarity` do texto enviado ao LLM: só gasta tokens de entrada.

### 2.5 Pular chunks duplicados antes de embedar
PDFs costumam repetir cabeçalho/rodapé/aviso em todas as páginas. Deduplicar por `content` normalizado (hash) dentro do documento antes do `embed()`. Ganho variável, custo de ~5 linhas.

### 2.6 Recuperação no boot (confiabilidade, barato)
Em `onModuleInit` do `RagModule`: marcar como `FAILED` (`error: "Interrupted by restart"`) os documentos `PROCESSING` com `updatedAt` mais antigo que ~15 min, e apagar arquivos de `matias-rag/` com mais de 1h. Resolve o problema 4 sem fila. O usuário reenvia o arquivo.

### 2.7 HNSW com filtro (quando o volume crescer)
Resolve o problema 3. A imagem `pgvector/pgvector:pg16` atual traz pgvector ≥ 0.8, que suporta busca iterativa:
- Na transação da busca: `SET LOCAL hnsw.iterative_scan = relaxed_order;` (e, se preciso, `SET LOCAL hnsw.ef_search = 100`).
- Alternativa mais simples enquanto o volume por usuário for pequeno: não usar o índice (scan exato sobre os chunks filtrados já é rápido com o índice em `user_id, conversation_id`).
- Pode esperar; não afeta a velocidade hoje.

### Opções maiores (só se o free tier continuar sendo o gargalo)
- **Subir a quota** (plano pago) e ajustar `EMBEDDING_TOKENS_PER_MINUTE` — zero código; com 2.1 o ganho é imediato.
- **Embedding local** (ex.: `multilingual-e5-small` via `@huggingface/transformers`, 384 dims): elimina quota e rede, mas muda dimensão (nova migration + re-embedding de tudo) e consome CPU do processo. Só faz sentido se a quota paga não for opção.
- **Busca disponível durante o processamento:** inserir os chunks por lote e permitir busca em `PROCESSING`. O usuário pergunta antes do fim, com resultado parcial. Muda a regra do `status = READY`; deixar para depois.

### O que não vale a pena agora
- Tokenizer real (tiktoken etc.): mais precisão no tamanho do chunk, nenhum ganho de velocidade.
- Fila (BullMQ/Redis): confiabilidade, não velocidade. Com 2.1 + 2.6, a fila em memória atende o volume atual.
- Remover a serialização global de `processDocument`: com o limitador compartilhado (2.1) ela deixa de ser necessária para a quota, mas a quota continua sendo o teto, então paralelizar não acelera a ingestão no free tier. Manter.

### Ordem sugerida
1. Testes unitários do RAG que estão faltando (base para mexer no resto com segurança).
2. 2.4 (query rápida + `RETRIEVAL_QUERY` + pular busca) — sentido em toda mensagem.
3. 2.1 + 2.3 (limitador + lotes por token) — maior ganho na ingestão.
4. 2.2 e 2.5 (menos tokens).
5. 2.6 (recuperação no boot).
6. 2.7 quando o volume justificar.

Testes novos que a Fase 2 exige (com `vi.useFakeTimers()`):
- `embedding.service.spec.ts`: sem espera abaixo da quota; espera quando a janela estoura; lote fecha em 100 textos ou no teto de tokens; busca não faz retry longo em 429.
- `chunker.spec.ts`: overlap de ~64 tokens.
- `rag.service.spec.ts`: chunks duplicados embedados uma vez; query usa `RETRIEVAL_QUERY`.
- `ai.service.spec.ts`: não chama `search` quando a conversa não tem documento `READY`.
- Recuperação no boot: `PROCESSING` antigo vira `FAILED`.

## Shortcuts (dívidas conhecidas)

- `shortcut: processamento async em memória do processo, sem fila — jobs são perdidos se o processo reiniciar e não há retry automático; migrar para BullMQ/Redis quando houver volume ou exigência de confiabilidade.`
- `shortcut: chunking por unidades + estimativa de ~4 caracteres/token — chunks podem variar do alvo de 512; trocar por tokenizer local (ex.: tiktoken) se a precisão do tamanho importar.`
- `shortcut: arquivo temporário em disco para o processamento async — a pasta precisa de limpeza periódica caso o processo morra no meio; usar storage externo (S3) ou fila quando crescer.`
- `shortcut: PDF é lido inteiro em memória para o pdf-parse (até 200 MB) — aceitável no volume atual; usar extração por streaming/worker isolado se o tamanho ou a concorrência crescerem.`

## Critérios de conclusão

Marcados conforme revisão de código em 2026-11-05 (não houve teste manual nem automatizado do RAG).

- [x] `src/documents/` permanece intocado (`memeMax` intacto).
- [x] Upload de PDF e DOCX em `/rag/documents` retorna `documentId` e processa em background.
- [x] Batch aceita até 10 arquivos de 20 MB e isola falhas por arquivo.
- [x] Todas as rotas exigem usuário autenticado com e-mail confirmado (401/403 corretos).
- [x] Chunks de 512/128 tokens gravados com embedding de 768 dims. *(Fase 2.2 propõe 512/64.)*
- [x] `GET /rag/search` retorna até 5 chunks do usuário logado, com `similarity`. *(Ver problema 3 quando o volume crescer.)*
- [x] `POST /ai/chat` usa os chunks da conversa + histórico, persiste USER/IA e funciona sem documentos.
- [ ] Status do documento reflete `PROCESSING`/`READY`/`FAILED` e nunca fica preso. *(Dentro do processo sim; após restart não — Fase 2.6.)*
- [x] Arquivos temporários são apagados em sucesso, falha e rejeição. *(Exceto se o processo morrer — Fase 2.6.)*
- [ ] Testes unitários dos itens acima passam; lint e tsc limpos. *(Specs do RAG não existem; lint/tsc limpos no RAG; specs de `auth` quebrados.)*
- [x] Nenhum dado de um usuário acessível por outro (busca sempre com `INNER JOIN rag_documents` + `userId` do `@CurrentUser()`).
