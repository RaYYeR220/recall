import type { Address, Hex } from "viem";
import { refToBytes32, termsHash } from "../src/terms";
import { Scheme, type MandateOffer } from "../src/types";
import { ZERO_ADDRESS } from "../src/types";

export const TEST_TOKEN: Address = "0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a";

/** A valid-looking offer for tests that do not touch the chain. */
export function sampleOffer(overrides: Partial<MandateOffer> = {}): MandateOffer {
  return {
    creditorId: 1n,
    token: TEST_TOKEN,
    scheme: Scheme.CORE,
    oneOff: false,
    maxPerCollection: 100_000_000n,
    maxPerPeriod: 200_000_000n,
    periodLength: 30 * 86_400,
    prenoticeLength: 86_400,
    offerRef: refToBytes32("REF-001"),
    termsHash: termsHash("terms"),
    maxUses: 0,
    validUntil: 1_900_000_000n,
    timeScale: 1,
    debtor: ZERO_ADDRESS,
    ...overrides,
  };
}

/** 32 bytes of hex made from a repeated byte, e.g. bytes32("ab"). */
export const bytes32 = (byte: string): Hex => `0x${byte.repeat(32)}`;

export const SAMPLE_SIG: Hex = `0x${"ab".repeat(32)}${"cd".repeat(32)}1b`;

/** Offers that exercise every field of the typed-data struct, including extremes. */
export function offerVariants(base: { creditorId: bigint; token: Address; debtor: Address }): MandateOffer[] {
  const max128 = (1n << 128n) - 1n;
  const max64 = (1n << 64n) - 1n;
  return [
    sampleOffer({ creditorId: base.creditorId, token: base.token }),
    sampleOffer({ creditorId: base.creditorId, token: base.token, scheme: Scheme.B2B, oneOff: true, maxUses: 1 }),
    sampleOffer({ creditorId: base.creditorId, token: base.token, debtor: base.debtor, timeScale: 10080 }),
    sampleOffer({
      creditorId: base.creditorId,
      token: base.token,
      maxPerCollection: max128,
      maxPerPeriod: max128,
      periodLength: 0xffffffff,
      prenoticeLength: 0xffffffff,
      maxUses: 0xffffffff,
      validUntil: max64,
      offerRef: `0x${"ff".repeat(32)}`,
      termsHash: `0x${"00".repeat(31)}01`,
    }),
    sampleOffer({ creditorId: (1n << 255n) + 7n, token: base.token, validUntil: 0n }),
  ];
}

/** Awaits a promise that must reject and returns the error (so tests can assert on it without a floating `.rejects`). */
export async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  throw new Error("expected the promise to reject");
}
