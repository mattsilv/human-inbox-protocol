import { HipClient } from "../client.js";
import { loadConfig, ConfigError, type HipConfig } from "./config.js";
import { spin } from "./tty.js";

/**
 * Load config, connect an MCP client, run `fn`, print the result, and clean up.
 * Maps the two failure modes a user actually hits to actionable messages:
 * no config → run `hip install`; daemon down → run `hip serve`.
 */
export async function withClient(
  fn: (client: HipClient, cfg: HipConfig) => Promise<string>,
): Promise<void> {
  await withClientVoid(async (client, cfg) => {
    const out = await fn(client, cfg);
    process.stdout.write(out + "\n");
  });
}

/**
 * Like `withClient`, but the callback owns all output (no trailing print). The
 * interactive inbox drives its own clack output and returns nothing, so it uses
 * this seam to avoid a stray newline after the outro.
 */
export async function withClientVoid(
  fn: (client: HipClient, cfg: HipConfig) => Promise<void>,
): Promise<void> {
  let cfg: HipConfig;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) return fail(e.message);
    throw e;
  }

  const client = new HipClient({ url: cfg.url, token: cfg.token });
  try {
    // spin rethrows, so the connect-failure mapping below still fires (KTD5).
    await spin("Connecting to the HIP daemon", () => client.connect());
  } catch {
    return fail(`cannot reach the HIP daemon at ${cfg.url} — run \`hip serve\` (or \`hip install\`).`);
  }
  try {
    await fn(client, cfg);
  } finally {
    await client.close();
  }
}

function fail(message: string): void {
  process.stderr.write(`hip: ${message}\n`);
  process.exitCode = 1;
}
