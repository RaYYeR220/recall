import { describe, expect, test } from "bun:test";
import {
  applyStep,
  canRun,
  countdowns,
  isActive,
  isFinished,
  nextStep,
  refundWindowClosed,
  RUN_STALE_SECONDS,
  settleExpiry,
  type DemoRun,
} from "../_lib/demo-machine";

const H = (n: string) => `0x${n.repeat(32)}` as const;
const T = 1_800_000_000;

function started(): DemoRun {
  return applyStep(null, "start", { mandateId: H("aa"), txHash: H("01") }, "run1", T);
}
function prenotified(due = T + 140): DemoRun {
  return applyStep(started(), "prenotify", { collectionId: H("bb"), e2eId: H("cc"), dueAt: due, txHash: H("02") }, "run1", T + 5);
}
function collected(settledAt = T + 150, window = 480): DemoRun {
  return applyStep(prenotified(), "collect", { settledAt, refundWindow: window, txHash: H("03") }, "run1", settledAt);
}

describe("the happy path", () => {
  test("start -> prenotify -> collect -> refund", () => {
    const s = started();
    expect(s.phase).toBe("started");
    expect(nextStep(s)).toBe("prenotify");
    const p = prenotified();
    expect(p.phase).toBe("prenotified");
    expect(p.collectionId).toBe(H("bb"));
    expect(nextStep(p)).toBe("collect");
    const c = collected();
    expect(c.phase).toBe("collected");
    expect(nextStep(c)).toBe("refund");
    const r = applyStep(c, "refund", { txHash: H("04") }, "run1", T + 200);
    expect(r.phase).toBe("refunded");
    expect(Object.keys(r.txs)).toEqual(["start", "prenotify", "collect", "refund"]);
    expect(isFinished(r)).toBe(true);
    expect(nextStep(r)).toBe("start");
  });

  test("applyStep never mutates the run it was given", () => {
    const s = started();
    const copy = JSON.stringify(s);
    applyStep(s, "prenotify", { collectionId: H("bb"), e2eId: H("cc"), dueAt: T + 100, txHash: H("02") }, "run1", T);
    expect(JSON.stringify(s)).toBe(copy);
  });
});

describe("what each step allows", () => {
  test("start is allowed with no run, after a finished run, and after a stale one", () => {
    expect(canRun(null, "start", T).ok).toBe(true);
    const done = applyStep(collected(), "refund", { txHash: H("04") }, "run1", T + 200);
    expect(canRun(done, "start", T + 201).ok).toBe(true);
    expect(canRun(started(), "start", T + RUN_STALE_SECONDS + 1).ok).toBe(true);
  });

  test("start is refused while a run is in progress", () => {
    const g = canRun(started(), "start", T + 30);
    expect(g).toMatchObject({ ok: false, status: 409, code: "RunInProgress" });
  });

  test("every other step needs an active run", () => {
    for (const step of ["prenotify", "collect", "refund"] as const) {
      expect(canRun(null, step, T)).toMatchObject({ ok: false, code: "NoActiveRun" });
    }
  });

  test("steps must come in order", () => {
    expect(canRun(started(), "prenotify", T + 1).ok).toBe(true);
    expect(canRun(started(), "collect", T + 1)).toMatchObject({ ok: false, code: "WrongStep" });
    expect(canRun(started(), "refund", T + 1)).toMatchObject({ ok: false, code: "WrongStep" });
    expect(canRun(prenotified(), "prenotify", T + 10)).toMatchObject({ ok: false, code: "WrongStep" });
    expect(canRun(prenotified(T + 5), "refund", T + 10)).toMatchObject({ ok: false, code: "WrongStep" });
  });

  test("collect waits out the notice and says for how long", () => {
    const p = prenotified(T + 140);
    expect(canRun(p, "collect", T + 100)).toMatchObject({ ok: false, status: 409, code: "TooEarly", retryAfterSeconds: 40 });
    expect(canRun(p, "collect", T + 139)).toMatchObject({ ok: false, code: "TooEarly", retryAfterSeconds: 1 });
    expect(canRun(p, "collect", T + 140).ok).toBe(true);
    expect(canRun(p, "collect", T + 500).ok).toBe(true);
  });

  test("refund works inside the window and not after it", () => {
    const c = collected(T + 150, 480);
    expect(canRun(c, "refund", T + 150).ok).toBe(true);
    expect(canRun(c, "refund", T + 629).ok).toBe(true);
    expect(canRun(c, "refund", T + 630)).toMatchObject({ ok: false, code: "RefundWindowClosed" });
    expect(refundWindowClosed(c, T + 630)).toBe(true);
    expect(refundWindowClosed(c, T + 629)).toBe(false);
  });

  test("a refunded run accepts no further steps", () => {
    const done = applyStep(collected(), "refund", { txHash: H("04") }, "run1", T + 200);
    for (const step of ["prenotify", "collect", "refund"] as const) {
      expect(canRun(done, step, T + 210)).toMatchObject({ ok: false, code: "NoActiveRun" });
    }
  });
});

describe("expiry", () => {
  test("a run left idle past the stale limit is failed", () => {
    expect(isActive(started(), T + RUN_STALE_SECONDS - 1)).toBe(true);
    expect(isActive(started(), T + RUN_STALE_SECONDS)).toBe(false);
    expect(settleExpiry(started(), T + RUN_STALE_SECONDS)?.phase).toBe("failed");
  });

  test("a collected run whose refund window passed is expired", () => {
    expect(settleExpiry(collected(T + 150, 480), T + 629)?.phase).toBe("collected");
    expect(settleExpiry(collected(T + 150, 480), T + 630)?.phase).toBe("expired");
  });

  test("finished and empty runs are left alone", () => {
    expect(settleExpiry(null, T)).toBeNull();
    const done = applyStep(collected(), "refund", { txHash: H("04") }, "run1", T + 200);
    expect(settleExpiry(done, T + 99_999)?.phase).toBe("refunded");
  });
});

describe("countdowns", () => {
  test("notice counts down to the due time, then stops at 0", () => {
    const p = prenotified(T + 140);
    expect(countdowns(p, T + 100)).toEqual({ noticeLeft: 40, refundLeft: null });
    expect(countdowns(p, T + 500)).toEqual({ noticeLeft: 0, refundLeft: null });
  });

  test("refund window counts down from the settlement", () => {
    const c = collected(T + 150, 480);
    expect(countdowns(c, T + 150)).toEqual({ noticeLeft: null, refundLeft: 480 });
    expect(countdowns(c, T + 600)).toEqual({ noticeLeft: null, refundLeft: 30 });
    expect(countdowns(c, T + 9999).refundLeft).toBe(0);
  });

  test("no run, no clocks", () => {
    expect(countdowns(null, T)).toEqual({ noticeLeft: null, refundLeft: null });
  });
});
