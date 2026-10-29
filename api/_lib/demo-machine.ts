import type { Hex } from "viem";

/** The four things a visitor does, in order. */
export type DemoStep = "start" | "prenotify" | "collect" | "refund";
export const DEMO_STEPS: readonly DemoStep[] = ["start", "prenotify", "collect", "refund"];

export type DemoPhase = "started" | "prenotified" | "collected" | "refunded" | "expired" | "failed";

/** 0.02 EURC (6 decimals): what every demo debit moves. The refund returns it to the house debtor. */
export const DEMO_AMOUNT = 20_000n;
/** A run that has not finished this long after it began is abandoned and may be replaced. */
export const RUN_STALE_SECONDS = 20 * 60;

export interface DemoRun {
  id: string;
  phase: DemoPhase;
  /** Unix seconds. */
  createdAt: number;
  mandateId?: Hex;
  collectionId?: Hex;
  e2eId?: Hex;
  /** Unix seconds the collection is due. */
  dueAt?: number;
  /** Unix seconds it settled. */
  settledAt?: number;
  /** Scaled refund window in seconds, captured when collected. */
  refundWindow?: number;
  txs: Partial<Record<DemoStep, Hex>>;
  /** Server-side secret handed to whoever started the run; later steps must present it. Never sent back. */
  token?: string;
}

export type Guard =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; retryAfterSeconds?: number };

const live = (run: DemoRun | null): run is DemoRun => run !== null && (run.phase === "started" || run.phase === "prenotified" || run.phase === "collected");

/** Is a run still in progress (and not abandoned)? */
export function isActive(run: DemoRun | null, nowSec: number): boolean {
  return live(run) && nowSec - run.createdAt < RUN_STALE_SECONDS;
}

/** The refund window has run out for a collected run. */
export function refundWindowClosed(run: DemoRun, nowSec: number): boolean {
  return run.phase === "collected" && run.settledAt !== undefined && run.refundWindow !== undefined && nowSec >= run.settledAt + run.refundWindow;
}

/**
 * May `step` run now? Pure: state and the clock come in, a verdict goes out. The server never sends a
 * transaction that this refuses, so the visitor gets an explanation instead of a wasted tx.
 */
export function canRun(run: DemoRun | null, step: DemoStep, nowSec: number): Guard {
  if (step === "start") {
    if (isActive(run, nowSec)) {
      return { ok: false, status: 409, code: "RunInProgress", message: "A demo run is already in progress. Finish it, or wait for it to time out." };
    }
    return { ok: true };
  }
  if (!run || !live(run) || !isActive(run, nowSec)) {
    return { ok: false, status: 409, code: "NoActiveRun", message: "There is no active demo run. Start one first." };
  }
  switch (step) {
    case "prenotify":
      return run.phase === "started"
        ? { ok: true }
        : { ok: false, status: 409, code: "WrongStep", message: `Pre-notify comes right after signing. This run is at "${run.phase}".` };
    case "collect": {
      if (run.phase !== "prenotified" || run.dueAt === undefined) {
        return { ok: false, status: 409, code: "WrongStep", message: `Collect needs a pre-notified debit. This run is at "${run.phase}".` };
      }
      if (nowSec < run.dueAt) {
        return {
          ok: false,
          status: 409,
          code: "TooEarly",
          message: `The debit is not due yet. It was announced and must wait out its notice.`,
          retryAfterSeconds: run.dueAt - nowSec,
        };
      }
      return { ok: true };
    }
    case "refund": {
      if (run.phase !== "collected") {
        return { ok: false, status: 409, code: "WrongStep", message: `Refund needs a collected debit. This run is at "${run.phase}".` };
      }
      if (refundWindowClosed(run, nowSec)) {
        return { ok: false, status: 409, code: "RefundWindowClosed", message: "The refund window has closed, so this debit can no longer be taken back." };
      }
      return { ok: true };
    }
  }
}

export interface StepResult {
  mandateId?: Hex;
  collectionId?: Hex;
  e2eId?: Hex;
  dueAt?: number;
  settledAt?: number;
  refundWindow?: number;
  txHash: Hex;
}

function need(run: DemoRun | null): DemoRun {
  if (!run) throw new Error("applyStep: no run to advance");
  return run;
}

/** The run after `step` succeeded. Never mutates. */
export function applyStep(run: DemoRun | null, step: DemoStep, result: StepResult, newRunId: string, nowSec: number): DemoRun {
  switch (step) {
    case "start":
      return { id: newRunId, phase: "started", createdAt: nowSec, mandateId: result.mandateId, txs: { start: result.txHash } };
    case "prenotify": {
      const r = need(run);
      return { ...r, phase: "prenotified", collectionId: result.collectionId, e2eId: result.e2eId, dueAt: result.dueAt, txs: { ...r.txs, prenotify: result.txHash } };
    }
    case "collect": {
      const r = need(run);
      return { ...r, phase: "collected", settledAt: result.settledAt, refundWindow: result.refundWindow, txs: { ...r.txs, collect: result.txHash } };
    }
    case "refund": {
      const r = need(run);
      return { ...r, phase: "refunded", txs: { ...r.txs, refund: result.txHash } };
    }
  }
}

/** A run that ran out of road is closed so the next visitor can start. */
export function settleExpiry(run: DemoRun | null, nowSec: number): DemoRun | null {
  if (!run) return run;
  if (live(run) && nowSec - run.createdAt >= RUN_STALE_SECONDS) return { ...run, phase: "failed" };
  if (refundWindowClosed(run, nowSec)) return { ...run, phase: "expired" };
  return run;
}

export function isFinished(run: DemoRun | null): boolean {
  return run !== null && (run.phase === "refunded" || run.phase === "expired" || run.phase === "failed");
}

export interface Countdowns {
  /** Seconds until the announced debit is due (0 once due). */
  noticeLeft: number | null;
  /** Seconds until the refund window closes (0 once closed). */
  refundLeft: number | null;
}

export function countdowns(run: DemoRun | null, nowSec: number): Countdowns {
  if (!run) return { noticeLeft: null, refundLeft: null };
  const noticeLeft = run.dueAt !== undefined && (run.phase === "prenotified" || run.phase === "started") ? Math.max(0, run.dueAt - nowSec) : null;
  const refundLeft =
    run.phase === "collected" && run.settledAt !== undefined && run.refundWindow !== undefined ? Math.max(0, run.settledAt + run.refundWindow - nowSec) : null;
  return { noticeLeft, refundLeft };
}

/** What the page should offer next. */
export function nextStep(run: DemoRun | null): DemoStep | null {
  if (!run || isFinished(run)) return "start";
  switch (run.phase) {
    case "started":
      return "prenotify";
    case "prenotified":
      return "collect";
    case "collected":
      return "refund";
    default:
      return "start";
  }
}
