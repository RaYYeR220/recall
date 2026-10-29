import { describe, expect, test } from "bun:test";
import { validateOffer } from "../src/offers";
import { sampleOffer } from "./fixtures";

const prod = (o = {}) => sampleOffer({ timeScale: 1, ...o });
const demo = (o = {}) => sampleOffer({ timeScale: 10080, maxPerCollection: 1_000_000n, maxPerPeriod: 2_000_000n, ...o });

describe("validateOffer", () => {
  test("a sound offer has no problems", () => {
    expect(validateOffer(prod(), "prod", 1_800_000_000)).toEqual([]);
    expect(validateOffer(demo(), "demo", 1_800_000_000)).toEqual([]);
  });

  test("caps", () => {
    expect(validateOffer(prod({ maxPerCollection: 0n }), "prod")).toHaveLength(1);
    expect(validateOffer(prod({ maxPerCollection: 5n, maxPerPeriod: 4n }), "prod")[0]).toMatch(/below the cap per debit/);
    expect(validateOffer(prod({ maxPerCollection: 5n, maxPerPeriod: 5n }), "prod")).toEqual([]);
  });

  test("period and notice", () => {
    expect(validateOffer(prod({ periodLength: 0 }), "prod")[0]).toMatch(/period/);
    expect(validateOffer(prod({ prenoticeLength: 86_399 }), "prod")[0]).toMatch(/one day/);
    expect(validateOffer(prod({ prenoticeLength: 86_400 }), "prod")).toEqual([]);
  });

  test("the demo rail caps a debit at 1 and a period at 2", () => {
    expect(validateOffer(demo({ maxPerCollection: 1_000_001n }), "demo")[0]).toMatch(/1\.00/);
    expect(validateOffer(demo({ maxPerPeriod: 2_000_001n }), "demo")[0]).toMatch(/2\.00/);
    expect(validateOffer(prod({ maxPerCollection: 50_000_000n, maxPerPeriod: 90_000_000n }), "prod")).toEqual([]);
  });

  test("the time scale must match the instance", () => {
    expect(validateOffer(prod(), "demo")[0]).toMatch(/10080/);
    expect(validateOffer(demo(), "prod")[0]).toMatch(/must be 1/);
  });

  test("expiry is checked only when the time is given", () => {
    expect(validateOffer(prod({ validUntil: 100n }), "prod")).toEqual([]);
    expect(validateOffer(prod({ validUntil: 100n }), "prod", 101)[0]).toMatch(/future/);
    expect(validateOffer(prod({ validUntil: 101n }), "prod", 101)).toEqual([]);
  });
});
