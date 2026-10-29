import { describe, expect, test } from "bun:test";
import { CollectionStatus, collectionIdOf, Scheme } from "@recall/sdk";
import { MAX_KEEPER_TXS, planKeeperActions, presentedSecret, type KeeperItem, type KeeperWindows } from "../_lib/keeper-core";
import { parseKeeperCreditors } from "../_lib/env";

const H = (n: string) => `0x${n.repeat(32)}` as const;
const NOW = 2_000_000_000;
const W: Record<"prod" | "demo", KeeperWindows> = {
  prod: { refundWindow: 8 * 7 * 86_400, executionWindow: 5 * 86_400 },
  demo: { refundWindow: 480, executionWindow: 900 },
};

const item = (over: Partial<KeeperItem["collection"]> & { instance?: "prod" | "demo"; scheme?: number; mandate?: string }): KeeperItem => ({
  instance: over.instance ?? "demo",
  creditorId: 2n,
  mandateId: H(over.mandate ?? "aa"),
  scheme: over.scheme ?? Scheme.CORE,
  collection: { e2eId: over.e2eId ?? H("e1"), status: over.status ?? CollectionStatus.SCHEDULED, dueAt: over.dueAt ?? 0n, settledAt: over.settledAt ?? 0n },
});

describe("planKeeperActions", () => {
  test("collects what is due and inside its execution window", () => {
    const due = item({ dueAt: BigInt(NOW - 10) });
    const plan = planKeeperActions([due], NOW, W);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: "collect", instance: "demo", collectionId: collectionIdOf(due.mandateId, due.collection.e2eId) });
  });

  test("does not collect early, or after the execution window", () => {
    expect(planKeeperActions([item({ dueAt: BigInt(NOW + 1) })], NOW, W)).toEqual([]);
    expect(planKeeperActions([item({ dueAt: BigInt(NOW - 901) })], NOW, W)).toEqual([]);
    expect(planKeeperActions([item({ dueAt: BigInt(NOW - 900) })], NOW, W)).toHaveLength(1);
  });

  test("releases Core collections once the refund window has matured", () => {
    const settled = (age: number) => item({ status: CollectionStatus.SETTLED, settledAt: BigInt(NOW - age) });
    expect(planKeeperActions([settled(479)], NOW, W)).toEqual([]);
    expect(planKeeperActions([settled(480)], NOW, W)[0]).toMatchObject({ kind: "release" });
  });

  test("never releases a B2B or a finished collection", () => {
    expect(planKeeperActions([item({ scheme: Scheme.B2B, status: CollectionStatus.SETTLED, settledAt: 1n })], NOW, W)).toEqual([]);
    for (const status of [CollectionStatus.FINAL, CollectionStatus.REFUNDED, CollectionStatus.RETURNED, CollectionStatus.REFUSED, CollectionStatus.CANCELLED, CollectionStatus.EXPIRED]) {
      expect(planKeeperActions([item({ status, dueAt: 1n, settledAt: 1n })], NOW, W)).toEqual([]);
    }
  });

  test("uses each instance's own windows", () => {
    const s = (instance: "prod" | "demo") => item({ instance, status: CollectionStatus.SETTLED, settledAt: BigInt(NOW - 1000) });
    expect(planKeeperActions([s("prod")], NOW, W)).toEqual([]);
    expect(planKeeperActions([s("demo")], NOW, W)).toHaveLength(1);
  });

  test("caps at 20 per run and takes the oldest first", () => {
    const items = Array.from({ length: 30 }, (_, i) => item({ e2eId: H(i.toString(16).padStart(2, "0")), dueAt: BigInt(NOW - 800 + i) }));
    const plan = planKeeperActions(items, NOW, W);
    expect(plan).toHaveLength(MAX_KEEPER_TXS);
    expect(plan.map((a) => a.since)).toEqual([...plan.map((a) => a.since)].sort((a, b) => a - b));
    expect(plan[0]?.since).toBe(NOW - 800);
    expect(planKeeperActions(items, NOW, W, 5)).toHaveLength(5);
    expect(planKeeperActions(items, NOW, W, 0)).toEqual([]);
  });
});

describe("keeper auth and config", () => {
  test("the secret is read from x-cron-secret or a Bearer header", () => {
    expect(presentedSecret(new Headers({ "x-cron-secret": "s3" }))).toBe("s3");
    expect(presentedSecret(new Headers({ authorization: "Bearer s3" }))).toBe("s3");
    expect(presentedSecret(new Headers({ authorization: "Basic s3" }))).toBeNull();
    expect(presentedSecret(new Headers())).toBeNull();
  });

  test("KEEPER_CREDITORS parsing skips bad entries", () => {
    expect(parseKeeperCreditors("prod:1, demo:2")).toEqual([
      { instance: "prod", creditorId: 1n },
      { instance: "demo", creditorId: 2n },
    ]);
    expect(parseKeeperCreditors("main:1,prod:x,demo:0,prod:")).toEqual([]);
    expect(parseKeeperCreditors(undefined)).toEqual([]);
  });
});
