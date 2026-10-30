import type { Address, Hex } from "viem";
import { collectionIdOf, debitRailAbi, type RailClient } from "../../../sdk/src/index.js";
import type { ReadContext } from "../context.js";

export type RailCollection = Awaited<ReturnType<RailClient["getCollection"]>>;

export interface CollectionRow {
  collectionId: Hex;
  mandateId: Hex;
  creditorId: bigint;
  debtor: Address;
  token: Address;
  scheme: number;
  mandateStatus: number;
  maxPerCollection: bigint;
  prenoticeLength: number;
  offerRef: Hex;
  collection: RailCollection;
}

type MandateView = Awaited<ReturnType<RailClient["creditorView"]>>["views"][number];

async function expand(reader: RailClient, view: MandateView): Promise<CollectionRow[]> {
  const m = view.mandate;
  // The lens returns the newest few collections inline; fetch the full history when there are more.
  const cols = view.collectionCount > BigInt(view.collections.length) ? (await reader.collectionsPage(view.id, 0, 0)).page : view.collections;
  return cols.map((collection) => ({
    collectionId: collectionIdOf(view.id, collection.e2eId),
    mandateId: view.id,
    creditorId: m.creditorId,
    debtor: m.debtor,
    token: m.token,
    scheme: m.scheme,
    mandateStatus: m.status,
    maxPerCollection: m.maxPerCollection,
    prenoticeLength: m.prenoticeLength,
    offerRef: m.offerRef,
    collection,
  }));
}

/** Every collection of a creditor, across all its mandates (bounded). */
export async function creditorCollections(reader: RailClient, creditorId: bigint, maxMandates = 200): Promise<CollectionRow[]> {
  const rows: CollectionRow[] = [];
  const PAGE = 50;
  for (let offset = 0; offset < maxMandates; offset += PAGE) {
    const { views, total } = await reader.creditorView(creditorId, offset, PAGE);
    for (const v of views) rows.push(...(await expand(reader, v)));
    if (BigInt(offset + PAGE) >= total) break;
  }
  return rows;
}

/** Every collection of a payer, across all their mandates. */
export async function debtorCollections(reader: RailClient, payer: Address): Promise<CollectionRow[]> {
  const { views } = await reader.debtorView(payer, 0, 0);
  const rows: CollectionRow[] = [];
  for (const v of views) rows.push(...(await expand(reader, v)));
  return rows;
}

const names = new Map<string, string>();

/** Creditor display names, read from the rail (cached for the life of the process). */
export async function creditorName(ctx: ReadContext, instance: "prod" | "demo", creditorId: bigint): Promise<string> {
  const reader = ctx.reader(instance);
  const key = `${ctx.network}:${reader.rail}:${creditorId}`;
  const cached = names.get(key);
  if (cached) return cached;
  const c = await ctx.publicClient.readContract({ address: reader.rail, abi: debitRailAbi, functionName: "getCreditor", args: [creditorId] });
  names.set(key, c.name);
  return c.name;
}

export async function chainNow(ctx: ReadContext): Promise<number> {
  return Number((await ctx.publicClient.getBlock()).timestamp);
}
