import { serializeForRelay } from "@recall/sdk";

/** JSON response; bigints become decimal strings. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(serializeForRelay(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function methodNotAllowed(allowed: string): Response {
  return json({ error: `Method not allowed. Use ${allowed}.` }, 405, { allow: allowed });
}

/** The caller's IP as the platform reports it (first hop of x-forwarded-for), or "unknown". */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}

export async function readJson(req: Request, maxBytes = 64_000): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const text = await req.text();
  if (text.length > maxBytes) return { ok: false, error: "Request body is too large." };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "Request body is not valid JSON." };
  }
}

/** Constant-time string comparison (for secrets). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
