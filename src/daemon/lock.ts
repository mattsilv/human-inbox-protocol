import { openSync, closeSync, writeSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { ensureDir } from "../store/atomic.js";
import { dirname } from "node:path";

export class LockError extends Error {}

export interface Lock {
  release(): void;
}

/**
 * Exclusive data-dir lock. Two daemons = two writers + two nudge engines = duplicate
 * decisions, so only one process may hold the store. The lock file carries the holder
 * pid; a lock whose pid is dead is treated as stale and reclaimed.
 */
export function acquireDataDirLock(lockFile: string): Lock {
  ensureDir(dirname(lockFile));
  if (existsSync(lockFile)) {
    const pid = Number.parseInt(readFileSync(lockFile, "utf8").trim(), 10);
    if (Number.isFinite(pid) && isAlive(pid)) {
      throw new LockError(`HIP daemon already running (pid ${pid}) — another process holds the store lock`);
    }
    // Stale lock from a crashed process: reclaim it (tolerate a concurrent unlink).
    try {
      unlinkSync(lockFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  let fd: number;
  try {
    fd = openSync(lockFile, "wx");
  } catch (e) {
    // Another process won the reclaim race between our unlink and open.
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new LockError("HIP daemon already running — lost the store-lock acquisition race");
    }
    throw e;
  }
  writeSync(fd, String(process.pid));
  closeSync(fd);
  return {
    release() {
      try {
        if (existsSync(lockFile)) unlinkSync(lockFile);
      } catch {
        /* best-effort */
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}
