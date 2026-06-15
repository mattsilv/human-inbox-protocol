import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { checkDistStaleness } from "../src/cli/lifecycle.js";
import { tmpRoot, cleanup } from "./helpers.js";

describe("dist-staleness hint (U4)", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach(cleanup));

  function scaffold(opts: { src?: boolean; dist?: boolean }): string {
    const root = tmpRoot();
    roots.push(root);
    if (opts.src) {
      mkdirSync(join(root, "src", "cli"), { recursive: true });
      writeFileSync(join(root, "src", "cli", "lifecycle.ts"), "// src");
    }
    if (opts.dist) {
      mkdirSync(join(root, "dist", "cli"), { recursive: true });
      writeFileSync(join(root, "dist", "cli", "index.js"), "// built");
    }
    return root;
  }

  function setMtime(path: string, secondsAgo: number): void {
    const t = new Date(Date.now() - secondsAgo * 1000);
    utimesSync(path, t, t);
  }

  it("flags a warn when src is newer than the dist marker", () => {
    const root = scaffold({ src: true, dist: true });
    setMtime(join(root, "dist", "cli", "index.js"), 60); // dist built a minute ago
    setMtime(join(root, "src", "cli", "lifecycle.ts"), 1); // src touched just now
    const issue = checkDistStaleness(root);
    expect(issue?.severity).toBe("warn");
    expect(issue?.code).toBe("dist-stale");
    expect(issue?.message).toMatch(/may be stale/);
  });

  it("returns null when dist is newer than src (fresh build)", () => {
    const root = scaffold({ src: true, dist: true });
    setMtime(join(root, "src", "cli", "lifecycle.ts"), 60);
    setMtime(join(root, "dist", "cli", "index.js"), 1);
    expect(checkDistStaleness(root)).toBeNull();
  });

  it("returns null when src/ is absent (npm-shipped package)", () => {
    const root = scaffold({ dist: true });
    expect(checkDistStaleness(root)).toBeNull();
  });

  it("returns null when dist/cli/index.js is absent (dev tree mid-build)", () => {
    const root = scaffold({ src: true });
    expect(checkDistStaleness(root)).toBeNull();
  });
});
