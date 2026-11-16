import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { normalizeTimestamp } from "../timestamps.js";
import { formatSize, transcriptSize } from "../transcript.js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { bootstrapPrompt } from "../bootstrap.js";
import { binaryOnPath } from "../launch.js";
import { eventKeys, stableUuid } from "../stable-id.js";
import { toolInput } from "../tool-input.js";
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
 * Session writer validated against Claude Code 2.1.x (2026-07): resume looks
 * up <uuid>.jsonl only inside the project directory encoded from the launch
 * cwd; the conversation is reconstructed by walking parentUuid links backward
 * from the last line, and timestamps are required on every line.
 */
const VALIDATED_VERSION_PREFIX = "2.";

function claudeVersion(): string | null {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1]! : null;
}

/** ~/.claude/projects key: every non-alphanumeric cwd character becomes "-". */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function projectsDir(): string {
  return join(process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"), "projects");
}

interface SessionLine {
  parentUuid: string | null;
  isSidechain: boolean;
  userType: string;
  entrypoint: string;
  cwd: string;
  sessionId: string;
  version: string;
  type: "user" | "assistant";
  message: Record<string, unknown>;
  uuid: string;
  timestamp: string;
}

/** Cosmetic `ai-title` record — what the resume picker titles a session by. */
interface TitleLine {
  type: "ai-title";
  aiTitle: string;
  sessionId: string;
}

export type FabricatedLine = SessionLine | TitleLine;

/** The `user`/`assistant` lines — i.e. everything the parentUuid walk sees. */
export function conversationLines(lines: FabricatedLine[]): SessionLine[] {
  return lines.filter((l): l is SessionLine => l.type === "user" || l.type === "assistant");
}

interface LineSpec {
  /** Identity of the line within its session; its uuid is derived from it. */
  key: string;
  type: "user" | "assistant";
  content: unknown;
  timestamp: string;
  model?: string;
}

/**
 * Convert canonical blocks to Claude-native content blocks. Foreign tool
 * calls keep their names (history is replayed as context, never re-executed);
 * thinking blocks are folded to labeled text — their signatures can't be
 * forged and must not be fabricated.
 */
function convertBlocks(
  blocks: TurnBlock[],
  seenToolUseIds: Set<string>,
  fallbackToolId: (blockIndex: number) => string,
): unknown[] {
  const out: unknown[] = [];
  for (const [blockIndex, block] of blocks.entries()) {
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.trim()) {
          out.push({ type: "text", text: block.text });
        }
        break;
      case "thinking":
        if (block.text) out.push({ type: "text", text: `[visible thinking]\n${String(block.text)}` });
        break;
      case "tool_use": {
        const id = typeof block.id === "string" ? block.id : fallbackToolId(blockIndex);
        seenToolUseIds.add(id);
        const input = toolInput(block.input);
        out.push({ type: "tool_use", id, name: block.name ?? "ImportedTool", input });
        break;
      }
      case "tool_result": {
        const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
        if (id && seenToolUseIds.has(id)) {
          const content =
            typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          out.push({ type: "tool_result", tool_use_id: id, content });
        } else {
          // orphaned result — replay as labeled text rather than break pairing
          out.push({
            type: "text",
            text: `[tool result]\n${typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")}`,
          });
        }
        break;
      }
      default:
        out.push({ type: "text", text: JSON.stringify(block) });
    }
  }
  return out;
}

/**
 * Picker title for a bridged session.
 *
 * Verified by scripts/probe-picker.mjs: the picker titles a session by its
 * `ai-title` line, falling back to the first user message when there is none.
 * Fabricated sessions had no such line, so every bridged conversation showed
 * up in the picker titled by threadhop's own import notice — identical for
 * every bridge, and describing the machinery rather than the conversation.
 * Naming it after the first thing the human actually said is both more useful
 * and closer to what the title would have been natively.
 */
function pickerTitle(summary: ConversationSummary): string {
  const label = cliLabel(summary.source);
  for (const event of summary.events) {
    if (event.actor.type !== "human") continue;
    const content = turnContent(event);
    const text = content?.blocks
      .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .join(" ")
      .trim();
    if (!text) continue;
    const oneLine = text.replace(/\s+/g, " ");
    const snippet = oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine;
    return `${snippet} (from ${label})`;
  }
  return `Imported from ${label}`;
}

export function buildSessionLines(
  summary: ConversationSummary,
  sessionId: string,
  cwd: string,
  version: string,
  now: Date,
  importedSourceEventIds?: string[],
): FabricatedLine[] {
  const specs: LineSpec[] = [
    {
      key: "notice",
      type: "user",
      // Fabrication time, which is *newer* than every history line below it, so
      // the file steps backward exactly once at line 1. Verified deliberate, not
      // an oversight: probe-session-invariants.mjs resumed both this and a
      // backdated-monotonic variant with full history intact, so ordering is not
      // load-bearing for resume. Keeping `now` is the weakly better of two
      // safe options — if the picker sorts on line timestamps rather than file
      // mtime, backdating would bury a freshly bridged session under genuinely
      // old ones, and no reading of the evidence makes it better.
      timestamp: now.toISOString(),
      content: [
        {
          type: "text",
          text:
            `[threadhop import notice] This conversation was imported from ${importSourceLabel(summary)}. ` +
            "The history below is the literal visible transcript; hidden reasoning and provider-private " +
            "state were not transferred, and historical tool calls are context only.",
        },
      ],
    },
  ];

  const seenToolUseIds = new Set<string>();
  const keyFor = eventKeys();
  for (const event of summary.events) {
    const content = turnContent(event);
    if (!content) continue;
    const key = `event:${keyFor(event.id)}`;
    const blocks = convertBlocks(
      content.blocks,
      seenToolUseIds,
      (blockIndex) => `toolu_tb_${stableUuid(`${sessionId}:${key}:tool:${blockIndex}`).slice(0, 8)}`,
    );
    if (blocks.length === 0) continue;
    // tool results ride on user lines in Claude's format
    const type = content.role === "user" || event.actor.type === "human" || content.role === "tool_result" ? "user" : "assistant";
    const spec: LineSpec = {
      key,
      type,
      content: blocks,
      timestamp: normalizeTimestamp(event.occurred_at, now),
    };
    if (type === "assistant" && event.actor.type === "agent" && event.producer.model) {
      spec.model = event.producer.model;
    }
    specs.push(spec);
    importedSourceEventIds?.push(event.id);
  }

  const lines: SessionLine[] = [];
  let parentUuid: string | null = null;
  for (const spec of specs) {
    // Derived, not random: rebuilding the same history for the same session
    // yields the same uuids and parentUuid chain, which is what lets an
    // in-place update tell its own earlier lines from lines Claude appended.
    const uuid = stableUuid(`${sessionId}:${spec.key}`);
    const message: Record<string, unknown> =
      spec.type === "assistant"
        ? {
            // full envelope: defends against stricter validation in other versions
            model: spec.model ?? "threadhop-import",
            id: `msg_tb_${uuid.slice(0, 8)}`,
            type: "message",
            role: "assistant",
            content: spec.content,
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
        : { role: "user", content: spec.content };
    lines.push({
      parentUuid,
      isSidechain: false,
      userType: "external",
      entrypoint: "cli",
      cwd,
      sessionId,
      version,
      type: spec.type,
      message,
      uuid,
      timestamp: spec.timestamp,
    });
    parentUuid = uuid;
  }
  // Trailing placement verified safe by probe-session-invariants.mjs: the
  // parentUuid walk starts at the last line but skips non-conversation types,
  // so a trailing ai-title does not truncate history.
  return [...lines, { type: "ai-title", aiTitle: pickerTitle(summary), sessionId }];
}

async function readExisting(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * How to bring an existing fabricated session up to date with `next`, or why
 * it can't be. Claude Code appends its own session-state records to a file
 * the moment it is opened, even with nothing typed — verified on 2.1.316:
 * `atis-latch`, `cost-state`, `file-history-snapshot`, `mode`,
 * `permission-mode`. None carries a `uuid`, so none is part of the parentUuid
 * chain, and they hold the user's state (permission mode, cost), so they are
 * kept rather than rewritten away.
 *
 * Chain lines — anything with a `uuid` — must all be threadhop's, in order,
 * a prefix of what it would write now (uuids derive from the session id and
 * source events, so the prefix holds while the source only grows). Then the
 * update is simply appending the rest: their parentUuids already continue
 * from the last existing line. A chain line threadhop did not write means
 * the session was continued after resuming, which is divergence: refusing is
 * recoverable, overwriting a user's turns is not.
 */
export function planSessionAppend(
  existing: string,
  next: FabricatedLine[],
): { reason: string } | { append: FabricatedLine[] } {
  const ours = conversationLines(next);
  let matched = 0;
  let hasTitle = false;
  for (const raw of existing.split("\n")) {
    if (!raw.trim()) continue;
    let line: { type?: unknown; uuid?: unknown };
    try {
      line = JSON.parse(raw) as { type?: unknown; uuid?: unknown };
    } catch {
      return { reason: "has a line that is not JSON" };
    }
    if (line.type === "ai-title") {
      hasTitle = true;
      continue;
    }
    if (typeof line.uuid !== "string") continue;
    if (matched >= ours.length || line.uuid !== ours[matched]!.uuid) {
      return { reason: "has conversation lines threadhop did not write (was it continued after resuming?)" };
    }
    matched++;
  }
  const append: FabricatedLine[] = ours.slice(matched);
  if (!hasTitle) append.push(...next.filter((line) => line.type === "ai-title"));
  return { append };
}

export const claudeCodeTarget: TargetAdapter = {
  name: "claude-code",
  binary: "claude",
  supportsUpdateInPlace: true,

  isInstalled() {
    return binaryOnPath("claude");
  },

  nativeResume(sessionId: string, cwd: string): LaunchPlan {
    return {
      command: "claude",
      args: ["--resume", sessionId],
      cwd,
      notes: [`resuming native Claude Code session ${sessionId}`],
    };
  },

  // `opts.replayReasoning` doesn't apply here: only Codex issues opaque
  // reasoning ciphertext, and it can't be forged as a native Claude Code
  // reasoning item, so there is nothing for this target to replay.
  async fabricate(summary: ConversationSummary, cwd: string, opts: FabricateOptions): Promise<LaunchPlan> {
    const version = claudeVersion();
    if (!version) {
      throw new FabricationUnsupportedError("could not determine claude version", "claude-code");
    }
    const notes: string[] = [];
    if (!version.startsWith(VALIDATED_VERSION_PREFIX)) {
      notes.push(
        `claude ${version} has not been validated against the fabrication spec (pinned ${VALIDATED_VERSION_PREFIX}x); ` +
          "rerun with --bootstrap if the resumed session misbehaves",
      );
    }

    const sessionId = opts.existingSessionId ?? randomUUID();
    // resume lookup is scoped to the project dir encoded from the launch cwd
    const dir = join(projectsDir(), encodeProjectDir(cwd));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${sessionId}.jsonl`);
    const importedSourceEventIds: string[] = [];
    const lines = buildSessionLines(
      summary,
      sessionId,
      cwd,
      version,
      new Date(),
      importedSourceEventIds,
    );
    const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

    const existing = opts.existingSessionId ? await readExisting(path) : null;
    if (existing === null) {
      await writeFile(path, body, { mode: 0o600, flag: "wx" });
      notes.push(
        `fabricated Claude Code session ${sessionId} from ${cliLabel(summary.source)} history (${summary.turnCount} turns)`,
        `session file: ${path} (${formatSize(transcriptSize(body))})`,
      );
    } else {
      const plan = planSessionAppend(existing, lines);
      if ("reason" in plan) {
        throw new MirrorDivergedError(
          `Claude Code session ${sessionId} ${plan.reason}; leaving it untouched`,
          "claude-code",
          sessionId,
        );
      }
      // Append, as Claude itself does, rather than replace: its own records
      // stay where they are and a concurrent Claude write is never clobbered.
      if (plan.append.length > 0) {
        const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
        await appendFile(path, separator + plan.append.map((l) => JSON.stringify(l)).join("\n") + "\n");
      }
      const added = conversationLines(plan.append).length;
      notes.push(
        added > 0
          ? `updated Claude Code session ${sessionId} from ${cliLabel(summary.source)} history (+${added} line${added === 1 ? "" : "s"}, ${summary.turnCount} turns)`
          : `Claude Code session ${sessionId} is already up to date with ${cliLabel(summary.source)} history`,
        `session file: ${path}`,
      );
    }
    return {
      command: "claude",
      args: ["--resume", sessionId],
      cwd,
      notes,
      fabricatedConversationId: `claude-code:${sessionId}`,
      importedSourceEventIds,
    };
  },

  bootstrap(summary: ConversationSummary, cwd: string, transcriptPath: string): LaunchPlan {
    return {
      command: "claude",
      args: [bootstrapPrompt(summary, transcriptPath)],
      cwd,
      notes: [
        `starting a NEW Claude Code session rehydrated from ${cliLabel(summary.source)} (bootstrap mode)`,
        `transcript: ${transcriptPath}`,
      ],
    };
  },
};
