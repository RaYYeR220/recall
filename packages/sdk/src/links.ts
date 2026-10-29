import {
  getAddress,
  isAddress,
  isHex,
  recoverTypedDataAddress,
  size,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { debitRailAbi } from "./abi";
import { offerTypedData, railDomain } from "./eip712";
import { RAIL_INSTANCES, RAIL_NETWORKS, TIME_SCALE, type RailInstance, type RailNetwork } from "./networks";
import { termsHash } from "./terms";
import type { MandateOffer } from "./types";

/** Everything a payer's browser needs to review and accept a mandate. */
export interface CheckoutLinkPayload {
  network: RailNetwork;
  instance: RailInstance;
  offer: MandateOffer;
  offerSig: Hex;
  creditorName: string;
  /** The exact mandate text. `keccak256(terms)` must equal `offer.termsHash`. */
  terms: string;
}

export class CheckoutLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutLinkError";
  }
}

const LINK_VERSION = 1;
const PARAM = "r";
const MAX_ENCODED_CHARS = 32_768;
const MAX_NAME_CHARS = 128;
const MAX_TERMS_CHARS = 8_192;
const MAX_SIG_BYTES = 4_096;

// ── base64url (UTF-8 safe, works in browsers, Bun and Node) ──────────────────

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new CheckoutLinkError("Checkout link is not valid base64url.");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new CheckoutLinkError("Checkout link is not valid base64url.");
  }
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CheckoutLinkError("Checkout link is not valid UTF-8.");
  }
}

// ── encode ───────────────────────────────────────────────────────────────────

interface WireOffer {
  creditorId: string;
  token: string;
  scheme: number;
  oneOff: boolean;
  maxPerCollection: string;
  maxPerPeriod: string;
  periodLength: number;
  prenoticeLength: number;
  offerRef: string;
  termsHash: string;
  maxUses: number;
  validUntil: string;
  timeScale: number;
  debtor: string;
}

interface Wire {
  v: number;
  n: RailNetwork;
  i: RailInstance;
  o: WireOffer;
  s: string;
  c: string;
  t: string;
}

/**
 * Builds a compact checkout link: the payload as base64url JSON in the URL fragment
 * (`#r=...`), which browsers never send to a server. `decodeCheckoutLink` also accepts `?r=...`.
 */
export function encodeCheckoutLink(baseUrl: string, payload: CheckoutLinkPayload): string {
  const o = payload.offer;
  const wire: Wire = {
    v: LINK_VERSION,
    n: payload.network,
    i: payload.instance,
    o: {
      creditorId: o.creditorId.toString(),
      token: o.token,
      scheme: o.scheme,
      oneOff: o.oneOff,
      maxPerCollection: o.maxPerCollection.toString(),
      maxPerPeriod: o.maxPerPeriod.toString(),
      periodLength: o.periodLength,
      prenoticeLength: o.prenoticeLength,
      offerRef: o.offerRef,
      termsHash: o.termsHash,
      maxUses: o.maxUses,
      validUntil: o.validUntil.toString(),
      timeScale: o.timeScale,
      debtor: o.debtor,
    },
    s: payload.offerSig,
    c: payload.creditorName,
    t: payload.terms,
  };
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = `${PARAM}=${toBase64Url(JSON.stringify(wire))}`;
  return url.toString();
}

// ── decode + shape verification ──────────────────────────────────────────────

function fail(msg: string): never {
  throw new CheckoutLinkError(msg);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function uintString(x: unknown, field: string, bits: number): bigint {
  if (typeof x !== "string" || !/^(0|[1-9]\d*)$/.test(x) || x.length > 78) fail(`Checkout link: "${field}" must be a decimal integer.`);
  const n = BigInt(x);
  if (n >= 1n << BigInt(bits)) fail(`Checkout link: "${field}" does not fit in uint${bits}.`);
  return n;
}

function uintNumber(x: unknown, field: string, bits: number): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x >= 2 ** bits) {
    fail(`Checkout link: "${field}" must be an integer that fits in uint${bits}.`);
  }
  return x;
}

function hex32(x: unknown, field: string): Hex {
  if (typeof x !== "string" || !isHex(x, { strict: true }) || x.length !== 66) fail(`Checkout link: "${field}" must be 32 bytes of hex.`);
  return x;
}

function addr(x: unknown, field: string): Address {
  if (typeof x !== "string" || !isAddress(x, { strict: false })) fail(`Checkout link: "${field}" must be an address.`);
  return getAddress(x);
}

function parseOffer(x: unknown): MandateOffer {
  if (!isRecord(x)) fail('Checkout link: "offer" is missing.');
  if (typeof x["oneOff"] !== "boolean") fail('Checkout link: "oneOff" must be a boolean.');
  const scheme = uintNumber(x["scheme"], "scheme", 8);
  if (scheme > 1) fail('Checkout link: "scheme" must be 0 (CORE) or 1 (B2B).');
  return {
    creditorId: uintString(x["creditorId"], "creditorId", 256),
    token: addr(x["token"], "token"),
    scheme,
    oneOff: x["oneOff"],
    maxPerCollection: uintString(x["maxPerCollection"], "maxPerCollection", 128),
    maxPerPeriod: uintString(x["maxPerPeriod"], "maxPerPeriod", 128),
    periodLength: uintNumber(x["periodLength"], "periodLength", 32),
    prenoticeLength: uintNumber(x["prenoticeLength"], "prenoticeLength", 32),
    offerRef: hex32(x["offerRef"], "offerRef"),
    termsHash: hex32(x["termsHash"], "termsHash"),
    maxUses: uintNumber(x["maxUses"], "maxUses", 32),
    validUntil: uintString(x["validUntil"], "validUntil", 64),
    timeScale: uintNumber(x["timeScale"], "timeScale", 32),
    debtor: addr(x["debtor"], "debtor"),
  };
}

function extractParam(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    fail("Checkout link is not a valid URL.");
  }
  const fromHash = new URLSearchParams(u.hash.replace(/^#/, "")).get(PARAM);
  const value = fromHash ?? u.searchParams.get(PARAM);
  if (!value) fail("Checkout link has no mandate data.");
  return value;
}

/**
 * Parses and shape-checks a checkout link. Throws `CheckoutLinkError` on anything malformed, on a
 * terms text that does not hash to `offer.termsHash`, or on an offer whose `timeScale` disagrees
 * with the instance named in the link. It does NOT check the signature: use `verifyOfferSignature`.
 */
export function decodeCheckoutLink(url: string): CheckoutLinkPayload {
  const encoded = extractParam(url);
  if (encoded.length > MAX_ENCODED_CHARS) fail("Checkout link is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(encoded));
  } catch (e) {
    if (e instanceof CheckoutLinkError) throw e;
    fail("Checkout link does not contain valid JSON.");
  }
  if (!isRecord(raw)) fail("Checkout link payload is not an object.");
  if (raw["v"] !== LINK_VERSION) fail(`Checkout link version ${String(raw["v"])} is not supported.`);

  const network = raw["n"];
  const instance = raw["i"];
  if (typeof network !== "string" || !(RAIL_NETWORKS as readonly string[]).includes(network)) fail('Checkout link: unknown "network".');
  if (typeof instance !== "string" || !(RAIL_INSTANCES as readonly string[]).includes(instance)) fail('Checkout link: unknown "instance".');

  const offer = parseOffer(raw["o"]);
  const offerSig = raw["s"];
  if (typeof offerSig !== "string" || !isHex(offerSig, { strict: true }) || size(offerSig) < 64 || size(offerSig) > MAX_SIG_BYTES) {
    fail('Checkout link: "offerSig" is not a valid signature.');
  }
  const creditorName = raw["c"];
  const terms = raw["t"];
  if (typeof creditorName !== "string" || creditorName.length === 0 || creditorName.length > MAX_NAME_CHARS) fail('Checkout link: "creditorName" is invalid.');
  if (typeof terms !== "string" || terms.length === 0 || terms.length > MAX_TERMS_CHARS) fail('Checkout link: "terms" is invalid.');

  const inst = instance as RailInstance;
  if (offer.timeScale !== TIME_SCALE[inst]) {
    fail(`Checkout link: offer time scale ${offer.timeScale} does not match the ${inst} rail (${TIME_SCALE[inst]}).`);
  }
  if (termsHash(terms).toLowerCase() !== offer.termsHash.toLowerCase()) {
    fail("Checkout link: the mandate text does not match the hash the creditor signed.");
  }

  return { network: network as RailNetwork, instance: inst, offer, offerSig: offerSig, creditorName, terms };
}

// ── signature verification (needs the chain) ─────────────────────────────────

export interface OfferSignatureResult {
  valid: boolean;
  /** Recovered signer, when the signature is an ECDSA signature. */
  signer?: Address;
  role?: "owner" | "operator";
  /** Why the check failed (when `valid` is false). */
  reason?: string;
}

/**
 * Checks that `sig` over `offer` was made by the creditor's owner or one of its operators, and that
 * the offer is aimed at this rail (time scale). Smart-contract owners (ERC-1271) are supported.
 */
export async function verifyOfferSignature(
  publicClient: PublicClient,
  rail: Address,
  offer: MandateOffer,
  sig: Hex,
): Promise<OfferSignatureResult> {
  const [domain, railTimeScale] = await Promise.all([
    railDomain(publicClient, rail),
    publicClient.readContract({ address: rail, abi: debitRailAbi, functionName: "timeScale" }),
  ]);
  if (offer.timeScale !== railTimeScale) {
    return { valid: false, reason: `Offer time scale ${offer.timeScale} does not match this rail (${railTimeScale}).` };
  }

  let owner: Address;
  try {
    const creditor = await publicClient.readContract({
      address: rail,
      abi: debitRailAbi,
      functionName: "getCreditor",
      args: [offer.creditorId],
    });
    owner = creditor.owner;
  } catch {
    return { valid: false, reason: "Unknown creditor." };
  }
  if (/^0x0{40}$/i.test(owner)) return { valid: false, reason: "Unknown creditor." };

  const typed = offerTypedData(domain, offer);

  let signer: Address | undefined;
  try {
    signer = await recoverTypedDataAddress({ ...typed, signature: sig });
  } catch {
    signer = undefined; // not a 65-byte ECDSA signature; may still be an ERC-1271 signature
  }

  if (signer) {
    if (signer.toLowerCase() === owner.toLowerCase()) return { valid: true, signer, role: "owner" };
    const isOp = await publicClient.readContract({
      address: rail,
      abi: debitRailAbi,
      functionName: "isOperator",
      args: [offer.creditorId, signer],
    });
    if (isOp) return { valid: true, signer, role: "operator" };
  }

  // Smart-contract owner (ERC-1271)?
  try {
    const ok = await publicClient.verifyTypedData({ ...typed, address: owner, signature: sig });
    if (ok) return { valid: true, signer: signer ?? owner, role: "owner" };
  } catch {
    // ignore: treated as invalid below
  }

  return {
    valid: false,
    signer,
    reason: signer ? "Signer is neither the creditor's owner nor an operator." : "Signature is malformed.",
  };
}
