import type { CliName, ConversationSummary } from "../types.js";

/** A concrete command to hand the terminal over to. */
export interface LaunchPlan {
  command: string;
  args: string[];
  cwd: string;
  /** Shown to the user before launch (session type honesty, warnings). */
  notes: string[];
  /** Submit only at a known native composer. No approval/trust screens are accepted. */
  initialInput?: { prompt: string; readiness: string; paste?: boolean };
  /**
   * Ledger conversation id the fabricated session will be captured under
   * (`<source>:<generated-session-id>`), when this plan fabricated one. The
   * generated id is preserved across the target's native resume, so it is a
   * stable anchor for recording source→target lineage.
   */
  fabricatedConversationId?: string;
  /** Why native fabrication fell back; environment failures are not format incompatibility. */
  nativeImportFallback?: { kind: "format" | "environment"; reason: string };
  /** Ordered ids of source events the fabricated target actually contains. */
  importedSourceEventIds?: string[];
}

export interface TargetAdapter {
  name: CliName;
  /** Executable name looked up on PATH. */
  binary: string;
  /** Native resume by exact ID may be absent even when transcript bootstrap works. */
  supportsNativeResume?: boolean;
  supportsNativeImport?: boolean;
  /**
   * Whether `fabricate` honours `opts.existingSessionId` by rewriting that
   * session in place. Adapters without it would mint a new session instead,
   * so callers must check this before asking for an update.
   */
  supportsUpdateInPlace?: boolean;
  isInstalled(): Promise<boolean>;
  /** Native resume for a conversation that originated in this CLI. */
  nativeResume(sessionId: string, cwd: string): LaunchPlan;
  /**
   * Fabricate a native session file from canonical events so this CLI's own
   * resume loads it, then return the resume plan. Version-pinned; throws
   * FabricationUnsupportedError when the installed CLI version is unverified.
   * `replayReasoning` governs whether opaque `reasoning` events are replayed
   * verbatim where the target supports it (Codex only, gated per-event on
   * `producer.source === "codex"` — most targets ignore the flag entirely).
   * `existingSessionId`, on adapters with `supportsUpdateInPlace`, rewrites
   * that previously fabricated session instead of creating a new one, and
   * throws MirrorDivergedError (leaving the file untouched) when the session
   * holds anything turnbridge would not write itself, such as turns the user
   * added after resuming it.
   */
  fabricate(
    summary: ConversationSummary,
    cwd: string,
    opts: FabricateOptions,
  ): Promise<LaunchPlan>;
  /** Honest fallback: fresh session instructed to read the transcript file. */
  bootstrap(summary: ConversationSummary, cwd: string, transcriptPath: string): LaunchPlan;
}

export interface FabricateOptions {
  replayReasoning: boolean;
  /** Rewrite this previously fabricated session in place (see supportsUpdateInPlace). */
  existingSessionId?: string | undefined;
}

/**
 * The session asked to be updated in place has content turnbridge did not
 * write, so rewriting it would destroy that content. Callers fall back to a
 * new session; this is not a format failure and must not trigger bootstrap.
 */
export class MirrorDivergedError extends Error {
  constructor(
    message: string,
    public readonly cliName: CliName,
    public readonly sessionId: string,
  ) {
    super(message);
  }
}

export class FabricationUnsupportedError extends Error {
  constructor(
    message: string,
    public readonly cliName: CliName,
    public readonly kind: "format" | "environment" = "format",
  ) {
    super(message);
  }
}
