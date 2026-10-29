import { hashDomain, parseSignature, type Address, type Hex, type PublicClient } from "viem";
import { debitRailAbi } from "./abi";
import { erc20Abi } from "./erc20";
import type { DebtorAction, MandateAcceptance, MandateOffer, PermitData } from "./types";

export interface RailDomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
}

/**
 * Reads the EIP-712 domain from the rail itself (ERC-5267). The domain name differs per
 * instance ("Recall DebitRail" vs "Recall DebitRail DEMO (1 week = 1 minute)"), so it is
 * never hardcoded.
 */
export async function railDomain(publicClient: PublicClient, rail: Address): Promise<RailDomain> {
  const [, name, version, chainId, verifyingContract] = await publicClient.readContract({
    address: rail,
    abi: debitRailAbi,
    functionName: "eip712Domain",
  });
  return { name, version, chainId: Number(chainId), verifyingContract };
}

export const OFFER_TYPES = {
  MandateOffer: [
    { name: "creditorId", type: "uint256" },
    { name: "token", type: "address" },
    { name: "scheme", type: "uint8" },
    { name: "oneOff", type: "bool" },
    { name: "maxPerCollection", type: "uint128" },
    { name: "maxPerPeriod", type: "uint128" },
    { name: "periodLength", type: "uint32" },
    { name: "prenoticeLength", type: "uint32" },
    { name: "offerRef", type: "bytes32" },
    { name: "termsHash", type: "bytes32" },
    { name: "maxUses", type: "uint32" },
    { name: "validUntil", type: "uint64" },
    { name: "timeScale", type: "uint32" },
    { name: "debtor", type: "address" },
  ],
} as const;

export const ACCEPTANCE_TYPES = {
  MandateAcceptance: [
    { name: "offerHash", type: "bytes32" },
    { name: "debtor", type: "address" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const DEBTOR_ACTION_TYPES = {
  DebtorAction: [
    { name: "kind", type: "uint8" },
    { name: "target", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

/** Typed data the creditor (owner or operator) signs. Its digest equals `rail.hashOffer(offer)`. */
export function offerTypedData(domain: RailDomain, offer: MandateOffer) {
  return {
    domain,
    types: OFFER_TYPES,
    primaryType: "MandateOffer",
    message: {
      creditorId: offer.creditorId,
      token: offer.token,
      scheme: offer.scheme,
      oneOff: offer.oneOff,
      maxPerCollection: offer.maxPerCollection,
      maxPerPeriod: offer.maxPerPeriod,
      periodLength: offer.periodLength,
      prenoticeLength: offer.prenoticeLength,
      offerRef: offer.offerRef,
      termsHash: offer.termsHash,
      maxUses: offer.maxUses,
      validUntil: offer.validUntil,
      timeScale: offer.timeScale,
      debtor: offer.debtor,
    },
  } as const;
}

/** Typed data the debtor signs to accept an offer. Its digest equals `rail.hashAcceptance(acc)`. */
export function acceptanceTypedData(domain: RailDomain, acceptance: MandateAcceptance) {
  return {
    domain,
    types: ACCEPTANCE_TYPES,
    primaryType: "MandateAcceptance",
    message: {
      offerHash: acceptance.offerHash,
      debtor: acceptance.debtor,
      deadline: acceptance.deadline,
    },
  } as const;
}

/** Typed data the debtor signs to REFUND, REVOKE or REFUSE gaslessly. Digest equals `rail.hashDebtorAction(a)`. */
export function debtorActionTypedData(domain: RailDomain, action: DebtorAction) {
  return {
    domain,
    types: DEBTOR_ACTION_TYPES,
    primaryType: "DebtorAction",
    message: {
      kind: action.kind,
      target: action.target,
      nonce: action.nonce,
      deadline: action.deadline,
    },
  } as const;
}

const EIP712_DOMAIN_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ],
} as const;

function domainSeparator(domain: RailDomain): Hex {
  return hashDomain({ domain: { ...domain, chainId: BigInt(domain.chainId) }, types: EIP712_DOMAIN_TYPES });
}

async function tryRead<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/**
 * Typed data for an EIP-2612 permit on `token`. Reads the token's name, version and the owner's
 * nonce, then CHECKS the resulting domain against the token's own DOMAIN_SEPARATOR. If the check
 * fails (a wrong version string is the usual cause) this throws instead of returning typed data
 * the token would reject.
 */
export async function permitTypedData(
  publicClient: PublicClient,
  token: Address,
  owner: Address,
  spender: Address,
  value: bigint,
  deadline: bigint,
) {
  const [nonce, onchainSeparator, chainId, fiveSixSeven, name, version] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: "nonces", args: [owner] }),
    tryRead(() => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "DOMAIN_SEPARATOR" })),
    publicClient.getChainId(),
    tryRead(() => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "eip712Domain" })),
    tryRead(() => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "name" })),
    tryRead(() => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "version" })),
  ]);

  if (!onchainSeparator) {
    throw new Error(`permitTypedData: ${token} has no DOMAIN_SEPARATOR(), so the permit domain cannot be verified.`);
  }

  // Candidate domains, most trustworthy first: ERC-5267, then name()+version(), then the usual versions.
  const candidates: RailDomain[] = [];
  if (fiveSixSeven) {
    candidates.push({
      name: fiveSixSeven[1],
      version: fiveSixSeven[2],
      chainId: Number(fiveSixSeven[3]),
      verifyingContract: fiveSixSeven[4],
    });
  }
  if (name !== undefined) {
    const versions = [...(version !== undefined ? [version] : []), "2", "1"];
    for (const v of versions) candidates.push({ name, version: v, chainId, verifyingContract: token });
  }

  const match = candidates.find((d) => domainSeparator(d).toLowerCase() === onchainSeparator.toLowerCase());
  if (!match) {
    throw new Error(
      `permitTypedData: could not reproduce DOMAIN_SEPARATOR() of ${token} (tried ${candidates.length} candidate domains).`,
    );
  }

  return {
    domain: match,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner, spender, value, nonce, deadline },
  } as const;
}

/** Splits a 65-byte permit signature into the `PermitData` tuple that `activateMandateWithPermit` takes. */
export function toPermitData(signature: Hex, value: bigint, deadline: bigint): PermitData {
  const sig = parseSignature(signature);
  const v = sig.v !== undefined ? Number(sig.v) : 27 + sig.yParity;
  return { value, deadline, v, r: sig.r, s: sig.s };
}
