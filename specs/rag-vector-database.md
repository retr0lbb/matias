# Especificação: RAG com PGVector (upload de PDF/DOCX → top 5 chunks)

## Contexto

API NestJS v12 + TypeScript, PostgreSQL com `pgvector` (imagem `pgvector/pgvector:pg16` já no `docker-compose.yaml`), Drizzle ORM e SDK `@google/genai`.

Objetivo: um conjunto de endpoints onde o usuário autenticado envia documentos (PDF e DOCX), o sistema extrai o texto, divide em chunks, gera embeddings com Gemini e armazena no PGVector. Uma consulta recebe um texto e devolve os **5 chunks mais similares** (top 5 fixo).

Este documento é o plano de implementação. Nada aqui foi implementado ainda.

## Decisões já tomadas (Q&A)

| Tema | Decisão |
|---|---|
| Stack | NestJS + Drizzle + PostgreSQL/pgvector (já existente) |
| Vector store | PGVector, coluna `vector` via Drizzle |
| Modelo de embedding | Gemini `gemini-embedding-001` |
| Chunking | **Token-based** com `@google/genai` (`countTokens`) |
| Chunk size / overlap | **512 tokens / 128 de overlap** |
| Armazenamento dos chunks | Tabela separada `document_chunks` ligada a `documents` |
| Resultado da busca | **Top 5 fixo** (sem paginação) |
| Processamento | **Assíncrono** (upload retorna `jobId`/`documentId`; processa em background) |
| Upload | Endpoint único para 1 arquivo + endpoint separado para lote |
| Escopo dos dados | Vinculado ao usuário autenticado (`user_id`) |

## O que está fora do escopo

- Geração de resposta pelo LLM usando os chunks (RAG "completo"). Aqui só se recupera os chunks.
- OCR de PDF escaneado (sem camada de texto). PDFs de imagem retornam erro de extração.
- Fila distribuída / retry persistente (BullMQ, Redis). Ver "Shortcuts".
- Suporte a outros formatos (TXT, XLSX, PPTX, imagens).
- Interface de UI. Apenas API.

## Arquitetura do fluxo

```
POST /documents (1 arquivo)         POST /documents/batch (N arquivos)
        │                                     │
        ▼                                     ▼
DocumentsService.upload()  ──► insere row em documents (status=PROCESSING)
        │                              │
        │  retorna { documentId, status } (sem await no processamento)
        ▼                              ▼
   (background) RagService.processDocument(documentId)
        1. extrai texto  (pdf-parse | mammoth)
        2. chunker (512/128, token-aware)
        3. embeddings (gemini-embedding-001, 768 dims)
        4. insere document_chunks (com vector)
        5. atualiza documents.status = READY | FAILED(+error)

GET /rag/search?query=...  ──► embed da query ──► ORDER BY cosine distance LIMIT 5
GET /documents/:id         ──► status do processamento
```

## Dependências a adicionar

Runtime:
- `pdf-parse` — extração de texto de PDF.
- `mammoth` — extração de texto de DOCX (`.docx`; não suporta `.doc` antigo).

Dev:
- `@types/multer` — tipo `Express.Multer.File`.
- `@types/pdf-parse` (se a versão instalada não trouxer tipos).

> Verificar a API da versão instalada de `pdf-parse` (v1 usa função default `pdf(buffer)`; v2 mudou a assinatura). Fixar a versão e escrever o extrator conforme ela.

Nada de fila, Redis ou tokenizer externo: `countTokens` do SDK cobre o token counting.

## Modelo de dados (Drizzle)

Seguir a convenção existente: um arquivo por tabela em `src/db/schemas/`, tipos `$inferSelect`/`$inferInsert`.

### `src/db/schemas/document.ts`

```
documentStatusEnum = pgEnum("document_status", ["PROCESSING", "READY", "FAILED"])

documentsTable "documents"
  id          uuid pk defaultRandom
  userId      uuid ("user_id") references userTable.id onDelete cascade notNull
  filename    varchar notNull
  mimeType    varchar ("mime_type") notNull
  sizeBytes   integer ("size_bytes") notNull
  status      documentStatusEnum notNull default "PROCESSING"
  error       text nullable
  createdAt   timestamp defaultNow notNull
  updatedAt   timestamp $onUpdateFn(new Date()) defaultNow

  index ("documents_user_status_index").on(userId, status)
```

### `src/db/schemas/document-chunk.ts`

```
documentChunksTable "document_chunks"
  id          uuid pk defaultRandom
  documentId  uuid ("document_id") references documentsTable.id onDelete cascade notNull
  chunkIndex  integer ("chunk_index") notNull
  content     text notNull
  tokenCount  integer ("token_count") notNull
  embedding   vector("embedding", { dimensions: 768 }) notNull
  createdAt   timestamp defaultNow notNull

  index ("document_chunks_document_id_index").on(documentId)
  index ("document_chunks_embedding_hnsw_index")
        .using("hnsw", tb.embedding.op("vector_cosine_ops"))
```

Notas:
- `vector` vem de `drizzle-orm/pg-core`. 768 dimensões porque `gemini-embedding-001` suporta `outputDimensionality` e 768 é um bom custo/qualidade.
- A extensão precisa existir no banco: `CREATE EXTENSION IF NOT EXISTS vector;`. O Drizzle não cria extensões pelo schema. Adicionar essa linha no topo do `migration.sql` gerado (ou rodar uma vez no banco).
- O índice HNSW é opcional para o volume inicial, mas evita full scan quando crescer. Se o `drizzle-kit generate` não emitir o `USING hnsw`, criar via SQL na migration.

### Migration

```bash
npx drizzle-kit generate
# editar o migration.sql gerado: adicionar CREATE EXTENSION IF NOT EXISTS vector;
# aplicar conforme o fluxo atual do projeto (não há script db:migrate no package.json)
```

## Contratos da API

Autenticação em todos os endpoints: `@Authenticate({ verifiedEmail: true })` + `@CurrentUser()`, como em `ai.controller.ts`.

### `POST /documents` — upload de 1 arquivo

- `multipart/form-data`, campo `file`.
- `FileInterceptor("file")`.
- Aceita: `application/pdf`, `.pdf`; `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `.docx`.
- Limite de tamanho: 20 MB (`limits.fileSize`).
- Rejeitar tipo inválido com `BadRequestException` **antes** de inserir no banco.
- Retorno `201`:

```json
{ "documentId": "uuid", "filename": "prova.pdf", "status": "PROCESSING" }
```

### `POST /documents/batch` — upload de N arquivos

- `multipart/form-data`, campo `files` (até 10).
- `FilesInterceptor("files", 10)`.
- Processa cada arquivo de forma independente: um inválido não derruba o lote.
- Retorno `201`:

```json
{
  "documents": [
    { "documentId": "uuid", "filename": "a.pdf", "status": "PROCESSING" },
    { "documentId": null, "filename": "b.txt", "status": "REJECTED", "error": "Unsupported file type" }
  ]
}
```

### `GET /documents/:id` — status

- Retorna `{ id, filename, status, error, chunkCount, createdAt }`.
- `404` se não existir ou não pertencer ao usuário.

### `GET /rag/search` — top 5 chunks

- Query params: `query` (obrigatório, string não vazia), `documentId` (opcional, restringe a um documento).
- Busca apenas chunks de documentos `READY` do usuário logado.
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

`similarity = 1 - cosineDistance` (arredondar para 4 casas). `limit` fixo em 5.

## Algoritmo de chunking (token-aware, 512/128)

Problema: `countTokens` retorna só o total de tokens, não offsets por token. Não dá para cortar exatamente no token 512 sem um tokenizer com offsets (que o usuário não quer adicionar).

Solução preguiçosa e correta o suficiente (`src/rag/chunker.ts`, função pura exceto pelo `countTokens` injetado):

1. Normalizar espaços em branco e quebrar o texto em unidades (parágrafos → sentenças). Manter separadores.
2. Empacotar unidades em um chunk até `countTokens(chunk) > 512`. Quando estourar, fechar o chunk na unidade anterior.
3. Overlap: o próximo chunk começa repetindo as últimas unidades do chunk anterior até somar ~128 tokens (usar `countTokens` para medir).
4. Unidade única maior que 512 tokens (parágrafo gigante): cortar por caracteres proporcionalmente (`512 / tokensDaUnidade * length`) para não gerar chunk infinito. Documentar como `shortcut`.
5. Ignorar chunks vazios/só whitespace.
6. Retornar `Array<{ content: string; tokenCount: number; index: number }>`.

Assinatura sugerida:

```ts
export type TokenCounter = (text: string) => Promise<number>;
export interface ChunkOptions { maxTokens: number; overlapTokens: number; }
export async function chunkText(
  text: string,
  countTokens: TokenCounter,
  options?: Partial<ChunkOptions>, // default { maxTokens: 512, overlapTokens: 128 }
): Promise<Array<{ content: string; tokenCount: number; index: number }>>;
```

Passar o `countTokens` como parâmetro deixa a função testável sem rede.

## Embedding (`src/rag/embedding.service.ts`)

Encapsula o `GoogleGenAI` (mesmo padrão do `AiExpensesFactory`: instanciar com `ConfigService.getOrThrow("GEMINI_API_KEY")`).

```ts
const ai = new GoogleGenAI({ apiKey });
// embed (uma ou várias entradas)
const res = await ai.models.embedContent({
  model: "gemini-embedding-001",
  contents: texts,                     // string[]
  config: { outputDimensionality: 768 },
});
// res.embeddings[i].values -> number[]
```

- `countTokens` para o chunker: usar `ai.models.countTokens({ model, contents })`. Se a API recusar o modelo de embedding, usar um modelo Gemini da mesma família (`gemini-3.1-flash-lite`, já usado no projeto). Validar isso na implementação; é o único ponto incerto do SDK.
- Fazer embedding em lotes (ex.: 20 chunks por chamada) para reduzir latência/custo.
- Validar que o tamanho do vetor retornado é 768 antes de inserir; erro claro se não for.

## Serviços e módulos

### `src/documents/documents.service.ts`
- `uploadOne(file, userId)` → valida tipo, insere `documents`, dispara processamento sem await, retorna `{ documentId, filename, status }`.
- `uploadMany(files, userId)` → loop independente, retorna resultado por arquivo.
- `getStatus(id, userId)` → row + `chunkCount` (count dos chunks).
- Processamento em background:
  ```ts
  void this.rag.processDocument(documentId).catch((err) =>
    this.markFailed(documentId, err)
  );
  ```
  `markFailed` grava `status=FAILED` e `error` (mensagem curta). Nunca deixar a promise rejeitada sem catch.

### `src/rag/rag.service.ts`
- `processDocument(documentId)`:
  1. carrega o documento (precisa do buffer? ver abaixo)
  2. extrai texto
  3. chunk + embed
  4. insere chunks
  5. `status=READY`
- `search(query, userId, documentId?)` → top 5.

> O buffer do arquivo não deve ser guardado em memória entre requisições nem no banco. Para o processamento assíncrono funcionar, **salvar o arquivo em disco** em uma pasta temporária (`os.tmpdir()` ou `./storage`) na hora do upload, guardar `storagePath` em `documents`, processar a partir do arquivo e apagar ao final (sucesso ou falha). Alternativa mais simples: processar **em background mas dentro da mesma requisição de upload** é impossível sem manter o buffer. Portanto: `documents.storagePath varchar` (não exposto na API) + limpeza no `finally`. Se preferir não persistir arquivo, o upload teria que ser síncrono — o que contraria a decisão de async.

### Controllers
- `src/documents/documents.controller.ts` — substituir o handler placeholder `memeMax` por `POST /`, `POST /batch`, `GET /:id`.
- `src/rag/rag.controller.ts` — `GET /rag/search`.

### Módulos
- `DocumentsModule`: controllers + `DocumentsService`; importa `RagModule`.
- `RagModule`: providers `RagService`, `EmbeddingService`; exports `RagService`, `EmbeddingService`.
- `app.module.ts` já importa `RagModule` e `DocumentsModule` — nada a mudar.

## Regras obrigatórias

1. **Escopo por usuário.** Toda query filtra `documents.userId = user.id`. Nunca retornar chunks de outro usuário.
2. **Validação de upload** é fronteira de confiança: validar mimetype **e** extensão, tamanho e presença do arquivo. Não confiar só no `Content-Type`.
3. **Falha não derruba o lote.** No batch, cada arquivo tem seu próprio try/catch.
4. **Nenhum documento fica `PROCESSING` para sempre.** Todo caminho de erro atualiza `FAILED` + `error`.
5. **Apagar arquivo temporário** no `finally`, inclusive em erro.
6. **Não logar conteúdo de documento nem embeddings** (dados do usuário). Logar apenas id/status.
7. **Embedding da query e dos chunks usa o mesmo modelo e a mesma dimensão.**
8. **`limit` fixo em 5**, sem aceitar valor do cliente.
9. **Sem `any`** para silenciar tipos; seguir os tipos do Drizzle e do SDK.

## Testes (seguir `specs/TEST.md`)

Unitários, sem I/O real, com `Test.createTestingModule` e `vi.*`.

- `src/rag/chunker.spec.ts` (função pura, `countTokens` mockado):
  - texto vazio → `[]`
  - texto menor que 512 → 1 chunk
  - texto maior → múltiplos chunks, cada um ≤ 512 (pelo mock)
  - overlap de ~128 tokens entre chunks consecutivos
  - unidade gigante (> 512) é cortada, não gera chunk infinito
  - `index` sequencial a partir de 0
- `src/rag/rag.service.spec.ts` (db, extrator, embedding mockados):
  - processamento feliz: extrai → chunka → embeda → insere → `status=READY`
  - extração vazia/erro → `status=FAILED` + `error`
  - busca: filtra por `userId` e `status=READY`, `limit` 5, ordena por distância
  - busca com `documentId` adiciona o filtro
- `src/documents/documents.service.spec.ts`:
  - upload de tipo válido insere row e dispara processamento (mock)
  - tipo inválido lança `BadRequestException` e **não** insere
  - batch com 1 inválido retorna `REJECTED` e processa os válidos
  - `getStatus` de documento de outro usuário → `NotFoundException`
  - falha no processamento marca `FAILED`

Rodar: `npx vitest run <arquivo>`, `npm test`, `npm run lint`, `npx tsc --noEmit`.

## Passos de implementação (ordem)

1. Adicionar dependências (`pdf-parse`, `mammoth`, `@types/multer`) e criar os schemas `document.ts` / `document-chunk.ts`.
2. Gerar migration; adicionar `CREATE EXTENSION IF NOT EXISTS vector;`; aplicar.
3. `src/rag/chunker.ts` + `chunker.spec.ts`.
4. `src/rag/embedding.service.ts` (embed + countTokens).
5. `src/rag/rag.service.ts` (`processDocument`, `search`).
6. `src/rag/rag.controller.ts` (`GET /rag/search`).
7. `src/documents/documents.service.ts` (upload, batch, status, background + tmp file).
8. `src/documents/documents.controller.ts` (substituir placeholder).
9. Wire dos módulos e testes dos serviços/controllers.
10. Rodar suíte completa + lint + tsc.

## Shortcuts (dívidas conhecidas)

- `shortcut: processamento async em memória do processo, sem fila — jobs são perdidos se o processo reiniciar e não há retry automático; migrar para BullMQ/Redis quando houver volume ou exigência de confiabilidade.`
- `shortcut: chunking por unidades + countTokens, sem offsets reais de token — chunks podem variar ~poucos tokens do alvo de 512; trocar por tokenizer com offsets (ex.: tiktoken) se a precisão do tamanho importar.`
- `shortcut: arquivo temporário em disco para o processamento async — pasta precisa de limpeza periódica caso o processo morra no meio; usar storage externo (S3) ou fila quando crescer.`

## Critérios de conclusão

- [ ] Upload de PDF e DOCX retorna `documentId` e processa em background.
- [ ] Batch aceita vários arquivos e isola falhas por arquivo.
- [ ] Chunks de 512/128 tokens gravados com embedding de 768 dims.
- [ ] `GET /rag/search` retorna exatamente até 5 chunks do usuário logado, com `similarity`.
- [ ] Status do documento reflete `PROCESSING`/`READY`/`FAILED` e nunca fica preso.
- [ ] Testes unitários dos itens acima passam; lint e tsc limpos.
- [ ] Nenhum dado de um usuário acessível por outro.
