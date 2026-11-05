import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiError, GoogleGenAI } from "@google/genai";
import { estimateTokens } from "./chunker.js";

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

// Free tier allows 30k embed tokens/minute. A sliding 60s window lets small
// documents go through without any wait and only throttles when the window is
// actually full.
const TOKENS_PER_MINUTE = 30_000;
const WINDOW_MS = 60_000;
// The ~4 chars/token estimate can be off; keep a margin below the real quota.
const QUOTA_SAFETY_FACTOR = 0.9;

// The API accepts up to 100 texts per request; the token cap keeps a single
// request from eating the whole window.
const MAX_BATCH_TEXTS = 100;
const MAX_BATCH_TOKENS = 8_000;

const MAX_RETRIES = 5;
// Queries sit on the chat request path: fail fast and let the caller answer
// without context instead of waiting for a ~57s retryDelay.
const QUERY_MAX_RETRIES = 1;
const QUERY_RETRY_DELAY_MS = 1_000;

interface WindowEntry {
  at: number;
  tokens: number;
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly client: GoogleGenAI;
  private readonly tokenBudget: number;
  private readonly window: WindowEntry[] = [];

  constructor(configService: ConfigService) {
    this.client = new GoogleGenAI({
      apiKey: configService.getOrThrow<string>("GEMINI_API_KEY"),
    });
    const tokensPerMinute =
      Number(configService.get("EMBEDDING_TOKENS_PER_MINUTE")) ||
      TOKENS_PER_MINUTE;
    this.tokenBudget = Math.floor(tokensPerMinute * QUOTA_SAFETY_FACTOR);
  }

  /** Embeds document chunks, throttled by the shared per-minute token window. */
  async embed(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (const batch of buildBatches(texts)) {
      await this.acquire(batch.tokens);
      const values = await this.embedWithRetry(
        batch.texts,
        "RETRIEVAL_DOCUMENT",
        MAX_RETRIES,
      );

      for (const vector of values) {
        assertDimensions(vector, embeddings.length);
        embeddings.push(vector);
      }
    }

    return embeddings;
  }

  /**
   * Embeds a search query. Never waits on the window: it is a handful of
   * tokens on the chat path, so it is recorded and sent right away.
   */
  async embedQuery(text: string): Promise<number[]> {
    this.record(estimateTokens(text));
    const [vector] = await this.embedWithRetry(
      [text],
      "RETRIEVAL_QUERY",
      QUERY_MAX_RETRIES,
      QUERY_RETRY_DELAY_MS,
    );

    if (!vector) {
      throw new Error("Could not embed the query");
    }

    assertDimensions(vector, 0);
    return vector;
  }

  private async acquire(tokens: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      const used = this.usedTokens(now);

      // An oversized batch on an empty window still goes through; otherwise it
      // would never fit.
      if (used + tokens <= this.tokenBudget || this.window.length === 0) {
        this.window.push({ at: now, tokens });
        return;
      }

      const oldest = this.window[0];
      await sleep(Math.max(oldest.at + WINDOW_MS - now, 50));
    }
  }

  private record(tokens: number): void {
    const now = Date.now();
    this.usedTokens(now);
    this.window.push({ at: now, tokens });
  }

  private usedTokens(now: number): number {
    while (this.window.length > 0 && this.window[0].at <= now - WINDOW_MS) {
      this.window.shift();
    }

    return this.window.reduce((total, entry) => total + entry.tokens, 0);
  }

  private async embedWithRetry(
    texts: string[],
    taskType: EmbeddingTask,
    maxRetries: number,
    fixedDelayMs?: number,
  ): Promise<number[][]> {
    let attempt = 0;

    for (;;) {
      try {
        const response = await this.client.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: texts,
          config: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType },
        });

        const batchEmbeddings = response.embeddings ?? [];
        if (batchEmbeddings.length !== texts.length) {
          throw new Error(
            `Expected ${texts.length} embeddings, received ${batchEmbeddings.length}`,
          );
        }

        return batchEmbeddings.map((embedding) => embedding.values ?? []);
      } catch (error) {
        if (!isQuotaError(error) || attempt >= maxRetries) {
          throw error;
        }

        const delayMs =
          fixedDelayMs ?? retryDelayMs(error) ?? 2 ** attempt * 1000;
        attempt++;
        this.logger.warn(
          `Embedding quota hit, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${maxRetries})`,
        );
        await sleep(delayMs);
      }
    }
  }
}

function buildBatches(
  texts: string[],
): Array<{ texts: string[]; tokens: number }> {
  const batches: Array<{ texts: string[]; tokens: number }> = [];
  let current: { texts: string[]; tokens: number } = { texts: [], tokens: 0 };

  for (const text of texts) {
    const tokens = estimateTokens(text);
    const full =
      current.texts.length >= MAX_BATCH_TEXTS ||
      current.tokens + tokens > MAX_BATCH_TOKENS;

    if (current.texts.length > 0 && full) {
      batches.push(current);
      current = { texts: [], tokens: 0 };
    }

    current.texts.push(text);
    current.tokens += tokens;
  }

  if (current.texts.length > 0) {
    batches.push(current);
  }

  return batches;
}

function assertDimensions(vector: number[], index: number): void {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding ${index} does not have ${EMBEDDING_DIMENSIONS} dimensions`,
    );
  }
}

function isQuotaError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 429;
  }

  return (
    error instanceof Error &&
    (error.message.includes("RESOURCE_EXHAUSTED") ||
      error.message.includes("429"))
  );
}

function retryDelayMs(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  // The API reports RetryInfo as retryDelay: "57s".
  const match = error.message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!match) {
    return undefined;
  }

  return Number(match[1]) * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
