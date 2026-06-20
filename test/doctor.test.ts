import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { bindRealityChecks, rebind, install } from "../src/cli/lifecycle.js";
import { loadConfig, writeConfig } from "../src/cli/config.js";
import { buildPlist, plistPath } from "../src/daemon/launchd.js";
import { SystemdManager, type RunResult } from "../src/daemon/systemd.js";
import { tmpRoot, cleanup } from "./helpers.js";

describe("bindRealityChecks (U5)", () => {
  let dataDir: string;
  let configDirPath: string;
  let fakeHome: string;
  const saved: Record<string, string | undefined> = {};
  const okDeps = { reload: () => true, verify: async () => "ok" as const };

  beforeEach(() => {
    dataDir = tmpRoot();
    configDirPath = tmpRoot();
    fakeHome = tmpRoot();
    for (const k of ["HIP_DATA_DIR", "HIP_CONFIG_DIR", "HIP_PORT", "HIP_HOST", "HOME"]) saved[k] = process.env[k];
    process.env.HIP_DATA_DIR = dataDir;
    process.env.HIP_CONFIG_DIR = configDirPath;
    process.env.HIP_PORT = "4319";
    process.env.HOME = fakeHome;
    delete process.env.HIP_HOST;
    install({}); // loopback install, writes config + plist into fakeHome
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    [dataDir, configDirPath, fakeHome].forEach(cleanup);
  });

  function writePlistHost(host: string): void {
    writeFileSync(
      plistPath(),
      buildPlist({
        nodePath: process.execPath, // a node binary that actually exists (avoids tripping launchd-node-missing)
        scriptPath: "/x/hip",
        dataDir,
        configDir: configDirPath,
        host,
        port: 4319,
        logDir: dataDir,
      }),
    );
  }

  it("reports no host/bind issues for a default loopback install", () => {
    // dist-staleness is build-state dependent (and nondeterministic in a dev tree), so
    // assert only on the bind-reality codes this unit owns.
    const codes = bindRealityChecks().map((i) => i.code);
    expect(codes).not.toContain("host-mismatch");
    expect(codes).not.toContain("bind-all-interfaces");
    expect(codes).not.toContain("non-loopback-bind");
  });

  it("warns (not errors) on a scoped non-loopback bind; ok stays true", async () => {
    await rebind("100.64.0.1", okDeps);
    const issues = bindRealityChecks();
    const nl = issues.find((i) => i.code === "non-loopback-bind");
    expect(nl?.severity).toBe("warn");
    expect(issues.every((i) => i.severity !== "error")).toBe(true); // ok stays true
  });

  it("does not false-positive host-mismatch on equivalent IPv6 spellings (canonical compare)", async () => {
    await rebind("FD7A:1:2::3", okDeps); // config url bracketed lowercase, plist bare lowercase
    expect(bindRealityChecks().find((i) => i.code === "host-mismatch")).toBeUndefined();
  });

  it("errors on a plist↔config host mismatch", () => {
    const cfg = loadConfig();
    writeConfig({ url: "http://10.0.0.5:4319/mcp", token: cfg.token, actorId: cfg.actorId, dataDir: cfg.dataDir });
    // plist still carries the install-time 127.0.0.1
    const mismatch = bindRealityChecks().find((i) => i.code === "host-mismatch");
    expect(mismatch?.severity).toBe("error");
  });

  it("errors on an all-interfaces bind (0.0.0.0)", () => {
    const cfg = loadConfig();
    writeConfig({ url: "http://0.0.0.0:4319/mcp", token: cfg.token, actorId: cfg.actorId, dataDir: cfg.dataDir });
    writePlistHost("0.0.0.0");
    const issue = bindRealityChecks().find((i) => i.code === "bind-all-interfaces");
    expect(issue?.severity).toBe("error");
  });

  it("errors when the LaunchAgent node binary is missing (Homebrew-GC class of bug)", () => {
    writeFileSync(
      plistPath(),
      buildPlist({
        nodePath: "/opt/homebrew/Cellar/node/25.8.1/bin/node", // a path that does not exist
        scriptPath: "/x/hip",
        dataDir,
        configDir: configDirPath,
        host: "127.0.0.1",
        port: 4319,
        logDir: dataDir,
      }),
    );
    const issue = bindRealityChecks().find((i) => i.code === "launchd-node-missing");
    expect(issue?.severity).toBe("error");
  });

  // Doctor on linux routes unit introspection through the injected systemd manager: it
  // reports systemd linger state instead of any launchd-specific message, and a loopback
  // co-located install (matching host) raises no bind/host errors. (KTD3 / U2)
  it("reports the systemd linger warning when running under a systemd manager", () => {
    const xdg = tmpRoot();
    const savedXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.USER = "ash";
    try {
      const run = (cmd: string, args: string[]): RunResult => {
        const key = `${cmd} ${args.join(" ")}`;
        if (key.includes("show-user")) return { status: 0, stdout: "Linger=no\n" };
        return { status: 0, stdout: "" };
      };
      const mgr = new SystemdManager(run);
      // install-time unit, loopback host matching the config url (no host-mismatch),
      // node = a real binary (no node-missing).
      mgr.writeUnit(
        mgr.buildUnit({
          nodePath: process.execPath,
          scriptPath: "/opt/hip/cli.js",
          dataDir: "/x",
          configDir: "/x",
          host: "127.0.0.1",
          port: 4319,
          logDir: "/x",
        }),
      );
      const issues = bindRealityChecks(mgr);
      const linger = issues.find((i) => i.code === "linger-disabled");
      expect(linger?.severity).toBe("warn");
      expect(issues.find((i) => i.code === "host-mismatch")).toBeUndefined();
      expect(issues.find((i) => i.code === "launchd-node-missing")).toBeUndefined();
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
      cleanup(xdg);
    }
  });
});
