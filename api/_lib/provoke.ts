import proof from "../../public/proof.json";

/** The six ways to try to break the rail, mapped to the contract error each one must produce. */
export const PROVOKE_CASES = {
  "collect-too-early": { expect: "TooEarly", label: "Collect before the due date" },
  "over-cap": { expect: "OverCollectionCap", label: "Pre-notify above the mandate's cap" },
  "refund-after-window": { expect: "RefundWindowClosed", label: "Refund after the window closed" },
  "withdraw-locked-reserve": { expect: "ReserveLocked", label: "Withdraw reserve that is locked" },
  "refund-b2b": { expect: "NoRefundRightB2B", label: "Refund a business (B2B) debit" },
  "prenotify-revoked": { expect: "MD01_NoValidMandate", label: "Pre-notify on a revoked mandate" },
} as const;

export type ProvokeCase = keyof typeof PROVOKE_CASES;

export function isProvokeCase(x: unknown): x is ProvokeCase {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(PROVOKE_CASES, x);
}

export interface RecordedRefusal {
  label: string;
  hash: string;
  error: string;
  rail: string;
}

interface ProofEntry {
  label: string;
  kind: string;
  rail: string;
  hash: string;
  error?: string;
}

/** The real, reverted mainnet transaction that proves a case, from public/proof.json. */
export function recordedRefusal(c: ProvokeCase): RecordedRefusal | null {
  const want = PROVOKE_CASES[c].expect;
  const e = (proof.entries as ProofEntry[]).find((x) => x.kind === "refusal" && x.error === want);
  return e ? { label: e.label, hash: e.hash, error: want, rail: e.rail } : null;
}
