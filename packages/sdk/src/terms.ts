import { formatUnits, keccak256, pad, stringToBytes, stringToHex, type Address, type Hex } from "viem";
import { Scheme, type SchemeName } from "./types.js";
import { TIME_SCALE, TOKEN_DECIMALS, networkInfo, type RailInstance, type RailNetwork } from "./networks.js";
import { e2eIdText } from "./camt054.js";
import type { MandateOffer } from "./types.js";

/** Refund window, lapse period: the legal (unscaled) values the contract divides by timeScale. */
const LEGAL_REFUND_WINDOW_S = 8 * 7 * 86_400;
const LEGAL_LAPSE_S = 1080 * 86_400;

export interface MandateTextParams {
  creditorName: string;
  creditorId?: bigint;
  instance: RailInstance;
  network?: RailNetwork;
  /** Rail contract the mandate is for. Shown so the payer can check it in the explorer. */
  rail?: Address;
  token: "EURC" | "USDC";
  scheme: SchemeName | number;
  oneOff: boolean;
  /** Smallest units (6 decimals). */
  maxPerCollection: bigint;
  maxPerPeriod: bigint;
  /** Legal seconds, unscaled. */
  periodLength: number;
  /** Legal seconds, unscaled. */
  prenoticeLength: number;
  /** 0 = unlimited. */
  maxUses: number;
  /** Unix seconds. 0 = never expires. */
  validUntil: bigint;
  /** Zero address or undefined = open offer. */
  debtor?: Address;
  offerRef?: string;
}

/** Strips control characters and collapses whitespace, so a creditor name can never forge extra clauses. */
export function sanitizeLine(s: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping control chars is the point
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
}

/** Human duration, at most two units. Weeks are used only for exact multiples of 3 weeks or more ("14 days", "8 weeks"). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s === 0) return "0 seconds";
  if (s % 604_800 === 0 && s >= 3 * 604_800) return plural(s / 604_800, "week");
  const parts: string[] = [];
  let rest = s;
  for (const [unit, size] of [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
    ["second", 1],
  ] as const) {
    const n = Math.floor(rest / size);
    if (n > 0) {
      parts.push(plural(n, unit));
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function amount(v: bigint, token: string): string {
  const [whole, frac = ""] = formatUnits(v, TOKEN_DECIMALS).split(".");
  return `${whole}.${frac.padEnd(2, "0")} ${token}`;
}

function isoUtc(unixSeconds: bigint): string {
  return new Date(Number(unixSeconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * A legal duration, plus its scaled equivalent on the demo rail.
 * Prod: "14 days". Demo: "14 days (2 minutes at demo speed)".
 */
function windowText(legalSeconds: number, timeScale: number, legalLabel?: string): string {
  const legal = legalLabel ?? formatDuration(legalSeconds);
  if (timeScale === 1) return legal;
  return `${legal} (${formatDuration(Math.floor(legalSeconds / timeScale))} at demo speed)`;
}

/**
 * The human-readable mandate shown to the payer before they sign. Deterministic: the same inputs
 * always give the same text, and `termsHash(text)` is what the offer commits to onchain.
 */
export function mandateText(p: MandateTextParams): string {
  const timeScale = TIME_SCALE[p.instance];
  const isDemo = p.instance === "demo";
  const name = sanitizeLine(p.creditorName) || "(unnamed creditor)";
  const schemeName: SchemeName =
    typeof p.scheme === "number" ? (p.scheme === Scheme.B2B ? "B2B" : "CORE") : p.scheme;
  const isCore = schemeName === "CORE";
  const open = !p.debtor || /^0x0{40}$/i.test(p.debtor);

  const lines: string[] = [];
  lines.push(isDemo ? "RECALL DIRECT DEBIT MANDATE (DEMO)" : "RECALL DIRECT DEBIT MANDATE");
  if (isDemo) {
    lines.push("DEMO RAIL: time runs faster here. 1 week = 1 minute. Do not use for real payments.");
  }
  lines.push("");
  lines.push(`Creditor: ${name}${p.creditorId !== undefined ? ` (creditor #${p.creditorId})` : ""}`);
  if (p.offerRef) lines.push(`Reference: ${sanitizeLine(p.offerRef)}`);
  lines.push(`Scheme: ${isCore ? "Core (consumer, with refund right)" : "B2B (business, no refund right)"}`);
  lines.push(`Payer: ${open ? "whoever signs this mandate" : p.debtor}`);
  if (p.network && p.rail) {
    lines.push(`Contract: ${p.rail} on ${networkInfo(p.network).chain.name}`);
  }
  lines.push("");
  lines.push(`You authorise ${name} to collect ${p.token} from your wallet by direct debit, within these limits:`);
  lines.push(`- At most ${amount(p.maxPerCollection, p.token)} per collection.`);
  lines.push(
    `- At most ${amount(p.maxPerPeriod, p.token)} in each period of ${windowText(p.periodLength, timeScale)}.`,
  );
  lines.push(
    p.oneOff
      ? "- One collection only."
      : "- Repeated collections, for as long as the mandate stays active.",
  );
  if (p.maxUses > 0) lines.push(`- This offer can be accepted at most ${p.maxUses} time${p.maxUses === 1 ? "" : "s"}.`);
  lines.push(
    `- You are told the amount and due date at least ${windowText(p.prenoticeLength, timeScale)} before each collection.`,
  );
  if (p.validUntil > 0n) lines.push(`- This offer can be accepted until ${isoUtc(p.validUntil)}.`);
  lines.push("");
  if (isCore) {
    lines.push(
      `Your refund right: for ${windowText(LEGAL_REFUND_WINDOW_S, timeScale)} after any collection you can claim a full refund, no questions asked.`,
    );
    lines.push(`After that window the funds are released to ${name}.`);
  } else {
    lines.push("No refund right: this is a business mandate. A collection is final once it is settled.");
  }
  lines.push("You can refuse a single collection before it runs, and revoke this mandate at any time.");
  lines.push(`The mandate lapses after ${windowText(LEGAL_LAPSE_S, timeScale, "36 months")} without a collection.`);
  return lines.join("\n");
}

/** keccak256 of the exact UTF-8 text. This is the `termsHash` an offer commits to. */
export function termsHash(text: string): Hex {
  return keccak256(stringToBytes(text));
}

/**
 * A creditor's own label as a bytes32: right-padded UTF-8 when it fits in 32 bytes,
 * otherwise its keccak256. Use for `offerRef` and for `e2eId`.
 */
export function refToBytes32(ref: string): Hex {
  const bytes = stringToBytes(ref);
  if (bytes.length === 0) throw new Error("refToBytes32: empty reference");
  if (bytes.length <= 32) return pad(stringToHex(ref), { size: 32, dir: "right" });
  return keccak256(bytes);
}

/**
 * The canonical mandate text for an offer: built ONLY from the offer's own fields plus the creditor's
 * registered name, so the text cannot promise anything the fields do not. Merchants write this text
 * (and hash it into the offer's `termsHash`); `verifyCheckoutLink` rebuilds it and demands equality.
 */
export function mandateTextForOffer(
  offer: MandateOffer,
  ctx: { creditorName: string; network: RailNetwork; instance: RailInstance; rail: Address; token: "EURC" | "USDC" },
): string {
  return mandateText({
    creditorName: ctx.creditorName,
    creditorId: offer.creditorId,
    instance: ctx.instance,
    network: ctx.network,
    rail: ctx.rail,
    token: ctx.token,
    scheme: offer.scheme,
    oneOff: offer.oneOff,
    maxPerCollection: offer.maxPerCollection,
    maxPerPeriod: offer.maxPerPeriod,
    periodLength: offer.periodLength,
    prenoticeLength: offer.prenoticeLength,
    maxUses: offer.maxUses,
    validUntil: offer.validUntil,
    debtor: offer.debtor,
    offerRef: e2eIdText(offer.offerRef),
  });
}
