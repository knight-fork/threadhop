import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoInfo } from "conversation-ledger";
import { listConversations } from "../conversations.js";
import { stableUuid } from "../stable-id.js";
import {
  buildSessionLines,
  claudeCodeTarget,
  conversationLines,
  encodeProjectDir,
  planSessionAppend,
  type FabricatedLine,
} from "../targets/claude-code.js";
import { buildRolloutLines, codexTarget, rolloutDivergence } from "../targets/codex.js";
import { MirrorDivergedError, type TargetAdapter } from "../targets/types.js";
import type { ConversationSummary } from "../types.js";
import { cleanupRepo, makeTempRepo, seedConversation, type TurnSpec } from "./helpers.js";

const SOURCE = "opencode:ses_update_in_place";
const CWD = "/work/update-in-place";
const NOW = new Date("2026-03-01T00:00:00.000Z");

const FIRST: TurnSpec[] = [
  { role: "user", text: "find the flaky test", seq: 0, email: "me@x.com" },
  { role: "assistant", text: "It races on the port.", seq: 1 },
];
const MORE: TurnSpec[] = [
  { role: "user", text: "pin the port then", seq: 2, email: "me@x.com" },
  { role: "assistant", text: "Done; it now binds port 0.", seq: 3 },
];

interface Sandbox {
  repo: RepoInfo;
  claudeDir: string;
  codexHome: string;
  summary(): Promise<ConversationSummary>;
}

/**
 * A temp repo plus fake `claude`/`codex` binaries and private config dirs, so
 * fabrication never reaches the real CLIs or the developer's own sessions.
 */
async function withSandbox(fn: (box: Sandbox) => Promise<void>): Promise<void> {
  const repo = await makeTempRepo();
  const binDir = await mkdtemp(join(tmpdir(), "threadhop-uip-bin-"));
  const claudeDir = await mkdtemp(join(tmpdir(), "threadhop-uip-claude-"));
  const codexHome = await mkdtemp(join(tmpdir(), "threadhop-uip-codex-"));
  for (const [name, version] of [["claude", "2.1.316 (Claude Code)"], ["codex", "codex-cli 0.146.0"]]) {
    const path = join(binDir, name!);
    await writeFile(path, `#!/bin/sh\necho "${version}"\n`);
    await chmod(path, 0o755);
  }
  const saved = {
    PATH: process.env["PATH"],
    CLAUDE_CONFIG_DIR: process.env["CLAUDE_CONFIG_DIR"],
    CODEX_HOME: process.env["CODEX_HOME"],
  };
  process.env["PATH"] = `${binDir}:${saved.PATH ?? ""}`;
  process.env["CLAUDE_CONFIG_DIR"] = claudeDir;
  process.env["CODEX_HOME"] = codexHome;
  try {
    await seedConversation(repo, SOURCE, "opencode", FIRST);
    await fn({
      repo,
      claudeDir,
      codexHome,
      async summary() {
        const [summary] = await listConversations(repo, { all: true });
        assert.ok(summary);
        return summary;
      },
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanupRepo(repo);
    for (const dir of [binDir, claudeDir, codexHome]) await rm(dir, { recursive: true, force: true });
  }
}

/** Records Claude Code 2.1.316 appended when a fabricated session was merely opened and closed. */
function claudeOpenRecords(sid: string): string {
  return [
    { type: "atis-latch", atis: "", sessionId: sid },
    { type: "cost-state", sessionId: sid, totalCostUSD: 0, totalDuration: 4178, modelUsage: {} },
    { type: "file-history-snapshot", messageId: "90dcd6a9-9ea2-49dd-9399-18d79b6e8e50", snapshot: { trackedFileBackups: {} }, isSnapshotUpdate: false },
    { type: "mode", mode: "normal", sessionId: sid },
    { type: "permission-mode", permissionMode: "auto", sessionId: sid },
  ].map((record) => JSON.stringify(record) + "\n").join("");
}

function jsonl(lines: FabricatedLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
}

/** Walk parentUuid back from the last chain line, as Claude's resume does. */
function resumedChain(body: string): string[] {
  const chain = body.trim().split("\n").map((l) => JSON.parse(l) as { uuid?: string; parentUuid?: string | null })
    .filter((l) => typeof l.uuid === "string");
  const byUuid = new Map(chain.map((l) => [l.uuid!, l]));
  const walked: string[] = [];
  for (let line = chain[chain.length - 1]; line; line = line.parentUuid ? byUuid.get(line.parentUuid) : undefined) {
    walked.unshift(line.uuid!);
  }
  return walked;
}

function sessionIdOf(id: string | undefined): string {
  assert.ok(id);
  return id.split(":").slice(1).join(":");
}

async function codexRollouts(codexHome: string): Promise<string[]> {
  const entries = await readdir(join(codexHome, "sessions"), { recursive: true });
  return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(codexHome, "sessions", e));
}

test("stableUuid is a deterministic RFC 4122 version-5 uuid", () => {
  const a = stableUuid("session-a:event:e1");
  assert.equal(a, stableUuid("session-a:event:e1"));
  assert.notEqual(a, stableUuid("session-b:event:e1"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("claude: rebuilding the same history for a session reproduces its uuids", async () => {
  await withSandbox(async (box) => {
    const summary = await box.summary();
    const sid = "11111111-1111-4111-8111-111111111111";
    const once = conversationLines(buildSessionLines(summary, sid, CWD, "2.1.316", NOW)).map((l) => l.uuid);
    const again = conversationLines(buildSessionLines(summary, sid, CWD, "2.1.316", new Date())).map((l) => l.uuid);
    assert.deepEqual(again, once);
    const other = conversationLines(
      buildSessionLines(summary, "22222222-2222-4222-8222-222222222222", CWD, "2.1.316", NOW),
    ).map((l) => l.uuid);
    assert.equal(other.some((uuid) => once.includes(uuid)), false, "distinct sessions share no uuids");
  });
});

test("claude: a grown source appends only the new chain lines", async () => {
  await withSandbox(async (box) => {
    const sid = "33333333-3333-4333-8333-333333333333";
    const before = buildSessionLines(await box.summary(), sid, CWD, "2.1.316", NOW);
    await seedConversation(box.repo, SOURCE, "opencode", MORE);
    const after = buildSessionLines(await box.summary(), sid, CWD, "2.1.316", NOW);
    const plan = planSessionAppend(jsonl(before) + claudeOpenRecords(sid), after);
    assert.ok("append" in plan, JSON.stringify(plan));
    assert.deepEqual(
      plan.append.map((l) => ("uuid" in l ? l.uuid : l.type)),
      conversationLines(after).slice(conversationLines(before).length).map((l) => l.uuid),
      "only the new turns, and no second ai-title",
    );
  });
});

test("claude: divergence means a chain line threadhop did not write", async () => {
  await withSandbox(async (box) => {
    const sid = "44444444-4444-4444-8444-444444444444";
    const lines = buildSessionLines(await box.summary(), sid, CWD, "2.1.316", NOW);
    const body = jsonl(lines);
    const typed = JSON.stringify({ type: "user", uuid: "typed-after-resume", parentUuid: null, message: { role: "user", content: "hi" } });
    assert.match((planSessionAppend(body + typed + "\n", lines) as { reason: string }).reason, /did not write/);
    const compacted = JSON.stringify({ type: "system", subtype: "compact_boundary", uuid: "claude-own" });
    assert.ok("reason" in planSessionAppend(body + compacted + "\n", lines), "any foreign chain line counts");
    assert.match((planSessionAppend(body + "{not json\n", lines) as { reason: string }).reason, /not JSON/);
    const renamed = JSON.stringify({ type: "custom-title", customTitle: "mine", sessionId: sid });
    assert.deepEqual(planSessionAppend(body + claudeOpenRecords(sid) + renamed + "\n", lines), { append: [] },
      "Claude's own state records and a user /rename are not divergence");
  });
});

async function claudeSessionFile(box: Sandbox, sid: string): Promise<string> {
  return join(box.claudeDir, "projects", encodeProjectDir(CWD), `${sid}.jsonl`);
}

test("claude: fabricate with existingSessionId brings the same session up to date", async () => {
  await withSandbox(async (box) => {
    const first = await claudeCodeTarget.fabricate(await box.summary(), CWD, { replayReasoning: false });
    const sid = sessionIdOf(first.fabricatedConversationId);
    const path = await claudeSessionFile(box, sid);
    const beforeCount = conversationLines(
      (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l)),
    ).length;

    // opened and closed in Claude, with nothing typed
    await appendFile(path, claudeOpenRecords(sid));
    await seedConversation(box.repo, SOURCE, "opencode", MORE);
    const second = await claudeCodeTarget.fabricate(await box.summary(), CWD, {
      replayReasoning: false,
      existingSessionId: sid,
    });
    assert.equal(second.fabricatedConversationId, `claude-code:${sid}`);
    assert.match(second.notes.join("\n"), /^updated Claude Code session/m);
    const files = await readdir(join(box.claudeDir, "projects", encodeProjectDir(CWD)));
    assert.deepEqual(files, [`${sid}.jsonl`], "no second session");
    const after = await readFile(path, "utf8");
    assert.match(after, /binds port 0/);
    const afterCount = conversationLines(after.trim().split("\n").map((l) => JSON.parse(l))).length;
    assert.equal(afterCount, beforeCount + MORE.length);
    assert.ok(after.includes(claudeOpenRecords(sid)), "Claude's own records are kept in place");
    assert.equal(resumedChain(after).length, afterCount, "the parentUuid walk reaches every turn");

    const third = await claudeCodeTarget.fabricate(await box.summary(), CWD, {
      replayReasoning: false,
      existingSessionId: sid,
    });
    assert.match(third.notes.join("\n"), /already up to date/);
    assert.equal(await readFile(path, "utf8"), after, "nothing new, nothing written");
  });
});

test("claude: a continued session is refused and left byte-identical", async () => {
  await withSandbox(async (box) => {
    const first = await claudeCodeTarget.fabricate(await box.summary(), CWD, { replayReasoning: false });
    const sid = sessionIdOf(first.fabricatedConversationId);
    const path = await claudeSessionFile(box, sid);
    await appendFile(path, JSON.stringify({ type: "user", uuid: "typed-after-resume", message: { role: "user", content: "next" } }) + "\n");
    const before = await readFile(path, "utf8");
    await seedConversation(box.repo, SOURCE, "opencode", MORE);
    await assert.rejects(
      claudeCodeTarget.fabricate(await box.summary(), CWD, { replayReasoning: false, existingSessionId: sid }),
      (error: unknown) => error instanceof MirrorDivergedError && error.sessionId === sid,
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("claude: existingSessionId with no file on disk writes that session fresh", async () => {
  await withSandbox(async (box) => {
    const sid = "55555555-5555-4555-8555-555555555555";
    const plan = await claudeCodeTarget.fabricate(await box.summary(), CWD, {
      replayReasoning: false,
      existingSessionId: sid,
    });
    assert.equal(plan.fabricatedConversationId, `claude-code:${sid}`);
    assert.match(plan.notes.join("\n"), /^fabricated Claude Code session/m);
    await readFile(await claudeSessionFile(box, sid), "utf8");
  });
});

test("codex: rebuilding the same history reproduces every history line", async () => {
  await withSandbox(async (box) => {
    const sid = "66666666-6666-4666-8666-666666666666";
    const summary = await box.summary();
    const once = buildRolloutLines(summary, sid, CWD, "0.146.0", NOW, false);
    const again = buildRolloutLines(summary, sid, CWD, "0.146.0", new Date(), false);
    const body = once.map((l) => JSON.stringify(l)).join("\n") + "\n";
    assert.equal(rolloutDivergence(body, again, sid), null);
    assert.match(rolloutDivergence(body, again, "77777777-7777-4777-8777-777777777777") ?? "", /session_meta/);
  });
});

test("codex: fabricate with existingSessionId rewrites the original rollout file", async () => {
  await withSandbox(async (box) => {
    const first = await codexTarget.fabricate(await box.summary(), CWD, { replayReasoning: false });
    const sid = sessionIdOf(first.fabricatedConversationId);
    const [path] = await codexRollouts(box.codexHome);
    assert.ok(path);

    await seedConversation(box.repo, SOURCE, "opencode", MORE);
    const second = await codexTarget.fabricate(await box.summary(), CWD, {
      replayReasoning: false,
      existingSessionId: sid,
    });
    assert.equal(second.fabricatedConversationId, `codex:${sid}`);
    assert.match(second.notes.join("\n"), /^updated Codex session/m);
    assert.deepEqual(await codexRollouts(box.codexHome), [path], "same file, no second rollout");
    const dir = await readdir(join(path, ".."));
    assert.equal(dir.some((name) => name.endsWith(".tmp")), false, "no leftover temp file");
    assert.match(await readFile(path, "utf8"), /binds port 0/);
  });
});

test("codex: a continued rollout is refused and left byte-identical", async () => {
  await withSandbox(async (box) => {
    const first = await codexTarget.fabricate(await box.summary(), CWD, { replayReasoning: false });
    const sid = sessionIdOf(first.fabricatedConversationId);
    const [path] = await codexRollouts(box.codexHome);
    assert.ok(path);
    await appendFile(path, JSON.stringify({ timestamp: NOW.toISOString(), type: "turn_context", payload: {} }) + "\n");
    const before = await readFile(path, "utf8");
    await assert.rejects(
      codexTarget.fabricate(await box.summary(), CWD, { replayReasoning: false, existingSessionId: sid }),
      MirrorDivergedError,
    );
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("only adapters that rewrite in place advertise it", async () => {
  const { targets } = await import("../targets/index.js");
  const advertised = Object.values(targets as Record<string, TargetAdapter>)
    .filter((t) => t.supportsUpdateInPlace)
    .map((t) => t.name)
    .sort();
  assert.deepEqual(advertised, ["claude-code", "codex"]);
});
