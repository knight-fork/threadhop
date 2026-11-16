import type { RepoInfo } from "conversation-ledger";
import { recordContinuation, type Lineage } from "./lineage.js";
import { resolveLineageHistory, type ResolvedHistory } from "./lineage-resolution.js";
import { MirrorDivergedError, type LaunchPlan, type TargetAdapter } from "./targets/types.js";
import { cliLabel, relativeTime, type ConversationSummary } from "./types.js";
import { threadhopVersion } from "./version.js";

/** An earlier native copy of a conversation, found on this machine. */
export interface ReusableCopy {
  sessionId: string;
  occurredAt: string;
}

/**
 * Earlier native copies of `summary` in `target` that are on this machine,
 * newest first. Continuation records sync between collaborators, so only a
 * session the adapter can find locally (where a resume from `cwd` looks) is a
 * candidate; anything else would be recreated under someone else's id.
 */
export async function reusableCopies(
  target: TargetAdapter,
  summary: ConversationSummary,
  lineage: Lineage,
  cwd: string,
): Promise<ReusableCopy[]> {
  if (!target.supportsUpdateInPlace || !target.hasSession) return [];
  const prefix = `${target.name}:`;
  const records = (lineage.childrenOf.get(summary.id) ?? [])
    .filter((rec) => rec.targetCli === target.name && rec.mode !== "bootstrap" && rec.target.startsWith(prefix))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
  const copies: ReusableCopy[] = [];
  for (const rec of records) {
    const sessionId = rec.target.slice(prefix.length);
    if (await target.hasSession(sessionId, cwd)) copies.push({ sessionId, occurredAt: rec.occurredAt });
  }
  return copies;
}

/** The history to write for `summary`: flattened to its origins when it is itself a copy. */
export function historyFor(
  summary: ConversationSummary,
  available: ConversationSummary[],
  lineage: Lineage,
): ResolvedHistory {
  return lineage.parentOf.has(summary.id)
    ? resolveLineageHistory(summary, available, lineage)
    : { summary, notes: [] };
}

export interface CopyOptions {
  /** Always fabricate a separate session instead of updating an earlier copy. */
  newCopy?: boolean;
  /**
   * When every earlier copy has been continued by the user: make a new copy
   * (resume, which is about to open it), or leave things as they are (mirror,
   * which would otherwise add another session to the picker on every run).
   */
  whenAllContinued: "create" | "skip";
}

export interface CopyResult {
  /** Null when skipped because every earlier copy had been continued. */
  plan: LaunchPlan | null;
  /** The earlier copy that was brought up to date, if one was. */
  reused: ReusableCopy | null;
  /** Why earlier copies were not reused, one note per copy. */
  notReused: string[];
}

/**
 * Fabricate into the newest earlier copy that has not been continued, so
 * bridging a conversation again brings that copy up to date instead of adding
 * another to the target's picker. A copy the user typed in is a branch of its
 * own: the adapter refuses it untouched and the next candidate is tried.
 */
export async function fabricateCopy(
  target: TargetAdapter,
  summary: ConversationSummary,
  resolved: ConversationSummary,
  lineage: Lineage,
  cwd: string,
  replayReasoning: boolean,
  options: CopyOptions,
): Promise<CopyResult> {
  const label = cliLabel(target.name);
  const candidates = options.newCopy ? [] : await reusableCopies(target, summary, lineage, cwd);
  const notReused: string[] = [];
  for (const copy of candidates) {
    try {
      const plan = await target.fabricate(resolved, cwd, { replayReasoning, existingSessionId: copy.sessionId });
      plan.notes.unshift(
        ...notReused,
        `reusing the ${label} copy made ${relativeTime(copy.occurredAt)} instead of creating another`,
      );
      return { plan, reused: copy, notReused };
    } catch (err) {
      if (!(err instanceof MirrorDivergedError)) throw err;
      notReused.push(`not reusing the earlier ${label} copy: ${err.message}`);
    }
  }
  if (candidates.length > 0 && options.whenAllContinued === "skip") {
    return { plan: null, reused: null, notReused };
  }
  const plan = await target.fabricate(resolved, cwd, { replayReasoning });
  plan.notes.unshift(...notReused);
  return { plan, reused: null, notReused };
}

/**
 * Record `plan`'s session as a continuation of `summary`. A copy that was
 * already current is not recorded again: its newest record still says exactly
 * what it holds, and mirroring must not grow the shared ledger on every run.
 */
export async function recordCopy(
  repo: RepoInfo,
  target: TargetAdapter,
  summary: ConversationSummary,
  plan: LaunchPlan,
): Promise<void> {
  if (!plan.fabricatedConversationId || plan.fabrication === "unchanged") return;
  const lastSeq = summary.events[summary.events.length - 1]?.stream?.seq ?? 0;
  await recordContinuation(repo, {
    source: summary.id,
    target: plan.fabricatedConversationId,
    importedThroughSeq: lastSeq,
    sourceEventIds: plan.importedSourceEventIds ?? [],
    targetCli: target.name,
    version: threadhopVersion(),
  });
}
