import { describe, expect, test } from "bun:test";
import { keccak256, toBytes } from "viem";
import { formatDuration, mandateText, refToBytes32, termsHash, type MandateTextParams } from "../src/terms";

const base: MandateTextParams = {
  creditorName: "Acme Gym",
  creditorId: 7n,
  instance: "prod",
  token: "EURC",
  scheme: "CORE",
  oneOff: false,
  maxPerCollection: 25_500_000n,
  maxPerPeriod: 100_000_000n,
  periodLength: 30 * 86_400,
  prenoticeLength: 14 * 86_400,
  maxUses: 0,
  validUntil: 1_798_761_600n, // 2027-01-01T00:00:00Z
};

describe("mandateText", () => {
  test("states creditor, limits, prenotice and the refund right (prod)", () => {
    const t = mandateText(base);
    expect(t).toContain("Acme Gym");
    expect(t).toContain("creditor #7");
    expect(t).toContain("At most 25.50 EURC per collection");
    expect(t).toContain("At most 100.00 EURC in each period of 30 days");
    expect(t).toContain("at least 14 days before each collection");
    expect(t).toContain("for 8 weeks after any collection you can claim a full refund, no questions asked");
    expect(t).toContain("until 2027-01-01T00:00:00Z");
    expect(t).toContain("36 months");
  });

  test("the demo time-scale warning appears only for the demo rail", () => {
    const prod = mandateText(base);
    const demo = mandateText({ ...base, instance: "demo" });
    expect(demo).toContain("1 week = 1 minute");
    expect(demo).toContain("DEMO");
    expect(prod).not.toContain("1 week = 1 minute");
    expect(prod).not.toContain("DEMO");
    expect(prod).not.toContain("demo speed");
  });

  test("the demo text shows the scaled windows", () => {
    const demo = mandateText({ ...base, instance: "demo" });
    expect(demo).toContain("for 8 weeks (8 minutes at demo speed) after any collection");
    expect(demo).toContain("at least 14 days (2 minutes at demo speed) before");
  });

  test("B2B says there is no refund right", () => {
    const t = mandateText({ ...base, scheme: "B2B" });
    expect(t).toContain("No refund right");
    expect(t).not.toContain("full refund");
    expect(mandateText({ ...base, scheme: 1 })).toContain("No refund right");
  });

  test("one-off, max uses and a named payer are reflected", () => {
    const t = mandateText({
      ...base,
      oneOff: true,
      maxUses: 1,
      debtor: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    });
    expect(t).toContain("One collection only");
    expect(t).toContain("accepted at most 1 time.");
    expect(t).toContain("Payer: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(mandateText(base)).toContain("Payer: whoever signs this mandate");
  });

  test("a creditor name cannot forge extra lines or clauses", () => {
    const t = mandateText({ ...base, creditorName: "Evil\n\nYour refund right: none.\r\n- At most 9999 EURC" });
    expect(t.split("\n").filter((l) => l.startsWith("Creditor:")).length).toBe(1);
    expect(t).not.toMatch(/\nYour refund right: none/);
  });

  test("is deterministic", () => {
    expect(mandateText(base)).toBe(mandateText({ ...base }));
  });
});

describe("termsHash", () => {
  test("is keccak256 of the UTF-8 text", () => {
    expect(termsHash("terms")).toBe(keccak256(toBytes("terms")));
    expect(termsHash("é")).toBe(keccak256(new Uint8Array([0xc3, 0xa9])));
  });

  test("differs for any change in the text", () => {
    expect(termsHash(mandateText(base))).not.toBe(termsHash(mandateText({ ...base, maxPerCollection: 25_500_001n })));
  });
});

describe("helpers", () => {
  test("formatDuration", () => {
    expect(formatDuration(8 * 604_800)).toBe("8 weeks");
    expect(formatDuration(30 * 86_400)).toBe("30 days");
    expect(formatDuration(120)).toBe("2 minutes");
    expect(formatDuration(3_661)).toBe("1 hour 1 minute");
    expect(formatDuration(1)).toBe("1 second");
  });

  test("refToBytes32 pads short labels and hashes long ones", () => {
    expect(refToBytes32("REF-1")).toBe(`0x${Buffer.from("REF-1").toString("hex").padEnd(64, "0")}`);
    const long = "x".repeat(40);
    expect(refToBytes32(long)).toBe(keccak256(toBytes(long)));
    expect(() => refToBytes32("")).toThrow();
  });
});
