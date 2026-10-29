import { describe, expect, test } from "bun:test";
import { blockWindows, LOG_WINDOW, scanWindows } from "../src/logs";

describe("blockWindows", () => {
  test("covers the range exactly, in windows of at most 9,000 blocks", () => {
    const w = blockWindows(28_299_079n, 28_469_086n);
    expect(w[0]?.[0]).toBe(28_299_079n);
    expect(w[w.length - 1]?.[1]).toBe(28_469_086n);
    for (const [a, b] of w) expect(b - a + 1n).toBeLessThanOrEqual(LOG_WINDOW);
    for (let i = 1; i < w.length; i++) expect((w[i])[0]).toBe((w[i - 1])[1] + 1n);
  });
  test("edges", () => {
    expect(blockWindows(5n, 5n)).toEqual([[5n, 5n]]);
    expect(blockWindows(0n, 8999n)).toEqual([[0n, 8999n]]);
    expect(blockWindows(0n, 9000n)).toEqual([[0n, 8999n], [9000n, 9000n]]);
    expect(blockWindows(10n, 5n)).toEqual([]);
    expect(() => blockWindows(0n, 1n, 0n)).toThrow();
  });
});

describe("scanWindows", () => {
  test("returns results in block order and bounds concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await scanWindows(0n, 100n, async (from) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, Number(10n - (from / 10n) % 10n)));
      inFlight--;
      return [from];
    }, { size: 10n, concurrency: 3 });
    expect(out).toEqual([0n, 10n, 20n, 30n, 40n, 50n, 60n, 70n, 80n, 90n, 100n]);
    expect(peak).toBeLessThanOrEqual(3);
  });
  test("a failing window rejects the scan", async () => {
    const p = scanWindows(0n, 30n, (from) => (from === 10n ? Promise.reject(new Error("rpc")) : Promise.resolve([from])), { size: 10n });
    const err = await p.catch((e: unknown) => e);
    expect((err as Error).message).toBe("rpc");
  });
});
