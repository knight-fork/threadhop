import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

/**
 * Replace `path` by writing a sibling temp file and renaming it over the
 * original, so a reader never sees a half-written session file. Same
 * directory, so the rename stays on one filesystem and is atomic.
 */
export async function replaceAtomically(path: string, body: string): Promise<void> {
  const tmp = `${path}.turnbridge-${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, body, { mode: 0o600, flag: "wx" });
  await rename(tmp, path);
}
