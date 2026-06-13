import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeConfig } from "../src/cli/config.js";
import { withClient } from "../src/cli/run.js";
import { tmpRoot, cleanup } from "./helpers.js";

// U3: spin() wraps client.connect(), but rethrows, so withClient's connect-failure
// mapping still fires (KTD5). In vitest (non-TTY) spin is silent — proving the
// rethrow path without a real spinner.

describe("withClient connect failure through spin (U3)", () => {
  let cfgDir: string;
  const prev = process.env.HIP_CONFIG_DIR;

  beforeEach(() => {
    cfgDir = tmpRoot();
    process.env.HIP_CONFIG_DIR = cfgDir;
    // A config pointing at a dead port — connect will reject.
    writeConfig({ url: "http://127.0.0.1:1/mcp", token: "x", actorId: "act_matt" });
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.HIP_CONFIG_DIR;
    else process.env.HIP_CONFIG_DIR = prev;
    cleanup(cfgDir);
    process.exitCode = 0;
  });

  it("maps a connect failure to an actionable message and sets exit code", async () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await withClient(async () => "should not run");
      const printed = err.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toMatch(/cannot reach the HIP daemon/);
      expect(process.exitCode).toBe(1);
    } finally {
      err.mockRestore();
    }
  });
});
