import type { Kv } from "./kv";

export const DAY_SECONDS = 86_400;

export interface RelayLimits {
  perIpPerDay: number;
  globalPerDay: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = { perIpPerDay: 20, globalPerDay: 200 };
export const DEMO_RUNS_PER_DAY = 40;

/** The UTC day a timestamp falls in, as `YYYY-MM-DD`. Counters are keyed by it so they reset at 00:00 UTC. */
export function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Seconds from `nowMs` to the next 00:00 UTC (the longest a daily counter needs to live). */
export function secondsUntilNextDay(nowMs: number): number {
  const d = new Date(nowMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

export type LimitDecision =
  | { ok: true; ipCount: number; globalCount: number }
  | { ok: false; reason: "ip" | "global"; limit: number; retryAfterSeconds: number };

/**
 * Per-IP and global daily caps for the relay. Counts only requests that are actually going to be sent
 * (the caller checks the simulation first), and checks the global cap first so a refused request never
 * burns an IP's allowance.
 */
export async function takeRelaySlot(
  kv: Kv,
  ip: string,
  nowMs: number,
  limits: RelayLimits = DEFAULT_RELAY_LIMITS,
): Promise<LimitDecision> {
  const day = dayKey(nowMs);
  const ttl = secondsUntilNextDay(nowMs);
  const globalCount = await kv.incr(`relay:global:${day}`, ttl);
  if (globalCount > limits.globalPerDay) {
    return { ok: false, reason: "global", limit: limits.globalPerDay, retryAfterSeconds: ttl };
  }
  const ipCount = await kv.incr(`relay:ip:${day}:${ip}`, ttl);
  if (ipCount > limits.perIpPerDay) {
    // give the global slot back: this request will not be sent
    await refundGlobal(kv, day, ttl);
    return { ok: false, reason: "ip", limit: limits.perIpPerDay, retryAfterSeconds: ttl };
  }
  return { ok: true, ipCount, globalCount };
}

async function refundGlobal(kv: Kv, day: string, ttl: number): Promise<void> {
  const key = `relay:global:${day}`;
  const cur = Number((await kv.get(key)) ?? "0");
  if (cur > 0) await kv.set(key, String(cur - 1), ttl);
}

export type RunSlot = { ok: true; runsToday: number } | { ok: false; limit: number; retryAfterSeconds: number };

/** Daily cap on demo runs. */
export async function takeDemoRun(kv: Kv, nowMs: number, limit: number = DEMO_RUNS_PER_DAY): Promise<RunSlot> {
  const day = dayKey(nowMs);
  const ttl = secondsUntilNextDay(nowMs);
  const n = await kv.incr(`demo:runs:${day}`, ttl);
  if (n > limit) return { ok: false, limit, retryAfterSeconds: ttl };
  return { ok: true, runsToday: n };
}

export const DEMO_LOCK_KEY = "demo:lock";
export const DEMO_LOCK_TTL_SECONDS = 15 * 60;

export interface LockInfo {
  runId: string;
  startedAt: number;
}

/** One active demo run at a time. The lock expires on its own so a crashed run never blocks forever. */
export async function acquireDemoLock(kv: Kv, runId: string, nowMs: number): Promise<{ ok: true } | { ok: false; holder: LockInfo | null }> {
  const info: LockInfo = { runId, startedAt: nowMs };
  if (await kv.setIfAbsent(DEMO_LOCK_KEY, JSON.stringify(info), DEMO_LOCK_TTL_SECONDS)) return { ok: true };
  const raw = await kv.get(DEMO_LOCK_KEY);
  let holder: LockInfo | null = null;
  try {
    holder = raw ? (JSON.parse(raw) as LockInfo) : null;
  } catch {
    holder = null;
  }
  return { ok: false, holder };
}

/** Releases the lock, but only if `runId` still holds it. */
export async function releaseDemoLock(kv: Kv, runId: string): Promise<void> {
  const raw = await kv.get(DEMO_LOCK_KEY);
  if (!raw) return;
  try {
    if ((JSON.parse(raw) as LockInfo).runId === runId) await kv.del(DEMO_LOCK_KEY);
  } catch {
    await kv.del(DEMO_LOCK_KEY);
  }
}

/** Refreshes the lock's expiry while a run is making progress. */
export async function touchDemoLock(kv: Kv, runId: string): Promise<void> {
  const raw = await kv.get(DEMO_LOCK_KEY);
  if (!raw) return;
  try {
    const info = JSON.parse(raw) as LockInfo;
    if (info.runId === runId) await kv.set(DEMO_LOCK_KEY, raw, DEMO_LOCK_TTL_SECONDS);
  } catch {
    /* ignore */
  }
}

/** A plain per-caller daily counter (for the cheap, read-only endpoints). */
export async function takeDaily(kv: Kv, scope: string, id: string, limit: number, nowMs: number): Promise<{ ok: boolean; count: number; retryAfterSeconds: number }> {
  const ttl = secondsUntilNextDay(nowMs);
  const count = await kv.incr(`${scope}:${dayKey(nowMs)}:${id}`, ttl);
  return { ok: count <= limit, count, retryAfterSeconds: ttl };
}
