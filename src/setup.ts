/**
 * `threadhop setup`: everything a new machine needs after `npm install -g`,
 * in one command. Capture (the vendored conversation-ledger) is installed for
 * each supported CLI found on PATH, conversations default to staying on this
 * machine, and `--mirror` turns on automatic mirroring between those CLIs.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasAuthorIdentity } from "./vendor/annals/index.js";
import { runtimeHome } from "./vendor/annals/runtime.js";
import { INSTALLABLE_ADAPTERS } from "./vendor/conversation-ledger/install.js";
import { enableCommand } from "./auto-mirror.js";
import { targetFor } from "./targets/index.js";

export interface SetupFlags {
  mirror?: boolean;
}

const SETUP_CLIS = [
  { cli: "claude-code", adapter: "claude-code", label: "Claude Code" },
  { cli: "codex", adapter: "codex", label: "Codex" },
] as const;

/** Where cledger reads its per-user settings (see annals redact/config.ts). */
export function cledgerUserConfigPath(): string {
  return join(runtimeHome(), ".config", "cledger", "config.json");
}

export async function setupCommand(flags: SetupFlags): Promise<number> {
  const out = (line = "") => process.stdout.write(line + "\n");

  if (!(await hasAuthorIdentity())) {
    process.stderr.write(
      "threadhop setup: git doesn't know who you are yet, and every recorded turn is attributed to\n" +
        "your git email (that is how threadhop tells your conversations from a teammate's). Run:\n" +
        '  git config --global user.email "you@company.com"\n' +
        '  git config --global user.name  "Your Name"\n' +
        "then `threadhop setup` again. Nothing was changed.\n",
    );
    return 1;
  }

  const found: (typeof SETUP_CLIS)[number][] = [];
  for (const entry of SETUP_CLIS) if (await targetFor(entry.cli).isInstalled()) found.push(entry);
  if (found.length === 0) {
    process.stderr.write(
      "threadhop setup: neither `claude` (Claude Code) nor `codex` is on PATH. Install one, then run this again.\n" +
        "  Other CLIs: `cledger install <cli>` (see `cledger --help`). Nothing was changed.\n",
    );
    return 1;
  }

  // Conversations stay on this machine unless a repository opts in to sharing
  // with a committed .cledger.json; an existing choice is never overwritten.
  const configPath = cledgerUserConfigPath();
  if (existsSync(configPath)) {
    out(`kept your existing cledger settings (${configPath})`);
  } else {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ transport: { hook: false, fetchRefspec: false } }, null, 2) + "\n");
    out(`conversations stay on this machine by default (${configPath})`);
  }

  for (const entry of found) out(await INSTALLABLE_ADAPTERS[entry.adapter]!());

  if (flags.mirror) {
    if (found.length < 2) {
      out(`mirroring skipped: it needs both Claude Code and Codex, and only ${found[0]!.label} is installed`);
    } else {
      out("");
      const code = await enableCommand(["codex", "claude"]);
      if (code !== 0) return code;
    }
  }

  out("");
  out("Done. Next:");
  if (found.some((entry) => entry.cli === "codex")) {
    out("  - open `codex` once, type /hooks and approve the new hooks (Codex skips hooks until approved)");
  }
  out("  - start Claude Code or Codex inside a git repository; each turn is recorded there");
  out("  - `threadhop list` / `threadhop resume` to see and continue your conversations");
  out("  - `threadhop mirror status` checks that capture is installed");
  return 0;
}
