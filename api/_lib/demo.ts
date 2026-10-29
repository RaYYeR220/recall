import type { Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  debitRailAbi,
  CollectionStatus,
  mandateTextForOffer,
  networkInfo,
  refToBytes32,
  Scheme,
  termsHash,
  TIME_SCALE,
  txUrl,
  type MandateOffer,
  type RailNetwork,
} from "@recall/sdk";
import { publicClientFor, railAddress, railFor, refusalOf, toTxResult } from "./chain";
import {
  applyStep,
  canRun,
  countdowns,
  DEMO_AMOUNT,
  isActive,
  isFinished,
  nextStep,
  settleExpiry,
  type DemoRun,
  type DemoStep,
  type Guard,
} from "./demo-machine";
import { accountFromEnv, configuredNetwork, ENV_NAMES, missingEnv } from "./env";
import type { Kv } from "./kv";
import {
  acquireDemoLock,
  dayKey,
  DEMO_RUNS_PER_DAY,
  releaseDemoLock,
  takeDemoRun,
  touchDemoLock,
} from "./limits";
import { safeEqual } from "./http";

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

const RUN_KEY = "demo:run";
const DAY = 86_400;
const REQUIRED_ENV = [ENV_NAMES.demoCreditorKey, ENV_NAMES.demoDebtorKey, ENV_NAMES.relayerKey];

export interface DemoContext {
  network: RailNetwork;
  creditor: PrivateKeyAccount;
  debtor: PrivateKeyAccount;
  relayer: PrivateKeyAccount;
}

export function demoContext(): { ok: true; ctx: DemoContext } | { ok: false; missing: string[] } {
  const missing = missingEnv(REQUIRED_ENV);
  const creditor = accountFromEnv(ENV_NAMES.demoCreditorKey);
  const debtor = accountFromEnv(ENV_NAMES.demoDebtorKey);
  const relayer = accountFromEnv(ENV_NAMES.relayerKey);
  if (missing.length > 0 || !creditor || !debtor || !relayer) return { ok: false, missing };
  return { ok: true, ctx: { network: configuredNetwork(), creditor, debtor, relayer } };
}

export const notConfigured = (missing: string[]): Reply => ({
  status: 503,
  body: { error: "The live demo is not configured on this server.", code: "DemoNotConfigured", missing },
});

const fromGuard = (g: Extract<Guard, { ok: false }>): Reply => ({
  status: g.status,
  body: { error: g.message, code: g.code, ...(g.retryAfterSeconds !== undefined ? { retryAfterSeconds: g.retryAfterSeconds } : {}) },
});

// ── state ────────────────────────────────────────────────────────────────────

async function loadRun(kv: Kv): Promise<DemoRun | null> {
  const raw = await kv.get(RUN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DemoRun;
  } catch {
    return null;
  }
}

async function saveRun(kv: Kv, run: DemoRun): Promise<void> {
  await kv.set(RUN_KEY, JSON.stringify(run), DAY);
}

async function chainNow(network: RailNetwork): Promise<number> {
  return Number((await publicClientFor(network).getBlock()).timestamp);
}

const creditorIds = new Map<string, bigint>();

/** The house creditor's id on the demo rail: the registered creditor whose owner is the demo creditor key. */
export async function houseCreditorId(ctx: DemoContext): Promise<bigint | null> {
  const cacheKey = `${ctx.network}:${ctx.creditor.address}`;
  const cached = creditorIds.get(cacheKey);
  if (cached) return cached;
  const pc = publicClientFor(ctx.network);
  const rail = railAddress(ctx.network, "demo").rail;
  const count = await pc.readContract({ address: rail, abi: debitRailAbi, functionName: "creditorCount" });
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i + 1));
  const rows = await Promise.all(ids.map((id) => pc.readContract({ address: rail, abi: debitRailAbi, functionName: "getCreditor", args: [id] })));
  const idx = rows.findIndex((c) => c.owner.toLowerCase() === ctx.creditor.address.toLowerCase());
  const id = idx >= 0 ? ids[idx] : undefined;
  if (id) creditorIds.set(cacheKey, id);
  return id ?? null;
}

async function readiness(ctx: DemoContext, creditorId: bigint | null): Promise<string[]> {
  const pc = publicClientFor(ctx.network);
  const info = networkInfo(ctx.network);
  const problems: string[] = [];
  if (creditorId === null) {
    problems.push("The demo creditor key is not registered as a creditor on the demo rail.");
    return problems;
  }
  const rail = railFor(ctx.network, "demo");
  const [cov, debtorBal, relayerGas, creditorGas] = await Promise.all([
    rail.coverage(creditorId),
    pc.readContract({ address: info.eurc.address, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [ctx.debtor.address] }),
    pc.getBalance({ address: ctx.relayer.address }),
    pc.getBalance({ address: ctx.creditor.address }),
  ]);
  const free = cov.eurc.reserveTotal - cov.eurc.reserveLocked;
  if (free < DEMO_AMOUNT) problems.push("The demo creditor's free EURC reserve is below 0.02 EURC.");
  if (debtorBal < DEMO_AMOUNT) problems.push("The demo payer holds less than 0.02 EURC.");
  if (relayerGas === 0n) problems.push("The relayer wallet has no gas.");
  if (creditorGas === 0n) problems.push("The demo creditor wallet has no gas.");
  return problems;
}

// ── steps ────────────────────────────────────────────────────────────────────

function publicRun(run: DemoRun, network: RailNetwork) {
  const { token: _token, ...rest } = run;
  void _token;
  const links: Record<string, string> = {};
  for (const [k, h] of Object.entries(run.txs)) links[k] = txUrl(network, h);
  return { ...rest, explorer: links };
}

export async function stepStart(ctx: DemoContext, kv: Kv, nowMs: number): Promise<Reply> {
  const network = ctx.network;
  const nowSec = await chainNow(network);
  const current = settleExpiry(await loadRun(kv), nowSec);
  const guard = canRun(current, "start", nowSec);
  if (!guard.ok) return fromGuard(guard);

  const creditorId = await houseCreditorId(ctx);
  const problems = await readiness(ctx, creditorId);
  if (problems.length > 0 || creditorId === null) {
    return { status: 503, body: { error: "The live demo is not ready.", code: "NotReady", problems } };
  }

  const runId = crypto.randomUUID().slice(0, 8);
  const lock = await acquireDemoLock(kv, runId, nowMs);
  if (!lock.ok) {
    return { status: 409, body: { error: "Another visitor is running the demo right now. Try again in a minute.", code: "Busy" } };
  }
  const cap = await takeDemoRun(kv, nowMs);
  if (!cap.ok) {
    await releaseDemoLock(kv, runId);
    return { status: 429, body: { error: `The demo has reached today's limit of ${DEMO_RUNS_PER_DAY} runs. It resets at 00:00 UTC.`, code: "DailyLimit", retryAfterSeconds: cap.retryAfterSeconds } };
  }

  try {
    const info = networkInfo(network);
    const creditorRail = railFor(network, "demo", ctx.creditor);
    const debtorRail = railFor(network, "demo", ctx.debtor);
    const relayerRail = railFor(network, "demo", ctx.relayer);
    const ts = BigInt(nowSec);
    const base: MandateOffer = {
      creditorId,
      token: info.eurc.address,
      scheme: Scheme.CORE,
      oneOff: false,
      maxPerCollection: 50_000n,
      maxPerPeriod: 100_000n,
      periodLength: 30 * 86_400,
      prenoticeLength: 14 * 86_400,
      offerRef: refToBytes32(`DEMO-${runId}`),
      termsHash: `0x${"00".repeat(32)}`,
      maxUses: 1,
      validUntil: ts + 3_600n,
      timeScale: TIME_SCALE.demo,
      debtor: ctx.debtor.address,
    };
    const name = (await publicClientFor(network).readContract({ address: railAddress(network, "demo").rail, abi: debitRailAbi, functionName: "getCreditor", args: [creditorId] })).name;
    const terms = mandateTextForOffer(base, { creditorName: name, network, instance: "demo", rail: railAddress(network, "demo").rail, token: "EURC" });
    const offer: MandateOffer = { ...base, termsHash: termsHash(terms) };

    const offerSig = await creditorRail.signOffer(offer);
    const deadline = ts + 3_600n;
    const { acceptance, sig } = await debtorRail.signAcceptance(offer, { deadline });
    const permit = await debtorRail.signPermit(offer.token, 50_000n, deadline);
    const hash = await relayerRail.activate(offer, offerSig, acceptance, sig, permit);
    const tx = await toTxResult(network, "demo", hash);
    const mandateId = await relayerRail.mandateId(offer, ctx.debtor.address);

    const token = crypto.randomUUID();
    const run = { ...applyStep(null, "start", { mandateId, txHash: hash }, runId, nowSec), token };
    await saveRun(kv, run);
    return { status: 200, body: { step: "start", runId, runToken: token, tx, run: publicRun(run, network), runsToday: cap.runsToday, runsPerDay: DEMO_RUNS_PER_DAY } };
  } catch (e) {
    await releaseDemoLock(kv, runId);
    return failure(e);
  }
}

function failure(e: unknown): Reply {
  const r = refusalOf(e);
  if (r.name !== "UnknownError") return { status: 422, body: { error: r.message, refusal: r } };
  return { status: 502, body: { error: "The chain did not accept that. Nothing changed.", code: "ChainError" } };
}

/** Looks up the caller's run, or explains why they cannot act on it. */
async function authorise(kv: Kv, runId: unknown, token: unknown, step: DemoStep, nowSec: number): Promise<{ run: DemoRun } | { reply: Reply }> {
  const run = settleExpiry(await loadRun(kv), nowSec);
  if (run && (run.phase === "expired" || run.phase === "failed")) await finish(kv, run);
  if (!run || typeof runId !== "string" || run.id !== runId || typeof token !== "string" || !run.token || !safeEqual(run.token, token)) {
    return { reply: { status: 403, body: { error: "This is not your run. Start your own.", code: "NotYourRun" } } };
  }
  const guard = canRun(run, step, nowSec);
  if (!guard.ok) return { reply: fromGuard(guard) };
  return { run };
}

async function finish(kv: Kv, run: DemoRun): Promise<void> {
  await saveRun(kv, run);
  await releaseDemoLock(kv, run.id);
}

export async function stepPrenotify(ctx: DemoContext, kv: Kv, input: { runId?: unknown; token?: unknown }): Promise<Reply> {
  const network = ctx.network;
  const nowSec = await chainNow(network);
  const auth = await authorise(kv, input.runId, input.token, "prenotify", nowSec);
  if ("reply" in auth) return auth.reply;
  const { run } = auth;
  try {
    const pc = publicClientFor(network);
    const mandate = await pc.readContract({ address: railAddress(network, "demo").rail, abi: debitRailAbi, functionName: "getMandate", args: [run.mandateId as Hex] });
    const notice = Math.floor(mandate.prenoticeLength / TIME_SCALE.demo);
    const dueAt = nowSec + notice + 20;
    const e2eId = refToBytes32(`E2E-${run.id}`);
    const creditorRail = railFor(network, "demo", ctx.creditor);
    const hash = await creditorRail.prenotify(run.mandateId as Hex, DEMO_AMOUNT, BigInt(dueAt), e2eId, `Recall demo ${run.id}: 0.02 EURC`);
    const tx = await toTxResult(network, "demo", hash);
    const collectionId = creditorRail.collectionId(run.mandateId as Hex, e2eId);
    const next = { ...applyStep(run, "prenotify", { collectionId, e2eId, dueAt, txHash: hash }, run.id, nowSec), token: run.token };
    await saveRun(kv, next);
    await touchDemoLock(kv, run.id);
    return { status: 200, body: { step: "prenotify", tx, run: publicRun(next, network), countdowns: countdowns(next, nowSec), noticeSeconds: notice } };
  } catch (e) {
    return failure(e);
  }
}

export async function stepCollect(ctx: DemoContext, kv: Kv, input: { runId?: unknown; token?: unknown }): Promise<Reply> {
  const network = ctx.network;
  const nowSec = await chainNow(network);
  const auth = await authorise(kv, input.runId, input.token, "collect", nowSec);
  if ("reply" in auth) return auth.reply;
  const { run } = auth;
  try {
    const relayerRail = railFor(network, "demo", ctx.relayer);
    const hash = await relayerRail.collect(run.collectionId as Hex);
    const tx = await toTxResult(network, "demo", hash);
    const col = await relayerRail.getCollection(run.collectionId as Hex);
    if (col.status !== CollectionStatus.SETTLED) {
      // e.g. RETURNED (AM04): the debit did not settle, so there is nothing to refund. End the run.
      const ended = { ...run, phase: "failed" as const, txs: { ...run.txs, collect: hash } };
      await finish(kv, ended);
      return { status: 200, body: { step: "collect", tx, outcome: "not-settled", collectionStatus: col.status, run: publicRun(ended, network) } };
    }
    const w = await relayerRail.windows();
    const next = { ...applyStep(run, "collect", { settledAt: Number(col.settledAt), refundWindow: Number(w.refundWindow), txHash: hash }, run.id, nowSec), token: run.token };
    await saveRun(kv, next);
    await touchDemoLock(kv, run.id);
    return { status: 200, body: { step: "collect", tx, outcome: "settled", run: publicRun(next, network), countdowns: countdowns(next, Number(col.settledAt)), refundWindow: Number(w.refundWindow) } };
  } catch (e) {
    return failure(e);
  }
}

export async function stepRefund(ctx: DemoContext, kv: Kv, input: { runId?: unknown; token?: unknown }): Promise<Reply> {
  const network = ctx.network;
  const nowSec = await chainNow(network);
  const auth = await authorise(kv, input.runId, input.token, "refund", nowSec);
  if ("reply" in auth) return auth.reply;
  const { run } = auth;
  try {
    const debtorRail = railFor(network, "demo", ctx.debtor);
    const relayerRail = railFor(network, "demo", ctx.relayer);
    const signed = await debtorRail.signDebtorAction("REFUND", run.collectionId as Hex);
    const hash = await relayerRail.executeDebtorAction(signed.action, signed.debtor, signed.sig);
    const tx = await toTxResult(network, "demo", hash);
    const next = applyStep(run, "refund", { txHash: hash }, run.id, nowSec);
    await finish(kv, next);
    return { status: 200, body: { step: "refund", tx, run: publicRun(next, network), refunded: true, note: "The money went back to the house payer. This run only cost gas." } };
  } catch (e) {
    return failure(e);
  }
}

export async function stepStatus(kv: Kv, nowMs: number): Promise<Reply> {
  const network = configuredNetwork();
  const info = networkInfo(network);
  const rail = railAddress(network, "demo");
  const env = demoContext();
  const nowSec = await chainNow(network);
  const run = settleExpiry(await loadRun(kv), nowSec);
  if (run && (run.phase === "expired" || run.phase === "failed")) await finish(kv, run);
  const runsToday = Number((await kv.get(`demo:runs:${dayKey(nowMs)}`)) ?? "0");

  const base = {
    network,
    chainId: info.chainId,
    instance: "demo",
    rail: rail.rail,
    lens: rail.lens,
    timeScale: TIME_SCALE.demo,
    chainNow: nowSec,
    runsToday,
    runsPerDay: DEMO_RUNS_PER_DAY,
    run: run ? publicRun(run, network) : null,
    active: isActive(run, nowSec),
    next: nextStep(run),
    countdowns: countdowns(run, nowSec),
  };
  if (!env.ok) return { status: 200, body: { ...base, configured: false, missing: env.missing, ready: false, problems: [] } };

  const creditorId = await houseCreditorId(env.ctx);
  const problems = await readiness(env.ctx, creditorId);
  const w = await railFor(network, "demo").windows();
  return {
    status: 200,
    body: {
      ...base,
      configured: true,
      ready: problems.length === 0,
      problems,
      creditorId,
      houseCreditor: env.ctx.creditor.address,
      housePayer: env.ctx.debtor.address,
      windows: { refundWindow: Number(w.refundWindow), minPrenotice: Number(w.minPrenotice) },
      finished: isFinished(run),
    },
  };
}

