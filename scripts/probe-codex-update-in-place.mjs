// Does Codex write to a fabricated rollout just by opening it, and can
// threadhop then still bring that copy up to date in place?
//
// Claude Code 2.1.316 appends its own uuid-less state records the moment a
// session is opened, so its update appends instead of rewriting. Codex's
// update is stricter: it rewrites the rollout and refuses (MirrorDivergedError)
// when any history line differs from what threadhop would write. If Codex
// also writes on open, every opened copy would be refused and re-bridging
// would always make a new copy. This answers that against the installed CLI:
//
//   1. fabricate a two-turn conversation into Codex
//   2. open it with `codex resume <id>` in a real PTY, type nothing, /exit
//   3. diff the rollout: what (if anything) did merely opening it add?
//   4. grow the source, update in place, and reopen to see both turns render
//
// Fully isolated: a disposable HOME and CODEX_HOME, a fake key, and a model
// endpoint nothing listens on. No turn is ever submitted, so no request is
// made; your own ~/.codex is never read or written.
//
// Usage: npm run build && node scripts/probe-codex-update-in-place.mjs [--keep]
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { codexTarget } from "../dist/targets/codex.js";
import { MirrorDivergedError } from "../dist/targets/types.js";
import { configureScriptedTarget, TERMINAL_SYNTAX } from "../dist/verification/configure.js";
import { isolatedEnvironment } from "../dist/verification/process.js";
import { runPty } from "../dist/verification/pty.js";

const RUN = Math.random().toString(36).slice(2, 6).toUpperCase();
const MARK_ONE = `UIP-ONE-${RUN}`;
const MARK_TWO = `UIP-TWO-${RUN}`;
const keep = process.argv.includes("--keep");
const UNREACHABLE = "http://127.0.0.1:9";

const sourceSession = randomUUID();
const stream = `claude-code:${sourceSession}`;
function turn(seq, role, text) {
  const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
  return {
    id: `uip-${RUN}-${seq}`,
    schema: "annals/v1",
    kind: "conversation_turn",
    occurred_at: at,
    recorded_at: at,
    actor: role === "assistant" ? { type: "agent" } : { type: "human" },
    producer: { tool: "cledger", source: "claude-code", session_id: sourceSession },
    stream: { id: stream, seq },
    content: { role, blocks: [{ type: "text", text }] },
  };
}
function summary(events) {
  return {
    id: stream,
    source: "claude-code",
    sessionId: sourceSession,
    title: `update-in-place probe ${RUN}`,
    firstActivity: events[0].occurred_at,
    lastActivity: events[events.length - 1].occurred_at,
    turnCount: events.length,
    owners: [],
    ownerDisplays: [],
    events,
  };
}
const first = [turn(0, "user", `first question ${MARK_ONE}`), turn(1, "assistant", `first answer ${MARK_ONE}`)];
const more = [turn(2, "user", `second question ${MARK_TWO}`), turn(3, "assistant", `second answer ${MARK_TWO}`)];

const root = await mkdtemp(join(tmpdir(), "threadhop-codex-uip-"));
await mkdir(join(root, "repo"), { recursive: true });
// Codex trusts folders by their resolved path (/private/var/... on macOS)
const repoPath = await realpath(join(root, "repo"));
spawnSync("git", ["init", "-q", repoPath]);
process.env = {
  ...isolatedEnvironment(root, process.env.PATH ?? "/usr/bin:/bin"),
  TERM: "xterm-256color",
  THREADHOP_HOME: join(root, ".threadhop"),
};
const flags = await configureScriptedTarget("codex", root, repoPath, UNREACHABLE);

async function rolloutPath() {
  const dir = join(process.env.CODEX_HOME, "sessions");
  const entries = await readdir(dir, { recursive: true });
  const match = entries.find((e) => e.endsWith(".jsonl"));
  if (!match) throw new Error("no rollout written");
  return join(dir, match);
}
const lines = (body) => body.split("\n").filter((l) => l.trim());
const describe = (raw) => {
  const line = JSON.parse(raw);
  return [line.type, line.payload?.type].filter(Boolean).join("/");
};

// Quit only once the history marker has rendered at the composer, so "nothing
// was written" can never come from a session that did not actually load.
async function openAndQuit(sessionId, label, marker) {
  const result = await runPty("codex", ["resume", sessionId, ...flags], {
    cwd: repoPath,
    env: process.env,
    timeoutMs: 60_000,
    answerTerminalQueries: true,
    transcriptPath: join(root, `${label}-terminal.log`),
    actions: [{ waitFor: `${marker}[\\s\\S]*${TERMINAL_SYNTAX.codex.ready}`, send: "/exit\r", delayMs: 1500 }],
  });
  const screen = stripVTControlCharacters(result.output);
  return {
    exit: result.code,
    timedOut: result.timedOut,
    reachedComposer: result.actionsCompleted === 1,
    renderedOne: screen.includes(MARK_ONE),
    renderedTwo: screen.includes(MARK_TWO),
  };
}

const report = { codex: spawnSync("codex", ["--version"], { encoding: "utf8" }).stdout.trim(), artifacts: root };
try {
  const fabricated = await codexTarget.fabricate(summary(first), repoPath, { replayReasoning: false });
  const sessionId = fabricated.fabricatedConversationId.split(":")[1];
  const path = await rolloutPath();
  const written = await readFile(path, "utf8");
  report.fabricateNotes = fabricated.notes.filter((n) => !n.startsWith("rollout file"));

  report.firstOpen = await openAndQuit(sessionId, "open-1", MARK_ONE);
  const afterOpen = await readFile(path, "utf8");
  report.firstOpen.fileUnchanged = afterOpen === written;
  report.firstOpen.ourLinesKeptAsPrefix = afterOpen.startsWith(written);
  report.firstOpen.linesAddedByCodex = lines(afterOpen).slice(lines(written).length).map(describe);

  try {
    const updated = await codexTarget.fabricate(summary([...first, ...more]), repoPath, {
      replayReasoning: false,
      existingSessionId: sessionId,
    });
    report.update = { ok: true, sameSession: updated.fabricatedConversationId === fabricated.fabricatedConversationId };
    const afterUpdate = await readFile(path, "utf8");
    report.secondOpen = await openAndQuit(sessionId, "open-2", MARK_TWO);
    report.secondOpen.linesAddedByCodex = lines(await readFile(path, "utf8"))
      .slice(lines(afterUpdate).length)
      .map(describe);
  } catch (error) {
    if (!(error instanceof MirrorDivergedError)) throw error;
    report.update = { ok: false, refused: error.message };
  }
} finally {
  console.log(JSON.stringify(report, null, 2));
  if (!keep) await rm(root, { recursive: true, force: true });
}
