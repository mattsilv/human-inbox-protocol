import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isInteractive, spin, colorStatus, colorId, forcePlain } from "../src/cli/tty.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/;

describe("CLI presentation foundation (U1)", () => {
  let stdinTTY: unknown;
  let stdoutTTY: unknown;
  const prevNoInteractive = process.env.HIP_NO_INTERACTIVE;

  beforeEach(() => {
    stdinTTY = process.stdin.isTTY;
    stdoutTTY = process.stdout.isTTY;
    delete process.env.HIP_NO_INTERACTIVE;
    forcePlain(false);
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: stdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutTTY, configurable: true });
    if (prevNoInteractive === undefined) delete process.env.HIP_NO_INTERACTIVE;
    else process.env.HIP_NO_INTERACTIVE = prevNoInteractive;
    forcePlain(false);
  });

  function setTTY(stdin: boolean | undefined, stdout: boolean | undefined): void {
    Object.defineProperty(process.stdin, "isTTY", { value: stdin, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdout, configurable: true });
  }

  it("isInteractive() is false when stdout is not a TTY (piped run)", () => {
    setTTY(true, undefined);
    expect(isInteractive()).toBe(false);
  });

  it("isInteractive() is true only when both stdin and stdout are TTYs", () => {
    setTTY(true, true);
    expect(isInteractive()).toBe(true);
  });

  it("isInteractive() is false when HIP_NO_INTERACTIVE is set even with TTY flags forced true", () => {
    setTTY(true, true);
    process.env.HIP_NO_INTERACTIVE = "1";
    expect(isInteractive()).toBe(false);
  });

  it("isInteractive() is false when forcePlain() set even with TTY flags forced true", () => {
    setTTY(true, true);
    forcePlain(true);
    expect(isInteractive()).toBe(false);
  });

  it("spin() in non-interactive mode resolves to the wrapped value and writes nothing", async () => {
    setTTY(undefined, undefined);
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const out = await spin("Working", async () => 42);
      expect(out).toBe(42);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it("spin() rethrows when the wrapped fn rejects (no throw-swallow)", async () => {
    setTTY(undefined, undefined);
    await expect(spin("Working", async () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");
  });

  it("color helpers return raw input unchanged when non-interactive (no ANSI bytes)", () => {
    setTTY(undefined, undefined);
    expect(colorStatus("waiting")).toBe("waiting");
    expect(colorId("tsk_1")).toBe("tsk_1");
    expect(ANSI.test(colorStatus("waiting"))).toBe(false);
  });
});
