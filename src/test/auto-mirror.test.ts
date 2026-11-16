import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoInfo } from "conversation-ledger";
import {
  disableCommand,
  enableCommand,
  hookConfigPath,
  hookState,
  installTrigger,
  mirrorLogPath,
  removeTrigger,
  runTriggered,
} from "../auto-mirror.js";
import { drain, enqueue, processQueued, tryLock, unlock, withMirrorLock } from "../mirror-lock.js";
import { runMirror } from "../mirror.js";
import { claudeCodeTarget } from "../targets/claude-code.js";
import { codexTarget } from "../targets/codex.js";
import { cleanupRepo, makeTempRepo, seedConversation } from "./helpers.js";

const ME = "test@example.com"; // makeTempRepo's git user.email
const SESSION = "aaaaaaaa-1111-4111-8111-111111111111";
const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

interface Sandbox {
  repo: RepoInfo;
  binDir: string;
  claudeDir: string;
  codexHome: string;
  threadhopHome: string;
  env: NodeJS.ProcessEnv;
}

/** Temp repo, fake `claude`/`codex` binaries and private config dirs: nothing reaches real sessions or settings. */
async function withSandbox(fn: (box: Sandbox) => Promise<void>): Promise<void> {
  const repo = await makeTempRepo();
  const dirs = await Promise.all(
    ["bin", "claude", "codex", "home"].map((name) => mkdtemp(join(tmpdir(), `threadhop-auto-${name}-`))),
  );
  const [binDir, claudeDir, codexHome, threadhopHome] = dirs as [string, string, string, string];
  for (const [name, version] of [["claude", "2.1.316 (Claude Code)"], ["codex", "codex-cli 0.146.0"]]) {
    await writeFile(join(binDir, name!), `#!/bin/sh\necho "${version}"\n`);
    await chmod(join(binDir, name!), 0o755);
  }
  const keys = ["PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "THREADHOP_HOME"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env["PATH"] = `${binDir}:${saved["PATH"] ?? ""}`;
  process.env["CLAUDE_CONFIG_DIR"] = claudeDir;
  process.env["CODEX_HOME"] = codexHome;
  process.env["THREADHOP_HOME"] = threadhopHome;
  try {
    await fn({ repo, binDir, claudeDir, codexHome, threadhopHome, env: { ...process.env } });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanupRepo(repo);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
}

async function setConfig(box: Sandbox, config: unknown): Promise<void> {
  await writeFile(join(box.threadhopHome, "config.json"), JSON.stringify(config));
}

function claudeLine(role: "user" | "assistant", text: string, at: string): string {
  return JSON.stringify({
    type: role,
    sessionId: SESSION,
    timestamp: at,
    message: role === "user" ? { role, content: text } : { role, model: "claude-x", content: [{ type: "text", text }] },
  }) + "\n";
}

/** A real Claude Code transcript for a session run in the repo, as its hook would point at. */
async function writeTranscript(box: Sandbox): Promise<string> {
  const dir = join(box.claudeDir, "projects", "source-session");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${SESSION}.jsonl`);
  await writeFile(
    path,
    claudeLine("user", "how do I rotate the logs", "2026-01-01T00:00:00.000Z") +
      claudeLine("assistant", "rename the file once it passes a size", "2026-01-01T00:00:01.000Z"),
  );
  return path;
}

async function codexCopies(box: Sandbox): Promise<string[]> {
  const dir = join(box.codexHome, "sessions");
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(dir, e));
}

async function mirrorLog(): Promise<string> {
  return readFile(mirrorLogPath(), "utf8").catch(() => "");
}

/** Run `fn` with stdout captured; enable/disable/status print their report there. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const write = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => ((out += chunk.toString()), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => ((out += chunk.toString()), true)) as typeof process.stderr.write;
  try {
    return { result: await fn(), out };
  } finally {
    process.stdout.write = write;
    process.stderr.write = errWrite;
  }
}

// ---------------------------------------------------------------------------
// Lock and queue

test("mirror lock: a queued request waits for the holder, then runs once", async () => {
  await withSandbox(async ({ repo }) => {
    assert.equal(await tryLock(repo), true);
    assert.equal(await tryLock(repo), false, "held");
    const runs: string[][] = [];
    const pending = processQueued(repo, { source: "claude-code", sessionId: "s1", cwd: "/w" }, async (requests) => {
      runs.push(requests.map((r) => r.sessionId));
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(runs, [], "nothing runs while another run holds the lock");
    await enqueue(repo, { source: "claude-code", sessionId: "s1", cwd: "/w" }); // the same session's SessionEnd
    await unlock(repo);
    assert.deepEqual(await pending, { ran: true });
    assert.deepEqual(runs, [["s1"]], "back-to-back triggers for one session coalesce into one run");
    assert.deepEqual(await drain(repo), [], "queue left empty");
  });
});

test("mirror lock: an abandoned lock is taken over; a live one makes withMirrorLock time out", async () => {
  await withSandbox(async ({ repo }) => {
    const lock = join(repo.commonDir, "threadhop", "mirror.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    assert.equal(await tryLock(repo), true, "a lock whose process is gone is taken over");

    await assert.rejects(withMirrorLock(repo, async () => "ran", 300), /another threadhop run has held/);
    await unlock(repo);
    assert.equal(await withMirrorLock(repo, async () => "ran"), "ran");
    assert.equal(await tryLock(repo), true, "released after the run");
    await unlock(repo);
  });
});

// ---------------------------------------------------------------------------
// The triggered run

test("trigger: captures the session and mirrors only it; then up to date; then updated", async () => {
  await withSandbox(async (box) => {
    await setConfig(box, { mirror: { auto: true, targets: ["codex"] } });
    await seedConversation(box.repo, "opencode:ses_other", "opencode", [
      { role: "user", text: "an unrelated conversation", seq: 0, email: ME, occurredAt: "2026-01-02T00:00:00.000Z" },
    ]);
    const transcriptPath = await writeTranscript(box);
    const args = { source: "claude-code" as const, transcriptPath, cwd: box.repo.root, sessionId: SESSION };

    await quietly(() => runTriggered(args));
    const copies = await codexCopies(box);
    assert.equal(copies.length, 1, "only the triggering conversation is mirrored");
    assert.match(await readFile(copies[0]!, "utf8"), /rename the file once it passes a size/);
    assert.match(await mirrorLog(), /created Codex copy of "how do I rotate the logs"/);

    await quietly(() => runTriggered(args));
    assert.match(await mirrorLog(), /claude-code:.* copies already up to date/);

    await appendFile(
      transcriptPath,
      claudeLine("user", "and keep five of them", "2026-01-01T00:01:00.000Z") +
        claudeLine("assistant", "delete the sixth oldest", "2026-01-01T00:01:01.000Z"),
    );
    await quietly(() => runTriggered(args));
    assert.deepEqual(await codexCopies(box), copies, "same copy, brought up to date");
    assert.match(await readFile(copies[0]!, "utf8"), /delete the sixth oldest/);
    assert.match(await mirrorLog(), /updated Codex copy of/);
  });
});

test("trigger: does nothing unless automatic mirroring is on", async () => {
  await withSandbox(async (box) => {
    await setConfig(box, { mirror: { targets: ["codex"] } });
    const transcriptPath = await writeTranscript(box);
    await quietly(() => runTriggered({ source: "claude-code", transcriptPath, cwd: box.repo.root }));
    assert.deepEqual(await codexCopies(box), []);
    assert.equal(await mirrorLog(), "");
  });
});

test("mirror refuses a repository where conversation-ledger is turned off", async () => {
  await withSandbox(async (box) => {
    await seedConversation(box.repo, "opencode:ses_off", "opencode", [
      { role: "user", text: "captured before it was turned off", seq: 0, email: ME, occurredAt: "2026-01-01T00:00:00.000Z" },
    ]);
    await writeFile(join(box.repo.root, ".cledger.json"), JSON.stringify({ enabled: false }));
    await assert.rejects(
      runMirror(box.repo, "/work/off", { targets: [claudeCodeTarget, codexTarget], self: ME, limit: 10, replayReasoning: false }),
      /turned off .* would add new ones on every run/,
    );
    assert.deepEqual(await codexCopies(box), [], "nothing written");
  });
});

// ---------------------------------------------------------------------------
// Installing the trigger

const CLAUDE_SETTINGS = {
  model: "opus",
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "cledger hook claude-code", timeout: 120 }] }],
    SessionEnd: [{ hooks: [{ type: "command", command: "cledger hook claude-code", timeout: 120 }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-guard" }] }],
  },
};

const CODEX_CONFIG = `model = "gpt-x"

[plugins."a@b"]
enabled = true

# conversation-ledger capture (added by cledger install codex)
[features]
hooks = true

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "cledger hook codex"
timeout = 120
`;

test("trigger install: added beside cledger's hooks, invisible to cledger's own check, removed exactly", async () => {
  await withSandbox(async () => {
    const claudePath = hookConfigPath("claude-code");
    const codexPath = hookConfigPath("codex");
    await mkdir(join(claudePath, ".."), { recursive: true });
    await mkdir(join(codexPath, ".."), { recursive: true });
    await writeFile(claudePath, JSON.stringify(CLAUDE_SETTINGS, null, 2) + "\n");
    await writeFile(codexPath, CODEX_CONFIG);

    for (const source of ["claude-code", "codex"] as const) {
      assert.deepEqual(await hookState(source), { capture: true, trigger: false }, source);
      assert.equal(await installTrigger(source), "added");
      assert.equal(await installTrigger(source), "present", "installing twice adds nothing");
      assert.deepEqual(await hookState(source), { capture: true, trigger: true }, source);
    }

    const settings = JSON.parse(await readFile(claudePath, "utf8")) as typeof CLAUDE_SETTINGS;
    const added = settings.hooks.Stop.flatMap((e) => e.hooks.map((h) => h.command)).filter((c) => c !== "cledger hook claude-code");
    assert.equal(added.length, 1);
    assert.match(added[0]!, /mirror-trigger claude-code$/);
    // cledger decides its hook is installed when a command contains "hook <cli>".
    assert.doesNotMatch(added[0]!, /hook claude-code/);
    const toml = await readFile(codexPath, "utf8");
    assert.match(toml, /mirror-trigger codex/);
    assert.doesNotMatch(toml.slice(CODEX_CONFIG.length), /hook codex/);
    // Codex 0.169 clamps SessionEnd hooks to 3s and warns on every run when asked for more.
    assert.match(toml.slice(CODEX_CONFIG.length), /\[\[hooks\.SessionEnd\.hooks\]\][^[]*timeout = 3\n/);

    // A trigger an earlier threadhop wrote differently is repaired in place, not duplicated.
    await writeFile(codexPath, toml.replace(/(SessionEnd\.hooks\]\][^[]*timeout = )3/, "$110"));
    const staleSettings = JSON.parse(await readFile(claudePath, "utf8")) as typeof CLAUDE_SETTINGS;
    staleSettings.hooks.Stop[1]!.hooks[0]!.timeout = 99;
    await writeFile(claudePath, JSON.stringify(staleSettings, null, 2) + "\n");
    assert.equal(await installTrigger("codex"), "updated");
    assert.equal(await installTrigger("claude-code"), "updated");
    assert.equal(await readFile(codexPath, "utf8"), toml, "the block is back to what install writes");
    assert.deepEqual(JSON.parse(await readFile(claudePath, "utf8")), settings);
    assert.equal(await installTrigger("codex"), "present");

    assert.equal(await removeTrigger("claude-code"), "removed");
    assert.equal(await removeTrigger("codex"), "removed");
    assert.equal(await removeTrigger("codex"), "absent");
    assert.deepEqual(JSON.parse(await readFile(claudePath, "utf8")), CLAUDE_SETTINGS, "other hooks untouched");
    assert.equal(await readFile(codexPath, "utf8"), CODEX_CONFIG, "config restored byte for byte");
    const backups = (await readdir(join(codexPath, ".."))).filter((f) => f.startsWith("config.toml.bak-"));
    assert.ok(backups.length >= 1, "the original is backed up before each change");
  });
});

test("mirror enable: refuses, changing nothing, while a source CLI isn't captured; disable undoes it", async () => {
  await withSandbox(async (box) => {
    const claudePath = hookConfigPath("claude-code");
    await mkdir(join(claudePath, ".."), { recursive: true });
    await writeFile(claudePath, JSON.stringify(CLAUDE_SETTINGS, null, 2) + "\n");

    // Codex is a target and a source (of conversations to copy into Claude Code), but isn't captured.
    const refused = await quietly(() => enableCommand(["codex", "claude"]));
    assert.equal(refused.result, 1);
    assert.match(refused.out, /Run `cledger install codex` first/);
    assert.deepEqual(await hookState("claude-code"), { capture: true, trigger: false }, "nothing installed");
    await assert.rejects(readFile(join(box.threadhopHome, "config.json"), "utf8"), "config not written");

    // Into Codex only: Codex sessions have nowhere to go, so only Claude Code needs the trigger.
    const enabled = await quietly(() => enableCommand(["codex"]));
    assert.equal(enabled.result, 0, enabled.out);
    assert.match(enabled.out, /automatic mirroring is on, into Codex/);
    assert.deepEqual(await hookState("claude-code"), { capture: true, trigger: true });
    assert.deepEqual(await hookState("codex"), { capture: false, trigger: false });
    const config = JSON.parse(await readFile(join(box.threadhopHome, "config.json"), "utf8"));
    assert.deepEqual(config.mirror, { targets: ["codex"], auto: true });

    const disabled = await quietly(() => disableCommand());
    assert.equal(disabled.result, 0);
    assert.deepEqual(await hookState("claude-code"), { capture: true, trigger: false });
    assert.equal(JSON.parse(await readFile(join(box.threadhopHome, "config.json"), "utf8")).mirror.auto, false);
  });
});

// ---------------------------------------------------------------------------
// Through the real CLI, as a hook runs it

function runCli(args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

test("mirror-trigger CLI: returns at once and silently; the detached worker makes the copy", async () => {
  await withSandbox(async (box) => {
    await setConfig(box, { mirror: { auto: true, targets: ["codex"] } });
    const transcriptPath = await writeTranscript(box);
    const payload = JSON.stringify({ session_id: SESSION, transcript_path: transcriptPath, cwd: box.repo.root, hook_event_name: "Stop" });

    const run = await runCli(["mirror-trigger", "claude-code"], box.env, payload);
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "", "a Stop hook's output would show up in the session");
    assert.equal(run.stderr, "");

    const deadline = Date.now() + 20_000;
    while (!/created Codex copy/.test(await mirrorLog()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(await mirrorLog(), /created Codex copy of "how do I rotate the logs"/);
    assert.equal((await codexCopies(box)).length, 1);

    for (const junk of ["", "not json", "{}"]) {
      const quiet = await runCli(["mirror-trigger", "claude-code"], box.env, junk);
      assert.deepEqual([quiet.code, quiet.stdout, quiet.stderr], [0, "", ""], `stdin: ${JSON.stringify(junk)}`);
    }
  });
});
