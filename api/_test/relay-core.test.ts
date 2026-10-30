import { describe, expect, test } from "bun:test";
import type { Hex } from "viem";
import { encodeErrorResult } from "viem";
import { debitRailAbi } from "@recall/sdk";
import { memoryKv } from "../_lib/kv.js";
import { handleRelay, parseRelayBody, type RelayDeps } from "../_lib/relay-core.js";

const EURC = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
const USDC = "0x3600000000000000000000000000000000000000";
const H32 = `0x${"ab".repeat(32)}`;
const SIG = `0x${"cd".repeat(65)}`;
const DEBTOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const T0 = Date.UTC(2026, 9, 29, 10);

const offer = (over: Record<string, unknown> = {}) => ({
  creditorId: "1",
  token: EURC,
  scheme: 0,
  oneOff: false,
  maxPerCollection: "100000",
  maxPerPeriod: "200000",
  periodLength: 2592000,
  prenoticeLength: 1209600,
  offerRef: H32,
  termsHash: H32,
  maxUses: 1,
  validUntil: "1900000000",
  timeScale: 10080,
  debtor: DEBTOR,
  ...over,
});

const activate = (over: Record<string, unknown> = {}, instance = "demo") => ({
  network: "arc",
  instance,
  kind: "activate",
  payload: {
    offer: offer(over),
    offerSig: SIG,
    acceptance: { offerHash: H32, debtor: DEBTOR, deadline: "1900000000" },
    debtorSig: SIG,
    permit: { value: "50000", deadline: "1900000000", v: 27, r: H32, s: H32 },
  },
});

const action = {
  network: "arc",
  instance: "demo",
  kind: "action",
  payload: { action: { kind: 0, target: H32, nonce: "0", deadline: "1900000000" }, debtor: DEBTOR, sig: SIG },
};

const ctx = { network: "arc" as const, tokens: [EURC, USDC] as `0x${string}`[] };

function deps(over: Partial<RelayDeps> = {}): RelayDeps & { sent: number; simulated: number } {
  const state = { sent: 0, simulated: 0 };
  const d: RelayDeps = {
    network: "arc",
    tokens: ctx.tokens,
    configured: true,
    kv: memoryKv(() => T0),
    ip: "9.9.9.9",
    nowMs: T0,
    simulate: () => {
      state.simulated++;
      return Promise.resolve();
    },
    send: () => {
      state.sent++;
      return Promise.resolve(H32 as Hex);
    },
    ...over,
  };
  return Object.defineProperties(d, {
    sent: { get: () => state.sent },
    simulated: { get: () => state.simulated },
  }) as RelayDeps & { sent: number; simulated: number };
}

describe("parseRelayBody", () => {
  test("accepts a well-formed activate and a well-formed action", () => {
    const a = parseRelayBody(activate(), ctx);
    expect(a.ok && a.req.kind === "activate" && a.req.offer.maxPerCollection).toBe(100000n);
    const b = parseRelayBody(action, ctx);
    expect(b.ok && b.req.kind).toBe("action");
  });

  test("the rail is chosen by instance, never by the request", () => {
    // there is no field that could carry a target address, and unknown instances are refused
    expect(parseRelayBody({ ...activate(), instance: "0x1234" }, ctx)).toMatchObject({ ok: false, status: 400 });
    expect(parseRelayBody({ ...activate(), to: "0x000000000000000000000000000000000000dEaD" }, ctx).ok).toBe(true);
  });

  test("only the configured network", () => {
    expect(parseRelayBody({ ...activate(), network: "arc-testnet" }, ctx)).toMatchObject({ ok: false, status: 400 });
  });

  test("only activate and action; permit and others are refused", () => {
    expect(parseRelayBody({ ...action, kind: "permit" }, ctx)).toMatchObject({ ok: false, status: 400 });
    expect(parseRelayBody({ ...action, kind: "withdraw" }, ctx)).toMatchObject({ ok: false });
  });

  test("an offer for the wrong time scale is refused before any call", () => {
    expect(parseRelayBody(activate({ timeScale: 1 }), ctx)).toMatchObject({ ok: false });
    expect(parseRelayBody(activate({ timeScale: 10080 }, "prod"), ctx)).toMatchObject({ ok: false });
    expect(parseRelayBody(activate({ timeScale: 1 }, "prod"), ctx).ok).toBe(true);
  });

  test("an offer for a token other than EURC or USDC is refused", () => {
    expect(parseRelayBody(activate({ token: "0x000000000000000000000000000000000000dEaD" }), ctx)).toMatchObject({ ok: false });
  });

  test("malformed numbers, hex and addresses are refused", () => {
    for (const bad of [
      { maxPerCollection: "-1" },
      { maxPerCollection: (1n << 128n).toString() },
      { scheme: 2 },
      { oneOff: "yes" },
      { offerRef: "0x12" },
      { debtor: "nope" },
      { periodLength: 1.5 },
    ]) {
      expect(parseRelayBody(activate(bad), ctx).ok).toBe(false);
    }
    expect(parseRelayBody({ ...action, payload: { ...action.payload, sig: "zz" } }, ctx).ok).toBe(false);
    expect(parseRelayBody({ ...action, payload: { ...action.payload, action: { ...action.payload.action, kind: 3 } } }, ctx).ok).toBe(false);
    expect(parseRelayBody(null, ctx).ok).toBe(false);
    expect(parseRelayBody({ network: "arc", instance: "demo", kind: "activate" }, ctx).ok).toBe(false);
  });
});

describe("handleRelay", () => {
  test("inert without a relayer key", async () => {
    const d = deps({ configured: false });
    const r = await handleRelay(action, d);
    expect(r.status).toBe(503);
    expect(r.body["code"]).toBe("RelayNotConfigured");
    expect(d.simulated).toBe(0);
    expect(d.sent).toBe(0);
  });

  test("a good request is simulated, then sent", async () => {
    const d = deps();
    const r = await handleRelay(action, d);
    expect(r).toMatchObject({ status: 200, body: { txHash: H32 } });
    expect(d.simulated).toBe(1);
    expect(d.sent).toBe(1);
  });

  test("a request that would revert is refused with the decoded error and is not sent or counted", async () => {
    const data = encodeErrorResult({ abi: debitRailAbi, errorName: "BadNonce" });
    const d = deps({ simulate: () => Promise.reject(Object.assign(new Error("revert"), { data })) });
    const r = await handleRelay(action, d);
    expect(r.status).toBe(422);
    expect(r.body["refusal"]).toMatchObject({ name: "BadNonce" });
    expect(d.sent).toBe(0);
    expect(await d.kv.get("relay:global:2026-10-29")).toBeNull();
  });

  test("an ISO-coded refusal carries its code", async () => {
    const data = encodeErrorResult({ abi: debitRailAbi, errorName: "MD01_NoValidMandate" });
    const d = deps({ simulate: () => Promise.reject(Object.assign(new Error("revert"), { data })) });
    const r = await handleRelay(action, d);
    expect(r.body["refusal"]).toMatchObject({ name: "MD01_NoValidMandate", code: "MD01" });
  });

  test("an RPC failure during simulation sends nothing", async () => {
    const d = deps({ simulate: () => Promise.reject(new Error("fetch failed")) });
    const r = await handleRelay(action, d);
    expect(r.status).toBe(502);
    expect(d.sent).toBe(0);
  });

  test("the 21st request from one IP in a day is 429 and not sent", async () => {
    const kv = memoryKv(() => T0);
    let sent = 0;
    const mk = () => deps({ kv, send: () => (sent++, Promise.resolve(H32 as Hex)) });
    for (let i = 0; i < 20; i++) expect((await handleRelay(action, mk())).status).toBe(200);
    const r = await handleRelay(action, mk());
    expect(r.status).toBe(429);
    expect(r.body["limit"]).toBe("ip");
    expect(r.headers?.["retry-after"]).toBeDefined();
    expect(sent).toBe(20);
  });

  test("the global cap of 200 applies across IPs", async () => {
    const kv = memoryKv(() => T0);
    let n = 0;
    for (let ip = 0; ip < 20; ip++) {
      for (let i = 0; i < 10; i++) {
        n++;
        expect((await handleRelay(action, deps({ kv, ip: `5.5.5.${ip}` }))).status).toBe(200);
      }
    }
    expect(n).toBe(200);
    const r = await handleRelay(action, deps({ kv, ip: "7.7.7.7" }));
    expect(r.status).toBe(429);
    expect(r.body["limit"]).toBe("global");
  });

  test("a validation failure uses no allowance", async () => {
    const kv = memoryKv(() => T0);
    const r = await handleRelay({ ...action, kind: "nope" }, deps({ kv }));
    expect(r.status).toBe(400);
    expect(await kv.get("relay:global:2026-10-29")).toBeNull();
  });
});
