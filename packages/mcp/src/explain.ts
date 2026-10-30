import { CollectionStatus, Scheme, collectionStatusName } from "../../sdk/src/index.js";
import { duration, fmt, iso } from "./format.js";

export interface RefundInput {
  status: number;
  amount: bigint;
  dueAt: bigint;
  settledAt: bigint;
  locked: bigint;
  held: bigint;
  scheme: number;
  /** Scaled refund window of the rail, in seconds. */
  refundWindow: bigint;
  /** Chain time, unix seconds. */
  nowSec: number;
  symbol: string;
  creditorName: string;
  instance: "prod" | "demo";
}

export interface RefundExplanation {
  status: string;
  scheme: "CORE" | "B2B";
  /** Can the payer take this debit back right now? */
  canRefundNow: boolean;
  refundableUntil: string | null;
  refundableUntilUnix: number | null;
  secondsLeft: number | null;
  /** Where the money comes from. */
  fundedFrom: string | null;
  headline: string;
  explanation: string[];
}

/** Where a refund is paid from, in plain words. */
export function fundedFrom(locked: bigint, held: bigint, creditorName: string): string | null {
  if (locked > 0n && held > 0n) return `${creditorName}'s locked reserve and funds the contract is holding`;
  if (locked > 0n) return `${creditorName}'s locked reserve`;
  if (held > 0n) return "funds the contract is holding for this debit";
  return null;
}

/**
 * Plain-language refund rights for one debit. Pure: chain state and the clock come in. It only describes; a
 * refund still needs the payer's own signature.
 */
export function explainRefund(i: RefundInput): RefundExplanation {
  const status = collectionStatusName(i.status);
  const scheme = i.scheme === Scheme.B2B ? "B2B" : "CORE";
  const amount = `${fmt(i.amount)} ${i.symbol}`;
  const scaleNote =
    i.instance === "demo" ? ["This is the demo rail: time runs faster here (1 week = 1 minute), so the windows below are short on purpose."] : [];
  const out = (partial: Partial<RefundExplanation> & Pick<RefundExplanation, "canRefundNow" | "headline" | "explanation">): RefundExplanation => ({
    status,
    scheme,
    refundableUntil: null,
    refundableUntilUnix: null,
    secondsLeft: null,
    fundedFrom: null,
    ...partial,
    explanation: [...partial.explanation, ...scaleNote],
  });

  if (scheme === "B2B" && (i.status === CollectionStatus.SETTLED || i.status === CollectionStatus.FINAL)) {
    return out({
      canRefundNow: false,
      headline: "No refund right: this is a business-to-business mandate.",
      explanation: [
        `This ${amount} debit was taken under a B2B mandate. The payer agreed in the mandate that there is no refund right, so the rail refuses a refund (NoRefundRightB2B).`,
        "The payer could only stop future debits by revoking the mandate.",
      ],
    });
  }

  switch (i.status) {
    case CollectionStatus.SCHEDULED:
      return out({
        canRefundNow: false,
        headline: "Not taken yet: nothing to refund, but it can still be refused.",
        explanation: [
          `${i.creditorName} has announced a debit of ${amount}, due ${iso(i.dueAt)}. No money has moved.`,
          "Before it is collected the payer can refuse it, or revoke the mandate to stop all future debits. After it is collected, the refund right below applies.",
          scheme === "CORE" ? `Once collected, the payer has ${duration(Number(i.refundWindow))} to take it back with no questions asked.` : "",
        ].filter(Boolean),
      });
    case CollectionStatus.SETTLED: {
      const deadline = Number(i.settledAt + i.refundWindow);
      const left = deadline - i.nowSec;
      const from = fundedFrom(i.locked, i.held, i.creditorName);
      if (left > 0) {
        return out({
          canRefundNow: true,
          headline: `Yes: ${amount} can still be refunded, for ${duration(left)}.`,
          refundableUntil: iso(deadline),
          refundableUntilUnix: deadline,
          secondsLeft: left,
          fundedFrom: from,
          explanation: [
            `The debit settled ${iso(i.settledAt)}. The refund window is ${duration(Number(i.refundWindow))} and closes ${iso(deadline)}.`,
            from ? `A refund is paid straight back to the payer from ${from}, so it does not depend on ${i.creditorName} doing anything.` : "A refund is paid straight back to the payer.",
            "The payer signs the refund themselves. Nobody else can do it for them.",
          ],
        });
      }
      return out({
        canRefundNow: false,
        headline: "No: the refund window has closed.",
        refundableUntil: iso(deadline),
        refundableUntilUnix: deadline,
        secondsLeft: 0,
        explanation: [
          `The refund window closed ${iso(deadline)} (${duration(-left)} ago). The rail refuses a refund now (RefundWindowClosed) and the money is released to ${i.creditorName}.`,
        ],
      });
    }
    case CollectionStatus.FINAL:
      return out({
        canRefundNow: false,
        headline: "No: the refund window closed and the money was released.",
        explanation: [`This ${amount} debit is final. Its refund window ended and the funds were released to ${i.creditorName}.`],
      });
    case CollectionStatus.REFUNDED:
      return out({
        canRefundNow: false,
        headline: "Already refunded.",
        explanation: [`This ${amount} debit was refunded to the payer. The return code is MD06 (refund requested by the payer).`],
      });
    case CollectionStatus.RETURNED:
      return out({
        canRefundNow: false,
        headline: "Nothing to refund: the debit did not go through.",
        explanation: [`This ${amount} debit was returned unpaid, so no money left the payer's wallet.`],
      });
    case CollectionStatus.REFUSED:
      return out({
        canRefundNow: false,
        headline: "Nothing to refund: the payer refused it.",
        explanation: [`This ${amount} debit was refused before collection (return code MS02), so no money moved.`],
      });
    case CollectionStatus.CANCELLED:
    case CollectionStatus.EXPIRED:
      return out({
        canRefundNow: false,
        headline: `Nothing to refund: the debit was ${status.toLowerCase()}.`,
        explanation: [`This ${amount} debit was ${status.toLowerCase()} before it was collected, so no money moved.`],
      });
    default:
      return out({
        canRefundNow: false,
        headline: "No such debit.",
        explanation: ["The rail has no debit with this id on this instance. Check the id and the rail (prod or demo)."],
      });
  }
}
