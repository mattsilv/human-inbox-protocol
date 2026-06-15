import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";

export interface HipConfig {
  url: string;
  token: string;
  actorId: string;
  dataDir?: string;
}

export function configDir(): string {
  return process.env.HIP_CONFIG_DIR ?? join(homedir(), ".config", "hip");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function tokenPath(): string {
  return join(configDir(), "token");
}

export class ConfigError extends Error {}

/** Read the connection config, or throw an actionable error pointing at `hip install`. */
export function loadConfig(): HipConfig {
  const path = configPath();
  if (!existsSync(path)) {
    throw new ConfigError(`no HIP config at ${path} — run \`hip install\` first`);
  }
  let cfg: Partial<HipConfig>;
  try {
    cfg = JSON.parse(readFileSync(path, "utf8")) as Partial<HipConfig>;
    // The token lives 0600 beside the config, never inline in world-readable JSON.
    if (!cfg.token && existsSync(tokenPath())) cfg.token = readFileSync(tokenPath(), "utf8").trim();
  } catch (e) {
    throw new ConfigError(`could not read HIP config (${(e as Error).message}) — re-run \`hip install\``);
  }
  if (!cfg.url || !cfg.token || !cfg.actorId) {
    throw new ConfigError(`incomplete HIP config at ${path} — re-run \`hip install\``);
  }
  return cfg as HipConfig;
}

export interface WriteConfigInput {
  url: string;
  token: string;
  actorId: string;
  dataDir?: string;
}

/** Persist config (0700 dir); the bearer token goes to a separate 0600 file. */
export function writeConfig(input: WriteConfigInput): { configPath: string; tokenPath: string } {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best-effort on platforms without chmod */
  }
  const { token, ...rest } = input;
  writeFileSync(configPath(), JSON.stringify(rest, null, 2) + "\n", { mode: 0o600 });
  // No trailing newline: the file holds exactly the token, so an external consumer
  // comparing raw bytes matches. `loadConfig` .trim()s, so legacy newlined files still
  // load — the change is forward-only. See docs/binding.md (token-file format contract).
  writeFileSync(tokenPath(), token, { mode: 0o600 });
  try {
    chmodSync(tokenPath(), 0o600);
    chmodSync(configPath(), 0o600);
  } catch {
    /* best-effort */
  }
  return { configPath: configPath(), tokenPath: tokenPath() };
}
