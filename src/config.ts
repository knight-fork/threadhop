import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliName } from "./types.js";

export interface ThreadhopConfig {
  /** Target CLI used when `threadhop resume` is called without one. */
  defaultTarget?: CliName;
  /**
   * Replay a Codex-origin conversation's opaque `reasoning` blobs when
   * fabricating it back into Codex, restoring hidden reasoning provider-side
   * (see docs/WIP_TECHNICAL_DESIGN.md). Default on; set false to opt out.
   */
  reasoningReplay?: boolean;
  /** Defaults for `threadhop mirror` when it is run without arguments. */
  mirror?: {
    /** Target CLIs to keep copies in; only those that update a copy in place. */
    targets?: string[];
    /** How many of your most recent conversations to mirror. */
    limit?: number;
  };
}

export function configDir(): string {
  return process.env["THREADHOP_HOME"] ?? join(homedir(), ".threadhop");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<ThreadhopConfig> {
  try {
    const raw = await readFile(configPath(), "utf8");
    const data = JSON.parse(raw) as ThreadhopConfig;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export async function saveConfig(config: ThreadhopConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n");
}
