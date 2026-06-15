import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { bindRealityChecks, rebind, install } from "../src/cli/lifecycle.js";
import { loadConfig, writeConfig } from "../src/cli/config.js";
import { buildPlist, plistPath } from "../src/daemon/launchd.js";
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
        nodePath: "/usr/local/bin/node",
        scriptPath: "/x/hip",
        dataDir,
        configDir: configDirPath,
        host,
        port: 4319,
        logDir: dataDir,
      }),
    );
  }

  it("is clean for a default loopback install", () => {
    expect(bindRealityChecks()).toEqual([]);
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
});
