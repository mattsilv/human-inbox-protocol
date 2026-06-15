import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(p));
    });
  });
}
import { buildPlist } from "../src/daemon/launchd.js";
import { acquireDataDirLock, LockError } from "../src/daemon/lock.js";
import { install, status, serve, runReindex } from "../src/cli/lifecycle.js";
import { configPath, tokenPath, loadConfig } from "../src/cli/config.js";
import { Store } from "../src/store/index.js";
import { tmpRoot, cleanup } from "./helpers.js";

describe("daemon lifecycle (U8)", () => {
  let dataDir: string;
  let configDirPath: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dataDir = tmpRoot();
    configDirPath = tmpRoot();
    for (const k of ["HIP_DATA_DIR", "HIP_CONFIG_DIR", "HIP_PORT", "HIP_HOST"]) saved[k] = process.env[k];
    process.env.HIP_DATA_DIR = dataDir;
    process.env.HIP_CONFIG_DIR = configDirPath;
    process.env.HIP_PORT = "0";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup(dataDir);
    cleanup(configDirPath);
  });

  it("buildPlist emits valid XML with absolute paths and KeepAlive", () => {
    const plist = buildPlist({
      nodePath: "/usr/local/bin/node",
      scriptPath: "/usr/local/lib/hip/cli.js",
      dataDir: "/Users/m/hip",
      configDir: "/Users/m/.config/hip",
      host: "127.0.0.1",
      port: 4319,
      logDir: "/Users/m/hip",
    });
    expect(plist).toMatch(/^<\?xml/);
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("/usr/local/bin/node");
    expect(plist).toContain("/usr/local/lib/hip/cli.js");
    expect(plist).not.toMatch(/<string>node<\/string>/); // never a bare relative path
  });

  it("install seeds actors, writes a 0600 token file, and never prints the token", () => {
    const out = install({ writePlist: false });
    expect(existsSync(configPath())).toBe(true);
    expect(existsSync(tokenPath())).toBe(true);

    const token = readFileSync(tokenPath(), "utf8").trim();
    expect(token.length).toBeGreaterThan(20);
    expect(out).not.toContain(token); // path printed, not the secret
    expect(out).toContain(tokenPath());

    const tokenMode = statSync(tokenPath()).mode & 0o777;
    expect(tokenMode & 0o077).toBe(0); // no group/other access

    const store = new Store({ root: dataDir });
    expect(store.getActor("act_owner")).not.toBeNull();
    expect(store.getActor("act_cli")).not.toBeNull();
    store.close();
  });

  it("writes the token file with no trailing newline (U1 clean byte contract)", () => {
    install({ writePlist: false });
    const raw = readFileSync(tokenPath(), "utf8");
    expect(raw.endsWith("\n")).toBe(false);
    expect(raw).toBe(raw.trim());
    expect(raw.length).toBeGreaterThan(20);
  });

  it("loadConfig still reads a legacy newline-terminated token file (U1 backward compat)", () => {
    install({ writePlist: false });
    const tok = readFileSync(tokenPath(), "utf8");
    writeFileSync(tokenPath(), tok + "\n", { mode: 0o600 }); // simulate a pre-fix install
    expect(loadConfig().token).toBe(tok);
  });

  it("install is idempotent (re-running replaces without duplicating actors)", () => {
    install({ writePlist: false });
    const firstOwner = readActor("act_owner");
    install({ writePlist: false });
    const secondOwner = readActor("act_owner");
    expect(secondOwner.id).toBe(firstOwner.id);
    expect(secondOwner.createdAt).toBe(firstOwner.createdAt); // not recreated
  });

  it("status reports an actionable state when the daemon is dead", async () => {
    install({ writePlist: false });
    const msg = await status();
    expect(msg).toMatch(/not reachable|hip serve/);
  });

  it("the data-dir lock prevents a second writer (single-instance)", () => {
    const lockFile = join(dataDir, ".lock");
    const lock = acquireDataDirLock(lockFile);
    try {
      expect(() => acquireDataDirLock(lockFile)).toThrowError(LockError);
    } finally {
      lock.release();
    }
    // After release, a fresh acquire succeeds.
    acquireDataDirLock(lockFile).release();
  });

  it("serve starts, serves, and a second serve refuses (lock held)", async () => {
    process.env.HIP_PORT = String(await freePort()); // real port so client routing works
    install({ writePlist: false });
    const handle = await serve();
    try {
      expect(handle.daemon.listenPort).toBeGreaterThan(0);
      await expect(serve()).rejects.toThrow(/already running|in use/);
      // reindex routes through the live daemon's admin tool
      expect(await runReindex()).toContain("reindex complete");
    } finally {
      await handle.stop();
    }
  });

  function readActor(id: string): { id: string; createdAt: string } {
    const store = new Store({ root: dataDir });
    const a = store.getActor(id)!;
    store.close();
    return a;
  }
});
