import { describe, expect, test } from "bun:test";
import { memoryKv, restKv, type Kv } from "../_lib/kv.js";
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
} from "../_lib/limits.js";

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
  test("speaks the Upstash REST protocol, and INCR + EXPIRE travel in one pipeline request", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetchMock = ((url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as unknown[];
      requests.push({ url, body });
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
      if (url.endsWith("/pipeline")) return Promise.resolve(Response.json([{ result: 7 }, { result: 1 }]));
      const answers: Record<string, unknown> = { SET: "OK", GET: "7", DECR: 6, DEL: 1 };
      return Promise.resolve(Response.json({ result: answers[String(body[0])] }));
    }) as unknown as typeof fetch;
    const kv = restKv("https://kv.example/", "tok", fetchMock);

    expect(await kv.incr("k", 60)).toBe(7);
    expect(requests).toHaveLength(1); // a single round trip, so the count and its expiry cannot be split
    expect(requests[0]?.url).toBe("https://kv.example/pipeline");
    expect(requests[0]?.body).toEqual([
      ["INCR", "k"],
      ["EXPIRE", "k", 60, "NX"],
    ]);

    expect(await kv.decr("k")).toBe(6);
    expect(requests[1]?.body).toEqual(["DECR", "k"]);
    expect(await kv.get("k")).toBe("7");
    expect(await kv.setIfAbsent("l", "v", 30)).toBe(true);
    expect(requests[requests.length - 1]?.body).toEqual(["SET", "l", "v", "EX", 30, "NX"]);
  });

  test("a pipeline error surfaces instead of being counted as a pass", async () => {
    const fetchMock = (() => Promise.resolve(Response.json([{ error: "WRONGTYPE" }, { result: 0 }]))) as unknown as typeof fetch;
    const kv = restKv("https://kv.example", "tok", fetchMock);
    let message = "";
    try {
      await kv.incr("k", 60);
    } catch (e) {
      message = e instanceof Error ? e.message : "";
    }
    expect(message).toContain("WRONGTYPE");
  });
});

/** A store whose every call yields to the event loop first, so concurrent callers interleave as they would across instances. */
function jitteryKv(inner: Kv): Kv {
  const tick = () => new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 3)));
  return {
    get: async (k) => (await tick(), inner.get(k)),
    set: async (k, v, t) => (await tick(), inner.set(k, v, t)),
    setIfAbsent: async (k, v, t) => (await tick(), inner.setIfAbsent(k, v, t)),
    incr: async (k, t) => (await tick(), inner.incr(k, t)),
    decr: async (k) => (await tick(), inner.decr(k)),
    del: async (k) => (await tick(), inner.del(k)),
  };
}

describe("caps hold under concurrency", () => {
  test("memory incr hands out distinct consecutive values", async () => {
    const kv = memoryKv(() => T0);
    const values = await Promise.all(Array.from({ length: 50 }, () => kv.incr("c", 60)));
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  test("100 simultaneous relay requests from one IP: exactly 20 pass", async () => {
    const kv = jitteryKv(memoryKv(() => T0));
    const results = await Promise.all(Array.from({ length: 100 }, () => takeRelaySlot(kv, "1.2.3.4", T0)));
    expect(results.filter((r) => r.ok)).toHaveLength(20);
    expect(results.filter((r) => !r.ok && r.reason === "ip")).toHaveLength(80);
  });

  test("the global cap of 200 holds across many IPs at once", async () => {
    const kv = jitteryKv(memoryKv(() => T0));
    const results = await Promise.all(Array.from({ length: 300 }, (_, i) => takeRelaySlot(kv, `10.0.${Math.floor(i / 15)}.${i % 15}`, T0)));
    expect(results.filter((r) => r.ok)).toHaveLength(200);
    expect(results.filter((r) => !r.ok && r.reason === "global")).toHaveLength(100);
  });

  test("an IP that hits its cap hands its global slot back, so others still fit", async () => {
    const kv = jitteryKv(memoryKv(() => T0));
    const noisy = await Promise.all(Array.from({ length: 30 }, () => takeRelaySlot(kv, "9.9.9.9", T0)));
    expect(noisy.filter((r) => r.ok)).toHaveLength(20);
    // 20 used; the 10 refused ones were given back. 180 global slots remain.
    const others = await Promise.all(Array.from({ length: 200 }, (_, i) => takeRelaySlot(kv, `8.8.${Math.floor(i / 15)}.${i % 15}`, T0)));
    expect(others.filter((r) => r.ok)).toHaveLength(180);
  });

  test("the demo run cap of 40 holds under concurrency", async () => {
    const kv = jitteryKv(memoryKv(() => T0));
    const results = await Promise.all(Array.from({ length: 80 }, () => takeDemoRun(kv, T0)));
    expect(results.filter((r) => r.ok)).toHaveLength(DEMO_RUNS_PER_DAY);
  });

  test("only one of many simultaneous demo starts takes the lock", async () => {
    const kv = jitteryKv(memoryKv(() => T0));
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => acquireDemoLock(kv, `run-${i}`, T0)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });
});
