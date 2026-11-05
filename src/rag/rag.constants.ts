import { tmpdir } from "node:os";
import { join } from "node:path";

export const RAG_TEMP_DIR = join(tmpdir(), "matias-rag");
