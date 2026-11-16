#!/usr/bin/env node
import { runRecordsCommand } from "annals";
import { asLedger, findRepo } from "conversation-ledger";
import { mirrorCommand, type MirrorFlags } from "./mirror.js";
import { disableCommand, enableCommand, isTriggerSource, runTriggered, statusCommand, triggerCommand } from "./auto-mirror.js";
import { resumeCommand, type ResumeFlags } from "./resume.js";
import { shimInstall, shimStatus, shimUninstall } from "./shim.js";
import { parseCliName } from "./types.js";
import { targetCapabilities } from "./capabilities.js";

const USAGE = `threadhop — continue a coding-agent conversation in another CLI

Usage:
  threadhop resume [target-cli] [options]             pick a conversation and resume it
  threadhop list [options]                            print compatible conversations
  threadhop mirror [target-cli...] [options]          keep copies of your recent conversations
                                                       in other CLIs' own resume pickers
  threadhop mirror enable [target-cli...]             do that automatically after every turn
  threadhop mirror disable|status                     turn it off, or see what it has done
  threadhop targets [--json]                          show implemented target routes
  threadhop shim install|uninstall|status             opt-in \`claude --resume\` interception
  threadhop records <command>                         maintain shared cledger records

Options for resume/list:
  --all         include collaborators' conversations (default: yours + unattributed)
  --any-commit  include conversations anchored to commits not reachable from HEAD
  --bootstrap   force honest rehydration (fresh session reads the transcript)
                instead of fabricating a native session file
  --no-reasoning-replay
                don't replay Codex-origin encrypted reasoning blobs when
                fabricating back into Codex (default: replay them)
  --new-copy    create a separate session in the target even when an earlier
                copy you haven't typed in could be updated (Claude Code, Codex)

Options for mirror (targets default to "mirror.targets" in ~/.threadhop/config.json):
  --limit N     how many of your most recent conversations to mirror (default 10)
  --dry-run     show what would be created or updated without writing anything
  --any-commit  include conversations anchored to commits not reachable from HEAD
`;

const RECORD_ALIASES = new Map([
  ["sync", "sync"],
  ["review", "review"],
  ["inspect", "inspect"],
  ["redact", "redact"],
  ["allow", "allow"],
  ["reanchor", "reanchor"],
  ["re-anchor", "reanchor"],
]);

async function recordsCommand(argv: string[]): Promise<number> {
  // cledger alone owns the pre-push hook ABI for this shared namespace.
  if (argv[0] === "transport-push") {
    process.stderr.write("threadhop records: use cledger transport-push for the shared hook\n");
    return 2;
  }
  const repo = await findRepo(process.cwd());
  if (!repo) {
    process.stderr.write("threadhop records: run inside a git repository\n");
    return 1;
  }
  return runRecordsCommand({
    ledger: asLedger(repo),
    argv,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    commandName: "threadhop records",
  });
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Run by a CLI's own Stop/SessionEnd hook (installed by `mirror enable`);
 * with --worker, the detached background run it starts.
 */
async function mirrorTrigger(args: string[]): Promise<number> {
  const source = args[0] ?? "";
  if (!args.includes("--worker")) return triggerCommand(source, await readStdin());
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const transcriptPath = value("--transcript");
  const cwd = value("--cwd");
  const sessionId = value("--session");
  if (!isTriggerSource(source) || !transcriptPath || !cwd) return 0;
  await runTriggered({ source, transcriptPath, cwd, ...(sessionId ? { sessionId } : {}) });
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const command = args.shift();

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  if (command === "records") return recordsCommand(args);
  if (command === "targets") {
    if (args.some(arg => arg !== "--json")) { process.stderr.write("threadhop: targets accepts only --json\n"); return 1; }
    const capabilities = targetCapabilities();
    process.stdout.write(args.includes("--json") ? JSON.stringify(capabilities, null, 2) + "\n" :
      "CLI                  Native import  Exact resume  Bootstrap\n" + capabilities.map(cli =>
        `${cli.id.padEnd(21)}${(cli.nativeImport ? "implemented" : "unavailable").padEnd(15)}${(cli.exactNativeResume ? "implemented" : "unavailable").padEnd(14)}implemented`).join("\n") +
      "\nImplemented routes require installed-version checks; see verification evidence.\n");
    return 0;
  }
  const recordAlias = RECORD_ALIASES.get(command);
  if (recordAlias) return recordsCommand([recordAlias, ...args]);

  if (command === "resume" || command === "list") {
    const flags: ResumeFlags = { listOnly: command === "list" };
    for (const arg of args) {
      if (arg === "--all" || arg === "-a") flags.all = true;
      else if (arg === "--any-commit") flags.anyCommit = true;
      else if (arg === "--bootstrap") flags.bootstrap = true;
      else if (arg === "--no-reasoning-replay") flags.noReasoningReplay = true;
      else if (arg === "--new-copy") flags.newCopy = true;
      else if (!arg.startsWith("-")) {
        const target = parseCliName(arg);
        if (!target) {
          process.stderr.write(`threadhop: unknown target CLI: ${arg}\n`);
          return 1;
        }
        flags.target = target;
      } else {
        process.stderr.write(`threadhop: unknown option: ${arg}\n`);
        return 1;
      }
    }
    return resumeCommand(flags);
  }

  if (command === "mirror-trigger") return mirrorTrigger(args);

  if (command === "mirror") {
    const sub = args[0];
    if (sub === "enable") {
      const names = args.slice(1);
      const option = names.find((arg) => arg.startsWith("-"));
      if (option) {
        process.stderr.write(`threadhop: unknown option: ${option}\n`);
        return 1;
      }
      return enableCommand(names);
    }
    if (sub === "disable" || sub === "status") {
      if (args.length > 1) {
        process.stderr.write(`threadhop mirror ${sub} takes no arguments\n`);
        return 1;
      }
      return sub === "disable" ? disableCommand() : statusCommand();
    }
    const flags: MirrorFlags = { targets: [] };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--dry-run") flags.dryRun = true;
      else if (arg === "--any-commit") flags.anyCommit = true;
      else if (arg === "--limit" || arg.startsWith("--limit=")) {
        const value = arg === "--limit" ? args[++i] : arg.slice("--limit=".length);
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1) {
          process.stderr.write("threadhop mirror: --limit takes a positive whole number\n");
          return 1;
        }
        flags.limit = limit;
      } else if (!arg.startsWith("-")) flags.targets.push(arg);
      else {
        process.stderr.write(`threadhop: unknown option: ${arg}\n`);
        return 1;
      }
    }
    return mirrorCommand(flags);
  }

  if (command === "shim") {
    const sub = args.shift();
    if (sub === "install") return shimInstall();
    if (sub === "uninstall") return shimUninstall();
    if (sub === "status") return shimStatus();
    process.stderr.write("threadhop: shim install|uninstall|status\n");
    return 1;
  }

  process.stderr.write(`threadhop: unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => {
    process.stderr.write(`threadhop: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
