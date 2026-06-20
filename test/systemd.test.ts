import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SystemdManager, SYSTEMD_UNIT, type RunResult } from "../src/daemon/systemd.js";
import { selectServiceManager } from "../src/daemon/service-manager.js";
import type { UnitOptions } from "../src/daemon/service-manager.js";
import { tmpRoot, cleanup } from "./helpers.js";

const OPTS: UnitOptions = {
  nodePath: "/usr/bin/node",
  scriptPath: "/opt/hip/cli.js",
  dataDir: "/home/u/.hip",
  configDir: "/home/u/.config/hip",
  host: "127.0.0.1",
  port: 4319,
  logDir: "/home/u/.hip",
};

/** A spawn recorder: logs every (cmd, args) and returns a per-command canned result. */
function recorder(results: Record<string, RunResult> = {}) {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]): RunResult => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pat, res] of Object.entries(results)) if (key.includes(pat)) return res;
    return { status: 0, stdout: "" };
  };
  return { calls, run };
}

describe("SystemdManager (U2)", () => {
  let xdg: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    xdg = tmpRoot();
    for (const k of ["XDG_CONFIG_HOME", "USER"]) saved[k] = process.env[k];
    process.env.XDG_CONFIG_HOME = xdg;
    process.env.USER = "ash";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup(xdg);
  });

  it("emitted unit carries ExecStart, all four env vars, Restart, and WantedBy", () => {
    const unit = new SystemdManager().buildUnit(OPTS);
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/hip/cli.js" "serve"');
    expect(unit).toContain('Environment="HIP_DATA_DIR=/home/u/.hip"');
    expect(unit).toContain('Environment="HIP_CONFIG_DIR=/home/u/.config/hip"');
    expect(unit).toContain('Environment="HIP_HOST=127.0.0.1"');
    expect(unit).toContain('Environment="HIP_PORT=4319"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("unit path resolves to ~/.config/systemd/user/hip.service (via XDG_CONFIG_HOME)", () => {
    expect(new SystemdManager().unitPath()).toBe(join(xdg, "systemd", "user", "hip.service"));
  });

  it("selector returns the systemd impl on linux", () => {
    const mgr = selectServiceManager("linux");
    expect(mgr.name).toBe("systemd-user");
    expect(mgr).toBeInstanceOf(SystemdManager);
  });

  it("install runs enable-linger, daemon-reload, then enable --now (in order) and writes the unit", () => {
    const rec = recorder();
    const mgr = new SystemdManager(rec.run);
    const lines = mgr.writeUnit(mgr.buildUnit(OPTS));
    expect(existsSync(mgr.unitPath())).toBe(true);
    const seq = rec.calls.map((c) => c.join(" "));
    expect(seq).toEqual([
      "loginctl enable-linger ash",
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
    ]);
    expect(lines.join("\n")).toMatch(/linger:\s+enabled for ash/);
  });

  it("reports a linger failure in the install lines without throwing", () => {
    const rec = recorder({ "enable-linger": { status: 1, stdout: "" } });
    const lines = new SystemdManager(rec.run).writeUnit("[Service]\n");
    expect(lines.join("\n")).toMatch(/could NOT enable/);
  });

  it("reports a FAILED start (enable --now non-zero) instead of claiming success", () => {
    const rec = recorder({ "enable --now": { status: 1, stdout: "" } });
    const lines = new SystemdManager(rec.run).writeUnit("[Service]\n");
    expect(lines.join("\n")).toMatch(/enabled:\s+FAILED/);
  });

  it("reload runs daemon-reload then restart when active", () => {
    const rec = recorder({ "is-active": { status: 0, stdout: "active\n" } });
    const mgr = new SystemdManager(rec.run);
    expect(mgr.reload()).toBe(true);
    const seq = rec.calls.map((c) => c.join(" "));
    expect(seq).toContain("systemctl --user daemon-reload");
    expect(seq).toContain(`systemctl --user restart ${SYSTEMD_UNIT}`);
    // daemon-reload precedes restart
    expect(seq.indexOf("systemctl --user daemon-reload")).toBeLessThan(
      seq.indexOf(`systemctl --user restart ${SYSTEMD_UNIT}`),
    );
  });

  it("reload returns false (no restart) when the service is not active", () => {
    const rec = recorder({ "is-active": { status: 3, stdout: "inactive\n" } });
    const mgr = new SystemdManager(rec.run);
    expect(mgr.reload()).toBe(false);
    expect(rec.calls.map((c) => c.join(" "))).not.toContain(`systemctl --user restart ${SYSTEMD_UNIT}`);
  });

  it("reload throws when active but restart fails", () => {
    const rec = recorder({
      "is-active": { status: 0, stdout: "active\n" },
      restart: { status: 1, stdout: "" },
    });
    expect(() => new SystemdManager(rec.run).reload()).toThrow(/restart failed/);
  });

  it("isLoaded parses is-active output", () => {
    expect(new SystemdManager(recorder({ "is-active": { status: 0, stdout: "active\n" } }).run).isLoaded()).toBe(true);
    expect(new SystemdManager(recorder({ "is-active": { status: 3, stdout: "failed\n" } }).run).isLoaded()).toBe(false);
  });

  it("uninstall disables --now and removes the unit file", () => {
    const rec = recorder();
    const mgr = new SystemdManager(rec.run);
    mgr.writeUnit(mgr.buildUnit(OPTS));
    rec.calls.length = 0; // ignore install calls
    const msg = mgr.remove();
    expect(rec.calls.map((c) => c.join(" "))).toContain(`systemctl --user disable --now ${SYSTEMD_UNIT}`);
    expect(existsSync(mgr.unitPath())).toBe(false);
    expect(msg).toMatch(/Removed systemd unit/);
  });

  it("read-back parses HIP_HOST and the node path from the installed unit", () => {
    const mgr = new SystemdManager(recorder().run);
    mgr.writeUnit(mgr.buildUnit(OPTS));
    expect(mgr.readUnitHost()).toBe("127.0.0.1");
    expect(mgr.readUnitNodePath()).toBe("/usr/bin/node");
  });

  it("read-back is null when no unit is installed", () => {
    const mgr = new SystemdManager(recorder().run);
    expect(mgr.readUnitHost()).toBeNull();
    expect(mgr.readUnitNodePath()).toBeNull();
  });

  describe("extraChecks — linger doctor warning (KTD3)", () => {
    it("warns when the unit is installed but linger is disabled", () => {
      const rec = recorder({ "show-user": { status: 0, stdout: "Linger=no\n" } });
      const mgr = new SystemdManager(rec.run);
      mgr.writeUnit(mgr.buildUnit(OPTS));
      const issues = mgr.extraChecks();
      expect(issues).toHaveLength(1);
      expect(issues[0]!.code).toBe("linger-disabled");
      expect(issues[0]!.severity).toBe("warn");
    });

    it("is clean when linger is enabled", () => {
      const rec = recorder({ "show-user": { status: 0, stdout: "Linger=yes\n" } });
      const mgr = new SystemdManager(rec.run);
      mgr.writeUnit(mgr.buildUnit(OPTS));
      expect(mgr.extraChecks()).toEqual([]);
    });

    it("is clean when no unit is installed (nothing to warn about)", () => {
      expect(new SystemdManager(recorder().run).extraChecks()).toEqual([]);
    });
  });
});
