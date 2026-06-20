import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { atomicWrite, readIfExists } from "../store/index.js";
import type { ServiceManager, UnitOptions } from "./service-manager.js";

export const LAUNCHD_LABEL = "ai.hip.daemon";

export interface PlistOptions {
  label?: string;
  nodePath: string; // absolute — launchd has no PATH
  scriptPath: string; // absolute path to the hip cli entry
  dataDir: string;
  configDir: string;
  host: string;
  port: number;
  logDir: string;
}

export function plistPath(label: string = LAUNCHD_LABEL): string {
  return join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

/**
 * Per-user LaunchAgent. RunAtLoad + KeepAlive(SuccessfulExit:false) keeps the daemon
 * alive across logout/login and crashes; the at-or-after nudge guarantee comes from
 * the DB scan, not launchd. All paths are absolute because launchd runs with no PATH.
 */
export function buildPlist(opts: PlistOptions): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  const args = [opts.nodePath, opts.scriptPath, "serve"];
  const argXml = args.map((a) => `      <string>${escapeXml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HIP_DATA_DIR</key>
    <string>${escapeXml(opts.dataDir)}</string>
    <key>HIP_CONFIG_DIR</key>
    <string>${escapeXml(opts.configDir)}</string>
    <key>HIP_HOST</key>
    <string>${escapeXml(opts.host)}</string>
    <key>HIP_PORT</key>
    <string>${opts.port}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(opts.logDir, "hip.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(opts.logDir, "hip.err.log"))}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * macOS launchd implementation of the service-manager seam. Wraps the existing
 * `buildPlist`/`plistPath` plus the launchctl reload/list logic moved verbatim from
 * `src/cli/lifecycle.ts` — no behavior change. All spawns carry a timeout so a stuck
 * launchd/mach port cannot hang the event loop.
 */
export class LaunchdManager implements ServiceManager {
  readonly name = "launchd";

  unitPath(): string {
    return plistPath();
  }

  buildUnit(opts: UnitOptions): string {
    return buildPlist(opts);
  }

  /** Write the plist atomically (load stays a manual `launchctl load` step, as before). */
  writeUnit(unitText: string): string[] {
    const target = plistPath();
    mkdirSync(dirname(target), { recursive: true });
    atomicWrite(target, unitText);
    return [`  LaunchAgent: ${target}`, `  load it:    launchctl load ${target}`];
  }

  remove(): string {
    const target = plistPath();
    if (existsSync(target)) {
      unlinkSync(target);
      return `Removed LaunchAgent ${target}. Run \`launchctl unload ${target}\` if it is still loaded. Data dir left intact.`;
    }
    return "No LaunchAgent installed.";
  }

  /** Is the LaunchAgent loaded? Only meaningful on macOS; false elsewhere. */
  isLoaded(): boolean {
    if (process.platform !== "darwin") return false;
    const r = spawnSync("launchctl", ["list"], { encoding: "utf8", timeout: 5000 });
    return r.status === 0 && (r.stdout ?? "").includes(LAUNCHD_LABEL);
  }

  /**
   * Restart the LaunchAgent so it re-reads the plist env (and re-derives the allowlist).
   * Returns false if no launchd daemon is loaded; throws if a daemon IS loaded but every
   * restart path fails.
   */
  reload(): boolean {
    if (!this.isLoaded()) return false;
    const uid = process.getuid?.() ?? 0;
    const kick = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${LAUNCHD_LABEL}`], { timeout: 10000 });
    if (kick.status === 0) return true;
    // Fallback: unload (ignore "not loaded") then load — mirrors scripts/update.sh.
    const target = plistPath();
    spawnSync("launchctl", ["unload", target], { timeout: 10000 });
    const load = spawnSync("launchctl", ["load", target], { timeout: 10000 });
    if (load.status !== 0) {
      throw new Error(`launchctl reload failed — kickstart and unload/load both failed for ${LAUNCHD_LABEL}`);
    }
    return true;
  }

  /** The HIP_HOST declared in the installed plist, or null if no plist / no key. */
  readUnitHost(): string | null {
    const text = readIfExists(plistPath());
    if (text === null) return null;
    const m = /<key>HIP_HOST<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
    return m ? m[1]! : null;
  }

  /** The node binary the LaunchAgent will exec (ProgramArguments[0]), or null if no plist. */
  readUnitNodePath(): string | null {
    const text = readIfExists(plistPath());
    if (text === null) return null;
    const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text);
    return m ? m[1]! : null;
  }

  /** launchd has no per-user linger concern; no extra doctor checks. */
  extraChecks(): never[] {
    return [];
  }
}
