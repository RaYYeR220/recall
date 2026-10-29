import { decodeErrorResult, hexToString, isHex, type Hex } from "viem";
import { debitRailAbi } from "./abi.js";

export interface RailError {
  /** Solidity error name, e.g. "MD01_NoValidMandate". "Error" for a plain revert string, "Panic", or "UnknownError". */
  name: string;
  /** ISO 20022 code when the error name carries one (e.g. "MD01", "AM05"), otherwise null. */
  code: string | null;
  /** Plain-language explanation, safe to show to an end user. */
  message: string;
  args?: readonly unknown[];
  /** The raw revert data the error was decoded from. */
  data?: Hex;
}

/** One plain-language message per custom error in the DebitRail ABI. A test enforces full coverage. */
export const RAIL_ERROR_MESSAGES: Record<string, string> = {
  UnknownCreditor: "This creditor is not registered on this rail.",
  NotCreditorOwner: "Only the creditor's owner can do this.",
  NotCreditorAgent: "Only the creditor's owner or an operator can do this.",
  NotDebtor: "Only the payer on this mandate can do this.",
  NotDebtorOrCreditor: "Only the payer or the creditor's owner can do this.",
  TokenNotAllowed: "Only EURC and USDC are accepted.",
  BadSignature: "The signature does not match the expected signer.",
  SignatureExpired: "This signature has expired. Ask for a fresh one.",
  BadNonce: "This signature is out of date (its nonce was already used or skipped). Sign again.",
  OfferCancelled_: "The creditor cancelled this offer.",
  OfferUsedUp: "This offer has already been accepted the maximum number of times.",
  InvalidTerms: "The mandate terms are not allowed (for example the notice is too short or a cap is zero).",
  MandateExists: "This payer has already accepted this offer.",
  MD01_NoValidMandate: "No valid mandate: it is not active, or it has lapsed.",
  AM05_Duplicate: "Duplicate collection: this end-to-end ID was already used by this creditor.",
  ZeroAmount: "The amount must be greater than zero.",
  ZeroAddress: "An address argument was the zero address.",
  OverCollectionCap: "This amount is above the mandate's limit per collection.",
  OverPeriodCap: "This amount would exceed the mandate's limit for the period.",
  PrenoticeTooShort: "The due date is too soon: the payer must be told further in advance.",
  ScheduleTooFar: "The due date is too far in the future.",
  OneOffBusy: "This one-off mandate already has a collection scheduled or settled.",
  WrongStatus: "This item is not in the right state for that action.",
  TooEarly: "This collection is not due yet.",
  ExecutionWindowPassed: "The window to execute this collection has passed.",
  RefundWindowOpen: "The refund window is still open, so this cannot be released yet.",
  RefundWindowClosed: "The refund window has closed, so this can no longer be refunded.",
  NoRefundRightB2B: "Business (B2B) collections have no refund right.",
  ReserveLocked: "That part of the reserve is locked behind collections that can still be refunded.",
  NothingToClaim: "There is nothing to claim.",
  WrongTimeScale: "This offer was made for a different rail (its time scale does not match).",
  NotOfferedDebtor: "This offer is reserved for a different payer.",
  PermitFailed: "The token allowance could not be set from the permit.",
  TransferFailed: "The token transfer failed.",
  InvalidShortString: "An internal string was invalid.",
  StringTooLong: "A string was too long.",
  ReentrancyGuardReentrantCall: "Reentrant call blocked.",
  SafeCastOverflowedUintDowncast: "A number was too large for its field.",
  SafeERC20FailedOperation: "The token rejected the transfer (the account may be blocked by the issuer).",
};

const CODE_FROM_NAME = /^([A-Z]{2}\d{2})_/;

const MAX_DEPTH = 12;

/** Finds revert data (a 4-byte selector plus args) inside a viem error chain, a nested RPC error, or a bare hex string. */
export function extractRevertData(err: unknown): Hex | undefined {
  const seen = new Set<unknown>();
  const visit = (e: unknown, depth: number): Hex | undefined => {
    if (depth > MAX_DEPTH || e === null || e === undefined || seen.has(e)) return undefined;
    if (typeof e === "string") return isHex(e) && e.length >= 10 ? e : undefined;
    if (typeof e !== "object") return undefined;
    seen.add(e);
    const o = e as Record<string, unknown>;
    for (const key of ["raw", "data"] as const) {
      const v = o[key];
      if (typeof v === "string" && isHex(v) && v.length >= 10) return v;
    }
    for (const key of ["data", "error", "cause"] as const) {
      const found = visit(o[key], depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(err, 0);
}

function fallbackMessage(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const o = err as { shortMessage?: unknown; message?: unknown };
    if (typeof o.shortMessage === "string" && o.shortMessage) return o.shortMessage;
    if (typeof o.message === "string" && o.message) return o.message.split("\n")[0] ?? o.message;
  }
  return typeof err === "string" ? err : "The transaction failed for an unknown reason.";
}

/**
 * Turns anything a failed call throws (a viem error, a bare revert-data hex string) into
 * `{ name, code, message }`. Errors named after an ISO 20022 reason (MD01_NoValidMandate,
 * AM05_Duplicate) carry that code; the rest have `code: null` and a plain message.
 */
export function decodeRailError(err: unknown): RailError {
  const data = extractRevertData(err);
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: debitRailAbi, data });
      const name = decoded.errorName as string;
      const code = CODE_FROM_NAME.exec(name)?.[1] ?? null;
      if (name === "Error" || name === "Panic") {
        const detail = decoded.args?.[0];
        return {
          name,
          code,
          message: typeof detail === "string" || typeof detail === "bigint" ? `Reverted: ${String(detail)}` : "Reverted.",
          args: decoded.args,
          data,
        };
      }
      return {
        name,
        code,
        message: RAIL_ERROR_MESSAGES[name] ?? `The rail rejected this action (${name}).`,
        args: decoded.args,
        data,
      };
    } catch {
      // fall through: selector is not one of ours
    }
  }
  return { name: "UnknownError", code: null, message: fallbackMessage(err), data };
}

/** ISO 20022 R-transaction reason codes used by the rail. */
export const RETURN_CODE_LABELS: Record<string, string> = {
  AM04: "Insufficient funds",
  MS02: "Refused by the payer",
  MS03: "Reason not specified",
  MD01: "No valid mandate",
  MD06: "Refund requested by the payer",
  AM05: "Duplicate collection",
};

/** Reads a `bytes4` reason code (e.g. 0x414d3034) as its four-letter text ("AM04"). Empty for 0x00000000. */
export function decodeReturnCode(code: string): string {
  if (isHex(code, { strict: true }) && code.length === 10) {
    return hexToString(code, { size: 4 }).replace(/\0/g, "");
  }
  return code;
}

/** Label for an ISO 20022 reason code. Accepts "AM04" or the raw bytes4 from a Collection. */
export function returnCodeLabel(code: string): string {
  const text = decodeReturnCode(code).toUpperCase();
  if (text === "") return "";
  return RETURN_CODE_LABELS[text] ?? `Unknown reason (${text})`;
}
