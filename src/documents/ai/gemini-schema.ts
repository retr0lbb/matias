import { z } from 'zod/v4';

// The JSON Schema keywords Gemini's `responseJsonSchema` understands. Anything
// else Zod emits (`$schema`, `default`, `minLength`, `exclusiveMinimum`, ...)
// is dropped: it only guides generation, the Zod parse is the real validation.
const SUPPORTED_KEYWORDS = new Set([
  'type',
  'format',
  'title',
  'description',
  'enum',
  'items',
  'prefixItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'anyOf',
  'oneOf',
  'properties',
  'additionalProperties',
  'required',
  '$ref',
  '$defs',
]);

// Keywords whose value is a map of name → schema, so the names are kept as is.
const SCHEMA_MAP_KEYWORDS = new Set(['properties', '$defs']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(sanitize);
  }
  if (!isRecord(node)) {
    return node;
  }

  const result: Record<string, unknown> = {};

  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === 'const') {
      // Gemini has no `const`; a one-value enum means the same.
      result.enum = [value];
    } else if (!SUPPORTED_KEYWORDS.has(keyword)) {
      continue;
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && isRecord(value)) {
      result[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, sanitize(schema)]),
      );
    } else if (keyword === 'enum' || keyword === 'required') {
      result[keyword] = value;
    } else {
      result[keyword] = sanitize(value);
    }
  }

  return result;
}

/**
 * Derives the schema sent to Gemini from the Zod schema, so the two cannot
 * drift apart. Fields with a Zod default come out as required.
 */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitize(z.toJSONSchema(schema)) as Record<string, unknown>;
}
