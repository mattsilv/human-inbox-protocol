import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { HipDaemon } from "../src/daemon/server.js";
import { rebind, remoteVerify, install } from "../src/cli/lifecycle.js";
import { configPath, tokenPath } from "../src/cli/config.js";
import { plistPath, LaunchdManager } from "../src/daemon/launchd.js";
import { Store } from "../src/store/index.js";
import { tmpRoot, cleanup, freePort } from "./helpers.js";

// These tests assert launchd plist specifics; pin the launchd manager so they are
// deterministic on any CI host (on Linux, selectServiceManager() would pick systemd).
const ld = new LaunchdManager();

/** Start a stub HTTP server whose handler is supplied per call; returns its url + closer. */
async function stubServer(handler: Parameters<typeof createHttpServer>[1]): Promise<{ url: string; close: () => Promise<void>; server: Server }> {
  const srv = createHttpServer(handler);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((r) => srv.close(() => r())), server: srv };
}

describe("remoteVerify (U3) — authenticated POST against the new authority", () => {
  it("returns ok for an authenticated POST a live daemon admits", async () => {
    const root = tmpRoot();
    const store = new Store({ root });
    const daemon = new HipDaemon({ store, token: "tok", port: 0 });
    await daemon.start();
    try {
      expect(await remoteVerify(daemon.url, "tok", 1000, 50)).toBe("ok");
    } finally {
      await daemon.stop();
      store.close();
      cleanup(root);
    }
  });

  it("maps a 403 to forbidden and sends a POST with the Bearer token", async () => {
    let sawMethod = "";
    let sawAuth = "";
    const srv = createHttpServer((req, res) => {
      sawMethod = req.method ?? "";
      sawAuth = (req.headers["authorization"] as string) ?? "";
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      expect(await remoteVerify(`http://127.0.0.1:${port}/mcp`, "tok", 1000, 50)).toBe("forbidden");
      expect(sawMethod).toBe("POST");
      expect(sawAuth).toBe("Bearer tok");
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });

  it("returns unreachable when nothing is listening (polls to budget)", async () => {
    const dead = await freePort(); // closed immediately — connection refused
    expect(await remoteVerify(`http://127.0.0.1:${dead}/mcp`, "tok", 150, 50)).toBe("unreachable");
  });

  it("retries a non-2xx (e.g. 503 from a half-initialized daemon) until a 2xx, then ok", async () => {
    let n = 0;
    const stub = await stubServer((_req, res) => {
      n += 1;
      res.writeHead(n === 1 ? 503 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
    try {
      expect(await remoteVerify(stub.url, "tok", 1000, 50)).toBe("ok");
      expect(n).toBeGreaterThanOrEqual(2); // first 503 was retried, not surfaced
    } finally {
      await stub.close();
    }
  });

  it("does NOT read a 401 as success — retries it", async () => {
    let n = 0;
    const stub = await stubServer((_req, res) => {
      n += 1;
      res.writeHead(n === 1 ? 401 : 200, { "content-type": "application/json" });
      res.end("{}");
    });
    try {
      expect(await remoteVerify(stub.url, "tok", 1000, 50)).toBe("ok");
      expect(n).toBe(2);
    } finally {
      await stub.close();
    }
  });
});

describe("rebind (U3) — transactional file rewrite", () => {
  let dataDir: string;
  let configDirPath: string;
  let fakeHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dataDir = tmpRoot();
    configDirPath = tmpRoot();
    fakeHome = tmpRoot(); // redirects plistPath() away from the real ~/Library/LaunchAgents
    for (const k of ["HIP_DATA_DIR", "HIP_CONFIG_DIR", "HIP_PORT", "HIP_HOST", "HOME"]) saved[k] = process.env[k];
    process.env.HIP_DATA_DIR = dataDir;
    process.env.HIP_CONFIG_DIR = configDirPath;
    process.env.HIP_PORT = "4319";
    process.env.HOME = fakeHome;
    delete process.env.HIP_HOST;
    install({ manager: ld }); // writes config + plist (into fakeHome)
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup(dataDir);
    cleanup(configDirPath);
    cleanup(fakeHome);
  });

  const okDeps = { reload: () => true, verify: async () => "ok" as const, manager: ld };

  it("rewrites config url and plist HIP_HOST in one call and preserves the token (0600)", async () => {
    const tokenBefore = readFileSync(tokenPath(), "utf8");
    const out = await rebind("100.64.0.1", okDeps);
    expect(out).toContain("http://100.64.0.1:4319/mcp");

    const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as { url: string };
    expect(cfg.url).toBe("http://100.64.0.1:4319/mcp");
    const plist = readFileSync(plistPath(), "utf8");
    expect(plist).toContain("<key>HIP_HOST</key>\n    <string>100.64.0.1</string>");

    expect(readFileSync(tokenPath(), "utf8")).toBe(tokenBefore); // unchanged
    expect(statSync(tokenPath()).mode & 0o077).toBe(0); // still 0600
  });

  it("canonicalizes an IPv6 host: brackets in the url, bare lowercase in the plist", async () => {
    await rebind("FD7A:1:2::3", okDeps);
    const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as { url: string };
    expect(cfg.url).toBe("http://[fd7a:1:2::3]:4319/mcp");
    expect(readFileSync(plistPath(), "utf8")).toContain("<string>fd7a:1:2::3</string>");
  });

  it("prints the non-loopback security reminder for a remote host", async () => {
    const out = await rebind("100.64.0.1", okDeps);
    expect(out).toMatch(/security:/);
    expect(out).toMatch(/token is now the only gate/);
  });

  it("refuses 0.0.0.0 and :: with no file writes", async () => {
    const cfgBefore = readFileSync(configPath(), "utf8");
    const plistBefore = readFileSync(plistPath(), "utf8");
    await expect(rebind("0.0.0.0", okDeps)).rejects.toThrow(/all interfaces/);
    await expect(rebind("::", okDeps)).rejects.toThrow(/all interfaces/);
    expect(readFileSync(configPath(), "utf8")).toBe(cfgBefore);
    expect(readFileSync(plistPath(), "utf8")).toBe(plistBefore);
  });

  it("rolls back config and plist when the remote verify is forbidden", async () => {
    const cfgBefore = readFileSync(configPath(), "utf8");
    const plistBefore = readFileSync(plistPath(), "utf8");
    let reloads = 0;
    await expect(
      rebind("100.64.0.1", { reload: () => (reloads++, true), verify: async () => "forbidden", manager: ld }),
    ).rejects.toThrow(/rolled back/i);
    expect(readFileSync(configPath(), "utf8")).toBe(cfgBefore);
    expect(readFileSync(plistPath(), "utf8")).toBe(plistBefore);
    expect(reloads).toBe(2); // reload, then re-reload after restore
  });

  it("rolls back config and plist when the remote verify is unreachable", async () => {
    const cfgBefore = readFileSync(configPath(), "utf8");
    const plistBefore = readFileSync(plistPath(), "utf8");
    let reloads = 0;
    await expect(
      rebind("100.64.0.1", { reload: () => (reloads++, true), verify: async () => "unreachable", manager: ld }),
    ).rejects.toThrow(/did not come back|still restarting/i);
    expect(readFileSync(configPath(), "utf8")).toBe(cfgBefore);
    expect(readFileSync(plistPath(), "utf8")).toBe(plistBefore);
    expect(reloads).toBe(2); // reload, then re-reload after restore
  });

  it("rolls back when reload itself throws (e.g. a hard launchctl reload failure)", async () => {
    const cfgBefore = readFileSync(configPath(), "utf8");
    const plistBefore = readFileSync(plistPath(), "utf8");
    await expect(
      rebind("100.64.0.1", {
        reload: () => {
          throw new Error("launchctl reload failed");
        },
        verify: async () => "ok",
        manager: ld,
      }),
    ).rejects.toThrow(/launchctl reload failed[\s\S]*Rolled back/i);
    expect(readFileSync(configPath(), "utf8")).toBe(cfgBefore);
    expect(readFileSync(plistPath(), "utf8")).toBe(plistBefore);
  });

  it("rewrites config only and creates no plist when none exists (manual serve / --no-plist)", async () => {
    unlinkSync(plistPath()); // simulate an install without a LaunchAgent
    const out = await rebind("100.64.0.1", okDeps);
    expect(out).toContain("http://100.64.0.1:4319/mcp");
    expect(existsSync(plistPath())).toBe(false); // not created
    const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as { url: string };
    expect(cfg.url).toBe("http://100.64.0.1:4319/mcp");
  });

  it("writes files but skips verify when no launchd daemon is loaded", async () => {
    let verified = false;
    const out = await rebind("100.64.0.1", {
      reload: () => false,
      verify: async () => ((verified = true), "ok"),
      manager: ld,
    });
    expect(verified).toBe(false);
    expect(out).toMatch(/restart your `hip serve`/);
    const cfg = JSON.parse(readFileSync(configPath(), "utf8")) as { url: string };
    expect(cfg.url).toBe("http://100.64.0.1:4319/mcp"); // files still written
  });
});
