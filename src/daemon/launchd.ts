import { homedir } from "node:os";
import { join } from "node:path";

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
