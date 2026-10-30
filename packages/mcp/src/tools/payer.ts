import { getAddress, type Hex } from "viem";
import {
  ActionKind,
  collectionStatusName,
  CollectionStatus,
  debtorActionTypedData,
  railDomain,
} from "../../../sdk/src/index.js";
import type { ReadContext } from "../context.js";
import { explainRefund } from "../explain.js";
import { duration, fmt, iso, refOf } from "../format.js";
import { chainNow, creditorName, debtorCollections } from "./data.js";
import { addressField, bytes32Field, defineTool, instanceField, type Tool } from "./define.js";

/** One hour is long enough to open the link and sign, short enough that a stale signature is useless. */
export const REFUND_SIGNATURE_VALIDITY_SECONDS = 3_600;

/** The page where the human signs. The assistant only ever links there. */
export function refundUrl(ctx: Pick<ReadContext, "appUrl" | "network">, instance: string, collectionId: string): string {
  const q = new URLSearchParams({ rail: instance, refund: collectionId });
  if (ctx.network !== "arc") q.set("network", ctx.network);
  return `${ctx.appUrl}/pay?${q.toString()}`;
}

/**
 * Payer-assistant tools. They take a ReadContext, which has no wallet, no operator and no key: the payer's key
 * is never given to this server and these tools cannot sign.
 */
export function payerTools(ctx: ReadContext): Tool[] {
  const listMyDebits = defineTool({
    name: "list_my_debits",
    title: "List a payer's debits",
    description: "Lists every debit on a payer's mandates (announced, paid, refunded, returned...), newest first, with whether each can still be refunded. Read-only.",
    readOnly: true,
    shape: { instance: instanceField, payer: addressField("The payer's wallet address") },
    async handler({ instance, payer }) {
      const reader = ctx.reader(instance);
      const [rows, now, w] = await Promise.all([debtorCollections(reader, getAddress(payer)), chainNow(ctx), reader.windows()]);
      const debits = await Promise.all(
        rows.map(async (r) => {
          const name = await creditorName(ctx, instance, r.creditorId);
          const c = r.collection;
          const e = explainRefund({
            status: c.status, amount: c.amount, dueAt: c.dueAt, settledAt: c.settledAt, locked: c.locked, held: c.held,
            scheme: r.scheme, refundWindow: w.refundWindow, nowSec: now, symbol: ctx.symbolOf(r.token), creditorName: name, instance,
          });
          return {
            collectionId: r.collectionId,
            creditor: name,
            reference: refOf(c.e2eId),
            amount: fmt(c.amount),
            token: ctx.symbolOf(r.token),
            status: collectionStatusName(c.status),
            dueAt: iso(c.dueAt),
            canRefundNow: e.canRefundNow,
            refundableUntil: e.refundableUntil,
            newest: Number(c.dueAt),
          };
        }),
      );
      debits.sort((a, b) => b.newest - a.newest);
      return { summary: `${debits.length} debit${debits.length === 1 ? "" : "s"} for ${payer}.`, data: { payer: getAddress(payer), debits: debits.map(({ newest: _n, ...d }) => d) } };
    },
  });

  const upcoming = defineTool({
    name: "upcoming_debits",
    title: "Upcoming debits",
    description: "Debits that have been announced but not yet collected for a payer, soonest first. A payer can refuse these before they are collected. Read-only.",
    readOnly: true,
    shape: { instance: instanceField, payer: addressField("The payer's wallet address") },
    async handler({ instance, payer }) {
      const [rows, now] = await Promise.all([debtorCollections(ctx.reader(instance), getAddress(payer)), chainNow(ctx)]);
      const sched = rows.filter((r) => r.collection.status === CollectionStatus.SCHEDULED).sort((a, b) => Number(a.collection.dueAt - b.collection.dueAt));
      const upcomingList = await Promise.all(
        sched.map(async (r) => {
          const left = Number(r.collection.dueAt) - now;
          return {
            collectionId: r.collectionId,
            creditor: await creditorName(ctx, instance, r.creditorId),
            reference: refOf(r.collection.e2eId),
            amount: fmt(r.collection.amount),
            token: ctx.symbolOf(r.token),
            dueAt: iso(r.collection.dueAt),
            due: left > 0 ? `in ${duration(left)}` : "due now",
            note: "No money has moved yet. The payer can refuse this debit, or revoke the mandate, before it is collected.",
          };
        }),
      );
      return { summary: `${upcomingList.length} upcoming debit${upcomingList.length === 1 ? "" : "s"}.`, data: { payer: getAddress(payer), upcoming: upcomingList } };
    },
  });

  async function explain(instance: "prod" | "demo", collectionId: Hex) {
    const reader = ctx.reader(instance);
    const [c, now, w] = await Promise.all([reader.getCollection(collectionId), chainNow(ctx), reader.windows()]);
    if (c.status === CollectionStatus.NONE) return { c, m: null, explanation: null, name: "" } as const;
    const m = await reader.getMandate(c.mandateId);
    const name = await creditorName(ctx, instance, m.creditorId);
    const explanation = explainRefund({
      status: c.status, amount: c.amount, dueAt: c.dueAt, settledAt: c.settledAt, locked: c.locked, held: c.held,
      scheme: m.scheme, refundWindow: w.refundWindow, nowSec: now, symbol: ctx.symbolOf(m.token), creditorName: name, instance,
    });
    return { c, m, explanation, name, now } as const;
  }

  const explainRights = defineTool({
    name: "explain_refund_rights",
    title: "Explain refund rights",
    description: "Says in plain language whether a debit can still be refunded, until when, and what the refund is paid from (the creditor's reserve or funds the contract holds). Read-only.",
    readOnly: true,
    shape: { instance: instanceField, collectionId: bytes32Field("The debit's collection id") },
    async handler({ instance, collectionId }) {
      const r = await explain(instance, collectionId as Hex);
      if (!r.explanation) {
        return { isError: true, summary: "No debit with that id on this rail.", data: { collectionId, instance, found: false } };
      }
      return { summary: r.explanation.headline, data: { collectionId, creditor: r.name, amount: fmt(r.c.amount), ...r.explanation } };
    },
  });

  const prepareRefund = defineTool({
    name: "prepare_refund",
    title: "Prepare a refund for the payer to sign",
    description:
      "Prepares a refund but never performs it. Returns the EIP-712 typed data (a DebtorAction) and a link to the Recall payer page where the human connects their wallet and signs. " +
      "This server never holds or asks for the payer's key and cannot sign for them. Returns no typed data when the debit can no longer be refunded.",
    readOnly: true,
    shape: { instance: instanceField, collectionId: bytes32Field("The debit's collection id"), payer: addressField("The payer's wallet address") },
    async handler({ instance, collectionId, payer }) {
      const who = getAddress(payer);
      const r = await explain(instance, collectionId as Hex);
      if (!r.explanation || !r.m) return { isError: true, summary: "No debit with that id on this rail.", data: { collectionId, instance, found: false } };
      if (r.m.debtor.toLowerCase() !== who.toLowerCase()) {
        return {
          isError: true,
          summary: "That debit belongs to a different payer, so no refund was prepared.",
          data: { found: true, canRefund: false, reason: "NotYourDebit" },
        };
      }
      const link = refundUrl(ctx, instance, collectionId);
      if (!r.explanation.canRefundNow) {
        return {
          summary: r.explanation.headline,
          data: { canRefund: false, collectionId, explanation: r.explanation, payerPage: link },
        };
      }
      const reader = ctx.reader(instance);
      const [domain, nonce] = await Promise.all([railDomain(ctx.publicClient, reader.rail), reader.nonce(who)]);
      const deadline = BigInt(r.now + REFUND_SIGNATURE_VALIDITY_SECONDS);
      const typed = debtorActionTypedData(domain, { kind: ActionKind.REFUND, target: collectionId as Hex, nonce, deadline });
      return {
        summary: `Refund prepared. The payer must sign it at ${link}`,
        data: {
          canRefund: true,
          signed: false,
          note: "Nothing has been signed or sent. Only the payer's own wallet can sign this.",
          collectionId,
          payer: who,
          signUrl: link,
          validUntil: iso(deadline),
          explanation: r.explanation,
          typedData: {
            domain: { name: typed.domain.name, version: typed.domain.version, chainId: typed.domain.chainId, verifyingContract: typed.domain.verifyingContract },
            types: typed.types,
            primaryType: typed.primaryType,
            message: { kind: typed.message.kind, target: typed.message.target, nonce: typed.message.nonce.toString(), deadline: typed.message.deadline.toString() },
          },
        },
      };
    },
  });

  return [listMyDebits, upcoming, explainRights, prepareRefund];
}
