import mammoth from "mammoth";

export async function extractDocxText(path: string): Promise<string> {
  const result = await mammoth.extractRawText({ path });
  return result.value;
}
