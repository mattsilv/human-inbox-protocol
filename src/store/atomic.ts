import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

export function contentHash(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex").slice(0, 16);
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Durable atomic write: write to a temp sibling, fsync the file, rename over the
 * target (POSIX-atomic), then fsync the directory so the rename itself is durable.
 * A crash leaves either the old file intact or the new file complete — never a torn
 * mix. Stray `.tmp` files from a mid-write crash are ignored by readers/reindex.
 */
export function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data, null, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  // fsync the directory so the rename survives an OS crash.
  try {
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is best-effort; some platforms reject it.
  }
}

export function readIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf8");
}
