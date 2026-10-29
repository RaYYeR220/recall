import { encodeFunctionData, type Hex } from "viem";
import { debitRailAbi, MandateStatus, networkInfo, txUrl, type RailNetwork } from "@recall/sdk";
import { publicClientFor, railAddress, railFor, refusalOf, type Refusal } from "./chain";
import { demoContext, houseCreditorId, type DemoContext, type Reply } from "./demo";
import { isProvokeCase, PROVOKE_CASES, recordedRefusal, type ProvokeCase } from "./provoke";
import type { DemoRun } from "./demo-machine";
import type { Kv } from "./kv";
import { configuredNetwork } from "./env";

type Source = "live" | "replayed" | "recorded";

interface Attempt {
  source: Source;
  refusal: Refusal | null;
  note: string;
}

/** Runs a call that is expected to revert and reports the contract's own error, or null if it did not revert. */
async function expectRefusal(network: RailNetwork, call: { account: Hex; to: Hex; data: Hex; value?: bigint }): Promise<Refusal | null> {
  try {
    await publicClientFor(network).call(call);
    return null;
  } catch (e) {
    return refusalOf(e);
  }
}

/** Re-runs the exact calldata of a recorded mainnet refusal against the chain as it is now. */
async function replay(network: RailNetwork, hash: Hex): Promise<Attempt> {
  try {
    const tx = await publicClientFor(network).getTransaction({ hash });
    if (!tx.to) return { source: "recorded", refusal: null, note: "The recorded transaction is a contract creation, so it cannot be replayed." };
    const refusal = await expectRefusal(network, { account: tx.from, to: tx.to, data: tx.input, value: tx.value });
    return {
      source: "replayed",
      refusal,
      note: refusal
        ? "Replayed: the exact recorded call, run again against the chain as it is now."
        : "Replayed against the chain as it is now, the recorded call no longer reverts: the state it was refused in has moved on.",
    };
  } catch {
    return { source: "recorded", refusal: null, note: "The chain could not be reached to replay it. The recorded transaction below is the proof." };
  }
}

async function activeMandate(ctx: DemoContext, creditorId: bigint, kv: Kv): Promise<{ id: Hex; maxPerCollection: bigint } | null> {
  const rail = railFor(ctx.network, "demo");
  const raw = await kv.get("demo:run");
  if (raw) {
    try {
      const run = JSON.parse(raw) as DemoRun;
      if (run.mandateId) {
        const m = await rail.getMandate(run.mandateId);
        if (m.status === MandateStatus.ACTIVE) return { id: run.mandateId, maxPerCollection: m.maxPerCollection };
      }
    } catch {
      /* fall through to the lens */
    }
  }
  const { views } = await rail.creditorView(creditorId, 0, 0);
  const v = [...views].reverse().find((x) => x.mandate.status === MandateStatus.ACTIVE);
  return v ? { id: v.id, maxPerCollection: v.mandate.maxPerCollection } : null;
}

async function attempt(c: ProvokeCase, kv: Kv, network: RailNetwork, recordedHash: Hex | null): Promise<Attempt> {
  const env = demoContext();
  const rail = railAddress(network, "demo").rail;
  // The ledger is recorded on Arc mainnet, so it can only be replayed there.
  const fallback = async (): Promise<Attempt> =>
    recordedHash && network === "arc"
      ? replay(network, recordedHash)
      : { source: "recorded", refusal: null, note: "The recorded refusal below is on Arc mainnet; this server is not replaying it." };

  if (!env.ok) return fallback();
  const ctx = env.ctx;
  const nowSec = Number((await publicClientFor(network).getBlock()).timestamp);

  if (c === "withdraw-locked-reserve") {
    const creditorId = await houseCreditorId(ctx);
    if (creditorId === null) return fallback();
    const cov = await railFor(network, "demo").coverage(creditorId);
    const free = cov.eurc.reserveTotal - cov.eurc.reserveLocked;
    const data = encodeFunctionData({ abi: debitRailAbi, functionName: "withdrawReserve", args: [creditorId, networkInfo(network).eurc.address, free + 1n, ctx.creditor.address] });
    const refusal = await expectRefusal(network, { account: ctx.creditor.address, to: rail, data });
    return { source: "live", refusal, note: `Simulated now: the house creditor asks for ${free + 1n} base units when only ${free} are free.` };
  }

  if (c === "over-cap") {
    const creditorId = await houseCreditorId(ctx);
    const m = creditorId === null ? null : await activeMandate(ctx, creditorId, kv);
    if (!m) return fallback();
    const data = encodeFunctionData({
      abi: debitRailAbi,
      functionName: "prenotify",
      args: [m.id, m.maxPerCollection + 1n, BigInt(nowSec + 100_000), `0x${"ab".repeat(32)}`, "Recall demo: over the cap"],
    });
    const refusal = await expectRefusal(network, { account: ctx.creditor.address, to: rail, data });
    return { source: "live", refusal, note: "Simulated now: a pre-notification one base unit above the mandate's per-debit cap." };
  }

  if (c === "collect-too-early") {
    const raw = await kv.get("demo:run");
    let run: DemoRun | null = null;
    try {
      run = raw ? (JSON.parse(raw) as DemoRun) : null;
    } catch {
      run = null;
    }
    if (run && run.phase === "prenotified" && run.collectionId && run.dueAt !== undefined && nowSec < run.dueAt) {
      const data = encodeFunctionData({ abi: debitRailAbi, functionName: "collect", args: [run.collectionId] });
      const refusal = await expectRefusal(network, { account: ctx.relayer.address, to: rail, data });
      return { source: "live", refusal, note: `Simulated now against the debit in your run, ${run.dueAt - nowSec}s before it is due.` };
    }
    return {
      source: "recorded",
      refusal: null,
      note: "No debit is waiting out its notice right now. Pre-notify in the stepper, then press this again to see it refused live. The recorded mainnet refusal is below.",
    };
  }

  // refund-after-window, refund-b2b, prenotify-revoked need a state we do not create on demand: replay the real one.
  return fallback();
}

export async function provoke(body: unknown, kv: Kv): Promise<Reply> {
  const c = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["case"] : undefined;
  if (!isProvokeCase(c)) {
    return { status: 400, body: { error: `"case" must be one of: ${Object.keys(PROVOKE_CASES).join(", ")}.`, code: "UnknownCase" } };
  }
  const network = configuredNetwork();
  const rec = recordedRefusal(c);
  const expected = PROVOKE_CASES[c].expect;
  const a = await attempt(c, kv, network, rec ? (rec.hash as Hex) : null);
  if (a.source === "replayed" && a.refusal && a.refusal.name !== expected) {
    a.note = `Replayed against the chain as it is now. The state the original call was refused in has moved on, so the contract now answers ${a.refusal.name}. The recorded refusal below is the original.`;
  }
  return {
    status: 200,
    body: {
      case: c,
      label: PROVOKE_CASES[c].label,
      expected,
      source: a.source,
      refusal: a.refusal,
      reproduced: a.refusal !== null && a.refusal.name === expected,
      note: a.note,
      recorded: rec ? { label: rec.label, rail: rec.rail, error: rec.error, txHash: rec.hash, explorerUrl: txUrl("arc", rec.hash) } : null,
    },
  };
}
