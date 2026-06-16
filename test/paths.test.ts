import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultDataRoot } from "../src/store/index.js";

describe("defaultDataRoot", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.HIP_DATA_DIR;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.HIP_DATA_DIR;
    else process.env.HIP_DATA_DIR = saved;
  });

  it("defaults to ~/hip-data (not ~/hip, to avoid colliding with a source checkout)", () => {
    delete process.env.HIP_DATA_DIR;
    expect(defaultDataRoot()).toBe(join(homedir(), "hip-data"));
  });

  it("honors HIP_DATA_DIR override", () => {
    process.env.HIP_DATA_DIR = "/tmp/custom-hip";
    expect(defaultDataRoot()).toBe("/tmp/custom-hip");
  });
});
