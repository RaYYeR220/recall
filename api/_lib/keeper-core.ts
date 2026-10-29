import type { Hex } from "viem";
import { CollectionStatus, collectionIdOf, Scheme, type RailInstance } from "../../packages/sdk/src/index.js";

export interface KeeperWindows {
  refundWindow: number;
  executionWindow: number;
}

export interface KeeperItem {
  instance: RailInstance;
  creditorId: bigint;
  mandateId: Hex;
  scheme: number;
  collection: { e2eId: Hex; status: number; dueAt: bigint; settledAt: bigint };
}

export interface KeeperAction {
  kind: "collect" | "release";
  instance: RailInstance;
  creditorId: bigint;
  collectionId: Hex;
  /** Unix seconds the action became possible; the oldest go first. */
  since: number;
}

export const MAX_KEEPER_TXS = 20;

/**
 * What a keeper run should do right now, oldest first, capped. Collect what is due and still inside its
 * execution window; release Core collections whose refund window has matured. Nothing else.
 */
export function planKeeperActions(
  items: KeeperItem[],
  nowSec: number,
  windows: Record<RailInstance, KeeperWindows>,
  max: number = MAX_KEEPER_TXS,
): KeeperAction[] {
  const out: KeeperAction[] = [];
  for (const it of items) {
    const w = windows[it.instance];
    const c = it.collection;
    const collectionId = collectionIdOf(it.mandateId, c.e2eId);
    if (c.status === CollectionStatus.SCHEDULED) {
      const due = Number(c.dueAt);
      if (nowSec >= due && nowSec <= due + w.executionWindow) {
        out.push({ kind: "collect", instance: it.instance, creditorId: it.creditorId, collectionId, since: due });
      }
    } else if (c.status === CollectionStatus.SETTLED && it.scheme === Scheme.CORE) {
      const matured = Number(c.settledAt) + w.refundWindow;
      if (nowSec >= matured) {
        out.push({ kind: "release", instance: it.instance, creditorId: it.creditorId, collectionId, since: matured });
      }
    }
  }
  out.sort((a, b) => a.since - b.since);
  return out.slice(0, Math.max(0, max));
}

/** Accepts the secret in `x-cron-secret` or as `Authorization: Bearer <secret>` (what Vercel Cron sends). */
export function presentedSecret(headers: Headers): string | null {
  const direct = headers.get("x-cron-secret");
  if (direct) return direct;
  const auth = headers.get("authorization");
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  return m?.[1] ?? null;
}
