import { randomBytes } from "node:crypto";
import { ID_PREFIX } from "../types.js";

// Sortable-ish, collision-resistant ids: <prefix>_<base36 time><random>.
// The time component keeps directory listings roughly chronological; the random
// suffix removes same-millisecond collisions. Not a ULID, but enough for one store.
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomSuffix(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function newId(kind: keyof typeof ID_PREFIX, now: number = Date.now()): string {
  const time = now.toString(36);
  return `${ID_PREFIX[kind]}_${time}${randomSuffix(6)}`;
}

const PREFIXES = new Set(Object.values(ID_PREFIX));

export function idPrefix(id: string): string | null {
  const i = id.indexOf("_");
  if (i <= 0) return null;
  const p = id.slice(0, i);
  return PREFIXES.has(p as never) ? p : null;
}

export function isId(id: unknown, kind: keyof typeof ID_PREFIX): id is string {
  return typeof id === "string" && id.startsWith(`${ID_PREFIX[kind]}_`);
}
