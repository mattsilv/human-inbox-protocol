import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Store, defaultDataRoot, dataPaths, reindex, doctor, atomicWrite, type DoctorIssue, type DoctorReport } from "../store/index.js";
import { HipDaemon, DEFAULT_HOST, DEFAULT_PORT } from "../daemon/server.js";
import { hostPort, canonicalHost, isAllInterfaces, isLoopbackHost } from "../daemon/host.js";
import { NudgeEngine } from "../daemon/nudge.js";
import { generateToken } from "../daemon/auth.js";
import { acquireDataDirLock } from "../daemon/lock.js";
import { selectServiceManager, type ServiceManager } from "../daemon/service-manager.js";
import { registerAdminTools } from "../tools/admin.js";
import { ensureActor } from "../domain/actors.js";
import { loadConfig, writeConfig, configDir, configPath, tokenPath, ConfigError } from "./config.js";
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
function urlFor(hostOverride?: string): string {
  return `http://${hostPort(hostOverride ?? host(), port())}/mcp`;
}

// ---- serve ----------------------------------------------------------------

export interface ServeHandle {
  daemon: HipDaemon;
  stop(): Promise<void>;
}

export async function serve(): Promise<ServeHandle> {
  const cfg = loadConfig(); // throws an actionable ConfigError if not installed

  // Best-effort: warn (never block) if the running source is ahead of the built dist.
  const stale = checkDistStaleness();
  if (stale) process.stderr.write(`hip: ${stale.message}\n`);

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
  /** Bind host override; falls back to HIP_HOST/DEFAULT_HOST. Routed through `hostPort`. */
  host?: string;
}

export function install(opts: InstallOptions = {}): string {
  const root = defaultDataRoot();
  ensureDirMode(root, 0o700); // attention data is private

  // Resolve + canonicalize the bind host once and use it for both the config url and the
  // plist env, so the two writable sources and the daemon's allowlist agree byte-for-byte.
  const bindHost = canonicalHost(opts.host ?? host());

  const token = generateToken();

  // Seed the owner + CLI actors so the very first write has a valid actor (bootstrap).
  const store = new Store({ root });
  try {
    ensureActor(store, { id: OWNER, kind: "person", displayName: opts.ownerName ?? "Owner" });
    ensureActor(store, { id: CLI_ACTOR, kind: "service", displayName: "HIP CLI" });
  } finally {
    store.close();
  }

  const written = writeConfig({ url: urlFor(bindHost), token, actorId: OWNER, dataDir: root });

  const lines = [
    "HIP installed.",
    `  data dir:   ${root} (0700)`,
    `  config:     ${written.configPath}`,
    `  token file: ${written.tokenPath} (0600)  — the token is NOT printed; read it from this file`,
    `  owner actor: ${OWNER}     cli actor: ${CLI_ACTOR}`,
    `  url:        ${urlFor(bindHost)}`,
  ];

  if (opts.writePlist !== false) {
    const mgr = selectServiceManager();
    const unit = mgr.buildUnit({
      nodePath: process.execPath,
      scriptPath: process.argv[1] ?? "hip",
      dataDir: root,
      configDir: configDir(),
      host: bindHost,
      port: port(),
      logDir: root,
    });
    lines.push(...mgr.writeUnit(unit));
  }

  lines.push("");
  lines.push("Connect a client (Hermes / Claude Code):");
  lines.push(`  url=${urlFor(bindHost)}  bearer=$(cat ${tokenPath()})  actorId=${OWNER}`);
  return lines.join("\n");
}

export function uninstall(): string {
  return selectServiceManager().remove();
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
  // Bind-reality checks are CLI-side (they need config/plist/fs, which the daemon-side
  // store doctor does not have) and are merged into both the online and offline reports.
  const bind = bindRealityChecks();
  return viaDaemonOrDirect(
    async (client) => {
      const r = (await client.callOk("doctor_run")) as unknown as DoctorReport;
      return formatDoctor(withBindChecks(r, bind));
    },
    (store) => formatDoctor(withBindChecks(doctor(store), bind)) + "\n" + permsReport(),
  );
}

/** Merge bind-reality issues into a store-doctor report, recomputing `ok` (errors flip it; warnings do not). */
function withBindChecks(r: DoctorReport, bind: DoctorIssue[]): DoctorReport {
  const issues = [...r.issues, ...bind];
  return { ok: issues.every((i) => i.severity !== "error"), issues };
}

/** The host implied by the config url, or null if unparseable. */
function hostFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * CLI-side network/bind reality checks (KTD1): unit↔config host mismatch, an unsafe
 * all-interfaces bind (error), a non-loopback bind reminder (warn), and dist staleness.
 * Returns no issues when not installed. Unit introspection is routed through the active
 * service manager (launchd plist / systemd unit).
 */
export function bindRealityChecks(mgr: ServiceManager = selectServiceManager()): DoctorIssue[] {
  const issues: DoctorIssue[] = [];
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    return issues; // not installed — nothing to check
  }

  const cfgHost = hostFromUrl(cfg.url);
  const unitHost = mgr.readUnitHost();

  if (unitHost !== null && cfgHost !== null && canonicalHost(unitHost) !== canonicalHost(cfgHost)) {
    issues.push({
      severity: "error",
      code: "host-mismatch",
      message: `${mgr.name} HIP_HOST (${unitHost}) != config url host (${cfgHost}) — run \`hip rebind\` to resync`,
    });
  }

  const bindHost = cfgHost ?? unitHost;
  if (bindHost) {
    if (isAllInterfaces(bindHost)) {
      issues.push({
        severity: "error",
        code: "bind-all-interfaces",
        message: `daemon is bound to ${bindHost} (all interfaces) — never safe; \`hip rebind\` to a specific host`,
      });
    } else if (!isLoopbackHost(bindHost)) {
      issues.push({
        severity: "warn",
        code: "non-loopback-bind",
        message: `bound to ${bindHost} (non-loopback) — the bearer token is the only gate. HIP cannot verify network ACLs are in place; restrict the port at the network layer and keep the token 0600`,
      });
    }
  }

  // The daemon cannot restart if its pinned node binary was removed — e.g. a Homebrew
  // `node` upgrade garbage-collects the old Cellar version the unit points at. The
  // running process survives in memory but the next reboot/reload kills it for good.
  // Catch it here, before that happens, silently.
  const nodePath = mgr.readUnitNodePath();
  if (nodePath && !existsSync(nodePath)) {
    issues.push({
      severity: "error",
      code: "launchd-node-missing",
      message: `${mgr.name} node binary ${nodePath} is missing — the daemon will not restart (likely removed by a Homebrew upgrade). Point the unit at a pinned runtime (e.g. \`node@26\`) and reload.`,
    });
  }

  // Manager-specific checks (systemd: linger on a headless box). Launchd contributes none.
  issues.push(...mgr.extraChecks());

  const stale = checkDistStaleness();
  if (stale) issues.push(stale);

  return issues;
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

function formatDoctor(r: DoctorReport): string {
  if (r.ok && r.issues.length === 0) return "doctor: clean.";
  return ["doctor:", ...r.issues.map((i) => `  - [${i.severity}] ${i.message}`)].join("\n");
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

/** Newest mtime (ms) of any file ending in `ext` under `dir`, recursively. 0 if none. */
function newestMtime(dir: string, ext: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(p, ext));
    else if (entry.name.endsWith(ext)) newest = Math.max(newest, statSync(p).mtimeMs);
  }
  return newest;
}

/**
 * Best-effort staleness hint (a `warn`, never an `error`): is the built dist older than
 * the source? Catches a `git pull` without `hip update`. mtime is a weak proxy — an
 * editor save / `touch` trips a false positive, a `cp -p` / restore a false negative —
 * so the wording is hedged and this never gates startup. A recorded `dist/BUILD_SHA`
 * would be the reliable mechanism (deferred). Returns null when `src/` is absent (npm
 * package ships only dist) or `dist/cli/index.js` is absent (dev tree mid-build), so
 * there are no false positives in either runtime. `root` is injectable for tests.
 */
export function checkDistStaleness(root: string = repoRoot()): DoctorIssue | null {
  try {
    const srcDir = join(root, "src");
    const distMarker = join(root, "dist", "cli", "index.js");
    if (!existsSync(srcDir) || !existsSync(distMarker)) return null;
    const newestSrc = newestMtime(srcDir, ".ts");
    const distMtime = statSync(distMarker).mtimeMs;
    if (newestSrc > distMtime) {
      return {
        severity: "warn",
        code: "dist-stale",
        message: "dist may be stale (src is newer than dist/cli/index.js) — run `hip update` to rebuild",
      };
    }
    return null;
  } catch {
    // A transient fs fault (permission, TOCTOU during the walk) must degrade to "no hint",
    // never abort serve() startup — this is a best-effort signal, not a gate.
    return null;
  }
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

// ---- rebind ---------------------------------------------------------------

const NONLOOPBACK_REMINDER =
  "\n  security: bound beyond loopback — the bearer token is now the only gate. " +
  "HIP cannot verify network ACLs are in place; restrict the port at the network layer " +
  "(e.g. Tailscale ACLs) and keep the token 0600.";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type VerifyResult = "ok" | "forbidden" | "unreachable";

/**
 * Verify the daemon admits a *remote* request on the new authority. This MUST be an
 * authenticated POST: the daemon refuses non-POST with 405 and a missing Bearer with
 * 401 *before* the DNS-rebinding Host/Origin check ever runs, so only an authenticated
 * POST can produce the 403 that signals a stale allowlist. A 403 → the allowlist did not
 * pick up the rebind; any other response → admitted. Connection errors are retried until
 * the budget expires (the daemon may still be restarting), then reported unreachable.
 */
export async function remoteVerify(
  url: string,
  token: string,
  budgetMs = 5000,
  intervalMs = 250,
): Promise<VerifyResult> {
  const deadline = Date.now() + budgetMs;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  for (;;) {
    let status: number | null = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body,
        // Per-attempt timeout: a half-open socket (common mid-restart) must not block the
        // loop past the budget waiting on the OS TCP timeout. Abort → caught → retry.
        signal: AbortSignal.timeout(Math.min(intervalMs * 4, 2000)),
      });
      status = res.status;
    } catch {
      status = null; // connection error or per-attempt timeout — daemon may still be restarting
    }
    // 403 = stale allowlist, fail fast (a restart won't change it without our reload).
    // Only a clean 2xx counts as admitted; a 401/405/5xx from a half-initialized daemon
    // must NOT read as success, so retry it like a connection error until the budget ends.
    if (status === 403) return "forbidden";
    if (status !== null && status >= 200 && status < 300) return "ok";
    if (Date.now() >= deadline) return "unreachable";
    await sleep(intervalMs);
  }
}

export interface RebindDeps {
  /** Reload the daemon; returns false when no service is loaded. Injectable for tests. */
  reload?: () => boolean;
  /** Verify the remote path on the new url. Injectable for tests. */
  verify?: (url: string, token: string) => Promise<VerifyResult>;
  /** Service manager (unit build/path/reload). Injectable for tests; defaults to the platform manager. */
  manager?: ServiceManager;
}

/**
 * Transactionally rebind the daemon to `newHost`: reject all-interfaces, snapshot config
 * + unit, rewrite both to the new authority, reload the service, then verify the remote
 * path. On any failure after the writes, roll back to the previous host. "Transactional
 * with rollback", not a single atomic syscall — three writes plus a restart cannot be.
 */
export async function rebind(rawHost: string, deps: RebindDeps = {}): Promise<string> {
  if (!rawHost || !rawHost.trim()) {
    throw new Error(
      "rebind requires a host — an empty host binds all interfaces. Pass a specific host (loopback or a tailnet address).",
    );
  }
  if (isAllInterfaces(rawHost)) {
    throw new Error(
      `refusing to bind ${rawHost} (all interfaces) — the bearer token would be the only gate on every network interface. Bind a specific host (loopback or a tailnet address) instead.`,
    );
  }
  // Canonicalize so the unit HIP_HOST and the config url use one byte form.
  const newHost = canonicalHost(rawHost);

  const mgr = deps.manager ?? selectServiceManager();
  const cfg = loadConfig(); // actionable ConfigError if not installed
  const root = cfg.dataDir ?? defaultDataRoot();
  const newUrl = urlFor(newHost);
  const target = mgr.unitPath();

  // Snapshot for rollback.
  const cfgSnapshot = readFileSync(configPath(), "utf8");
  const unitSnapshot = existsSync(target) ? readFileSync(target, "utf8") : null;

  const restore = () => {
    writeFileSync(configPath(), cfgSnapshot, { mode: 0o600 });
    if (unitSnapshot !== null) atomicWrite(target, unitSnapshot);
  };

  // Rewrite config url (re-pass token/actorId/dataDir — there is no partial update) and,
  // if a unit exists, regenerate it with the new HIP_HOST.
  writeConfig({ url: newUrl, token: cfg.token, actorId: cfg.actorId, dataDir: cfg.dataDir });
  if (unitSnapshot !== null) {
    atomicWrite(
      target,
      mgr.buildUnit({
        nodePath: process.execPath,
        scriptPath: process.argv[1] ?? "hip",
        dataDir: root,
        configDir: configDir(),
        host: newHost,
        port: port(),
        logDir: root,
      }),
    );
  }

  const reload = deps.reload ?? (() => mgr.reload());
  const verify = deps.verify ?? remoteVerify;

  const rollback = (reason: string): never => {
    restore();
    try {
      reload(); // best-effort: get the daemon back onto the restored host
    } catch {
      /* the restored files are what matter; a failed rollback reload needs a manual restart */
    }
    throw new Error(`rebind to ${newHost} failed: ${reason}. Rolled back to the previous host.`);
  };

  let result: VerifyResult;
  try {
    const reloaded = reload();
    if (!reloaded) {
      // No managed service (manual `hip serve`): files are written; the operator must
      // restart the daemon themselves. Nothing to verify yet.
      return `Rebound to ${newUrl}. No ${mgr.name} service detected — restart your \`hip serve\` to pick up the new host (config + unit already written).`;
    }
    result = await verify(newUrl, cfg.token);
  } catch (e) {
    // reload or verify threw (e.g. a hard launchctl reload failure) — roll back, don't
    // leave config/plist pointing at a host the daemon never came up on.
    return rollback(e instanceof Error ? e.message : String(e));
  }

  if (result === "ok") {
    return `Rebound to ${newUrl} — remote path verified.${isLoopbackHost(newHost) ? "" : NONLOOPBACK_REMINDER}`;
  }

  return rollback(
    result === "forbidden"
      ? "the daemon rejected the new Host (its allowlist did not pick up the rebind)"
      : "the daemon did not come back on the new host (bind failed, or still restarting past the verify budget)",
  );
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
    .option("--host <host>", "bind host (default loopback); for a running daemon use `hip rebind` instead")
    .action((opts: { ownerName?: string; host?: string }) => {
      // install does not reload a running daemon, so --host on a loaded daemon would
      // leave the unit and the live allowlist mismatched — the silent desync rebind exists to prevent.
      if (opts.host && selectServiceManager().isLoaded()) {
        process.stderr.write(
          `hip: a daemon is already loaded — use \`hip rebind ${opts.host}\` to change the bind host safely (install does not reload).\n`,
        );
        process.exitCode = 1;
        return;
      }
      const installOpts: InstallOptions = {};
      if (opts.ownerName) installOpts.ownerName = opts.ownerName;
      if (opts.host) installOpts.host = opts.host;
      process.stdout.write(install(installOpts) + "\n");
    });

  program
    .command("rebind <host>")
    .description("Rebind the daemon to a new host: rewrite config + plist, reload, and verify the remote path")
    .action(async (host: string) => {
      try {
        process.stdout.write((await rebind(host)) + "\n");
      } catch (e) {
        process.stderr.write(`hip: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exitCode = 1;
      }
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
    .description("Audit store consistency plus network/bind reality (host mismatch, bind safety, dist staleness)")
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
