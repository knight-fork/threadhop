import { findRepo, gitUserIdentity, type RepoInfo } from "conversation-ledger";
import { randomUUID } from "node:crypto";
import { recordPendingBootstrap, reconcileBootstrapContinuations } from "./bootstrap-lineage.js";
import { writeBootstrapTranscript } from "./bootstrap.js";
import { loadConfig, saveConfig } from "./config.js";
import { listConversations } from "./conversations.js";
import { fabricateCopy, historyFor, recordCopy } from "./copies.js";
import { withMirrorLock } from "./mirror-lock.js";
import { readLineage, type Lineage } from "./lineage.js";
import { branchRows, buildBranchTree, withBranchesOfYours, type BranchNode, type BranchRow } from "./tree.js";
import { runInteractiveLaunchPlan } from "./interactive-launch.js";
import { withLedgerNotices } from "./ledger-io.js";
import { confirm, pickFromList } from "./picker.js";
import { installedTargets, targetFor } from "./targets/index.js";
import { formatSize } from "./transcript.js";
import { FabricationUnsupportedError, type LaunchPlan, type TargetAdapter } from "./targets/types.js";
import { cliLabel, relativeTime, type CliName, type ConversationSummary } from "./types.js";
import { threadhopVersion } from "./version.js";

export interface ResumeFlags {
  target?: CliName | undefined;
  all?: boolean;
  anyCommit?: boolean;
  bootstrap?: boolean;
  listOnly?: boolean;
  noReasoningReplay?: boolean;
  /** Always fabricate a separate copy instead of updating an earlier one. */
  newCopy?: boolean;
}

export interface PlanOptions {
  newCopy?: boolean;
}

/** Lineage annotation for a row: where it came from / where it was bridged. */
function lineageTag(summary: ConversationSummary, lineage: Lineage | undefined): string | null {
  if (!lineage) return null;
  const parent = lineage.parentOf.get(summary.id);
  if (parent) return `↳ continued from ${cliLabel(parent.source.split(":")[0] ?? "")}`;
  const children = lineage.childrenOf.get(summary.id);
  if (children && children.length > 0) {
    const latest = children.reduce((a, b) => (a.occurredAt > b.occurredAt ? a : b));
    return `→ bridged to ${cliLabel(latest.targetCli)} ${relativeTime(latest.occurredAt)}`;
  }
  return null;
}

/** Where a branch starts and how far it got: "↳ from turn 4, +2 turns". */
function branchTag(node: BranchNode): string {
  const own = `+${node.ownTurns} turn${node.ownTurns === 1 ? "" : "s"}`;
  return node.forkTurn === null ? `↳ ${own}` : `↳ from turn ${node.forkTurn}, ${own}`;
}

export function renderConversationRow(
  summary: ConversationSummary,
  index: number,
  selfEmail: string | null,
  lineage?: Lineage,
  branch?: BranchRow,
): string {
  const owner =
    summary.owners.length === 0
      ? "author unknown"
      : summary.owners.every((o) => o === selfEmail)
        ? null
        : summary.ownerDisplays[0] ?? summary.owners[0]!;
  const prefix = branch?.prefix ?? "";
  const parts = [
    `[${index + 1}]`,
    `${prefix}${cliLabel(summary.source)}`.padEnd(11 + prefix.length),
    relativeTime(summary.lastActivity).padStart(8),
    // A branch's own count (where it started plus what it added) leaves out
    // the import notice threadhop wrote into the copy.
    `${branch?.node.from && branch.node.forkTurn !== null ? branch.node.forkTurn + branch.node.ownTurns : summary.turnCount} turns`.padStart(9),
  ];
  if (owner) parts.push(`by ${owner}`);
  // In the tree, branches show where they start; a root only says where it
  // came from (its parent isn't listed), since its branches are drawn below it.
  const parentOnly = lineage && branch ? { parentOf: lineage.parentOf, childrenOf: new Map() } : lineage;
  const tag = branch?.node.from ? branchTag(branch.node) : lineageTag(summary, parentOnly);
  if (tag) parts.push(tag);
  parts.push(`· ${(branch?.node.from && branch.node.label) || summary.title}`);
  return parts.join("  ");
}

async function chooseTarget(flags: ResumeFlags): Promise<TargetAdapter | null> {
  if (flags.target) return targetFor(flags.target);
  const config = await loadConfig();
  if (config.defaultTarget) return targetFor(config.defaultTarget);

  const installed = await installedTargets();
  if (installed.length === 0) {
    process.stderr.write("threadhop: no supported target CLI found on PATH (wrapper targets also need cledger)\n");
    return null;
  }
  if (installed.length === 1) return installed[0]!;

  const choice = await pickFromList(
    installed,
    (t, i) => `[${i + 1}] ${cliLabel(t.name)}`,
    "Resume in which CLI?",
  );
  if (!choice) return null;
  if (await confirm(`Make ${cliLabel(choice.name)} your default target?`)) {
    await saveConfig({ ...(await loadConfig()), defaultTarget: choice.name });
    process.stderr.write(
      `threadhop: default target saved (change via ~/.threadhop/config.json)\n`,
    );
  }
  return choice;
}

export async function buildPlan(
  repo: RepoInfo,
  target: TargetAdapter,
  summary: ConversationSummary,
  cwd: string,
  useBootstrap: boolean,
  lineage: Lineage,
  availableConversations: ConversationSummary[],
  replayReasoning: boolean,
  options: PlanOptions = {},
): Promise<LaunchPlan> {
  if (target.name === summary.source && !useBootstrap && target.supportsNativeResume !== false) {
    return target.nativeResume(summary.sessionId, cwd);
  }
  const history = historyFor(summary, availableConversations, lineage);
  let nativeImportFallback: LaunchPlan["nativeImportFallback"];
  if (!useBootstrap) {
    try {
      // Held while the copy is written and recorded, so an automatic mirror
      // run can't append to the same copy at the same time.
      return await withMirrorLock(repo, async () => {
        // Resume is about to open the session, so a new copy beats none at all.
        const { plan, reused } = await fabricateCopy(target, summary, history.summary, lineage, cwd, replayReasoning, {
          newCopy: options.newCopy ?? false,
          whenAllContinued: "create",
        });
        if (!plan) throw new Error("fabricateCopy skipped despite whenAllContinued: create");
        if (reused) plan.notes.push("--new-copy makes a separate session instead");
        plan.notes.push(...history.notes);
        await recordCopy(repo, target, summary, plan);
        return plan;
      });
    } catch (err) {
      if (!(err instanceof FabricationUnsupportedError)) throw err;
      nativeImportFallback = { kind: err.kind, reason: err.message };
      process.stderr.write(
        `threadhop: ${err.message}; falling back to bootstrap rehydration\n`,
      );
    }
  }
  const bootstrapSummary = { ...history.summary, bootstrapToken: randomUUID() };
  const transcript = await writeBootstrapTranscript(bootstrapSummary);
  const plan = target.bootstrap(bootstrapSummary, cwd, transcript.path);
  if (nativeImportFallback) plan.nativeImportFallback = nativeImportFallback;
  await recordPendingBootstrap(repo, { token: bootstrapSummary.bootstrapToken, source: summary.id, targetCli: target.name,
    importedThroughSeq: Math.max(...summary.events.map(event => event.stream?.seq ?? 0), 0),
    sourceEventIds: history.summary.events.map(event => event.id), version: threadhopVersion() });
  plan.notes.push(...history.notes);
  plan.notes.push(
    `transcript is ${formatSize(transcript.size)}; fitting it is the target CLI's own concern ` +
      "(both apply their own compaction or truncation), so this is reported, not enforced",
  );
  return plan;
}

export async function resumeCommand(flags: ResumeFlags): Promise<number> {
  const cwd = process.cwd();
  const repo = await findRepo(cwd);
  if (!repo) {
    process.stderr.write("threadhop: not inside a git repository\n");
    return 1;
  }
  const identity = await gitUserIdentity(repo);
  await reconcileBootstrapContinuations(repo);
  // Sequential, not Promise.all: each ledger read may run lazy maintenance
  // (notes merge, re-anchor append) — concurrent calls race on the same
  // refs and cursor file. The second read's maintenance pass is a no-op.
  const [conversations, lineage, availableConversations] = await withLedgerNotices(async () => {
    const convs = await listConversations(repo, {
      all: flags.all ?? false,
      user: identity.email ?? undefined,
      anyCommit: flags.anyCommit ?? false,
    });
    const graph = await readLineage(repo, flags.anyCommit ?? false);
    const available = flags.all
      ? convs
      : await listConversations(repo, {
          all: true,
          anyCommit: flags.anyCommit ?? false,
        });
    return [convs, graph, available] as const;
  });

  if (conversations.length === 0) {
    process.stderr.write(
      "threadhop: no captured conversations for this repo state.\n" +
        "  - capture runs via conversation-ledger hooks: `cledger install all`\n" +
        "  - `--any-commit` lists conversations from other branches/commits\n" +
        "  - `--all` includes collaborators' conversations\n",
    );
    return 1;
  }

  // Branches: where you left off and where anyone who continued your work
  // left off, side by side, so either point can be resumed.
  const offered = flags.all ? conversations : withBranchesOfYours(conversations, availableConversations, lineage);
  const rows = branchRows(buildBranchTree(offered, lineage));
  const render = (row: BranchRow, i: number) => renderConversationRow(row.node.summary, i, identity.email, lineage, row);

  if (flags.listOnly) {
    rows.forEach((row, i) => process.stdout.write(render(row, i) + "\n"));
    return 0;
  }

  const picked = await pickFromList(rows, render, "Resume which conversation?");
  if (!picked) return 0;
  const summary = picked.node.summary;

  const target = await chooseTarget(flags);
  if (!target) return 1;
  if (!(await target.isInstalled())) {
    process.stderr.write(`threadhop: ${target.binary} is not on PATH\n`);
    return 1;
  }

  const config = await loadConfig();
  const replayReasoning = !flags.noReasoningReplay && config.reasoningReplay !== false;

  const plan = await buildPlan(
    repo,
    target,
    summary,
    cwd,
    flags.bootstrap ?? false,
    lineage,
    availableConversations,
    replayReasoning,
    { newCopy: flags.newCopy ?? false },
  );
  const code = await runInteractiveLaunchPlan(plan);
  await reconcileBootstrapContinuations(repo);
  return code;
}
