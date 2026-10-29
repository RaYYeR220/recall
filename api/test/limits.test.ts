import { describe, expect, test } from "bun:test";
import { memoryKv, restKv } from "../_lib/kv";
import {
  acquireDemoLock,
  dayKey,
  DEMO_LOCK_TTL_SECONDS,
  DEMO_RUNS_PER_DAY,
  releaseDemoLock,
  secondsUntilNextDay,
  takeDaily,
  takeDemoRun,
  takeRelaySlot,
} from "../_lib/limits";

const T0 = Date.UTC(2026, 9, 29, 10, 0, 0); // 29 Oct 2026, 10:00 UTC

describe("day boundaries", () => {
  test("dayKey is the UTC date", () => {
    expect(dayKey(T0)).toBe("2026-10-29");
    expect(dayKey(Date.UTC(2026, 9, 29, 23, 59, 59))).toBe("2026-10-29");
    expect(dayKey(Date.UTC(2026, 9, 30, 0, 0, 0))).toBe("2026-10-30");
  });
  test("secondsUntilNextDay counts to 00:00 UTC", () => {
    expect(secondsUntilNextDay(T0)).toBe(14 * 3600);
    expect(secondsUntilNextDay(Date.UTC(2026, 9, 29, 23, 59, 59))).toBe(1);
  });
});

describe("relay caps: 20 per IP and 200 global per day", () => {
  test("the 20th request from one IP passes, the 21st is refused", async () => {
    const kv = memoryKv(() => T0);
    for (let i = 1; i <= 20; i++) {
      const r = await takeRelaySlot(kv, "1.1.1.1", T0);
      expect(r.ok).toBe(true);
    }
    const over = await takeRelaySlot(kv, "1.1.1.1", T0);
    expect(over).toMatchObject({ ok: false, reason: "ip", limit: 20 });
    // another IP is unaffected
    expect((await takeRelaySlot(kv, "2.2.2.2", T0)).ok).toBe(true);
  });

  test("an IP refusal gives the global slot back", async () => {
    const kv = memoryKv(() => T0);
    for (let i = 0; i < 20; i++) await takeRelaySlot(kv, "1.1.1.1", T0);
    expect(await kv.get(`relay:global:${dayKey(T0)}`)).toBe("20");
    await takeRelaySlot(kv, "1.1.1.1", T0); // refused
    expect(await kv.get(`relay:global:${dayKey(T0)}`)).toBe("20");
  });

  test("the global cap stops everyone at 200, and says so", async () => {
    const kv = memoryKv(() => T0);
    // 10 requests from each of 20 IPs = 200
    for (let ip = 0; ip < 20; ip++) {
      for (let i = 0; i < 10; i++) expect((await takeRelaySlot(kv, `10.0.0.${ip}`, T0)).ok).toBe(true);
    }
    const r = await takeRelaySlot(kv, "10.0.0.99", T0);
    expect(r).toMatchObject({ ok: false, reason: "global", limit: 200 });
    // a global refusal does not burn that IP's own allowance
    expect(await kv.get(`relay:ip:${dayKey(T0)}:10.0.0.99`)).toBeNull();
  });

  test("custom limits are honoured", async () => {
    const kv = memoryKv(() => T0);
    const limits = { perIpPerDay: 2, globalPerDay: 3 };
    expect((await takeRelaySlot(kv, "a", T0, limits)).ok).toBe(true);
    expect((await takeRelaySlot(kv, "a", T0, limits)).ok).toBe(true);
    expect(await takeRelaySlot(kv, "a", T0, limits)).toMatchObject({ ok: false, reason: "ip" });
    expect((await takeRelaySlot(kv, "b", T0, limits)).ok).toBe(true);
    expect(await takeRelaySlot(kv, "c", T0, limits)).toMatchObject({ ok: false, reason: "global" });
  });

  test("counters reset at 00:00 UTC", async () => {
    let now = T0;
    const kv = memoryKv(() => now);
    const limits = { perIpPerDay: 1, globalPerDay: 5 };
    expect((await takeRelaySlot(kv, "a", now, limits)).ok).toBe(true);
    expect((await takeRelaySlot(kv, "a", now, limits)).ok).toBe(false);
    now = Date.UTC(2026, 9, 30, 0, 0, 1); // next day
    expect((await takeRelaySlot(kv, "a", now, limits)).ok).toBe(true);
  });

  test("retryAfterSeconds points at the next UTC midnight", async () => {
    const kv = memoryKv(() => T0);
    const limits = { perIpPerDay: 1, globalPerDay: 5 };
    await takeRelaySlot(kv, "a", T0, limits);
    const r = await takeRelaySlot(kv, "a", T0, limits);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfterSeconds).toBe(14 * 3600);
  });
});

describe("demo caps and lock", () => {
  test("40 runs a day, the 41st is refused", async () => {
    const kv = memoryKv(() => T0);
    for (let i = 1; i <= DEMO_RUNS_PER_DAY; i++) expect((await takeDemoRun(kv, T0)).ok).toBe(true);
    expect(await takeDemoRun(kv, T0)).toMatchObject({ ok: false, limit: 40 });
  });

  test("only one run holds the lock", async () => {
    const kv = memoryKv(() => T0);
    expect((await acquireDemoLock(kv, "run-a", T0)).ok).toBe(true);
    const second = await acquireDemoLock(kv, "run-b", T0);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.holder?.runId).toBe("run-a");
  });

  test("only the holder can release it", async () => {
    const kv = memoryKv(() => T0);
    await acquireDemoLock(kv, "run-a", T0);
    await releaseDemoLock(kv, "run-b");
    expect((await acquireDemoLock(kv, "run-c", T0)).ok).toBe(false);
    await releaseDemoLock(kv, "run-a");
    expect((await acquireDemoLock(kv, "run-c", T0)).ok).toBe(true);
  });

  test("a crashed run's lock expires on its own", async () => {
    let now = T0;
    const kv = memoryKv(() => now);
    await acquireDemoLock(kv, "run-a", now);
    now += (DEMO_LOCK_TTL_SECONDS - 1) * 1000;
    expect((await acquireDemoLock(kv, "run-b", now)).ok).toBe(false);
    now += 2000;
    expect((await acquireDemoLock(kv, "run-b", now)).ok).toBe(true);
  });

  test("takeDaily counts per caller", async () => {
    const kv = memoryKv(() => T0);
    expect((await takeDaily(kv, "provoke", "ip1", 2, T0)).ok).toBe(true);
    expect((await takeDaily(kv, "provoke", "ip1", 2, T0)).ok).toBe(true);
    expect((await takeDaily(kv, "provoke", "ip1", 2, T0)).ok).toBe(false);
    expect((await takeDaily(kv, "provoke", "ip2", 2, T0)).ok).toBe(true);
  });
});

describe("REST-backed store", () => {
  test("speaks the Upstash REST protocol", async () => {
    const calls: unknown[][] = [];
    const answers: Record<string, unknown> = { INCR: 1, SET: "OK", GET: "7", EXPIRE: 1, DEL: 1 };
    const fetchMock = ((_url: string, init: RequestInit) => {
      const cmd = JSON.parse(init.body as string) as unknown[];
      calls.push(cmd);
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
      return Promise.resolve(Response.json({ result: answers[String(cmd[0])] }));
    }) as unknown as typeof fetch;
    const kv = restKv("https://kv.example", "tok", fetchMock);
    expect(await kv.incr("k", 60)).toBe(1);
    expect(calls.map((c) => c[0])).toEqual(["INCR", "EXPIRE"]);
    expect(await kv.get("k")).toBe("7");
    expect(await kv.setIfAbsent("l", "v", 30)).toBe(true);
    expect(calls[calls.length - 1]).toEqual(["SET", "l", "v", "EX", 30, "NX"]);
  });
});
