import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/index.js";
import { HIP_VERSION } from "../src/index.js";

describe("cli entry", () => {
  it("builds a program named hip with the current version", () => {
    const program = buildProgram();
    expect(program.name()).toBe("hip");
    expect(program.version()).toBe(HIP_VERSION);
  });

  it("exposes a non-empty version string", () => {
    expect(HIP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
