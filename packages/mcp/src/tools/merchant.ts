import { parseUnits, type Hex } from "viem";
import { z } from "zod";
import {
  collectionStatusName,
  CollectionStatus,
  decodeRailError,
  decodeReturnCode,
  mandateStatusName,
  refToBytes32,
  returnCodeLabel,
  Scheme,
} from "../../../sdk/src/index.js";
import type { RecallContext } from "../context.js";
import { fmt, iso, refOf } from "../format.js";
import { chainNow, creditorCollections, type CollectionRow } from "./data.js";
import { bytes32Field, defineTool, idField, instanceField, toBigInt, type Tool } from "./define.js";

/** What an agent should do about a returned or refused debit. */
export function dunningAdvice(code: string): { action: "retry-after-top-up" | "contact-payer" | "stop"; note: string } {
  switch (code) {
    case "AM04":
      return { action: "retry-after-top-up", note: "Insufficient funds. Ask the payer to top up, then re-present with a new pre-notification (a new due date and reference)." };
    case "MS03":
      return { action: "contact-payer", note: "Reason not specified. Contact the payer before re-presenting." };
    case "MS02":
      return { action: "contact-payer", note: "The payer refused this debit. Do not re-present without asking them." };
    case "MD01":
      return { action: "stop", note: "There is no valid mandate (revoked or used up). Do not retry; ask for a new mandate." };
    case "AM05":
      return { action: "stop", note: "Duplicate collection. Nothing to retry." };
    default:
      return { action: "contact-payer", note: "Check the return code with the payer before trying again." };
  }
}

const MAX_COLLECT_PER_CALL = 25;

const summarise = (c: CollectionRow, ctx: RecallContext) => ({
  collectionId: c.collectionId,
  mandateId: c.mandateId,
  payer: c.debtor,
  token: ctx.symbolOf(c.token),
  amount: fmt(c.collection.amount),
  reference: refOf(c.collection.e2eId),
  dueAt: iso(c.collection.dueAt),
  status: collectionStatusName(c.collection.status),
  ...(c.collection.code !== "0x00000000" ? { code: decodeReturnCode(c.collection.code), label: returnCodeLabel(decodeReturnCode(c.collection.code)) } : {}),
});

export function merchantTools(ctx: RecallContext): Tool[] {
  const listMandates = defineTool({
    name: "list_mandates",
    title: "List a creditor's mandates",
    description:
      "Lists the mandates payers have signed for a creditor, newest first, with each mandate's limits and its most recent collections. Read-only.",
    readOnly: true,
    shape: {
      instance: instanceField,
      creditorId: idField("The creditor's id on the rail"),
      offset: z.number().int().min(0).optional().describe("Mandates to skip (default 0)."),
      limit: z.number().int().min(1).max(50).optional().describe("Mandates to return (default 10, max 50)."),
    },
    async handler({ instance, creditorId, offset, limit }) {
      const { views, total } = await ctx.reader(instance).creditorView(toBigInt(creditorId), offset ?? 0, limit ?? 10);
      const mandates = views.map((v) => ({
        mandateId: v.id,
        payer: v.mandate.debtor,
        status: mandateStatusName(v.mandate.status),
        scheme: v.mandate.scheme === Scheme.B2B ? "B2B" : "CORE",
        token: ctx.symbolOf(v.mandate.token),
        maxPerCollection: fmt(v.mandate.maxPerCollection),
        maxPerPeriod: fmt(v.mandate.maxPerPeriod),
        periodSeconds: v.mandate.periodLength,
        prenoticeSeconds: v.mandate.prenoticeLength,
        reference: refOf(v.mandate.offerRef),
        collectionCount: v.collectionCount.toString(),
        recentCollections: v.collections.map((col) => ({
          reference: refOf(col.e2eId),
          amount: fmt(col.amount),
          dueAt: iso(col.dueAt),
          status: collectionStatusName(col.status),
        })),
      }));
      return { summary: `${mandates.length} of ${total} mandates for creditor ${creditorId}.`, data: { total: total.toString(), offset: offset ?? 0, mandates } };
    },
  });

  const prenotify = defineTool({
    name: "prenotify_collection",
    title: "Announce a debit (pre-notify)",
    description:
      "Announces a future debit against a mandate. The rail is asked first (a dry run); if it would refuse (over the cap, notice too short, mandate revoked...) " +
      "nothing is sent and the decoded refusal is returned. Otherwise the pre-notification is sent and its transaction hash and collection id are returned. " +
      "Needs the operator key. The operator can only act inside the signed mandates.",
    readOnly: false,
    shape: {
      instance: instanceField,
      mandateId: bytes32Field("The mandate to debit"),
      amount: z.string().regex(/^\d+(\.\d{1,6})?$/, "a decimal such as 12.50").describe("Amount in the mandate's token, as a decimal such as 12.50."),
      dueAt: z.string().datetime({ offset: true }).describe("When the debit is due, ISO 8601, for example 2026-12-01T09:00:00Z. Must respect the mandate's notice period."),
      remittanceInfo: z.string().min(1).max(140).describe("What the payer sees as the reason for the debit (max 140 characters)."),
      reference: z
        .string()
        .min(1)
        .max(31)
        .optional()
        .describe("Optional end-to-end reference. Sending the same reference twice is refused as a duplicate (AM05), which makes retries safe. Generated when omitted."),
    },
    async handler({ instance, mandateId, amount, dueAt, remittanceInfo, reference }) {
      const rail = ctx.operator(instance);
      const dueUnix = Math.floor(Date.parse(dueAt) / 1000);
      const e2eId: Hex = refToBytes32(reference ?? `MCP-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 46_656).toString(36).toUpperCase()}`);
      const raw = parseUnits(amount, 6);
      try {
        // The SDK asks the rail first (eth_call) and only signs and sends when that succeeds.
        const hash = await rail.prenotify(mandateId as Hex, raw, BigInt(dueUnix), e2eId, remittanceInfo);
        const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          return { isError: true, summary: "The transaction was mined but reverted.", data: { outcome: "failed", txHash: hash } };
        }
        const collectionId = rail.collectionId(mandateId as Hex, e2eId);
        return {
          summary: `Pre-notified ${amount}, due ${dueAt}.`,
          data: { outcome: "sent", txHash: hash, collectionId, reference: refOf(e2eId), dueAt: iso(dueUnix), amount },
        };
      } catch (e) {
        const err = decodeRailError(e);
        if (err.name === "UnknownError") throw e;
        return {
          summary: `The rail would refuse this: ${err.name}${err.code ? ` (${err.code})` : ""}. Nothing was sent.`,
          data: { outcome: "refused", sent: false, refusal: { name: err.name, code: err.code, message: err.message } },
        };
      }
    },
  });

  const collectDue = defineTool({
    name: "collect_due",
    title: "Collect every due debit",
    description:
      "Collects every SCHEDULED collection of a creditor whose due time has passed (up to 25 per call). Returns, per collection, what happened: " +
      "SETTLED (paid), RETURNED with its ISO code such as AM04 (insufficient funds), or the rail's refusal. Needs the operator key.",
    readOnly: false,
    shape: { instance: instanceField, creditorId: idField("The creditor's id on the rail") },
    async handler({ instance, creditorId }) {
      const rail = ctx.operator(instance);
      const id = toBigInt(creditorId);
      const now = await chainNow(ctx);
      const rows = await creditorCollections(ctx.reader(instance), id);
      const due = rows
        .filter((r) => r.collection.status === CollectionStatus.SCHEDULED && Number(r.collection.dueAt) <= now)
        .sort((a, b) => Number(a.collection.dueAt - b.collection.dueAt));
      const batch = due.slice(0, MAX_COLLECT_PER_CALL);
      const results: Record<string, unknown>[] = [];
      for (const r of batch) {
        const base = { collectionId: r.collectionId, reference: refOf(r.collection.e2eId), amount: fmt(r.collection.amount), token: ctx.symbolOf(r.token) };
        try {
          const hash = await rail.collect(r.collectionId);
          await ctx.publicClient.waitForTransactionReceipt({ hash });
          const after = await rail.getCollection(r.collectionId);
          const code = after.code !== "0x00000000" ? decodeReturnCode(after.code) : undefined;
          results.push({ ...base, outcome: collectionStatusName(after.status), ...(code ? { code, label: returnCodeLabel(code) } : {}), txHash: hash });
        } catch (e) {
          const err = decodeRailError(e);
          if (err.name === "UnknownError") results.push({ ...base, outcome: "ERROR", message: err.message });
          else results.push({ ...base, outcome: "REFUSED_BY_RAIL", refusal: { name: err.name, code: err.code, message: err.message } });
        }
      }
      const settled = results.filter((x) => x["outcome"] === "SETTLED" || x["outcome"] === "FINAL").length;
      return {
        summary: `${due.length} due, ${results.length} attempted, ${settled} settled.`,
        data: { due: due.length, attempted: results.length, remaining: due.length - results.length, results },
      };
    },
  });

  const listReturns = defineTool({
    name: "list_returns",
    title: "List returned debits (for dunning)",
    description:
      "Lists a creditor's debits that came back unpaid or were refused, with their ISO return codes (AM04 insufficient funds, MS03 not specified, MS02 refused by the payer) and what to do next. Read-only.",
    readOnly: true,
    shape: { instance: instanceField, creditorId: idField("The creditor's id on the rail") },
    async handler({ instance, creditorId }) {
      const rows = await creditorCollections(ctx.reader(instance), toBigInt(creditorId));
      const returns = rows
        .filter((r) => r.collection.status === CollectionStatus.RETURNED || r.collection.status === CollectionStatus.REFUSED)
        .map((r) => {
          const s = summarise(r, ctx);
          const stored = r.collection.code !== "0x00000000" ? decodeReturnCode(r.collection.code) : "";
          const code = stored || (r.collection.status === CollectionStatus.REFUSED ? "MS02" : "MS03");
          return { ...s, code, label: returnCodeLabel(code), mandateStatus: mandateStatusName(r.mandateStatus), advice: dunningAdvice(code) };
        });
      return { summary: `${returns.length} returned or refused debit${returns.length === 1 ? "" : "s"}.`, data: { count: returns.length, returns } };
    },
  });

  const coverage = defineTool({
    name: "coverage",
    title: "Reserve coverage",
    description: "A creditor's reserve per token: free, locked (backing refunds), held by the contract, and open exposure. Read-only.",
    readOnly: true,
    shape: { instance: instanceField, creditorId: idField("The creditor's id on the rail") },
    async handler({ instance, creditorId }) {
      const cov = await ctx.reader(instance).coverage(toBigInt(creditorId));
      const one = (symbol: string, c: { reserveTotal: bigint; reserveLocked: bigint; held: bigint; openExposure: bigint }) => ({
        token: symbol,
        free: fmt(c.reserveTotal - c.reserveLocked),
        locked: fmt(c.reserveLocked),
        held: fmt(c.held),
        exposure: fmt(c.openExposure),
        reserveTotal: fmt(c.reserveTotal),
      });
      return { summary: `Coverage for creditor ${creditorId} on ${instance}.`, data: { tokens: [one("EURC", cov.eurc), one("USDC", cov.usdc)] } };
    },
  });

  return [listMandates, prenotify, collectDue, listReturns, coverage];
}
