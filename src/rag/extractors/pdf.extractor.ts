import { readFile } from "node:fs/promises";
import { PDFParse } from "pdf-parse";

export async function extractPdfText(path: string): Promise<string> {
  const data = await readFile(path);
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}
