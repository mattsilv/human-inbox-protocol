import { describe, expect, it } from "vitest";
import { runSmoke } from "../src/smoke.js";

describe("milestone smoke (U10)", () => {
  it("passes all three flows end-to-end (F1 nudge, F2 reconcile, F3 block→resume)", async () => {
    const result = await runSmoke();
    const failed = result.steps.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`);
    expect(failed, failed.join("; ")).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
  });
});
