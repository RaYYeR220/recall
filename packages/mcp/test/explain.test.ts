import { describe, expect, test } from "bun:test";
import { CollectionStatus, Scheme } from "../../sdk/src/types.js";
import { explainRefund, fundedFrom, type RefundInput } from "../src/explain.js";

const NOW = 1_800_000_000;
const base: RefundInput = {
  status: CollectionStatus.SETTLED,
  amount: 12_500_000n,
  dueAt: BigInt(NOW - 3_600),
  settledAt: BigInt(NOW - 3_600),
  locked: 12_500_000n,
  held: 0n,
  scheme: Scheme.CORE,
  refundWindow: 8n * 7n * 86_400n,
  nowSec: NOW,
  symbol: "EURC",
  creditorName: "Northwind Gym",
  instance: "prod",
};

describe("explainRefund", () => {
  test("inside the window: yes, until the deadline, from the locked reserve", () => {
    const e = explainRefund(base);
    expect(e.canRefundNow).toBe(true);
    expect(e.refundableUntilUnix).toBe(NOW - 3_600 + 8 * 7 * 86_400);
    expect(e.fundedFrom).toBe("Northwind Gym's locked reserve");
    expect(e.headline).toStartWith("Yes: 12.5 EURC can still be refunded");
  });

  test("the last second is still inside, the deadline itself is not", () => {
    const deadline = Number(base.settledAt + base.refundWindow);
    expect(explainRefund({ ...base, nowSec: deadline - 1 }).canRefundNow).toBe(true);
    expect(explainRefund({ ...base, nowSec: deadline }).canRefundNow).toBe(false);
    expect(explainRefund({ ...base, nowSec: deadline }).headline).toContain("closed");
  });

  test("funds the contract holds are named as the source", () => {
    expect(fundedFrom(0n, 5n, "X")).toBe("funds the contract is holding for this debit");
    expect(fundedFrom(5n, 5n, "X")).toContain("locked reserve and funds the contract is holding");
    expect(fundedFrom(0n, 0n, "X")).toBeNull();
  });

  test("B2B has no refund right, even inside what would be a window", () => {
    const e = explainRefund({ ...base, scheme: Scheme.B2B, status: CollectionStatus.FINAL });
    expect(e.canRefundNow).toBe(false);
    expect(e.explanation.join(" ")).toContain("NoRefundRightB2B");
  });

  test("an announced debit cannot be refunded yet but can be refused", () => {
    const e = explainRefund({ ...base, status: CollectionStatus.SCHEDULED, settledAt: 0n });
    expect(e.canRefundNow).toBe(false);
    expect(e.explanation.join(" ")).toContain("refuse");
  });

  test("every terminal state explains itself", () => {
    for (const status of [CollectionStatus.REFUNDED, CollectionStatus.RETURNED, CollectionStatus.REFUSED, CollectionStatus.CANCELLED, CollectionStatus.EXPIRED, CollectionStatus.FINAL, CollectionStatus.NONE]) {
      const e = explainRefund({ ...base, status });
      expect(e.canRefundNow).toBe(false);
      expect(e.headline.length).toBeGreaterThan(5);
    }
  });

  test("the demo rail mentions its accelerated clock, the prod rail does not", () => {
    expect(explainRefund({ ...base, instance: "demo" }).explanation.join(" ")).toContain("1 week = 1 minute");
    expect(explainRefund(base).explanation.join(" ")).not.toContain("1 week = 1 minute");
  });
});
