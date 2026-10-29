import type { Address, Hex } from "viem";

/** Payment scheme. CORE carries an 8-week refund right. B2B carries none. */
export const Scheme = { CORE: 0, B2B: 1 } as const;
export type SchemeName = keyof typeof Scheme;

/** The three actions a debtor can authorise with an off-chain signature. */
export const ActionKind = { REFUND: 0, REVOKE: 1, REFUSE: 2 } as const;
export type ActionKindName = keyof typeof ActionKind;

export const MandateStatus = { NONE: 0, ACTIVE: 1, REVOKED: 2, USED: 3 } as const;
export const CollectionStatus = {
  NONE: 0,
  SCHEDULED: 1,
  REFUSED: 2,
  CANCELLED: 3,
  EXPIRED: 4,
  RETURNED: 5,
  SETTLED: 6,
  REFUNDED: 7,
  FINAL: 8,
} as const;

export function mandateStatusName(n: number): keyof typeof MandateStatus {
  return (Object.keys(MandateStatus) as (keyof typeof MandateStatus)[]).find((k) => MandateStatus[k] === n) ?? "NONE";
}

export function collectionStatusName(n: number): keyof typeof CollectionStatus {
  return (
    (Object.keys(CollectionStatus) as (keyof typeof CollectionStatus)[]).find((k) => CollectionStatus[k] === n) ??
    "NONE"
  );
}

/** Mirrors `MandateOffer` in IDebitRail.sol. Periods and prenotice are in LEGAL seconds (unscaled). */
export interface MandateOffer {
  creditorId: bigint;
  token: Address;
  scheme: number;
  oneOff: boolean;
  maxPerCollection: bigint;
  maxPerPeriod: bigint;
  periodLength: number;
  prenoticeLength: number;
  offerRef: Hex;
  termsHash: Hex;
  maxUses: number;
  validUntil: bigint;
  /** Must equal the target instance's timeScale (1 for prod, 10080 for demo). */
  timeScale: number;
  /** Zero address = open offer. Non-zero = this debtor only. */
  debtor: Address;
}

export interface MandateAcceptance {
  offerHash: Hex;
  debtor: Address;
  deadline: bigint;
}

export interface DebtorAction {
  kind: number;
  target: Hex;
  nonce: bigint;
  deadline: bigint;
}

/** EIP-2612 permit parameters as accepted by `activateMandateWithPermit`. */
export interface PermitData {
  value: bigint;
  deadline: bigint;
  v: number;
  r: Hex;
  s: Hex;
}

/** A debtor's signed REFUND / REVOKE / REFUSE, ready for anyone to submit. */
export interface SignedDebtorAction {
  action: DebtorAction;
  debtor: Address;
  sig: Hex;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
