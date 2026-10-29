import { getAddress, isAddress, isHex, size, type Address, type Hex } from "viem";
import {
  decodeRailError,
  RAIL_INSTANCES,
  TIME_SCALE,
  type DebtorAction,
  type MandateAcceptance,
  type MandateOffer,
  type PermitData,
  type RailInstance,
  type RailNetwork,
} from "../../packages/sdk/src/index.js";
import type { Kv } from "./kv.js";
import { takeRelaySlot, type RelayLimits } from "./limits.js";

export type RelayRequest =
  | { kind: "activate"; offer: MandateOffer; offerSig: Hex; acceptance: MandateAcceptance; debtorSig: Hex; permit?: PermitData }
  | { kind: "action"; action: DebtorAction; debtor: Address; sig: Hex };

export type ParseResult = { ok: true; instance: RailInstance; req: RelayRequest } | { ok: false; status: number; error: string };

class Bad extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const bad = (m: string): never => {
  throw new Bad(m);
};

function big(x: unknown, field: string, bits: number): bigint {
  const ok = (typeof x === "string" && /^(0|[1-9]\d{0,77})$/.test(x)) || (typeof x === "number" && Number.isSafeInteger(x) && x >= 0);
  if (!ok) return bad(`"${field}" must be a non-negative integer.`);
  const n = BigInt(x);
  return n >= 1n << BigInt(bits) ? bad(`"${field}" does not fit in uint${bits}.`) : n;
}

function int(x: unknown, field: string, bits: number): number {
  return Number(big(x, field, bits));
}

function hex(x: unknown, field: string, bytes?: number): Hex {
  if (typeof x !== "string" || !isHex(x, { strict: true })) return bad(`"${field}" must be hex.`);
  if (bytes !== undefined ? size(x) !== bytes : size(x) < 1 || size(x) > 4096) return bad(`"${field}" has the wrong length.`);
  return x;
}

function addr(x: unknown, field: string): Address {
  if (typeof x !== "string" || !isAddress(x, { strict: false })) return bad(`"${field}" must be an address.`);
  return getAddress(x);
}

function rec(x: unknown, field: string): Record<string, unknown> {
  return isObj(x) ? x : bad(`"${field}" must be an object.`);
}

function parseOffer(x: unknown): MandateOffer {
  const o = rec(x, "offer");
  if (typeof o["oneOff"] !== "boolean") bad('"oneOff" must be a boolean.');
  const scheme = int(o["scheme"], "scheme", 8);
  if (scheme > 1) bad('"scheme" must be 0 or 1.');
  return {
    creditorId: big(o["creditorId"], "creditorId", 256),
    token: addr(o["token"], "token"),
    scheme,
    oneOff: o["oneOff"] as boolean,
    maxPerCollection: big(o["maxPerCollection"], "maxPerCollection", 128),
    maxPerPeriod: big(o["maxPerPeriod"], "maxPerPeriod", 128),
    periodLength: int(o["periodLength"], "periodLength", 32),
    prenoticeLength: int(o["prenoticeLength"], "prenoticeLength", 32),
    offerRef: hex(o["offerRef"], "offerRef", 32),
    termsHash: hex(o["termsHash"], "termsHash", 32),
    maxUses: int(o["maxUses"], "maxUses", 32),
    validUntil: big(o["validUntil"], "validUntil", 64),
    timeScale: int(o["timeScale"], "timeScale", 32),
    debtor: addr(o["debtor"], "debtor"),
  };
}

function parsePermit(x: unknown): PermitData {
  const p = rec(x, "permit");
  return {
    value: big(p["value"], "permit.value", 256),
    deadline: big(p["deadline"], "permit.deadline", 256),
    v: int(p["v"], "permit.v", 8),
    r: hex(p["r"], "permit.r", 32),
    s: hex(p["s"], "permit.s", 32),
  };
}

export interface ParseContext {
  /** The one network this server relays for. */
  network: RailNetwork;
  /** The only tokens an offer may name: EURC and USDC on that network. */
  tokens: Address[];
}

/**
 * Validates a relay request completely before anything touches the chain. The target contract is never
 * taken from the request: the caller picks `instance`, and the server maps it to the deployed rail.
 */
export function parseRelayBody(body: unknown, ctx: ParseContext): ParseResult {
  try {
    const b = rec(body, "body");
    if (b["network"] !== ctx.network) return { ok: false, status: 400, error: `This relay serves ${ctx.network} only.` };
    const instance = b["instance"];
    if (typeof instance !== "string" || !(RAIL_INSTANCES as readonly string[]).includes(instance)) {
      return { ok: false, status: 400, error: '"instance" must be "prod" or "demo".' };
    }
    const inst = instance as RailInstance;
    const kind = b["kind"];
    const payload = rec(b["payload"], "payload");

    if (kind === "activate") {
      const offer = parseOffer(payload["offer"]);
      if (offer.timeScale !== TIME_SCALE[inst]) bad(`The offer's time scale ${offer.timeScale} is not the ${inst} rail's (${TIME_SCALE[inst]}).`);
      if (!ctx.tokens.some((t) => t.toLowerCase() === offer.token.toLowerCase())) bad("The offer names a token this rail does not accept.");
      const acc = rec(payload["acceptance"], "acceptance");
      return {
        ok: true,
        instance: inst,
        req: {
          kind,
          offer,
          offerSig: hex(payload["offerSig"], "offerSig"),
          acceptance: { offerHash: hex(acc["offerHash"], "acceptance.offerHash", 32), debtor: addr(acc["debtor"], "acceptance.debtor"), deadline: big(acc["deadline"], "acceptance.deadline", 64) },
          debtorSig: hex(payload["debtorSig"], "debtorSig"),
          permit: payload["permit"] === undefined || payload["permit"] === null ? undefined : parsePermit(payload["permit"]),
        },
      };
    }
    if (kind === "action") {
      const a = rec(payload["action"], "action");
      const k = int(a["kind"], "action.kind", 8);
      if (k > 2) bad('"action.kind" must be 0, 1 or 2.');
      return {
        ok: true,
        instance: inst,
        req: {
          kind,
          action: { kind: k, target: hex(a["target"], "action.target", 32), nonce: big(a["nonce"], "action.nonce", 256), deadline: big(a["deadline"], "action.deadline", 64) },
          debtor: addr(payload["debtor"], "debtor"),
          sig: hex(payload["sig"], "sig"),
        },
      };
    }
    return { ok: false, status: 400, error: '"kind" must be "activate" or "action".' };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, status: 400, error: e.message };
    throw e;
  }
}

export interface RelayDeps {
  network: RailNetwork;
  tokens: Address[];
  /** False when no relayer key is set: the function stays inert. */
  configured: boolean;
  kv: Kv;
  ip: string;
  nowMs: number;
  limits?: RelayLimits;
  /** Dry-runs the call from the relayer. Must throw (with revert data) if it would revert. */
  simulate: (instance: RailInstance, req: RelayRequest) => Promise<void>;
  /** Signs and sends. Returns the transaction hash. */
  send: (instance: RailInstance, req: RelayRequest) => Promise<Hex>;
}

export interface RelayResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** The whole relay decision, with the chain and the clock injected so every branch can be tested. */
export async function handleRelay(body: unknown, deps: RelayDeps): Promise<RelayResponse> {
  if (!deps.configured) {
    return { status: 503, body: { error: "The relay is not configured on this server.", code: "RelayNotConfigured" } };
  }
  const parsed = parseRelayBody(body, { network: deps.network, tokens: deps.tokens });
  if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } };

  // 1. simulate first: a call that would revert is refused with the contract's own error and costs nothing.
  try {
    await deps.simulate(parsed.instance, parsed.req);
  } catch (e) {
    const d = decodeRailError(e);
    if (d.name === "UnknownError") {
      return { status: 502, body: { error: "Could not simulate the call against the chain. Nothing was sent.", code: "SimulationUnavailable" } };
    }
    return { status: 422, body: { error: d.message, refusal: { name: d.name, code: d.code, message: d.message } } };
  }

  // 2. only now spend an allowance slot
  const slot = await takeRelaySlot(deps.kv, deps.ip, deps.nowMs, deps.limits);
  if (!slot.ok) {
    return {
      status: 429,
      body: {
        error: slot.reason === "ip" ? "Daily limit for this address reached. Submit it from your own wallet instead." : "The relay's daily limit is reached. Submit it from your own wallet instead.",
        limit: slot.reason,
        max: slot.limit,
        retryAfterSeconds: slot.retryAfterSeconds,
      },
      headers: { "retry-after": String(slot.retryAfterSeconds) },
    };
  }

  // 3. send
  try {
    const txHash = await deps.send(parsed.instance, parsed.req);
    return { status: 200, body: { txHash } };
  } catch (e) {
    const d = decodeRailError(e);
    if (d.name !== "UnknownError") {
      return { status: 422, body: { error: d.message, refusal: { name: d.name, code: d.code, message: d.message } } };
    }
    return { status: 502, body: { error: "The relay could not send the transaction.", code: "SendFailed" } };
  }
}
