import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceEvent } from "conversation-ledger";
import type { ContinuationRecord, Lineage } from "../lineage.js";
import { renderConversationRow } from "../resume.js";
import { branchRows, buildBranchTree, withBranchesOfYours } from "../tree.js";
import type { ConversationSummary } from "../types.js";
import { turnDraft, type TurnSpec } from "./helpers.js";

const ME = "me@example.com";
const BOB = "bob@example.com";
const FORK = "2026-11-10T12:00:00.000Z"; // when each branch below was started
const BEFORE = (minute: number) => `2026-11-10T11:${String(minute).padStart(2, "0")}:00.000Z`;
const AFTER = (minute: number) => `2026-11-10T13:${String(minute).padStart(2, "0")}:00.000Z`;

function conv(id: string, turns: TurnSpec[]): ConversationSummary {
  const source = id.split(":")[0]!;
  const events = turns.map(
    (t) => ({ ...turnDraft(id, source, t), id: `${id}#${t.seq}`, recorded_at: t.occurredAt }) as unknown as EvidenceEvent,
  );
  const owners = [...new Set(turns.filter((t) => t.role === "user" && t.email).map((t) => t.email!))];
  return {
    id,
    source,
    sessionId: id.split(":")[1]!,
    title: turns.find((t) => t.role === "user")?.text ?? "",
    firstActivity: turns[0]!.occurredAt!,
    lastActivity: turns[turns.length - 1]!.occurredAt!,
    turnCount: turns.length,
    owners,
    ownerDisplays: owners.map((o) => o.split("@")[0]!.replace(/^./, (c) => c.toUpperCase())),
    events,
  };
}

/** The first `n` turns of a conversation as a copy holds them: same text and times. */
function copied(turns: TurnSpec[], n: number): TurnSpec[] {
  return turns.slice(0, n);
}

function lineageOf(records: ContinuationRecord[]): Lineage {
  const lineage: Lineage = { parentOf: new Map(), childrenOf: new Map() };
  for (const rec of records) {
    lineage.parentOf.set(rec.target, rec);
    lineage.childrenOf.set(rec.source, [...(lineage.childrenOf.get(rec.source) ?? []), rec]);
  }
  return lineage;
}

function rec(source: string, target: string, importedThroughSeq: number, targetCli: string): ContinuationRecord {
  return { source, target, importedThroughSeq, targetCli, mode: "native-import", occurredAt: FORK };
}

// My conversation: four turns before anyone branched, two more after.
const MINE: TurnSpec[] = [
  { role: "user", text: "plan the expression parser", seq: 0, email: ME, occurredAt: BEFORE(0) },
  { role: "assistant", text: "recursive descent fits", seq: 1, occurredAt: BEFORE(1) },
  { role: "user", text: "write the tokenizer first", seq: 2, email: ME, occurredAt: BEFORE(2) },
  { role: "assistant", text: "tokenizer written", seq: 3, occurredAt: BEFORE(3) },
  { role: "user", text: "switch to a pratt parser", seq: 4, email: ME, occurredAt: AFTER(5) },
  { role: "assistant", text: "rewrote it", seq: 5, occurredAt: AFTER(6) },
];
const A = conv("claude-code:mine", MINE);
// Bob picked it up in Codex after turn 4 and added two turns of his own.
const B = conv("codex:bobs", [
  ...copied(MINE, 4).map((t) => (t.role === "user" ? { ...t, email: BOB } : t)),
  { role: "user", text: "handle operator precedence", seq: 4, email: BOB, occurredAt: AFTER(1) },
  { role: "assistant", text: "added a precedence table", seq: 5, occurredAt: AFTER(2) },
]);
// A mirror copy in Codex that nobody typed in: the same point as mine.
const COPY = conv("codex:mirror-copy", copied(MINE, 4));
// Someone opened that copy and typed in it: a real branch, which belongs under mine.
const D = conv("claude-code:from-copy", [
  ...copied(MINE, 4),
  { role: "user", text: "add error recovery", seq: 4, email: ME, occurredAt: AFTER(3) },
]);
// Unrelated work by Bob.
const OTHER = conv("codex:other", [{ role: "user", text: "fix the build", seq: 0, email: BOB, occurredAt: AFTER(0) }]);

const LINEAGE = lineageOf([
  rec(A.id, B.id, 3, "codex"),
  rec(A.id, COPY.id, 3, "codex"),
  rec(COPY.id, D.id, 3, "claude-code"),
]);

test("branch tree: branches hang off what they continued; untouched copies are not branches", () => {
  const roots = buildBranchTree([A, B, COPY, D, OTHER], LINEAGE);
  assert.deepEqual(roots.map((r) => r.summary.id), [A.id, OTHER.id], "newest activity first");
  const mine = roots[0]!;
  assert.deepEqual(mine.children.map((c) => c.summary.id).sort(), [B.id, D.id].sort(), "the copy's branch moves up to mine");

  const bobs = mine.children.find((c) => c.summary.id === B.id)!;
  assert.equal(bobs.forkTurn, 4, "Bob started from my turn 4");
  assert.equal(bobs.ownTurns, 2, "and added two");
  assert.equal(bobs.label, "handle operator precedence", "labelled by what was asked on the branch");
  assert.equal(mine.forkTurn, null);
  assert.equal(mine.ownTurns, 6);
});

test("branch tree: a copy stays listed when what it copied is not", () => {
  const roots = buildBranchTree([COPY, D], LINEAGE);
  assert.deepEqual(roots.map((r) => r.summary.id), [COPY.id]);
  assert.deepEqual(roots[0]!.children.map((c) => c.summary.id), [D.id]);
  assert.deepEqual(buildBranchTree([B], LINEAGE).map((r) => r.from), [undefined], "parent not listed: a root");
});

test("branch rows: drawn like git log --graph, and rendered with where each branch starts", () => {
  const rows = branchRows(buildBranchTree([A, B, COPY, D], LINEAGE));
  assert.deepEqual(rows.map((r) => r.prefix), ["", "├─ ", "└─ "]);
  const bobsRow = rows.find((r) => r.node.summary.id === B.id)!;
  const rendered = renderConversationRow(B, rows.indexOf(bobsRow), ME, LINEAGE, bobsRow);
  assert.match(rendered, /Codex/);
  assert.match(rendered, /by Bob/);
  assert.match(rendered, /↳ from turn 4, \+2 turns {2}· handle operator precedence$/);
  const root = renderConversationRow(A, 0, ME, LINEAGE, rows[0]!);
  assert.match(root, /6 turns {2}· plan the expression parser$/, "no 'bridged to' tag: its branches are drawn below it");

  const nested = branchRows([
    { ...buildBranchTree([A], LINEAGE)[0]!, children: buildBranchTree([A, B, COPY, D], LINEAGE)[0]!.children.map((c, i) =>
      i === 0 ? { ...c, children: [{ ...c, children: [] }] } : c) },
  ]);
  assert.deepEqual(nested.map((r) => r.prefix), ["", "├─ ", "│  └─ ", "└─ "], "deeper branches keep the rail");
});

test("by default you're offered your conversations and every branch anyone made of them", () => {
  const offered = withBranchesOfYours([A, COPY, D], [A, B, COPY, D, OTHER], LINEAGE);
  assert.deepEqual(offered.map((c) => c.id), [A.id, B.id, COPY.id, D.id], "Bob's branch of mine, not his unrelated work");
});
