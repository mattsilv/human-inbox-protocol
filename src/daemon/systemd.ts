import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ServiceManager, UnitOptions } from "./service-manager.js";
import type { DoctorIssue } from "../store/index.js";

export const SYSTEMD_UNIT = "hip.service";

/** Result of one spawned command — the subset SystemdManager reads. */
export interface RunResult {
  status: number | null;
  stdout?: string;
}
/** Injectable command runner (real systemd cannot run in unit tests). */
export type Spawner = (cmd: string, args: string[]) => RunResult;

/** Default runner: timeout-guarded spawnSync, mirroring launchctl's bounded calls. */
const defaultRun: Spawner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 });
  return { status: r.status, stdout: r.stdout ?? "" };
};

function configHome(): string {
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
}

/**
 * Linux systemd **user** service implementation of the service-manager seam. Installs a
 * `systemctl --user` unit at ~/.config/systemd/user/hip.service, bound loopback, and
 * enables linger so the daemon survives logout/boot on a headless box (KTD3). All spawns
 * are timeout-guarded; the runner is injectable because real systemd can't run in tests.
 */
export class SystemdManager implements ServiceManager {
  readonly name = "systemd-user";
  private readonly user: string;

  constructor(private readonly run: Spawner = defaultRun) {
    // USER for headless installs where userInfo() may be sparse; fall back to userInfo.
    this.user = process.env.USER ?? safeUsername();
  }

  unitPath(): string {
    return join(configHome(), "systemd", "user", SYSTEMD_UNIT);
  }

  /**
   * Build a `[Unit]/[Service]/[Install]` file. Environment values and ExecStart args are
   * double-quoted so paths with spaces survive systemd's whitespace splitting.
   * Restart=on-failure + WantedBy=default.target are the systemd analogue of the plist's
   * KeepAlive(SuccessfulExit:false) + RunAtLoad.
   */
  buildUnit(opts: UnitOptions): string {
    const exec = [opts.nodePath, opts.scriptPath, "serve"].map(q).join(" ");
    return `[Unit]
Description=HIP daemon (human-in-the-loop protocol)
After=network.target

[Service]
Type=simple
ExecStart=${exec}
Environment=${q(`HIP_DATA_DIR=${opts.dataDir}`)}
Environment=${q(`HIP_CONFIG_DIR=${opts.configDir}`)}
Environment=${q(`HIP_HOST=${opts.host}`)}
Environment=${q(`HIP_PORT=${opts.port}`)}
Restart=on-failure
StandardOutput=append:${join(opts.logDir, "hip.out.log")}
StandardError=append:${join(opts.logDir, "hip.err.log")}

[Install]
WantedBy=default.target
`;
  }

  /**
   * Write the unit, enable linger (survive logout/boot — KTD3), reload the manager, and
   * enable+start the service. Returns operator-facing report lines.
   */
  writeUnit(unitText: string): string[] {
    const target = this.unitPath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, unitText);
    // linger first so the user manager persists; then pick up the new unit and start it.
    const linger = this.run("loginctl", ["enable-linger", this.user]);
    this.run("systemctl", ["--user", "daemon-reload"]);
    this.run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    return [
      `  systemd unit: ${target}`,
      `  enabled:      systemctl --user enable --now ${SYSTEMD_UNIT}`,
      linger.status === 0
        ? `  linger:       enabled for ${this.user} (survives logout/boot)`
        : `  linger:       could NOT enable for ${this.user} — run \`loginctl enable-linger ${this.user}\` so the daemon survives logout`,
    ];
  }

  remove(): string {
    const target = this.unitPath();
    this.run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    if (existsSync(target)) {
      unlinkSync(target);
      this.run("systemctl", ["--user", "daemon-reload"]);
      return `Removed systemd unit ${target} (disabled + stopped). Data dir left intact. Linger left enabled — \`loginctl disable-linger ${this.user}\` to undo.`;
    }
    return "No systemd unit installed.";
  }

  /** Active = `systemctl --user is-active hip.service` prints "active". */
  isLoaded(): boolean {
    const r = this.run("systemctl", ["--user", "is-active", SYSTEMD_UNIT]);
    return (r.stdout ?? "").trim() === "active";
  }

  /**
   * Reload so the daemon re-reads its env: daemon-reload then restart. Returns false when
   * the service is not active (manual `hip serve`) — mirrors launchd's not-loaded path.
   * Throws if the service IS active but restart fails, so rebind reports a reload failure.
   */
  reload(): boolean {
    if (!this.isLoaded()) return false;
    this.run("systemctl", ["--user", "daemon-reload"]);
    const r = this.run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    if (r.status !== 0) {
      throw new Error(`systemctl --user restart failed for ${SYSTEMD_UNIT}`);
    }
    return true;
  }

  /** HIP_HOST declared in the installed unit, or null if no unit / no key. */
  readUnitHost(): string | null {
    return this.readEnv("HIP_HOST");
  }

  /** Node binary the unit will exec (first ExecStart arg), or null if no unit. */
  readUnitNodePath(): string | null {
    const text = this.readUnit();
    if (text === null) return null;
    const m = /^ExecStart=(.+)$/m.exec(text);
    if (!m) return null;
    return firstArg(m[1]!);
  }

  /**
   * systemd-specific doctor check: warn when the unit is installed but linger is off — the
   * headless-box footgun where the daemon dies on logout (KTD3 risk). Empty otherwise.
   */
  extraChecks(): DoctorIssue[] {
    if (!existsSync(this.unitPath())) return [];
    if (this.lingerEnabled()) return [];
    return [
      {
        severity: "warn",
        code: "linger-disabled",
        message: `systemd linger is not enabled for ${this.user} — on a headless box the daemon dies at logout and will not start at boot. Run \`loginctl enable-linger ${this.user}\`.`,
      },
    ];
  }

  private lingerEnabled(): boolean {
    const r = this.run("loginctl", ["show-user", this.user, "--property=Linger"]);
    return (r.stdout ?? "").includes("Linger=yes");
  }

  private readUnit(): string | null {
    const target = this.unitPath();
    return existsSync(target) ? readFileSync(target, "utf8") : null;
  }

  private readEnv(key: string): string | null {
    const text = this.readUnit();
    if (text === null) return null;
    // Environment="KEY=value" (quoted) or Environment=KEY=value (bare).
    const m = new RegExp(`^Environment="?${key}=([^"\\n]*)"?$`, "m").exec(text);
    return m ? m[1]! : null;
  }
}

/** Quote a systemd token so embedded whitespace does not split it. */
function q(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** First whitespace- or quote-delimited token of an ExecStart line (handles quoting). */
function firstArg(line: string): string | null {
  const m = /^\s*"([^"]*)"|^\s*(\S+)/.exec(line);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return "user";
  }
}
