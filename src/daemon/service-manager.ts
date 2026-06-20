import { LaunchdManager } from "./launchd.js";
import { SystemdManager } from "./systemd.js";
import type { DoctorIssue } from "../store/index.js";

/**
 * Options for rendering a per-user service unit (launchd plist / systemd unit). The
 * superset both managers need; all paths absolute because neither manager has a PATH.
 */
export interface UnitOptions {
  nodePath: string; // absolute — the service runs with no PATH
  scriptPath: string; // absolute path to the hip cli entry
  dataDir: string;
  configDir: string;
  host: string;
  port: number;
  logDir: string;
}

/**
 * The platform-agnostic seam the CLI uses to install/reload/inspect the daemon's
 * supervisor. `launchd` (macOS) and `systemd-user` (Linux, U2) implement it; the CLI
 * never branches on `process.platform` beyond `selectServiceManager`.
 */
export interface ServiceManager {
  /** Short manager name for operator-facing messaging ("launchd" / "systemd-user"). */
  readonly name: string;
  /** Path to the installed unit file. */
  unitPath(): string;
  /** Render the unit text (plist / systemd unit) from options. */
  buildUnit(opts: UnitOptions): string;
  /** Write the unit and perform any activation; returns operator-facing report lines. */
  writeUnit(unitText: string): string[];
  /** Remove the unit (and deactivate); returns an operator-facing message. */
  remove(): string;
  /** Is the service currently loaded/active? */
  isLoaded(): boolean;
  /** Reload so the daemon re-reads its env; false when no service is loaded. */
  reload(): boolean;
  /** Bind host declared in the installed unit, or null when not installed. */
  readUnitHost(): string | null;
  /** Node binary the installed unit will exec, or null when not installed. */
  readUnitNodePath(): string | null;
  /** Manager-specific doctor checks (launchd: none; systemd: linger). Empty when not installed. */
  extraChecks(): DoctorIssue[];
}

/**
 * Platform-select the service manager. Linux → systemd-user; every other platform →
 * launchd. This is the only `process.platform` branch in the codebase.
 */
export function selectServiceManager(platform: NodeJS.Platform = process.platform): ServiceManager {
  if (platform === "linux") return new SystemdManager();
  return new LaunchdManager();
}
