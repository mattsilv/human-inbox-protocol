import type { Store } from "../store/index.js";
import { contentHash } from "../store/index.js";
import { conflict } from "./errors.js";

/**
 * Deterministic JSON: object keys sorted recursively and undefined values dropped, so an
 * honest retry that reorders or omits-as-undefined fields hashes equal. Hashes only the
 * client-supplied payload — never server-assigned/volatile fields (id, timestamps) — so
 * a genuine retry never false-conflicts (KTD4 risk).
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Content hash of a client-supplied creation payload (the idempotency fingerprint). */
export function payloadHash(payload: Record<string, unknown>): string {
  return contentHash(stableStringify(payload));
}

/**
 * Resolve a client idempotency key against the creation-key ledger:
 * - miss → null (caller creates the object and records the key in the same commit),
 * - hit, same hash + type → the existing object id (caller short-circuits, no new write),
 * - hit, different hash or type → throw `conflict` (a client bug: same key, different
 *   payload — surfaced, never silently merged).
 */
export function resolveCreationKey(
  store: Store,
  actorId: string,
  clientKey: string,
  hash: string,
  objectType: string,
): string | null {
  const prior = store.getCreationKey(actorId, clientKey);
  if (!prior) return null;
  if (prior.objectType !== objectType) {
    throw conflict(`clientKey "${clientKey}" was already used for a ${prior.objectType}, not a ${objectType}`);
  }
  if (prior.contentHash !== hash) {
    throw conflict(`clientKey "${clientKey}" was already used with different content`);
  }
  return prior.objectId;
}
