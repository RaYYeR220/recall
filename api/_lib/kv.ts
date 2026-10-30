import process from "node:process";

/**
 * The small key-value surface the functions need. In-memory by default (fine for one warm instance and for
 * tests); set KV_REST_API_URL and KV_REST_API_TOKEN (Vercel KV / Upstash REST) to share it across instances.
 */
export interface Kv {
  get(key: string): Promise<string | null>;
  /** Sets a value, optionally expiring after `ttlSeconds`. */
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  /** Sets only when the key is absent. Resolves true when this call took it. */
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /**
   * Atomically adds one and returns the new count. The first increment arms the expiry. Concurrent callers
   * always see distinct, consecutive values, so a cap can safely be "reject when the result exceeds it".
   */
  incr(key: string, ttlSeconds: number): Promise<number>;
  /** Atomically subtracts one and returns the new count (gives a slot back). */
  decr(key: string): Promise<number>;
  del(key: string): Promise<void>;
}

interface Entry {
  value: string;
  expiresAt: number;
}

export function memoryKv(now: () => number = Date.now): Kv {
  const store = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const e = store.get(key);
    if (e && e.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return e;
  };
  const expiry = (ttl?: number) => (ttl ? now() + ttl * 1000 : Number.POSITIVE_INFINITY);
  return {
    get: (key) => Promise.resolve(live(key)?.value ?? null),
    set(key, value, ttl) {
      store.set(key, { value, expiresAt: expiry(ttl) });
      return Promise.resolve();
    },
    setIfAbsent(key, value, ttl) {
      if (live(key)) return Promise.resolve(false);
      store.set(key, { value, expiresAt: expiry(ttl) });
      return Promise.resolve(true);
    },
    incr(key, ttl) {
      const e = live(key);
      const n = (e ? Number(e.value) : 0) + 1;
      store.set(key, { value: String(n), expiresAt: e ? e.expiresAt : expiry(ttl) });
      return Promise.resolve(n);
    },
    decr(key) {
      const e = live(key);
      const n = (e ? Number(e.value) : 0) - 1;
      store.set(key, { value: String(n), expiresAt: e ? e.expiresAt : Number.POSITIVE_INFINITY });
      return Promise.resolve(n);
    },
    del(key) {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

/** Upstash / Vercel KV over REST: each call is one command array POSTed to the base URL. */
export function restKv(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): Kv {
  const base = baseUrl.replace(/\/+$/, "");
  type Command = (string | number)[];
  /** Several commands in one round trip. The server runs them back to back, so INCR + EXPIRE cannot be split. */
  const pipeline = async (commands: Command[]): Promise<unknown[]> => {
    const res = await fetchImpl(`${base}/pipeline`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`KV answered ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: string }[];
    return json.map((r) => {
      if (r.error) throw new Error(`KV error: ${r.error}`);
      return r.result;
    });
  };
  const cmd = async (...args: Command): Promise<unknown> => {
    const res = await fetchImpl(base, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`KV answered ${res.status}`);
    const json = (await res.json()) as { result?: unknown; error?: string };
    if (json.error) throw new Error(`KV error: ${json.error}`);
    return json.result;
  };
  return {
    async get(key) {
      const r = await cmd("GET", key);
      return typeof r === "string" ? r : null;
    },
    async set(key, value, ttl) {
      if (ttl) await cmd("SET", key, value, "EX", ttl);
      else await cmd("SET", key, value);
    },
    async setIfAbsent(key, value, ttl) {
      return (await cmd("SET", key, value, "EX", ttl, "NX")) === "OK";
    },
    async incr(key, ttl) {
      // One pipeline: INCR plus EXPIRE ... NX (only arms the expiry on a key that has none).
      const [n] = await pipeline([
        ["INCR", key],
        ["EXPIRE", key, ttl, "NX"],
      ]);
      return Number(n);
    },
    async decr(key) {
      return Number(await cmd("DECR", key));
    },
    async del(key) {
      await cmd("DEL", key);
    },
  };
}

let shared: Kv | undefined;

/** The process-wide store: REST-backed when configured, otherwise in-memory. */
export function getKv(): Kv {
  if (!shared) {
    const url = process.env["KV_REST_API_URL"];
    const token = process.env["KV_REST_API_TOKEN"];
    shared = url && token ? restKv(url, token) : memoryKv();
  }
  return shared;
}

export function kvBackend(): "rest" | "memory" {
  return process.env["KV_REST_API_URL"] && process.env["KV_REST_API_TOKEN"] ? "rest" : "memory";
}
