import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readEvents, type RepoInfo } from "../vendor/conversation-ledger/index.js";
import { mirrorCandidates, renderMirrorResults, runMirror, type MirrorOptions, type MirrorResult } from "../mirror.js";
import type { ConversationSummary } from "../types.js";
import { claudeCodeTarget, encodeProjectDir } from "../targets/claude-code.js";
import { codexTarget } from "../targets/codex.js";
import { cleanupRepo, makeTempRepo, seedConversation, type TurnSpec } from "./helpers.js";

const ME = "test@example.com"; // makeTempRepo's git user.email
const CWD = "/work/mirror";
const FROM_OPENCODE = "opencode:ses_mirror_a";
const FROM_CLAUDE = "claude-code:11111111-1111-4111-8111-111111111111";

function turns(text: string, at: string, email = ME): TurnSpec[] {
  return [
    { role: "user", text: `${text} question`, seq: 0, occurredAt: at, email },
    { role: "assistant", text: `${text} answer`, seq: 1, occurredAt: at },
  ];
}

interface Box {
  repo: RepoInfo;
  claudeDir: string;
  codexHome: string;
  threadhopHome: string;
  mirror(overrides?: Partial<MirrorOptions>): Promise<MirrorResult[]>;
}

/** Temp repo, fake `claude`/`codex` binaries and private config dirs: nothing reaches real sessions. */
async function withBox(fn: (box: Box) => Promise<void>): Promise<void> {
  const repo = await makeTempRepo();
  const dirs = await Promise.all(
    ["bin", "claude", "codex", "home"].map((name) => mkdtemp(join(tmpdir(), `threadhop-mirror-${name}-`))),
  );
  const [binDir, claudeDir, codexHome, threadhopHome] = dirs as [string, string, string, string];
  for (const [name, version] of [["claude", "2.1.316 (Claude Code)"], ["codex", "codex-cli 0.146.0"]]) {
    await writeFile(join(binDir, name!), `#!/bin/sh\necho "${version}"\n`);
    await chmod(join(binDir, name!), 0o755);
  }
  const saved = Object.fromEntries(
    ["PATH", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "THREADHOP_HOME"].map((key) => [key, process.env[key]]),
  );
  process.env["PATH"] = `${binDir}:${saved["PATH"] ?? ""}`;
  process.env["CLAUDE_CONFIG_DIR"] = claudeDir;
  process.env["CODEX_HOME"] = codexHome;
  process.env["THREADHOP_HOME"] = threadhopHome;
  try {
    await fn({
      repo,
      claudeDir,
      codexHome,
      threadhopHome,
      mirror: (overrides = {}) =>
        runMirror(repo, CWD, {
          targets: [claudeCodeTarget, codexTarget],
          self: ME,
          limit: 10,
          replayReasoning: false,
          ...overrides,
        }),
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await cleanupRepo(repo);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
}

async function claudeCopies(box: Box): Promise<string[]> {
  return readdir(join(box.claudeDir, "projects", encodeProjectDir(CWD))).catch(() => []);
}

async function codexCopies(box: Box): Promise<string[]> {
  const dir = join(box.codexHome, "sessions");
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(dir, e));
}

async function continuationRecords(repo: RepoInfo): Promise<number> {
  return (await readEvents(repo, { kind: "continuation", tool: "threadhop" })).length;
}

function summarize(results: MirrorResult[]): string[] {
  return results.map((r) => `${r.conversation.id} -> ${r.target.name}: ${r.action}`).sort();
}

test("mirror: one copy per target for your conversations, never into the CLI they came from", async () => {
  await withBox(async (box) => {
    await seedConversation(box.repo, FROM_OPENCODE, "opencode", turns("opencode", "2026-01-01T00:00:00.000Z"));
    await seedConversation(box.repo, FROM_CLAUDE, "claude-code", turns("claude", "2026-01-02T00:00:00.000Z"));

    const results = await box.mirror();
    assert.deepEqual(summarize(results), [
      `${FROM_CLAUDE} -> codex: created`,
      `${FROM_OPENCODE} -> claude-code: created`,
      `${FROM_OPENCODE} -> codex: created`,
    ]);
    assert.equal((await claudeCopies(box)).length, 1);
    assert.equal((await codexCopies(box)).length, 2);
    const rendered = renderMirrorResults(results, CWD, false);
    assert.match(rendered, /^created {2}Codex copy of "claude question" \[Claude Code, /m);
    assert.match(rendered, /resume picker when it is run from \/work\/mirror/);
    assert.doesNotMatch(rendered, /session file:|rollout file:/, "file paths stay out of the summary");
  });
});

test("mirror: a run with nothing new writes nothing; a grown source is updated in place", async () => {
  await withBox(async (box) => {
    await seedConversation(box.repo, FROM_OPENCODE, "opencode", turns("opencode", "2026-01-01T00:00:00.000Z"));
    const first = await box.mirror();
    const records = await continuationRecords(box.repo);
    const claudeFile = join(box.claudeDir, "projects", encodeProjectDir(CWD), (await claudeCopies(box))[0]!);
    const before = await readFile(claudeFile, "utf8");

    const second = await box.mirror();
    assert.deepEqual(second.map((r) => r.action), ["unchanged", "unchanged"]);
    assert.equal(await continuationRecords(box.repo), records, "no new ledger records for an unchanged copy");
    assert.equal(await readFile(claudeFile, "utf8"), before);

    await seedConversation(box.repo, FROM_OPENCODE, "opencode", [
      { role: "user", text: "and one more thing", seq: 2, email: ME, occurredAt: "2026-01-01T00:05:00.000Z" },
      { role: "assistant", text: "handled the one more thing", seq: 3, occurredAt: "2026-01-01T00:05:01.000Z" },
    ]);
    const third = await box.mirror();
    assert.deepEqual(third.map((r) => r.action), ["updated", "updated"]);
    assert.deepEqual(third.map((r) => r.copy), first.map((r) => r.copy), "same sessions, brought up to date");
    assert.match(await readFile(claudeFile, "utf8"), /handled the one more thing/);
    assert.equal((await codexCopies(box)).length, 1);
  });
});

test("mirror: only your own conversations, never a collaborator's or a shared one", async () => {
  await withBox(async (box) => {
    await seedConversation(box.repo, FROM_OPENCODE, "opencode", turns("mine", "2026-01-01T00:00:00.000Z"));
    await seedConversation(box.repo, "opencode:ses_theirs", "opencode", turns("theirs", "2026-01-02T00:00:00.000Z", "them@example.com"));
    await seedConversation(box.repo, "opencode:ses_shared", "opencode", [
      ...turns("shared", "2026-01-04T00:00:00.000Z"),
      { role: "user", text: "their follow-up", seq: 2, email: "them@example.com", occurredAt: "2026-01-04T00:01:00.000Z" },
    ]);
    const results = await box.mirror({ targets: [codexTarget] });
    assert.deepEqual(summarize(results), [`${FROM_OPENCODE} -> codex: created`]);
  });
});

test("mirror: a copy you continued is left as it is, and no second copy is made", async () => {
  await withBox(async (box) => {
    await seedConversation(box.repo, FROM_OPENCODE, "opencode", turns("opencode", "2026-01-01T00:00:00.000Z"));
    await box.mirror({ targets: [claudeCodeTarget] });
    const [file] = await claudeCopies(box);
    const path = join(box.claudeDir, "projects", encodeProjectDir(CWD), file!);
    await appendFile(path, JSON.stringify({ type: "user", uuid: "typed-here", message: { role: "user", content: "my branch" } }) + "\n");
    const before = await readFile(path, "utf8");
    await seedConversation(box.repo, FROM_OPENCODE, "opencode", [
      { role: "user", text: "later in opencode", seq: 2, email: ME, occurredAt: "2026-01-01T00:05:00.000Z" },
    ]);

    const [result] = await box.mirror({ targets: [claudeCodeTarget] });
    assert.equal(result?.action, "skipped-continued");
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await claudeCopies(box), [file]);
    assert.match(renderMirrorResults([result!], CWD, false), /^skipped {2}Claude Code copy .*continued there/m);
  });
});

test("mirror: untouched copies are not mirrored back; a copy you continued is mirrored as a branch", async () => {
  await withBox(async (box) => {
    await seedConversation(box.repo, FROM_OPENCODE, "opencode", turns("opencode", "2026-01-01T00:00:00.000Z"));
    const first = await box.mirror();
    const codexCopy = first.find((r) => r.target === codexTarget)?.copy;
    assert.ok(codexCopy);

    // cledger captures the Codex copy once it is opened: the same imported turns
    await seedConversation(box.repo, codexCopy, "codex", turns("opencode", "2026-01-01T00:00:00.000Z"));
    const second = await box.mirror();
    assert.deepEqual(summarize(second), [
      `${FROM_OPENCODE} -> claude-code: unchanged`,
      `${FROM_OPENCODE} -> codex: unchanged`,
    ]);

    // the user then continues it in Codex: now it is a conversation of its own
    const later = new Date(Date.now() + 60_000).toISOString();
    await seedConversation(box.repo, codexCopy, "codex", [
      { role: "user", text: "taking this further in codex", seq: 2, email: ME, occurredAt: later },
    ]);
    const third = await box.mirror();
    assert.ok(summarize(third).includes(`${codexCopy} -> claude-code: created`));
    assert.equal((await claudeCopies(box)).length, 2);
  });
});

test("mirror: --limit keeps only your most recent conversations", async () => {
  await withBox(async (box) => {
    await seedConversation(box.repo, "opencode:ses_old", "opencode", turns("old", "2026-01-01T00:00:00.000Z"));
    await seedConversation(box.repo, "opencode:ses_mid", "opencode", turns("mid", "2026-01-02T00:00:00.000Z"));
    await seedConversation(box.repo, "opencode:ses_new", "opencode", turns("new", "2026-01-03T00:00:00.000Z"));
    const results = await box.mirror({ targets: [codexTarget], limit: 2 });
    assert.deepEqual(summarize(results), [
      "opencode:ses_mid -> codex: created",
      "opencode:ses_new -> codex: created",
    ]);
  });
});

test("mirror: --dry-run writes nothing and says what a real run would do", async () => {
  await withBox(async (box) => {
    await seedConversation(box.repo, FROM_OPENCODE, "opencode", turns("opencode", "2026-01-01T00:00:00.000Z"));
    const dry = await box.mirror({ dryRun: true });
    assert.deepEqual(dry.map((r) => r.action), ["would-create", "would-create"]);
    assert.deepEqual(await claudeCopies(box), []);
    assert.deepEqual(await codexCopies(box), []);
    assert.equal(await continuationRecords(box.repo), 0);
    assert.match(renderMirrorResults(dry, CWD, true), /dry run: nothing was written/);

    await box.mirror();
    const again = await box.mirror({ dryRun: true });
    assert.deepEqual(again.map((r) => r.action), ["would-update", "would-update"]);
  });
});

test("mirror command: rejects a CLI that can't update a copy in place, and asks for targets", async () => {
  await withBox(async (box) => {
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [cli, "mirror", ...args], { cwd: box.repo.root, encoding: "utf8", env: process.env });

    const gemini = run("gemini");
    assert.equal(gemini.status, 1);
    assert.match(gemini.stderr, /Gemini.* can't update a copy in place yet/);

    const none = run();
    assert.equal(none.status, 1);
    assert.match(none.stderr, /name the CLIs to keep copies in/);

    const badLimit = run("codex", "--limit", "0");
    assert.equal(badLimit.status, 1);
    assert.match(badLimit.stderr, /--limit takes a positive whole number/);
  });
});

test("mirror: conversations with no recorded author are never treated as yours", () => {
  // Only data captured before identity stamping has no human actor ids; the
  // ledger stamps the git identity on everything appended now.
  const summary = (id: string, owners: string[]): ConversationSummary => ({
    id, source: "opencode", sessionId: id, title: id, firstActivity: "2026-01-01T00:00:00.000Z",
    lastActivity: "2026-01-01T00:00:00.000Z", turnCount: 1, owners, ownerDisplays: [], events: [],
  });
  const lineage = { parentOf: new Map(), childrenOf: new Map() };
  const picked = mirrorCandidates([summary("opencode:legacy", []), summary("opencode:mine", [ME])], lineage, ME, 10);
  assert.deepEqual(picked.map((c) => c.id), ["opencode:mine"]);
});
