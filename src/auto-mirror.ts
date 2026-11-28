import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureClaudeTranscript,
  captureCodexTranscript,
  findRepo,
  gitUserIdentity,
} from "./vendor/conversation-ledger/index.js";
import { configDir, loadConfig, saveConfig } from "./config.js";
import { processQueued, type MirrorRequest } from "./mirror-lock.js";
import { resolveMirrorTargets, runMirror, type MirrorResult } from "./mirror.js";
import { targetFor } from "./targets/index.js";
import { cliLabel, parseCliName, type CliName } from "./types.js";

/**
 * Automatic mirroring: after each turn, the CLI the conversation is in runs
 * `threadhop mirror-trigger <cli>`, which hands the session to a background
 * worker and returns at once. The worker captures the session into the ledger
 * (cledger's own hook runs alongside, and may not have finished), then mirrors
 * that one conversation into the configured targets.
 *
 * The trigger is a separate hook entry next to cledger's, not a wrapper around
 * it, so capture keeps working exactly as before when mirroring is disabled.
 * Its command deliberately never contains "hook <cli>": that is the substring
 * cledger looks for to decide its own hook is already installed.
 */

/** CLIs whose sessions can trigger a mirror: the ones threadhop installs a hook into. */
export const TRIGGER_SOURCES = ["claude-code", "codex"] as const satisfies readonly CliName[];
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

const TRIGGER_COMMAND = "mirror-trigger";
const HOOK_TIMEOUT_SECONDS = 10;
/** Codex 0.169 clamps SessionEnd hooks to 3s, and warns on every run when asked for more. */
const CODEX_SESSION_END_TIMEOUT_SECONDS = 3;
const LOG_ROTATE_BYTES = 1024 * 1024;

export function isTriggerSource(name: string): name is TriggerSource {
  return (TRIGGER_SOURCES as readonly string[]).includes(name);
}

export function mirrorLogPath(): string {
  return join(configDir(), "mirror.log");
}

function cliScript(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
}

export interface TriggerArgs {
  source: TriggerSource;
  transcriptPath: string;
  cwd: string;
  sessionId?: string;
}

/**
 * `threadhop mirror-trigger <cli>`, run by the CLI's own hook. Must return
 * quickly, print nothing and exit 0 whatever happens: a failing Stop hook is
 * shown to the user mid-session, and exit code 2 would stop the turn ending.
 */
export async function triggerCommand(source: string, stdin: string): Promise<number> {
  try {
    if (!isTriggerSource(source)) return 0;
    const config = await loadConfig();
    if (!config.mirror?.auto) return 0;
    const payload = JSON.parse(stdin || "{}") as HookPayload;
    if (!payload.transcript_path) return 0;
    const args: TriggerArgs = {
      source,
      transcriptPath: payload.transcript_path,
      cwd: payload.cwd ?? process.cwd(),
      ...(payload.session_id ? { sessionId: payload.session_id } : {}),
    };
    if (process.env["THREADHOP_TRIGGER_FOREGROUND"] === "1") {
      await runTriggered(args);
      return 0;
    }
    await startWorker(args);
  } catch {
    // Never break the user's session; the worker logs its own failures.
  }
  return 0;
}

async function openLog(): Promise<number> {
  const path = mirrorLogPath();
  await mkdir(dirname(path), { recursive: true });
  try {
    if ((await stat(path)).size > LOG_ROTATE_BYTES) await rename(path, `${path}.1`);
  } catch {
    // no log yet
  }
  return openSync(path, "a");
}

/** Run the worker detached, so the CLI's turn ends without waiting for it. */
async function startWorker(args: TriggerArgs): Promise<void> {
  const log = await openLog();
  try {
    const argv = [cliScript(), TRIGGER_COMMAND, args.source, "--worker", "--transcript", args.transcriptPath, "--cwd", args.cwd];
    if (args.sessionId) argv.push("--session", args.sessionId);
    const child = spawn(process.execPath, argv, {
      cwd: args.cwd,
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** The session id a hook is about, from its payload or its transcript. */
async function sessionIdOf(args: TriggerArgs): Promise<string | null> {
  if (args.sessionId) return args.sessionId;
  if (args.source === "claude-code") return basename(args.transcriptPath, ".jsonl");
  try {
    const first = (await readFile(args.transcriptPath, "utf8")).split("\n", 1)[0] ?? "";
    const meta = JSON.parse(first) as { type?: string; payload?: { id?: string } };
    return meta.type === "session_meta" && typeof meta.payload?.id === "string" ? meta.payload.id : null;
  } catch {
    return null;
  }
}

/** One line in the mirror log; the worker's own output (and any crash) lands there too. */
function log(line: string): void {
  try {
    mkdirSync(dirname(mirrorLogPath()), { recursive: true });
    appendFileSync(mirrorLogPath(), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging must not be what fails a run.
  }
}

/** What one automatic run did, one log line per copy written or skipped. */
export function renderTriggeredResults(results: MirrorResult[], request: MirrorRequest): string[] {
  const changed = results.filter((r) => r.action !== "unchanged");
  if (results.length === 0) {
    return [`${request.source}:${request.sessionId} nothing to mirror (not yours, a copy nobody continued, or not captured)`];
  }
  if (changed.length === 0) return [`${request.source}:${request.sessionId} copies already up to date`];
  return changed.map((r) => {
    const detail = r.detail ? ` (${r.detail})` : "";
    return `${r.action} ${cliLabel(r.target.name)} copy of "${r.conversation.title}" [${r.conversation.id}] in ${request.cwd}${detail}`;
  });
}

/** The background half of a trigger: capture the session, then mirror it. */
export async function runTriggered(args: TriggerArgs): Promise<void> {
  try {
    const repo = await findRepo(args.cwd);
    if (!repo) return;
    const config = await loadConfig();
    if (!config.mirror?.auto) return;
    const resolved = await resolveMirrorTargets(config.mirror.targets ?? []);
    if ("error" in resolved) {
      log(`skipped: ${resolved.error}`);
      return;
    }
    const self = (await gitUserIdentity(repo)).email;
    if (!self) {
      log(`skipped ${repo.root}: git user.email is not set, so threadhop can't tell which conversations are yours`);
      return;
    }
    const sessionId = await sessionIdOf(args);
    if (!sessionId) {
      log(`skipped ${args.transcriptPath}: could not tell which session it is`);
      return;
    }
    // cledger's hook captures this too, alongside this one; capturing again
    // is idempotent and means the newest turn is in the ledger before mirroring.
    if (args.source === "claude-code") await captureClaudeTranscript(args.transcriptPath, args.cwd);
    else await captureCodexTranscript(args.transcriptPath, args.cwd);

    await processQueued(repo, { source: args.source, sessionId, cwd: args.cwd }, async (requests) => {
      for (const request of requests) {
        try {
          const results = await runMirror(repo, request.cwd, {
            targets: resolved.targets,
            self,
            limit: Number.POSITIVE_INFINITY,
            only: [{ source: request.source, sessionId: request.sessionId }],
            replayReasoning: config.reasoningReplay !== false,
          });
          for (const line of renderTriggeredResults(results, request)) log(line);
        } catch (err) {
          log(`failed ${request.source}:${request.sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Installing the trigger into each CLI's hook config

function claudeSettingsPath(): string {
  return join(process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude"), "settings.json");
}

function codexConfigPath(): string {
  return join(process.env["CODEX_HOME"] || join(homedir(), ".codex"), "config.toml");
}

export function hookConfigPath(source: TriggerSource): string {
  return source === "claude-code" ? claudeSettingsPath() : codexConfigPath();
}

/** `threadhop` when it is on PATH, as cledger does for itself; otherwise this install, by path. */
function triggerCommandLine(source: TriggerSource): string {
  const onPath = spawnSync("threadhop", ["help"], { stdio: "ignore" }).status === 0;
  return onPath
    ? `threadhop ${TRIGGER_COMMAND} ${source}`
    : `"${process.execPath}" "${cliScript()}" ${TRIGGER_COMMAND} ${source}`;
}

function isOurs(command: string | undefined, source: TriggerSource): boolean {
  return command?.includes(`${TRIGGER_COMMAND} ${source}`) ?? false;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeWithBackup(path: string, existing: string | null, next: string): Promise<void> {
  if (existing !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(path, `${path}.bak-${stamp}`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next);
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}
type ClaudeSettings = Record<string, unknown> & { hooks?: Record<string, ClaudeHookEntry[]> };

const CLAUDE_EVENTS = ["Stop", "SessionEnd"] as const;

function claudeHasCommand(settings: ClaudeSettings, match: (command: string | undefined) => boolean): boolean {
  return CLAUDE_EVENTS.every((event) =>
    (settings.hooks?.[event] ?? []).some((entry) => entry.hooks?.some((hook) => match(hook.command))),
  );
}

const CODEX_BEGIN = "# >>> threadhop mirror";
const CODEX_END = "# <<< threadhop mirror";
const CODEX_BLOCK = new RegExp(`\\n?${CODEX_BEGIN}[^\\n]*\\n[\\s\\S]*?${CODEX_END}[^\\n]*\\n?`, "g");

function codexBlock(command: string): string {
  const event = (name: string, timeout: number) =>
    [`[[hooks.${name}]]`, `[[hooks.${name}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(command)}`,
      `timeout = ${timeout}`, ""];
  return [
    `${CODEX_BEGIN}: copies this CLI's conversations into your other CLIs after each turn.`,
    "# Managed by `threadhop mirror enable`; `threadhop mirror disable` removes it.",
    ...event("Stop", HOOK_TIMEOUT_SECONDS),
    ...event("SessionEnd", CODEX_SESSION_END_TIMEOUT_SECONDS),
    CODEX_END,
    "",
  ].join("\n");
}

export interface HookState {
  /** cledger's capture hook, which mirroring depends on. */
  capture: boolean;
  /** threadhop's trigger. */
  trigger: boolean;
}

export async function hookState(source: TriggerSource): Promise<HookState> {
  const text = await readText(hookConfigPath(source));
  if (text === null) return { capture: false, trigger: false };
  if (source === "claude-code") {
    let settings: ClaudeSettings;
    try {
      settings = JSON.parse(text) as ClaudeSettings;
    } catch {
      return { capture: false, trigger: false };
    }
    return {
      capture: claudeHasCommand(settings, (c) => (c?.includes("hook claude-code") ?? false) && !isOurs(c, source)),
      trigger: claudeHasCommand(settings, (c) => isOurs(c, source)),
    };
  }
  const outside = text.replace(CODEX_BLOCK, "\n");
  return {
    // cledger's entry, and the switch Codex needs before it runs any hook.
    capture: outside.includes("hook codex") && /^[ \t]*(?:features[ \t]*\.[ \t]*)?hooks[ \t]*=[ \t]*true\b/m.test(outside),
    trigger: text.includes(CODEX_BEGIN),
  };
}

/**
 * Add the trigger to `source`'s hook config. One already there is brought up
 * to date when an earlier threadhop wrote it differently (another command
 * path, or a timeout a newer CLI clamps), and otherwise left alone.
 */
export async function installTrigger(source: TriggerSource): Promise<"added" | "updated" | "present"> {
  const path = hookConfigPath(source);
  const text = await readText(path);
  const command = triggerCommandLine(source);
  if (source === "claude-code") {
    const settings = (text ? JSON.parse(text) : {}) as ClaudeSettings;
    const hooks = (settings.hooks ??= {});
    let added = false;
    let updated = false;
    for (const event of CLAUDE_EVENTS) {
      const entries = (hooks[event] ??= []);
      const ours = entries.flatMap((entry) => entry.hooks ?? []).filter((hook) => isOurs(hook.command, source));
      if (ours.length === 0) {
        entries.push({ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] });
        added = true;
      }
      for (const hook of ours) {
        if (hook.command === command && hook.timeout === HOOK_TIMEOUT_SECONDS) continue;
        hook.command = command;
        hook.timeout = HOOK_TIMEOUT_SECONDS;
        updated = true;
      }
    }
    if (!added && !updated) return "present";
    await writeWithBackup(path, text, JSON.stringify(settings, null, 2) + "\n");
    return added ? "added" : "updated";
  }
  const block = codexBlock(command);
  const existing = text?.match(CODEX_BLOCK)?.[0];
  if (text && existing !== undefined) {
    if (existing.replace(/^\n/, "") === block) return "present";
    await writeWithBackup(path, text, text.replace(CODEX_BLOCK, "\n" + block));
    return "updated";
  }
  // Array-of-tables headers reset table scope, so a block appended at the
  // end of the file is valid whatever table the file ends in.
  await writeWithBackup(path, text, (text ?? "").replace(/\n?$/, "\n") + "\n" + block);
  return "added";
}

/** Remove the trigger from `source`'s hook config, leaving everything else as it was. */
export async function removeTrigger(source: TriggerSource): Promise<"removed" | "absent"> {
  const path = hookConfigPath(source);
  const text = await readText(path);
  if (text === null || !(await hookState(source)).trigger) return "absent";
  if (source === "claude-code") {
    const settings = JSON.parse(text) as ClaudeSettings;
    const hooks = settings.hooks ?? {};
    for (const event of CLAUDE_EVENTS) {
      const kept = (hooks[event] ?? [])
        .map((entry) => ({ ...entry, hooks: (entry.hooks ?? []).filter((hook) => !isOurs(hook.command, source)) }))
        .filter((entry) => (entry.hooks?.length ?? 0) > 0);
      if (kept.length > 0) hooks[event] = kept;
      else delete hooks[event];
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
    await writeWithBackup(path, text, JSON.stringify(settings, null, 2) + "\n");
  } else {
    await writeWithBackup(path, text, text.replace(CODEX_BLOCK, "\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"));
  }
  return "removed";
}

// ---------------------------------------------------------------------------
// `threadhop mirror enable | disable | status`

/** Sources whose sessions have somewhere else to go: a target other than themselves. */
function sourcesFor(targets: CliName[]): TriggerSource[] {
  return TRIGGER_SOURCES.filter((source) => targets.some((target) => target !== source));
}

export async function enableCommand(names: string[]): Promise<number> {
  const config = await loadConfig();
  const requested = names.length > 0 ? names : config.mirror?.targets ?? [];
  const resolved = await resolveMirrorTargets(requested);
  if ("error" in resolved) {
    process.stderr.write(`threadhop mirror enable: ${resolved.error}\n`);
    return 1;
  }
  const targets = resolved.targets.map((t) => t.name);
  const sources: TriggerSource[] = [];
  for (const source of sourcesFor(targets)) if (await targetFor(source).isInstalled()) sources.push(source);
  const uncaptured: TriggerSource[] = [];
  for (const source of sources) if (!(await hookState(source)).capture) uncaptured.push(source);
  if (uncaptured.length > 0) {
    process.stderr.write(
      "threadhop mirror enable: mirroring copies conversations that conversation-ledger captures, and " +
        `${uncaptured.map((s) => cliLabel(s)).join(" and ")} ${uncaptured.length > 1 ? "aren't" : "isn't"} being captured.\n` +
        `  Run ${uncaptured.map((s) => `\`cledger install ${s}\``).join(" and ")} first, then this again. Nothing was changed.\n`,
    );
    return 1;
  }

  const lines: string[] = [];
  for (const source of sources) {
    const result = await installTrigger(source);
    const verb = { added: "hook added to", updated: "hook updated in", present: "hook already in" }[result];
    lines.push(`  ${cliLabel(source)}: ${verb} ${hookConfigPath(source)}`);
  }
  await saveConfig({ ...config, mirror: { ...config.mirror, targets, auto: true } });

  const out = [
    `threadhop mirror: automatic mirroring is on, into ${targets.map((t) => cliLabel(t)).join(" and ")}.`,
    "After each turn, the conversation is copied (or its copies brought up to date) in the background;",
    `what each run did is logged to ${mirrorLogPath()}.`,
    ...lines,
  ];
  if (sources.includes("claude-code")) out.push("", "Claude Code picks the hook up without a restart, so sessions already open are mirrored too.");
  if (sources.includes("codex")) {
    out.push(
      "",
      "Codex asks you to approve new hooks once: open `codex`, run /hooks, and approve the",
      `\`${TRIGGER_COMMAND} codex\` command.`,
    );
  }
  out.push(
    "",
    "Conversations from before now are not copied until they change; run `threadhop mirror` once",
    "in a repository to copy its recent ones. `threadhop mirror disable` turns this off.",
    "",
  );
  process.stdout.write(out.join("\n"));
  return 0;
}

export async function disableCommand(): Promise<number> {
  const config = await loadConfig();
  const lines: string[] = [];
  for (const source of TRIGGER_SOURCES) {
    if ((await removeTrigger(source)) === "removed") lines.push(`  ${cliLabel(source)}: hook removed from ${hookConfigPath(source)}`);
  }
  if (config.mirror?.auto) await saveConfig({ ...config, mirror: { ...config.mirror, auto: false } });
  process.stdout.write(
    [
      "threadhop mirror: automatic mirroring is off. Copies made so far are left as they are;",
      "conversation-ledger still captures your conversations.",
      ...lines,
      "",
    ].join("\n"),
  );
  return 0;
}

export async function statusCommand(): Promise<number> {
  const config = await loadConfig();
  const targets = config.mirror?.targets ?? [];
  const out = [
    `automatic mirroring: ${config.mirror?.auto ? "on" : "off"}` +
      (targets.length ? ` (into ${targets.map((t) => cliLabel(parseCliName(t) ?? (t as CliName))).join(", ")})` : ""),
  ];
  for (const source of TRIGGER_SOURCES) {
    const state = await hookState(source);
    out.push(
      `  ${cliLabel(source)}: capture ${state.capture ? "installed" : "not installed"}, ` +
        `mirror trigger ${state.trigger ? "installed" : "not installed"} (${hookConfigPath(source)})`,
    );
  }
  const logText = await readText(mirrorLogPath());
  const recent = (logText ?? "").split("\n").filter((line) => /^\d{4}-\d\d-\d\dT/.test(line)).slice(-8);
  out.push("", recent.length ? `recent runs (${mirrorLogPath()}):` : "no automatic runs logged yet");
  out.push(...recent.map((line) => `  ${line}`), "");
  process.stdout.write(out.join("\n"));
  return 0;
}
