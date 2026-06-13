import type { Command } from "commander";
import { existsSync, writeFileSync, mkdirSync, chmodSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store, defaultDataRoot, dataPaths, reindex, doctor } from "../store/index.js";
import { HipDaemon, DEFAULT_HOST, DEFAULT_PORT } from "../daemon/server.js";
import { NudgeEngine } from "../daemon/nudge.js";
import { generateToken } from "../daemon/auth.js";
import { acquireDataDirLock } from "../daemon/lock.js";
import { buildPlist, plistPath } from "../daemon/launchd.js";
import { registerAdminTools } from "../tools/admin.js";
import { ensureActor } from "../domain/actors.js";
import { loadConfig, writeConfig, configDir, tokenPath, ConfigError } from "./config.js";
import { HipClient } from "../client.js";
import { spin, colorHeading } from "./tty.js";

const OWNER = "act_owner";
const CLI_ACTOR = "act_cli";

function host(): string {
  return process.env.HIP_HOST ?? DEFAULT_HOST;
}
function port(): number {
  return process.env.HIP_PORT ? Number.parseInt(process.env.HIP_PORT, 10) : DEFAULT_PORT;
}
function urlFor(): string {
  return `http://${host()}:${port()}/mcp`;
}

// ---- serve ----------------------------------------------------------------

export interface ServeHandle {
  daemon: HipDaemon;
  stop(): Promise<void>;
}

export async function serve(): Promise<ServeHandle> {
  const cfg = loadConfig(); // throws an actionable ConfigError if not installed
  const root = cfg.dataDir ?? defaultDataRoot();
  const paths = dataPaths(root);

  // Single-instance: hold the data-dir lock for the daemon's lifetime (throws LockError).
  const lock = acquireDataDirLock(paths.lockFile);

  const store = new Store({ root });
  // Startup order: reindex → nudge catch-up (dedupe must see decisions filed pre-crash).
  reindex(store);
  const daemon = new HipDaemon({
    store,
    token: cfg.token,
    host: host(),
    port: port(),
    extraTools: [registerAdminTools],
  });

  try {
    await daemon.start();
  } catch (e) {
    lock.release();
    store.close();
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`port ${port()} is in use — a HIP daemon is already running. Not starting a second.`, {
        cause: e,
      });
    }
    throw e;
  }

  const nudge = new NudgeEngine(store);
  nudge.start();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    nudge.stop();
    await daemon.stop();
    store.close();
    lock.release();
  };
  const onSignal = () => void stop().then(() => process.exit(0));
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return { daemon, stop };
}

// ---- install --------------------------------------------------------------

export interface InstallOptions {
  ownerName?: string;
  writePlist?: boolean;
}

export function install(opts: InstallOptions = {}): string {
  const root = defaultDataRoot();
  ensureDirMode(root, 0o700); // attention data is private

  const token = generateToken();

  // Seed the owner + CLI actors so the very first write has a valid actor (bootstrap).
  const store = new Store({ root });
  try {
    ensureActor(store, { id: OWNER, kind: "person", displayName: opts.ownerName ?? "Owner" });
    ensureActor(store, { id: CLI_ACTOR, kind: "service", displayName: "HIP CLI" });
  } finally {
    store.close();
  }

  const written = writeConfig({ url: urlFor(), token, actorId: OWNER, dataDir: root });

  const lines = [
    "HIP installed.",
    `  data dir:   ${root} (0700)`,
    `  config:     ${written.configPath}`,
    `  token file: ${written.tokenPath} (0600)  — the token is NOT printed; read it from this file`,
    `  owner actor: ${OWNER}     cli actor: ${CLI_ACTOR}`,
    `  url:        ${urlFor()}`,
  ];

  if (opts.writePlist !== false) {
    const target = plistPath();
    mkdirSync(dirname(target), { recursive: true });
    const plist = buildPlist({
      nodePath: process.execPath,
      scriptPath: process.argv[1] ?? "hip",
      dataDir: root,
      configDir: configDir(),
      host: host(),
      port: port(),
      logDir: root,
    });
    writeFileSync(target, plist);
    lines.push(`  LaunchAgent: ${target}`);
    lines.push(`  load it:    launchctl load ${target}`);
  }

  lines.push("");
  lines.push("Connect a client (Hermes / Claude Code):");
  lines.push(`  url=${urlFor()}  bearer=$(cat ${tokenPath()})  actorId=${OWNER}`);
  return lines.join("\n");
}

export function uninstall(): string {
  const target = plistPath();
  if (existsSync(target)) {
    unlinkSync(target);
    return `Removed LaunchAgent ${target}. Run \`launchctl unload ${target}\` if it is still loaded. Data dir left intact.`;
  }
  return "No LaunchAgent installed.";
}

// ---- status / doctor / reindex -------------------------------------------

export async function status(): Promise<string> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    return e instanceof ConfigError ? `not installed — ${e.message}` : String(e);
  }
  const client = new HipClient({ url: cfg.url, token: cfg.token });
  try {
    await spin("Checking the daemon", () => client.connect());
    const tools = await client.listTools();
    // Verify the port occupant is actually a HIP daemon, not some other server.
    if (!tools.includes("task_create")) {
      return `something is listening at ${cfg.url} but it is not a HIP daemon (no task_create tool).`;
    }
    const report = (await client.callOk("doctor_run")) as { ok: boolean; issues: unknown[] };
    await client.close();
    return `${colorHeading("HIP daemon is running")} at ${cfg.url}.\n  doctor: ${report.ok ? "clean" : `${report.issues.length} issue(s)`}`;
  } catch {
    return `HIP daemon is not reachable at ${cfg.url} — run \`hip serve\` or load the LaunchAgent.`;
  }
}

export async function runDoctor(): Promise<string> {
  return viaDaemonOrDirect(
    async (client) => {
      const r = (await client.callOk("doctor_run")) as { ok: boolean; issues: { message: string }[] };
      return formatDoctor(r);
    },
    (store) => formatDoctor(doctor(store)) + "\n" + permsReport(),
  );
}

export async function runReindex(): Promise<string> {
  return viaDaemonOrDirect(
    async (client) => {
      const r = (await client.callOk("reindex_run")) as { counts: Record<string, number> };
      return `reindex complete: ${JSON.stringify(r.counts)}`;
    },
    (store) => {
      const r = reindex(store);
      return `reindex complete: ${JSON.stringify(r.counts)}`;
    },
  );
}

/** When the daemon is alive, route through it; else take the lock and act directly. */
async function viaDaemonOrDirect(
  online: (client: HipClient) => Promise<string>,
  offline: (store: Store) => string,
): Promise<string> {
  const cfg = loadConfig();
  const client = new HipClient({ url: cfg.url, token: cfg.token });
  try {
    await client.connect();
    const out = await online(client);
    await client.close();
    return out;
  } catch {
    // Daemon down — direct access is permitted only with the lock held.
    const root = cfg.dataDir ?? defaultDataRoot();
    const paths = dataPaths(root);
    const lock = acquireDataDirLock(paths.lockFile);
    const store = new Store({ root });
    try {
      return offline(store);
    } finally {
      store.close();
      lock.release();
    }
  }
}

function formatDoctor(r: { ok: boolean; issues: { message: string }[] }): string {
  if (r.ok && r.issues.length === 0) return "doctor: clean.";
  return ["doctor:", ...r.issues.map((i) => `  - ${i.message}`)].join("\n");
}

/** Warn on loose permissions for the data dir and token file. */
function permsReport(): string {
  const out: string[] = [];
  const checks: [string, number][] = [
    [defaultDataRoot(), 0o700],
    [tokenPath(), 0o600],
  ];
  for (const [path, want] of checks) {
    if (!existsSync(path)) continue;
    const mode = statSync(path).mode & 0o777;
    if (mode & ~want & 0o077) out.push(`  warn: ${path} is mode ${mode.toString(8)} (want ${want.toString(8)})`);
  }
  return out.length ? out.join("\n") : "  perms: ok.";
}

function ensureDirMode(dir: string, mode: number): void {
  mkdirSync(dir, { recursive: true, mode });
  try {
    chmodSync(dir, mode);
  } catch {
    /* best-effort */
  }
}

// ---- update ---------------------------------------------------------------

/** The repo root, derived from this file's location: dist/cli/lifecycle.js → ../../ */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Pull latest, rebuild dist/, and restart the daemon via scripts/update.sh. */
export function update(opts: { pull?: boolean } = {}): number {
  const script = join(repoRoot(), "scripts", "update.sh");
  if (!existsSync(script)) {
    process.stderr.write(
      `hip: cannot self-update — ${script} not found. This build was not installed from the git checkout.\n`,
    );
    return 1;
  }
  const args = opts.pull === false ? [script, "--no-pull"] : [script];
  const r = spawnSync("bash", args, { stdio: "inherit" });
  return r.status ?? 1;
}

// ---- command registration -------------------------------------------------

export function registerLifecycleCommands(program: Command): void {
  program
    .command("serve")
    .description("Run the HIP daemon in the foreground")
    .action(async () => {
      try {
        const { daemon } = await serve();
        process.stdout.write(`HIP daemon listening at ${daemon.url}\n`);
      } catch (e) {
        process.stderr.write(`hip: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("install")
    .description("Generate the token, seed actors, and write the LaunchAgent")
    .option("--owner-name <name>", "display name for the owner actor")
    .action((opts: { ownerName?: string }) => {
      process.stdout.write(install(opts.ownerName ? { ownerName: opts.ownerName } : {}) + "\n");
    });

  program
    .command("uninstall")
    .description("Remove the LaunchAgent (data dir left intact)")
    .action(() => {
      process.stdout.write(uninstall() + "\n");
    });

  program
    .command("status")
    .description("Check daemon liveness and a doctor summary")
    .action(async () => {
      process.stdout.write((await status()) + "\n");
    });

  program
    .command("doctor")
    .description("Audit store consistency")
    .action(async () => {
      process.stdout.write((await runDoctor()) + "\n");
    });

  program
    .command("reindex")
    .description("Rebuild the derived index/timers from files")
    .action(async () => {
      process.stdout.write((await runReindex()) + "\n");
    });

  program
    .command("update")
    .description("Pull latest, rebuild, and restart the daemon")
    .option("--no-pull", "rebuild the current checkout without git pull")
    .action((opts: { pull?: boolean }) => {
      process.exitCode = update(opts.pull === false ? { pull: false } : {});
    });
}
