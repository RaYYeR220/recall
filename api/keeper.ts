import type { RailInstance } from "@recall/sdk";
import { toTxResult, railFor, refusalOf } from "./_lib/chain";
import { accountFromEnv, configuredNetwork, ENV_NAMES, parseKeeperCreditors, readEnv } from "./_lib/env";
import { json, methodNotAllowed, safeEqual } from "./_lib/http";
import { MAX_KEEPER_TXS, planKeeperActions, presentedSecret, type KeeperItem } from "./_lib/keeper-core";

/**
 * GET (header `x-cron-secret: $CRON_SECRET`, or `Authorization: Bearer $CRON_SECRET` from Vercel Cron).
 * Collects due SCHEDULED collections and releases matured SETTLED ones for the creditors in KEEPER_CREDITORS
 * (for example "prod:1,demo:2"), at most 20 transactions per run. Collect and release are open to anyone on
 * the rail, so the keeper needs only gas, signed by RELAYER_KEY.
 */
export async function GET(req: Request): Promise<Response> {
  const secret = readEnv(ENV_NAMES.cronSecret);
  if (!secret) return json({ error: "The keeper is not configured on this server.", code: "KeeperNotConfigured" }, 503);
  const given = presentedSecret(req.headers);
  if (!given || !safeEqual(given, secret)) return json({ error: "Unauthorized." }, 401);

  const relayer = accountFromEnv(ENV_NAMES.relayerKey);
  if (!relayer) return json({ error: "RELAYER_KEY is not set.", code: "KeeperNotConfigured" }, 503);
  const tracked = parseKeeperCreditors(readEnv(ENV_NAMES.keeperCreditors));
  if (tracked.length === 0) return json({ ok: true, note: "KEEPER_CREDITORS lists no creditors.", sent: [] });

  const network = configuredNetwork();
  const reader = (i: RailInstance) => railFor(network, i);
  const block = await reader("prod").publicClient.getBlock();
  const nowSec = Number(block.timestamp);

  const windows = {
    prod: await reader("prod").windows(),
    demo: await reader("demo").windows(),
  };
  const items: KeeperItem[] = [];
  for (const t of tracked) {
    const { views } = await reader(t.instance).creditorView(t.creditorId, 0, 0);
    for (const v of views) {
      for (const c of v.collections) {
        items.push({ instance: t.instance, creditorId: t.creditorId, mandateId: v.id, scheme: v.mandate.scheme, collection: c });
      }
    }
  }

  const plan = planKeeperActions(
    items,
    nowSec,
    {
      prod: { refundWindow: Number(windows.prod.refundWindow), executionWindow: Number(windows.prod.executionWindow) },
      demo: { refundWindow: Number(windows.demo.refundWindow), executionWindow: Number(windows.demo.executionWindow) },
    },
    MAX_KEEPER_TXS,
  );

  const sent: Record<string, unknown>[] = [];
  for (const a of plan) {
    const rail = railFor(network, a.instance, relayer);
    try {
      const hash = a.kind === "collect" ? await rail.collect(a.collectionId) : await rail.release(a.collectionId);
      const tx = await toTxResult(network, a.instance, hash);
      sent.push({ kind: a.kind, instance: a.instance, collectionId: a.collectionId, txHash: tx.txHash, explorerUrl: tx.explorerUrl });
    } catch (e) {
      sent.push({ kind: a.kind, instance: a.instance, collectionId: a.collectionId, refusal: refusalOf(e) });
    }
  }
  return json({ ok: true, network, checked: items.length, planned: plan.length, sent });
}

export function POST(): Response {
  return methodNotAllowed("GET");
}
