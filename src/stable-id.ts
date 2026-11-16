import { createHash } from "node:crypto";

/**
 * Fixed namespace for threadhop's name-based ids. Changing it changes every
 * id a fabricator derives, which would make previously written sessions look
 * diverged to an in-place update, so treat it as frozen.
 */
const NAMESPACE = "6f1f6f0e-6b1d-4c2a-9d1e-74726e627264";

function namespaceBytes(): Buffer {
  return Buffer.from(NAMESPACE.replace(/-/g, ""), "hex");
}

/**
 * RFC 4122 version-5 UUID for `name`: the same name always yields the same
 * id. Fabricators derive line and tool-call ids from the target session id
 * plus the source event id, so rewriting a session from the same history
 * reproduces the same ids instead of minting fresh random ones. Distinct
 * session ids still give distinct ids, as random ones did.
 */
export function stableUuid(name: string): string {
  const hash = createHash("sha1").update(namespaceBytes()).update(name, "utf8").digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Per-event id keys that stay unique even if a history were ever to repeat an
 * event id: the second occurrence of `e1` becomes `e1#1`, and so on.
 */
export function eventKeys(): (eventId: string) => string {
  const seen = new Map<string, number>();
  return (eventId) => {
    const n = seen.get(eventId) ?? 0;
    seen.set(eventId, n + 1);
    return n === 0 ? eventId : `${eventId}#${n}`;
  };
}
