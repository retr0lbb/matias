import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiError, GoogleGenAI } from "@google/genai";

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

// Free tier allows 30k embed tokens/minute. A batch of 10 chunks of 512 tokens
// is ~5.1k tokens, so pacing at tokens/quota keeps us under the limit instead
// of eating a ~57s 429 retry.
const EMBEDDING_BATCH_SIZE = 10;
const TOKENS_PER_MINUTE = 30_000;
const MAX_RETRIES = 5;
const CHARS_PER_TOKEN = 4;

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly client: GoogleGenAI;
  private readonly tokensPerMinute: number;

  constructor(configService: ConfigService) {
    this.client = new GoogleGenAI({
      apiKey: configService.getOrThrow<string>("GEMINI_API_KEY"),
    });
    this.tokensPerMinute =
      Number(configService.get("EMBEDDING_TOKENS_PER_MINUTE")) ||
      TOKENS_PER_MINUTE;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
      const values = await this.embedBatchWithRetry(batch);

      for (const [index, vector] of values.entries()) {
        if (vector.length !== EMBEDDING_DIMENSIONS) {
          throw new Error(
            `Embedding ${i + index} does not have ${EMBEDDING_DIMENSIONS} dimensions`,
          );
        }
        embeddings.push(vector);
      }

      if (i + EMBEDDING_BATCH_SIZE < texts.length) {
        await sleep(this.pacingDelayMs(batch));
      }
    }

    return embeddings;
  }

  private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
    let attempt = 0;

    for (;;) {
      try {
        const response = await this.client.models.embedContent({
          model: EMBEDDING_MODEL,
          contents: batch,
          config: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: "RETRIEVAL_DOCUMENT" },
        });

        const batchEmbeddings = response.embeddings ?? [];
        if (batchEmbeddings.length !== batch.length) {
          throw new Error(
            `Expected ${batch.length} embeddings, received ${batchEmbeddings.length}`,
          );
        }

        return batchEmbeddings.map((embedding) => embedding.values ?? []);
      } catch (error) {
        if (!isQuotaError(error) || attempt >= MAX_RETRIES) {
          throw error;
        }

        const delayMs = retryDelayMs(error) ?? 2 ** attempt * 1000;
        attempt++;
        this.logger.warn(
          `Embedding quota hit, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`,
        );
        await sleep(delayMs);
      }
    }
  }

  private pacingDelayMs(batch: string[]): number {
    const tokens = batch.reduce(
      (total, text) => total + Math.ceil(text.length / CHARS_PER_TOKEN),
      0,
    );

    return Math.ceil((tokens / this.tokensPerMinute) * 60_000);
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
