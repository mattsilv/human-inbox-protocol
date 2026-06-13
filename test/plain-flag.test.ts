import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli/index.js";
import { isInteractive, forcePlain } from "../src/cli/tty.js";
import { tmpRoot, cleanup } from "./helpers.js";

// U5: the global --plain flag forces non-interactive for the whole run via a
// preAction hook, so scripts/users get the plain path even in a real terminal.

describe("--plain global flag (U5)", () => {
  let stdinTTY: unknown;
  let stdoutTTY: unknown;
  let cfgDir: string;
  const prevCfg = process.env.HIP_CONFIG_DIR;

  beforeEach(() => {
    stdinTTY = process.stdin.isTTY;
    stdoutTTY = process.stdout.isTTY;
    // Simulate a real terminal so isInteractive() would otherwise be true.
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    cfgDir = tmpRoot();
    process.env.HIP_CONFIG_DIR = cfgDir; // no config → status returns gracefully, no daemon
    forcePlain(false);
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: stdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutTTY, configurable: true });
    if (prevCfg === undefined) delete process.env.HIP_CONFIG_DIR;
    else process.env.HIP_CONFIG_DIR = prevCfg;
    cleanup(cfgDir);
    forcePlain(false);
  });

  it("flips isInteractive() to false for the duration of the command", async () => {
    expect(isInteractive()).toBe(true); // baseline: TTY present, not forced

    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await buildProgram().parseAsync(["--plain", "status"], { from: "user" });
    } finally {
      write.mockRestore();
    }
    // The preAction hook forced plain before status ran, and it stays forced.
    expect(isInteractive()).toBe(false);
  });

  it("accepts --plain after the subcommand too (hip inbox --plain)", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await buildProgram().parseAsync(["inbox", "--plain"], { from: "user" });
      expect(isInteractive()).toBe(false);
    } finally {
      out.mockRestore();
      err.mockRestore();
      process.exitCode = 0;
    }
  });

  it("leaves interactivity on when --plain is absent", async () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      await buildProgram().parseAsync(["status"], { from: "user" });
    } finally {
      write.mockRestore();
    }
    expect(isInteractive()).toBe(true);
  });
});
