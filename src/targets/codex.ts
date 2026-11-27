import { spawnSync } from "node:child_process";
import { toolInput } from "../tool-input.js";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { parse } from "smol-toml";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EvidenceEvent } from "../vendor/conversation-ledger/index.js";
import { bootstrapPrompt } from "../bootstrap.js";
import { normalizeTimestamp } from "../timestamps.js";
import { formatSize, transcriptSize } from "../transcript.js";
import { binaryOnPath } from "../launch.js";
import { eventKeys, stableUuid } from "../stable-id.js";
import {
  cliLabel,
  importSourceLabel,
  turnContent,
  type ConversationSummary,
  type TurnBlock,
} from "../types.js";
import {
  FabricationUnsupportedError,
  MirrorDivergedError,
  type FabricateOptions,
  type LaunchPlan,
  type TargetAdapter,
} from "./types.js";

/**
 * Rollout writer validated against codex-cli 0.144.x, 0.145.x, 0.146.x and
 * 0.169.x (2026-07/08, 2026-11): resume-by-id scans ~/.codex/sessions for a rollout file whose
 * name and session_meta id match; plain `message` response_items are the
 * replayed conversation state. 0.145.0 revalidated 2026-07-21 via the
 * interactive smoke test plus a headless `codex exec resume` marker-recall
 * probe (scripts/probe-codex-content.mjs). 0.146.0 revalidated 2026-08-02 by
 * the same two plus structured tool replay (probe-codex-function-call.mjs)
 * and the 300-turn history probe — see docs/specs/codex-rollout-format.md §10.
 * 0.169.0 revalidated 2026-11-16 by the same probes plus the scripted
 * installed campaign (§12): 0.169 writes `history_mode: "paginated"` and
 * per-line `ordinal`s itself, but still reads the "legacy" rollouts written
 * here, into both the TUI and the model's context.
 */
const VALIDATED_VERSION_PREFIXES = ["0.144.", "0.145.", "0.146.", "0.169."];

function codexVersion(): string | null {
  const result = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1]! : null;
}

function sessionsDir(): string {
  const home = process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  return join(home, "sessions");
}

/** Local-time filename stamp: YYYY-MM-DDTHH-MM-SS. */
function localStamp(d: Date): { datePath: string; stamp: string } {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const datePath = join(String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return { datePath, stamp };
}

/**
 * Fold any block into plain text. Only input_text/output_text message blocks
 * are validated to replay safely in Codex, so foreign tool calls become
 * labeled text rather than fabricated function_call records.
 */
function foldBlock(block: TurnBlock): string {
  switch (block.type) {
    case "text":
      return typeof block.text === "string" ? block.text : "";
    case "thinking":
      return block.text ? `[visible thinking]\n${String(block.text)}` : "";
    case "tool_use":
      return `[used tool: ${block.name ?? "unknown"}]\ninput: ${JSON.stringify(block.input ?? {})}`;
    case "tool_result": {
      const body =
        typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
      return `[tool result]\n${body}`;
    }
    default:
      return JSON.stringify(block);
  }
}

export interface RolloutLine {
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
}

function messageLine(timestamp: string, role: "user" | "assistant", text: string): RolloutLine {
  const blockType = role === "assistant" ? "output_text" : "input_text";
  return {
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: blockType, text }] },
  };
}

/**
 * TUI scrollback renders from event_msg records, not response_items; without
 * these the resumed session looks empty even though the model sees history.
 */
function displayLine(timestamp: string, role: "user" | "assistant", text: string): RolloutLine {
  const payload =
    role === "user"
      ? { type: "user_message", message: text, images: [], local_images: [], text_elements: [] }
      : { type: "agent_message", message: text, phase: "final_answer", memory_citation: null };
  return { timestamp, type: "event_msg", payload };
}

/** A conversation turn as both the model-context record and its display twin. */
function turnLines(timestamp: string, role: "user" | "assistant", text: string): RolloutLine[] {
  return role === "user"
    ? [displayLine(timestamp, role, text), messageLine(timestamp, role, text)]
    : [messageLine(timestamp, role, text), displayLine(timestamp, role, text)];
}

/**
 * A foreign tool call as a real `function_call` response_item.
 *
 * Verified safe by scripts/probe-codex-function-call.mjs (codex-cli 0.145.0):
 * a well-formed call/output pair whose `name` is a tool Codex has never heard
 * of ("Edit") replays without API rejection, and the resumed model can name
 * the tool it sees. This closes docs/specs/codex-rollout-format.md §8.2, which
 * had flagged foreign names and orphaned outputs as an unverified rejection
 * risk and recommended text-folding until measured.
 *
 * Pairing is what actually matters: the same probe showed an orphaned
 * `function_call_output` does not error, but carries no `name` at all, so the
 * tool's identity is simply lost. Unpaired results stay text-folded, where the
 * name at least survives as prose.
 */
function functionCallLine(timestamp: string, callId: string, name: string, input: unknown): RolloutLine {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call",
      id: `fc_tb_${callId.slice(-16)}`,
      name,
      // the Responses API carries arguments as a JSON *string*, not an object
      arguments: JSON.stringify(toolInput(input)),
      call_id: callId,
    },
  };
}

function functionCallOutputLine(timestamp: string, callId: string, output: string): RolloutLine {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output: [{ type: "input_text", text: output }],
    },
  };
}

/** Codex has no generic tool-call `event_msg`, so scrollback gets prose. */
function toolDisplayLine(timestamp: string, text: string): RolloutLine {
  return displayLine(timestamp, "assistant", text);
}

/**
 * `reasoning` events this fabrication should replay verbatim: opaque
 * `encrypted_content` only the originating provider can decrypt, which the
 * ledger preserves losslessly (raw.data holds the exact original
 * response_item line) but never interprets. Foreign reasoning cannot be
 * forged as a native reasoning item, so replay is gated per-event on
 * `producer.source === "codex"` — the only direction this can ever be
 * valid, regardless of how the rest of the conversation's lineage looks.
 */
function eligibleReasoning(summary: ConversationSummary, replayReasoning: boolean): EvidenceEvent[] {
  if (!replayReasoning) return [];
  return summary.events.filter((e) => e.kind === "reasoning" && e.producer.source === "codex");
}

/** Human-facing disclosure for source model provenance Codex cannot store. */
export function modelDropNote(summary: ConversationSummary): string | null {
  const models: string[] = [];
  for (const event of summary.events) {
    if (event.actor.type !== "agent" || !event.producer.model) continue;
    const model =
      event.producer.provider && !event.producer.model.includes("/")
        ? `${event.producer.provider}/${event.producer.model}`
        : event.producer.model;
    if (!models.includes(model)) models.push(model);
  }
  if (models.length === 0) return null;
  return (
    `source history names model${models.length === 1 ? "" : "s"} ${models.join(", ")}; ` +
    "Codex has no per-turn model field, so the resumed session uses Codex's configured model"
  );
}

/** The verbatim `{type: "response_item", payload: {type: "reasoning", ...}}` line, if shaped as expected. */
function reasoningRolloutLine(event: EvidenceEvent, now: Date): RolloutLine | null {
  const line = event.raw?.data as { type?: unknown; payload?: unknown } | undefined;
  if (line?.type !== "response_item" || !line.payload || typeof line.payload !== "object") return null;
  return {
    // Outer rollout field only — `payload` (where the ciphertext lives) stays
    // byte-identical, since that is what the provider has to be able to decrypt.
    timestamp: normalizeTimestamp(event.occurred_at, now),
    type: "response_item",
    payload: line.payload as Record<string, unknown>,
  };
}

export function buildRolloutLines(
  summary: ConversationSummary,
  sessionId: string,
  cwd: string,
  cliVersion: string,
  now: Date,
  replayReasoning = true,
  importedSourceEventIds?: string[],
  modelProvider = "openai",
): RolloutLine[] {
  const nowIso = now.toISOString();
  const replayCount = eligibleReasoning(summary, replayReasoning).length;
  // The notice is a factual claim about this specific file, so it has to track
  // what was actually written: tool calls now replay as real function_call
  // records (history the model reads, never re-executed), except unpaired
  // results, which stay prose.
  const noticeText =
    `[threadhop import notice] This conversation was imported from ${importSourceLabel(summary)}. ` +
    "The history below is the literal visible transcript. Past tool calls are replayed as history " +
    "records, not as calls to re-run; tool results with no matching call appear as labeled text. " +
    (replayCount > 0
      ? `${replayCount} encrypted reasoning block(s) from the original Codex session were replayed ` +
        "verbatim below, which may restore hidden reasoning provider-side; all other hidden reasoning " +
        "and provider-private state were not transferred."
      : "Hidden reasoning and provider-private state were not transferred.");

  const lines: RolloutLine[] = [
    {
      timestamp: nowIso,
      type: "session_meta",
      payload: {
        session_id: sessionId,
        id: sessionId,
        timestamp: nowIso,
        cwd,
        originator: "codex-tui",
        cli_version: cliVersion,
        source: "cli",
        thread_source: "user",
        model_provider: modelProvider,
        history_mode: "legacy",
      },
    },
    ...turnLines(nowIso, "user", noticeText),
  ];

  // call_ids seen so far, so a tool_result can tell a real pairing from an
  // orphan whose matching call never made it into this conversation
  const seenCallIds = new Set<string>();
  const keyFor = eventKeys();
  for (const event of summary.events) {
    if (event.kind === "reasoning") {
      if (!replayReasoning || event.producer.source !== "codex") continue;
      const line = reasoningRolloutLine(event, now);
      if (line) {
        lines.push(line);
        importedSourceEventIds?.push(event.id);
      }
      continue;
    }
    const content = turnContent(event);
    if (!content) continue;
    const lineCountBefore = lines.length;
    const key = `event:${keyFor(event.id)}`;
    const ts = normalizeTimestamp(event.occurred_at, now);
    const role = event.actor.type === "human" ? "user" : "assistant";

    // Prose accumulates until a tool block interrupts it, so a turn's text and
    // its tool calls stay in their original order rather than being hoisted.
    let prose: string[] = [];
    const flushProse = () => {
      const text = prose.filter((t) => t.trim()).join("\n\n");
      prose = [];
      if (text) lines.push(...turnLines(ts, role, text));
    };

    for (const [blockIndex, block] of content.blocks.entries()) {
      if (block.type === "tool_use") {
        // derived, not random, so rebuilding the same history reproduces it
        const callId =
          typeof block.id === "string" && block.id
            ? block.id
            : `call_tb_${stableUuid(`${sessionId}:${key}:tool:${blockIndex}`).slice(0, 12)}`;
        const name = typeof block.name === "string" && block.name ? block.name : "ImportedTool";
        seenCallIds.add(callId);
        flushProse();
        lines.push(
          functionCallLine(ts, callId, name, block.input),
          toolDisplayLine(ts, `[used tool: ${name}]\ninput: ${JSON.stringify(block.input ?? {})}`),
        );
        continue;
      }
      if (block.type === "tool_result") {
        const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        const body =
          typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
        if (callId && seenCallIds.has(callId)) {
          flushProse();
          lines.push(
            functionCallOutputLine(ts, callId, body),
            toolDisplayLine(ts, `[tool result]\n${body}`),
          );
        } else {
          // unpaired: an orphaned function_call_output would drop the tool's
          // identity entirely, so keep it as prose where the label survives
          prose.push(foldBlock(block));
        }
        continue;
      }
      prose.push(foldBlock(block));
    }
    flushProse();
    if (lines.length > lineCountBefore) importedSourceEventIds?.push(event.id);
  }
  return lines;
}

/**
 * session_meta plus the import notice's two lines (model record and display
 * twin); everything after it is history. The notice text tracks the
 * replayed-reasoning count, so a later write can need a different notice.
 */
export const ROLLOUT_HEADER_LINES = 3;

/**
 * Records Codex appends to a rollout when it is merely opened, with nothing
 * typed. Verified on 0.169.0: `codex resume <id>` appends one
 * `thread_settings_applied` event (the model, provider and approval settings
 * the session opened with). They hold the user's state and are not turns, so
 * an update keeps them. Deliberately an allowlist: an unrecognised record
 * still counts as divergence, because refusing is recoverable and appending
 * past a user's own turns is not.
 */
const CODEX_OPEN_RECORDS = new Set(["thread_settings_applied"]);

function isCodexOpenRecord(line: unknown): boolean {
  const record = line as { type?: unknown; payload?: { type?: unknown } } | null;
  return record?.type === "event_msg" && CODEX_OPEN_RECORDS.has(record.payload?.type as string);
}

function withoutTimestamp(line: unknown): string {
  const { timestamp: _timestamp, ...rest } = (line ?? {}) as Record<string, unknown>;
  return JSON.stringify(rest);
}

/** The rollout file for `sessionId` under Codex's dated session tree, if any. */
async function findRollout(sessionId: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir(), { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const match = entries.find((entry) => entry.endsWith(`-${sessionId}.jsonl`));
  return match ? join(sessionsDir(), match) : null;
}

/**
 * How to bring the rollout `existing` up to date with `next`, or why it
 * can't be. Like Claude Code, Codex writes to a session as soon as it is
 * opened (see CODEX_OPEN_RECORDS), so an update appends instead of rewriting:
 * Codex's own records stay where they are, and a Codex process that has the
 * file open keeps appending to the same file rather than to a replaced one.
 *
 * Every other history line must be, in order, the line threadhop would write
 * now; then the rest is appended. Codex writes turns and turn_context records
 * when a session is continued, and those show up here as lines threadhop did
 * not write. A notice that would now read differently (a changed
 * replayed-reasoning count) is refused too, since appending cannot correct it.
 */
export function planRolloutAppend(
  existing: string,
  next: RolloutLine[],
  sessionId: string,
): { reason: string } | { append: RolloutLine[] } {
  const raw = existing.split("\n").filter((line) => line.trim());
  let parsed: unknown[];
  try {
    parsed = raw.map((line) => JSON.parse(line) as unknown);
  } catch {
    return { reason: "has a line that is not JSON" };
  }
  const meta = parsed[0] as { type?: unknown; payload?: { id?: unknown } } | undefined;
  if (meta?.type !== "session_meta" || meta.payload?.id !== sessionId) {
    return { reason: "does not start with this session's session_meta" };
  }
  for (let index = 1; index < ROLLOUT_HEADER_LINES; index++) {
    if (withoutTimestamp(parsed[index]) !== withoutTimestamp(next[index])) {
      return { reason: "has an import notice that no longer matches what would be imported" };
    }
  }
  const ours = next.slice(ROLLOUT_HEADER_LINES);
  let matched = 0;
  for (const line of parsed.slice(ROLLOUT_HEADER_LINES)) {
    if (isCodexOpenRecord(line)) continue;
    if (matched >= ours.length || JSON.stringify(line) !== JSON.stringify(ours[matched])) {
      return { reason: "has lines threadhop did not write (was it continued after resuming?)" };
    }
    matched++;
  }
  return { append: ours.slice(matched) };
}

export const codexTarget: TargetAdapter = {
  name: "codex",
  binary: "codex",
  supportsUpdateInPlace: true,

  async hasSession(sessionId: string): Promise<boolean> {
    return (await findRollout(sessionId)) !== null;
  },

  isInstalled() {
    return binaryOnPath("codex");
  },

  nativeResume(sessionId: string, cwd: string): LaunchPlan {
    return {
      command: "codex",
      args: ["resume", sessionId],
      cwd,
      notes: [`resuming native Codex session ${sessionId}`],
    };
  },

  async fabricate(
    summary: ConversationSummary,
    cwd: string,
    opts: FabricateOptions,
  ): Promise<LaunchPlan> {
    const version = codexVersion();
    if (!version) {
      throw new FabricationUnsupportedError("could not determine codex version", "codex");
    }
    const notes: string[] = [];
    if (!VALIDATED_VERSION_PREFIXES.some((p) => version.startsWith(p))) {
      notes.push(
        `codex ${version} has not been validated against the fabrication spec (validated: ${VALIDATED_VERSION_PREFIXES.map((p) => `${p}x`).join(", ")}); ` +
          "rerun with --bootstrap if the resumed session misbehaves",
      );
    }

    let modelProvider = "openai";
    try {
      const configPath = join(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), "config.toml");
      const config = parse(await readFile(configPath, "utf8"));
      if (typeof config.model_provider === "string") modelProvider = config.model_provider;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new FabricationUnsupportedError("could not read Codex's configured provider; native import would risk changing provider", "codex");
    }
    const sessionId = opts.existingSessionId ?? randomUUID();
    const now = new Date();
    const existingPath = opts.existingSessionId ? await findRollout(sessionId) : null;
    const { datePath, stamp } = localStamp(now);
    const dir = join(sessionsDir(), datePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // an update keeps the original file, whose name carries its creation time
    const path = existingPath ?? join(dir, `rollout-${stamp}-${sessionId}.jsonl`);
    const importedSourceEventIds: string[] = [];
    const lines = buildRolloutLines(
      summary,
      sessionId,
      cwd,
      version,
      now,
      opts.replayReasoning,
      importedSourceEventIds,
      modelProvider,
    );
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    let fabrication: LaunchPlan["fabrication"] = "created";
    if (existingPath) {
      const existing = await readFile(existingPath, "utf8");
      const plan = planRolloutAppend(existing, lines, sessionId);
      if ("reason" in plan) {
        throw new MirrorDivergedError(`Codex session ${sessionId} ${plan.reason}; leaving it untouched`, "codex", sessionId);
      }
      if (plan.append.length > 0) {
        const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        await appendFile(path, separator + plan.append.map((l) => JSON.stringify(l)).join("\n") + "\n");
      }
      const added = plan.append.length;
      fabrication = added > 0 ? "updated" : "unchanged";
      notes.push(
        added > 0
          ? `updated Codex session ${sessionId} from ${cliLabel(summary.source)} history (+${added} line${added === 1 ? "" : "s"}, ${summary.turnCount} turns)`
          : `Codex session ${sessionId} is already up to date with ${cliLabel(summary.source)} history`,
        `rollout file: ${path}`,
      );
    } else {
      await writeFile(path, body, { mode: 0o600, flag: "wx" });
      notes.push(
        `fabricated Codex session ${sessionId} from ${cliLabel(summary.source)} history (${summary.turnCount} turns)`,
        `rollout file: ${path} (${formatSize(transcriptSize(body))})`,
      );
    }
    const droppedModelNote = modelDropNote(summary);
    if (droppedModelNote) notes.push(droppedModelNote);
    const replayCount = eligibleReasoning(summary, opts.replayReasoning).length;
    if (replayCount > 0) {
      notes.push(
        `replayed ${replayCount} encrypted reasoning block(s) from the original Codex session verbatim ` +
          "(may restore hidden reasoning provider-side; disable with reasoningReplay: false in " +
          "~/.threadhop/config.json or --no-reasoning-replay)",
      );
    }
    return {
      command: "codex",
      args: ["resume", sessionId],
      cwd,
      notes,
      fabricatedConversationId: `codex:${sessionId}`,
      fabrication,
      importedSourceEventIds,
    };
  },

  bootstrap(summary: ConversationSummary, cwd: string, transcriptPath: string): LaunchPlan {
    return {
      command: "codex",
      args: [bootstrapPrompt(summary, transcriptPath)],
      cwd,
      notes: [
        `starting a NEW Codex session rehydrated from ${cliLabel(summary.source)} (bootstrap mode)`,
        `transcript: ${transcriptPath}`,
      ],
    };
  },
};
