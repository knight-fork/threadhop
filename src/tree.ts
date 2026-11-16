import type { ContinuationRecord, Lineage } from "./lineage.js";
import { isUntouchedCopy } from "./lineage-resolution.js";
import { turnContent, type ConversationSummary } from "./types.js";

/**
 * Conversations as branches, the way `git log --graph` shows commits.
 *
 * Continuing a conversation in another CLI, or by another person, starts a
 * branch: the new conversation holds the original's turns up to that point,
 * then its own. Both can keep going independently, and either tip can be
 * resumed. A copy nobody typed in is the same point as its original, so it is
 * not a branch and is left out (its own branches hang off the original).
 */
export interface BranchNode {
  summary: ConversationSummary;
  /** How this branch started: absent for a root. */
  from?: ContinuationRecord;
  /** Turns of the parent this branch starts with ("from turn N"); null when the parent isn't listed. */
  forkTurn: number | null;
  /** Turns added on this branch itself, after it started. */
  ownTurns: number;
  /** The first thing asked on this branch itself: a branch's title would repeat its parent's. */
  label: string | null;
  children: BranchNode[];
}

function isTurn(event: ConversationSummary["events"][number]): boolean {
  return turnContent(event) !== null;
}

/** Turns of `parent` that `record` copied into its branch. */
function turnsThrough(parent: ConversationSummary, record: ContinuationRecord): number {
  const copied = record.sourceEventIds?.length ? new Set(record.sourceEventIds) : null;
  return parent.events.filter(
    (event) => isTurn(event) && (copied ? copied.has(event.id) : (event.stream?.seq ?? 0) <= record.importedThroughSeq),
  ).length;
}

/** Turns that originated on `summary`, not copied into it from its parent. */
function turnsAfter(summary: ConversationSummary, record: ContinuationRecord): number {
  const boundary = Date.parse(record.occurredAt);
  return summary.events.filter((event) => isTurn(event) && Date.parse(event.occurred_at) > boundary).length;
}

/** The first human message on `summary` after `record` started it, on one line. */
function firstOwnMessage(summary: ConversationSummary, record: ContinuationRecord): string | null {
  const boundary = Date.parse(record.occurredAt);
  for (const event of summary.events) {
    if (event.actor.type !== "human" || Date.parse(event.occurred_at) <= boundary) continue;
    const content = turnContent(event);
    if (content?.role !== "user") continue;
    for (const block of content.blocks) {
      const text = block.type === "text" && typeof block.text === "string" ? block.text.trim() : "";
      if (!text || text.startsWith("<")) continue;
      const line = text.replace(/\s+/g, " ");
      return line.length > 80 ? `${line.slice(0, 77)}...` : line;
    }
  }
  return null;
}

/** Newest activity anywhere in the subtree, so a branch someone just used sorts first. */
function latest(node: BranchNode): string {
  return node.children.reduce((max, child) => {
    const t = latest(child);
    return t > max ? t : max;
  }, node.summary.lastActivity);
}

function sortTree(nodes: BranchNode[]): BranchNode[] {
  for (const node of nodes) sortTree(node.children);
  return nodes.sort((a, b) => (latest(a) < latest(b) ? 1 : latest(a) > latest(b) ? -1 : 0));
}

/**
 * Arrange `conversations` into branches. A conversation whose parent isn't in
 * the list (another branch of the code, or filtered out) becomes a root.
 */
export function buildBranchTree(conversations: ConversationSummary[], lineage: Lineage): BranchNode[] {
  const byId = new Map(conversations.map((c) => [c.id, c]));
  // An untouched copy is hidden only when what it copies is listed: otherwise
  // it is the only way to reach that point.
  const hidden = new Set(
    conversations
      .filter((c) => byId.has(lineage.parentOf.get(c.id)?.source ?? "") && isUntouchedCopy(c, lineage))
      .map((c) => c.id),
  );
  const nodes = new Map<string, BranchNode>();
  for (const summary of conversations) {
    if (hidden.has(summary.id)) continue;
    nodes.set(summary.id, { summary, forkTurn: null, ownTurns: summary.turnCount, label: null, children: [] });
  }

  const roots: BranchNode[] = [];
  for (const node of nodes.values()) {
    const record = lineage.parentOf.get(node.summary.id);
    // Hang branches of a hidden copy off what it copied, so they keep a parent.
    let parentId = record?.source;
    const seen = new Set<string>();
    while (parentId && hidden.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      parentId = lineage.parentOf.get(parentId)?.source;
    }
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (!record || !parent || parent === node) {
      roots.push(node);
      continue;
    }
    node.from = record;
    node.forkTurn = turnsThrough(parent.summary, record);
    node.ownTurns = turnsAfter(node.summary, record);
    node.label = firstOwnMessage(node.summary, record);
    parent.children.push(node);
  }
  return sortTree(roots);
}

/** One picker row: the conversation, and the graph prefix that places it. */
export interface BranchRow {
  node: BranchNode;
  depth: number;
  /** e.g. "", "├─ ", "│  └─ " */
  prefix: string;
}

/** Depth-first rows, each prefixed like `git log --graph`. */
export function branchRows(roots: BranchNode[]): BranchRow[] {
  const rows: BranchRow[] = [];
  const walk = (nodes: BranchNode[], depth: number, lead: string) => {
    nodes.forEach((node, i) => {
      const last = i === nodes.length - 1;
      rows.push({ node, depth, prefix: depth === 0 ? "" : `${lead}${last ? "└─ " : "├─ "}` });
      walk(node.children, depth + 1, depth === 0 ? "" : `${lead}${last ? "   " : "│  "}`);
    });
  };
  walk(roots, 0, "");
  return rows;
}

/**
 * The conversations to offer by default: yours (and unattributed ones), plus
 * every branch someone else started from one of them, at any depth: picking
 * up where a teammate left off on your own work shouldn't need `--all`.
 */
export function withBranchesOfYours(
  yours: ConversationSummary[],
  everyone: ConversationSummary[],
  lineage: Lineage,
): ConversationSummary[] {
  const included = new Set(yours.map((c) => c.id));
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of everyone) {
      if (included.has(c.id)) continue;
      const parent = lineage.parentOf.get(c.id)?.source;
      if (parent && included.has(parent)) {
        included.add(c.id);
        grew = true;
      }
    }
  }
  return everyone.filter((c) => included.has(c.id));
}
