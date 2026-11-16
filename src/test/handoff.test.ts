import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureClaudeTranscript, captureCodexTranscript, findRepo, type RepoInfo } from "conversation-ledger";
import { historyFor } from "../copies.js";
import { listConversations } from "../conversations.js";
import { readLineage } from "../lineage.js";
import { buildPlan } from "../resume.js";
import { claudeCodeTarget } from "../targets/claude-code.js";
import { codexTarget } from "../targets/codex.js";
import { turnContent, type ConversationSummary } from "../types.js";

/**
 * Two people sharing one private repository, end to end through a real
 * remote: Alice works in Claude Code and pushes; Bob fetches, continues her
 * conversation in Codex and pushes; Alice keeps going in her original; then
 * Alice can resume either point. Each person has their own home, git identity
 * and CLI folders. Sharing is off globally (~/.config/cledger) and turned on
 * by the repository's own .cledger.json, as recommended for a private repo.
 */

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const ALICE_SESSION = "a11ce000-0000-4000-8000-000000000001";

interface Person {
  name: string;
  email: string;
  home: string;
  claudeDir: string;
  codexHome: string;
  threadhopHome: string;
  repoPath: string;
}

function run(cmd: string, args: string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const git = (cwd: string, ...args: string[]) => run("git", args, cwd);

/** Run `fn` as `person`: their home, CLI folders and threadhop config. */
async function as<T>(person: Person, fn: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "THREADHOP_HOME"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env["HOME"] = person.home;
  process.env["CLAUDE_CONFIG_DIR"] = person.claudeDir;
  process.env["CODEX_HOME"] = person.codexHome;
  process.env["THREADHOP_HOME"] = person.threadhopHome;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function makePerson(root: string, name: string, email: string): Promise<Person> {
  const home = join(root, name);
  const person: Person = {
    name,
    email,
    home,
    claudeDir: join(home, ".claude"),
    codexHome: join(home, ".codex"),
    threadhopHome: join(home, ".threadhop"),
    repoPath: join(home, "project"),
  };
  // Sharing off for every repository, as on a machine set up for privacy.
  await mkdir(join(home, ".config", "cledger"), { recursive: true });
  await writeFile(
    join(home, ".config", "cledger", "config.json"),
    JSON.stringify({ transport: { hook: false, fetchRefspec: false } }),
  );
  return person;
}

function claudeLine(role: "user" | "assistant", text: string, at: string): string {
  return JSON.stringify({
    type: role,
    sessionId: ALICE_SESSION,
    timestamp: at,
    message: role === "user" ? { role, content: text } : { role, model: "claude-x", content: [{ type: "text", text }] },
  }) + "\n";
}

/** The lines Codex writes for one exchange: display and model-context twins. */
function codexExchange(user: string, assistant: string, at: Date): string {
  const t1 = at.toISOString();
  const t2 = new Date(at.getTime() + 1000).toISOString();
  return [
    { timestamp: t1, type: "event_msg", payload: { type: "user_message", message: user, images: [], local_images: [], text_elements: [] } },
    { timestamp: t1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] } },
    { timestamp: t2, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: assistant }] } },
    { timestamp: t2, type: "event_msg", payload: { type: "agent_message", message: assistant, phase: "final_answer", memory_citation: null } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function texts(summary: ConversationSummary): string[] {
  return summary.events.flatMap((event) =>
    (turnContent(event)?.blocks ?? []).flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])),
  );
}

async function conversations(repo: RepoInfo) {
  const all = await listConversations(repo, { all: true });
  return { all, lineage: await readLineage(repo, false) };
}

async function codexRollouts(person: Person): Promise<string[]> {
  const dir = join(person.codexHome, "sessions");
  const entries = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((e) => e.endsWith(".jsonl")).map((e) => join(dir, e));
}

test("handoff: a teammate continues your conversation; you can resume your point or theirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "threadhop-handoff-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const [name, version] of [["claude", "2.1.316 (Claude Code)"], ["codex", "codex-cli 0.169.0"]]) {
    await writeFile(join(bin, name!), `#!/bin/sh\necho "${version}"\n`);
    await chmod(join(bin, name!), 0o755);
  }
  const savedPath = process.env["PATH"];
  process.env["PATH"] = `${bin}:${savedPath ?? ""}`;
  try {
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const alice = await makePerson(root, "alice", ALICE);
    const bob = await makePerson(root, "bob", BOB);

    // --- Alice starts the project and turns sharing on for this repository only.
    await mkdir(alice.repoPath, { recursive: true });
    git(alice.repoPath, "init", "-q", "-b", "main");
    for (const [key, value] of [["user.email", ALICE], ["user.name", "Alice"], ["commit.gpgsign", "false"]]) {
      git(alice.repoPath, "config", key!, value!);
    }
    await writeFile(join(alice.repoPath, "README.md"), "parser\n");
    await writeFile(join(alice.repoPath, ".cledger.json"), JSON.stringify({ transport: { hook: true, fetchRefspec: true } }) + "\n");
    git(alice.repoPath, "add", ".");
    git(alice.repoPath, "commit", "-q", "-m", "init");
    git(alice.repoPath, "remote", "add", "origin", remote);
    await as(alice, async () => git(alice.repoPath, "push", "-q", "-u", "origin", "main"));
    git(alice.repoPath, "checkout", "-q", "-b", "parser");
    await writeFile(join(alice.repoPath, "parser.ts"), "// todo\n");
    git(alice.repoPath, "add", ".");
    git(alice.repoPath, "commit", "-q", "-m", "start parser");

    // --- Alice works in Claude Code; cledger captures it; she pushes her branch.
    const aliceTranscript = join(alice.claudeDir, "projects", "alice-project", `${ALICE_SESSION}.jsonl`);
    await mkdir(join(aliceTranscript, ".."), { recursive: true });
    await writeFile(
      aliceTranscript,
      claudeLine("user", "plan the expression parser", "2026-11-01T09:00:00.000Z") +
        claudeLine("assistant", "a recursive descent parser fits", "2026-11-01T09:00:01.000Z") +
        claudeLine("user", "write the tokenizer first", "2026-11-01T09:01:00.000Z") +
        claudeLine("assistant", "tokenizer written in parser.ts", "2026-11-01T09:01:01.000Z"),
    );
    const aliceRepo = (await findRepo(alice.repoPath))!;
    await as(alice, () => captureClaudeTranscript(aliceTranscript, alice.repoPath));
    assert.ok(await stat(join(aliceRepo.commonDir, "hooks", "pre-push")), "the repo's .cledger.json overrides the global opt-out");
    await as(alice, async () => git(alice.repoPath, "push", "-q", "-u", "origin", "parser"));
    assert.match(git(root, "ls-remote", remote), /refs\/notes\/conversation-ledger/, "her conversation went up with the branch");

    // --- Bob clones, fetches the conversations once, and finds Alice's.
    git(root, "clone", "-q", remote, bob.repoPath);
    for (const [key, value] of [["user.email", BOB], ["user.name", "Bob"], ["commit.gpgsign", "false"]]) {
      git(bob.repoPath, "config", key!, value!);
    }
    git(bob.repoPath, "checkout", "-q", "parser");
    await as(bob, async () => run(process.execPath, [CLI, "records", "sync", "--fetch-only"], bob.repoPath));
    const bobRepo = (await findRepo(bob.repoPath))!;
    const seenByBob = await as(bob, () => conversations(bobRepo));
    const aliceConv = seenByBob.all.find((c) => c.id === `claude-code:${ALICE_SESSION}`);
    assert.ok(aliceConv, `Bob sees Alice's conversation (saw: ${seenByBob.all.map((c) => c.id).join(", ")})`);
    assert.deepEqual(aliceConv.owners, [ALICE]);

    // --- Bob continues it in Codex, adds his own turns, commits and pushes.
    const plan = await as(bob, () =>
      buildPlan(bobRepo, codexTarget, aliceConv, bob.repoPath, false, seenByBob.lineage, seenByBob.all, false),
    );
    const bobConvId = plan.fabricatedConversationId!;
    const [bobRollout] = await as(bob, () => codexRollouts(bob));
    assert.ok(bobRollout, "Codex copy written into Bob's own Codex folder");
    await appendFile(bobRollout, codexExchange("handle operator precedence", "added a precedence table", new Date(Date.now() + 2000)));
    await as(bob, () => captureCodexTranscript(bobRollout, bob.repoPath));
    await writeFile(join(bob.repoPath, "parser.ts"), "// tokenizer + precedence\n");
    git(bob.repoPath, "commit", "-q", "-am", "precedence");
    await as(bob, async () => git(bob.repoPath, "push", "-q", "origin", "parser"));

    // --- Meanwhile Alice keeps going in her original conversation.
    await appendFile(
      aliceTranscript,
      claudeLine("user", "switch to a pratt parser instead", new Date(Date.now() + 4000).toISOString()) +
        claudeLine("assistant", "rewrote it as a pratt parser", new Date(Date.now() + 5000).toISOString()),
    );
    await as(alice, () => captureClaudeTranscript(aliceTranscript, alice.repoPath));

    // --- Alice fetches: both points are there, linked. A plain `git pull` (or
    // `git fetch`) brings conversations; `git pull origin parser` would not,
    // because naming a branch makes git skip the configured notes refspec.
    await as(alice, async () => git(alice.repoPath, "pull", "-q", "--no-rebase", "--no-edit"));
    const seenByAlice = await as(alice, () => conversations(aliceRepo));
    const bobConv = seenByAlice.all.find((c) => c.id === bobConvId);
    const aliceNow = seenByAlice.all.find((c) => c.id === `claude-code:${ALICE_SESSION}`)!;
    assert.ok(bobConv, `Alice sees Bob's continuation (saw: ${seenByAlice.all.map((c) => c.id).join(", ")})`);
    assert.equal(seenByAlice.lineage.parentOf.get(bobConvId)?.source, aliceNow.id, "Bob's conversation is linked to hers");

    // Her point: everything she did, nothing of Bob's.
    const mine = historyFor(aliceNow, seenByAlice.all, seenByAlice.lineage).summary;
    assert.ok(texts(mine).includes("switch to a pratt parser instead"));
    assert.ok(!texts(mine).includes("handle operator precedence"));

    // His point: her turns up to where he picked up, then his; not what she did after.
    const his = historyFor(bobConv, seenByAlice.all, seenByAlice.lineage).summary;
    const hisTexts = texts(his);
    assert.ok(hisTexts.includes("write the tokenizer first"), "her turns before the handoff");
    assert.ok(hisTexts.includes("handle operator precedence"), "his turns");
    assert.ok(!hisTexts.includes("switch to a pratt parser instead"), "not her turns after the handoff");
    assert.ok(hisTexts.indexOf("write the tokenizer first") < hisTexts.indexOf("handle operator precedence"), "in order");
    const askedBy = (text: string) => his.events.find((e) => texts({ ...his, events: [e] }).includes(text))?.actor.id;
    assert.equal(askedBy("write the tokenizer first"), ALICE, "her turns stay hers");
    assert.equal(askedBy("handle operator precedence"), BOB, "his turns are his");

    // Her list shows both points as branches, Bob's included without --all.
    const listed = await as(alice, async () => run(process.execPath, [CLI, "list"], alice.repoPath));
    const lines = listed.trim().split("\n");
    assert.equal(lines.length, 2, listed);
    assert.match(lines[0]!, /^\[1\] {2}Claude Code .*6 turns {2}· plan the expression parser$/, listed);
    assert.match(
      lines[1]!,
      /^\[2\] {2}└─ Codex .* 6 turns {2}by (Bob|bob@example\.com) {2}↳ from turn 4, \+2 turns {2}· handle operator precedence$/,
      listed,
    );

    // And she can actually open his point in her own Claude Code.
    const resumed = await as(alice, () =>
      buildPlan(aliceRepo, claudeCodeTarget, bobConv, alice.repoPath, false, seenByAlice.lineage, seenByAlice.all, false),
    );
    assert.equal(resumed.fabrication, "created");
    const sessionFile = resumed.notes.map((n) => /^session file:\s*(\S+\.jsonl)/.exec(n)?.[1]).find(Boolean);
    const written = sessionFile ? await readFile(sessionFile, "utf8") : "";
    assert.match(written, /added a precedence table/);
    assert.doesNotMatch(written, /pratt/);
  } finally {
    process.env["PATH"] = savedPath;
    if (process.env["THREADHOP_TEST_KEEP"]) console.log(`kept ${root}`);
    else await rm(root, { recursive: true, force: true });
  }
});
