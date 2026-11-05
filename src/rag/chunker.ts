export interface ChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

export interface TextChunk {
  content: string;
  tokenCount: number;
  index: number;
}

const DEFAULT_OPTIONS: ChunkOptions = {
  maxTokens: 512,
  // 64 instead of 128: ~14% fewer embedded tokens, which on the free tier is
  // ~14% less ingestion time. A sentence cut at a border still lands whole in
  // one of the two neighbouring chunks.
  overlapTokens: 64,
};

// Chunking is local-only. The previous implementation called the Gemini
// countTokens API for every candidate sentence, turning a small DOCX into
// minutes of HTTP round-trips. tokenCount is now an estimate.
// shortcut: ~4 chars/token ignores language/script differences; swap for a real
// tokenizer only if exact chunk sizes become a requirement.
const CHARS_PER_TOKEN = 4;

/**
 * Splits text into token-bounded chunks with overlap.
 */
export function chunkText(
  text: string,
  options: Partial<ChunkOptions> = {},
): TextChunk[] {
  const { maxTokens, overlapTokens } = { ...DEFAULT_OPTIONS, ...options };

  if (maxTokens < 1) {
    throw new Error("maxTokens must be at least 1");
  }

  const units = splitIntoUnits(text);
  const chunks: TextChunk[] = [];

  let start = 0;
  while (start < units.length) {
    const end = findChunkEnd(units, start, maxTokens);

    if (end === start) {
      const pieces = splitOversizedUnit(units[start], maxTokens);
      units.splice(start, 1, ...pieces);
      continue;
    }

    const content = units.slice(start, end).join(" ").trim();
    if (content.length > 0) {
      chunks.push({
        content,
        tokenCount: estimateTokens(content),
        index: chunks.length,
      });
    }

    if (end >= units.length) {
      break;
    }

    const overlapStart = findOverlapStart(units, start, end, overlapTokens);
    start = overlapStart > start ? overlapStart : end;
  }

  return chunks;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function splitIntoUnits(text: string): string[] {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  if (normalized.length === 0) {
    return [];
  }

  const units: string[] = [];
  for (const paragraph of normalized.split(/\n{2,}/)) {
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      const unit = sentence.trim();
      if (unit.length > 0) {
        units.push(unit);
      }
    }
  }

  return units;
}

function findChunkEnd(
  units: string[],
  start: number,
  maxTokens: number,
): number {
  let end = start;
  let tokens = 0;

  while (end < units.length) {
    const unitTokens = estimateTokens(units[end]);
    const next = tokens + unitTokens + (end > start ? 1 : 0);

    if (next > maxTokens) {
      break;
    }

    tokens = next;
    end++;
  }

  return end;
}

function findOverlapStart(
  units: string[],
  start: number,
  end: number,
  overlapTokens: number,
): number {
  if (overlapTokens <= 0) {
    return end;
  }

  let overlapStart = end;
  let tokens = 0;

  for (let i = end - 1; i >= start; i--) {
    const unitTokens = estimateTokens(units[i]);
    const next = tokens + unitTokens + (overlapStart < end ? 1 : 0);

    if (next > overlapTokens && overlapStart < end) {
      break;
    }

    tokens = next;
    overlapStart = i;

    if (tokens > overlapTokens) {
      break;
    }
  }

  return overlapStart;
}

function splitOversizedUnit(unit: string, maxTokens: number): string[] {
  const pieces: string[] = [];
  let remaining = unit;

  while (remaining.length > 0) {
    const tokens = estimateTokens(remaining);

    if (tokens <= maxTokens) {
      pieces.push(remaining);
      break;
    }

    let cut = Math.max(1, Math.floor((remaining.length * maxTokens) / tokens));
    const lastSpace = remaining.lastIndexOf(" ", cut);
    if (lastSpace > 0) {
      cut = lastSpace;
    }

    const piece = remaining.slice(0, cut).trim();
    if (piece.length === 0) {
      break;
    }

    pieces.push(piece);
    remaining = remaining.slice(cut).trim();
  }

  return pieces;
}
