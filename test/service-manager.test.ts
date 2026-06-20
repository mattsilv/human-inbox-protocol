import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { selectServiceManager } from "../src/daemon/service-manager.js";
import { LaunchdManager, buildPlist, plistPath } from "../src/daemon/launchd.js";
import type { UnitOptions } from "../src/daemon/service-manager.js";
import { tmpRoot, cleanup } from "./helpers.js";

const OPTS: UnitOptions = {
  nodePath: "/usr/local/bin/node",
  scriptPath: "/x/hip",
  dataDir: "/data",
  configDir: "/cfg",
  host: "127.0.0.1",
  port: 4319,
  logDir: "/data",
};

describe("service-manager seam (U1) — launchd characterization", () => {
  it("buildUnit is byte-identical to buildPlist for the same opts", () => {
    expect(new LaunchdManager().buildUnit(OPTS)).toBe(buildPlist(OPTS));
  });

  it("unitPath resolves to ~/Library/LaunchAgents/ai.hip.daemon.plist", () => {
    expect(new LaunchdManager().unitPath()).toBe(plistPath());
    expect(plistPath()).toContain(join("Library", "LaunchAgents", "ai.hip.daemon.plist"));
  });

  it("selector returns the launchd manager on darwin (name = launchd)", () => {
    const mgr = selectServiceManager("darwin");
    expect(mgr.name).toBe("launchd");
    expect(mgr).toBeInstanceOf(LaunchdManager);
  });

  it("selector returns a manager on linux (systemd-user branch lands in U2)", () => {
    // U1 ships launchd-only; this pins that the linux branch is reachable and total.
    expect(selectServiceManager("linux")).toBeDefined();
  });

  describe("writeUnit / read-back (redirected HOME)", () => {
    let fakeHome: string;
    let savedHome: string | undefined;

    beforeEach(() => {
      fakeHome = tmpRoot();
      savedHome = process.env.HOME;
      process.env.HOME = fakeHome; // redirects plistPath() away from the real LaunchAgents
    });
    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      cleanup(fakeHome);
    });

    it("writeUnit writes the plist and returns the load hint", () => {
      const mgr = new LaunchdManager();
      const lines = mgr.writeUnit(mgr.buildUnit(OPTS));
      expect(existsSync(plistPath())).toBe(true);
      expect(readFileSync(plistPath(), "utf8")).toBe(buildPlist(OPTS));
      expect(lines.join("\n")).toMatch(/launchctl load/);
    });

    it("readUnitHost and readUnitNodePath parse the installed unit", () => {
      const mgr = new LaunchdManager();
      mgr.writeUnit(mgr.buildUnit(OPTS));
      expect(mgr.readUnitHost()).toBe("127.0.0.1");
      expect(mgr.readUnitNodePath()).toBe("/usr/local/bin/node");
    });

    it("read-back is null when no unit is installed", () => {
      const mgr = new LaunchdManager();
      expect(mgr.readUnitHost()).toBeNull();
      expect(mgr.readUnitNodePath()).toBeNull();
    });

    it("remove deletes the unit and reports it; no-op message when absent", () => {
      const mgr = new LaunchdManager();
      expect(mgr.remove()).toBe("No LaunchAgent installed.");
      mgr.writeUnit(mgr.buildUnit(OPTS));
      expect(mgr.remove()).toMatch(/Removed LaunchAgent/);
      expect(existsSync(plistPath())).toBe(false);
    });
  });
});
