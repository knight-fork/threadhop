import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoInfo } from "conversation-ledger";

/**
 * One threadhop writer per repository at a time. Mirror and resume both bring
 * the same native copies up to date by appending to them, and two appenders
 * working from the same starting point would each add the same lines.
 *
 * The lock is a directory (mkdir is atomic) under the repository's common git
 * directory, so every worktree of a repository shares it, as they share its
 * ledger. A holder that crashed leaves it behind; it is taken over once its
 * process is gone or it is older than any run could take.
 */
const STALE_AFTER_MS = 10 * 60 * 1000;
const POLL_MS = 100;

function stateDir(repo: RepoInfo): string {
  return join(repo.commonDir, "threadhop");
}

function lockPath(repo: RepoInfo): string {
  return join(stateDir(repo), "mirror.lock");
}

function queuePath(repo: RepoInfo): string {
  return join(stateDir(repo), "mirror-queue.jsonl");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function isStale(lock: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(lock, "owner.json"), "utf8")) as { pid?: number };
    if (typeof owner.pid === "number" && !processIsAlive(owner.pid)) return true;
  } catch {
    // Owner not written yet (the holder is between mkdir and writeFile), or
    // unreadable: fall back to age alone.
  }
  try {
    return Date.now() - (await stat(lock)).mtimeMs > STALE_AFTER_MS;
  } catch {
    return false; // released in the meantime; the next attempt will see that
  }
}

/** Take the lock if it is free (or abandoned); false when someone else holds it. */
export async function tryLock(repo: RepoInfo): Promise<boolean> {
  const lock = lockPath(repo);
  await mkdir(stateDir(repo), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (attempt > 0 || !(await isStale(lock))) return false;
      await rm(lock, { recursive: true, force: true });
    }
  }
  return false;
}

export async function unlock(repo: RepoInfo): Promise<void> {
  await rm(lockPath(repo), { recursive: true, force: true });
}

/** Run `fn` holding the lock, waiting up to `timeoutMs` for another run to finish. */
export async function withMirrorLock<T>(repo: RepoInfo, fn: () => Promise<T>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (!(await tryLock(repo))) {
    if (Date.now() > deadline) {
      throw new Error(
        `another threadhop run has held ${lockPath(repo)} for over ${Math.round(timeoutMs / 1000)}s; ` +
          "if no threadhop is running, remove that directory",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  try {
    return await fn();
  } finally {
    await unlock(repo);
  }
}

/** A conversation an automatic run was asked to mirror. */
export interface MirrorRequest {
  source: string;
  sessionId: string;
  /** Where that session ran; copies are made for the same folder. */
  cwd: string;
}

export async function enqueue(repo: RepoInfo, request: MirrorRequest): Promise<void> {
  await mkdir(stateDir(repo), { recursive: true });
  await appendFile(queuePath(repo), JSON.stringify(request) + "\n");
}

/** Take every queued request, leaving the queue empty. Call only while holding the lock. */
export async function drain(repo: RepoInfo): Promise<MirrorRequest[]> {
  const taken = `${queuePath(repo)}.${process.pid}`;
  try {
    await rename(queuePath(repo), taken);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const raw = await readFile(taken, "utf8");
  await rm(taken, { force: true });
  const requests: MirrorRequest[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line) as MirrorRequest;
      const key = `${request.source}:${request.sessionId}:${request.cwd}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requests.push(request);
    } catch {
      // A torn line from a writer that died mid-append; its run is lost, and
      // the next turn in that session queues it again.
    }
  }
  return requests;
}

async function queueIsEmpty(repo: RepoInfo): Promise<boolean> {
  try {
    return (await stat(queuePath(repo))).size === 0;
  } catch {
    return true;
  }
}

/**
 * Queue `request`, then process the queue as soon as the lock is free. Hooks
 * fire back to back (a turn's Stop, then SessionEnd), and from several
 * sessions at once; this turns those into as few runs as possible, none of
 * them concurrent, and none of the requests lost.
 *
 * A request is queued before the lock is tried, so a run that is waiting
 * returns as soon as the queue is empty: an automatic run holding the lock
 * drained it and handles the request. A manual `mirror` or `resume` holding
 * the lock never drains the queue, so the request waits for the lock instead.
 * Requests still queued after `timeoutMs` are left for the next run.
 */
export async function processQueued(
  repo: RepoInfo,
  request: MirrorRequest,
  run: (requests: MirrorRequest[]) => Promise<void>,
  timeoutMs = 5 * 60_000,
): Promise<{ ran: boolean }> {
  await enqueue(repo, request);
  const deadline = Date.now() + timeoutMs;
  let ran = false;
  for (;;) {
    if (await tryLock(repo)) {
      try {
        const requests = await drain(repo);
        if (requests.length > 0) {
          ran = true;
          await run(requests);
        }
      } finally {
        await unlock(repo);
      }
    }
    if ((await queueIsEmpty(repo)) || Date.now() > deadline) return { ran };
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));
  }
}
