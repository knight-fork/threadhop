import { findRepo, gitUserIdentity, type RepoInfo } from "conversation-ledger";
import { reconcileBootstrapContinuations } from "./bootstrap-lineage.js";
import { loadConfig } from "./config.js";
import { listConversations } from "./conversations.js";
import { fabricateCopy, historyFor, recordCopy, reusableCopies } from "./copies.js";
import { withLedgerNotices } from "./ledger-io.js";
import { readLineage } from "./lineage.js";
import { isUntouchedCopy } from "./lineage-resolution.js";
import { targetFor } from "./targets/index.js";
import { FabricationUnsupportedError, type TargetAdapter } from "./targets/types.js";
import { cliLabel, parseCliName, relativeTime, type ConversationSummary } from "./types.js";

export const DEFAULT_MIRROR_LIMIT = 10;

export interface MirrorOptions {
  targets: TargetAdapter[];
  /** Your git email; only conversations every human turn of which is yours are mirrored. */
  self: string;
  limit: number;
  dryRun?: boolean;
  anyCommit?: boolean;
  replayReasoning: boolean;
}

export type MirrorAction =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped-continued"
  | "unsupported"
  | "would-create"
  | "would-update";

export interface MirrorResult {
  conversation: ConversationSummary;
  target: TargetAdapter;
  action: MirrorAction;
  /** Ledger id of the copy written or found, when there is one. */
  copy?: string;
  detail?: string;
  notes: string[];
}

/** Your own recent conversations, excluding copies threadhop wrote that nobody continued. */
export function mirrorCandidates(
  conversations: ConversationSummary[],
  lineage: Awaited<ReturnType<typeof readLineage>>,
  self: string,
  limit: number,
): ConversationSummary[] {
  return conversations
    .filter((c) => c.owners.length > 0 && c.owners.every((owner) => owner === self))
    .filter((c) => !isUntouchedCopy(c, lineage))
    .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0))
    .slice(0, limit);
}

/**
 * Keep one up-to-date native copy of each of your recent conversations in
 * each target, so it shows up in that CLI's own resume picker. Copies are
 * created once and then brought up to date in place; a copy you continued is
 * your own branch and is left exactly as it is, with no new copy made in its
 * place. Never falls back to bootstrap: that starts a live session, which a
 * background mirror must not do.
 */
export async function runMirror(repo: RepoInfo, cwd: string, options: MirrorOptions): Promise<MirrorResult[]> {
  if (!options.dryRun) await reconcileBootstrapContinuations(repo);
  const anyCommit = options.anyCommit ?? false;
  const [conversations, lineage] = await withLedgerNotices(async () => {
    const all = await listConversations(repo, { all: true, anyCommit });
    return [all, await readLineage(repo, anyCommit)] as const;
  });
  const candidates = mirrorCandidates(conversations, lineage, options.self, options.limit);

  const results: MirrorResult[] = [];
  for (const conversation of candidates) {
    for (const target of options.targets) {
      // Already in that CLI's own picker; nothing to mirror.
      if (target.name === conversation.source) continue;
      const result: MirrorResult = { conversation, target, action: "unchanged", notes: [] };
      results.push(result);

      if (options.dryRun) {
        const [copy] = await reusableCopies(target, conversation, lineage, cwd);
        result.action = copy ? "would-update" : "would-create";
        if (copy) {
          result.copy = `${target.name}:${copy.sessionId}`;
          result.detail = `copy made ${relativeTime(copy.occurredAt)}, unless it has been continued since`;
        }
        continue;
      }

      const history = historyFor(conversation, conversations, lineage);
      try {
        const { plan, notReused } = await fabricateCopy(
          target,
          conversation,
          history.summary,
          lineage,
          cwd,
          options.replayReasoning,
          { whenAllContinued: "skip" },
        );
        if (!plan) {
          result.action = "skipped-continued";
          result.detail = `your ${cliLabel(target.name)} copy has been continued there, so it is left as it is`;
          result.notes.push(...notReused);
          continue;
        }
        await recordCopy(repo, target, conversation, plan);
        result.action = plan.fabrication ?? "created";
        if (plan.fabricatedConversationId) result.copy = plan.fabricatedConversationId;
        result.notes.push(...plan.notes, ...history.notes);
      } catch (err) {
        if (!(err instanceof FabricationUnsupportedError)) throw err;
        result.action = "unsupported";
        result.detail = err.message;
      }
    }
  }
  return results;
}

const ACTION_LABEL: Record<MirrorAction, string> = {
  created: "created",
  updated: "updated",
  unchanged: "up to date",
  "skipped-continued": "skipped",
  unsupported: "failed",
  "would-create": "would create",
  "would-update": "would update",
};

/**
 * Notes that only restate the action line or name a file are left out of the
 * summary; disclosures (unvalidated versions, dropped models, replayed
 * reasoning, unavailable origins) are kept, each once.
 */
function isRestatement(note: string): boolean {
  return /^(fabricated|updated|reusing|not reusing|session file:|rollout file:)|is already up to date with/.test(note);
}

export function renderMirrorResults(results: MirrorResult[], cwd: string, dryRun: boolean): string {
  if (results.length === 0) {
    return "threadhop mirror: nothing to mirror (no recent conversations of yours from other CLIs)\n";
  }
  const width = Math.max(...results.map((r) => ACTION_LABEL[r.action].length));
  const lines = results.map((r) => {
    const title = r.conversation.title.length > 60 ? `${r.conversation.title.slice(0, 57)}...` : r.conversation.title;
    const from = `${cliLabel(r.conversation.source)}, ${relativeTime(r.conversation.lastActivity)}`;
    const detail = r.detail ? ` (${r.detail})` : "";
    return `${ACTION_LABEL[r.action].padEnd(width)}  ${cliLabel(r.target.name)} copy of "${title}" [${from}]${detail}`;
  });
  const notes = [...new Set(results.flatMap((r) => r.notes).filter((note) => !isRestatement(note)))];
  const footer = dryRun
    ? "dry run: nothing was written"
    : `copies are listed in each CLI's own resume picker when it is run from ${cwd}`;
  return [...lines, ...(notes.length ? ["", "notes:", ...notes.map((n) => `  - ${n}`)] : []), "", footer, ""].join("\n");
}

export interface MirrorFlags {
  targets: string[];
  limit?: number;
  dryRun?: boolean;
  anyCommit?: boolean;
}

export async function mirrorCommand(flags: MirrorFlags): Promise<number> {
  const cwd = process.cwd();
  const repo = await findRepo(cwd);
  if (!repo) {
    process.stderr.write("threadhop mirror: run inside a git repository\n");
    return 1;
  }
  const self = (await gitUserIdentity(repo)).email;
  if (!self) {
    process.stderr.write("threadhop mirror: set git user.email; only your own conversations are mirrored\n");
    return 1;
  }
  const config = await loadConfig();
  const names = flags.targets.length > 0 ? flags.targets : config.mirror?.targets ?? [];
  if (names.length === 0) {
    process.stderr.write(
      "threadhop mirror: name the CLIs to keep copies in, e.g. `threadhop mirror codex claude`,\n" +
        '  or set them once in ~/.threadhop/config.json: {"mirror": {"targets": ["codex", "claude-code"]}}\n',
    );
    return 1;
  }
  const targets: TargetAdapter[] = [];
  for (const name of names) {
    const cli = parseCliName(name);
    if (!cli) {
      process.stderr.write(`threadhop mirror: unknown target CLI: ${name}\n`);
      return 1;
    }
    const target = targetFor(cli);
    if (!target.supportsUpdateInPlace) {
      process.stderr.write(
        `threadhop mirror: ${cliLabel(cli)} can't update a copy in place yet, so mirroring would add a new ` +
          "session to its picker on every run; supported: Claude Code, Codex\n",
      );
      return 1;
    }
    if (!(await target.isInstalled())) {
      process.stderr.write(`threadhop mirror: ${target.binary} is not on PATH\n`);
      return 1;
    }
    if (!targets.includes(target)) targets.push(target);
  }
  const limit = flags.limit ?? config.mirror?.limit ?? DEFAULT_MIRROR_LIMIT;
  const results = await runMirror(repo, cwd, {
    targets,
    self,
    limit,
    dryRun: flags.dryRun ?? false,
    anyCommit: flags.anyCommit ?? false,
    replayReasoning: config.reasoningReplay !== false,
  });
  process.stdout.write(renderMirrorResults(results, cwd, flags.dryRun ?? false));
  return results.some((r) => r.action === "unsupported") ? 1 : 0;
}
