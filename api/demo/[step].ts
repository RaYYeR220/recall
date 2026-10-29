import { clientIp, json, methodNotAllowed, readJson } from "../_lib/http";
import { demoContext, notConfigured, stepCollect, stepPrenotify, stepRefund, stepStart, stepStatus, type Reply } from "../_lib/demo";
import { provoke } from "../_lib/demo-provoke";
import { getKv } from "../_lib/kv";
import { takeDaily } from "../_lib/limits";

const STEPS = ["start", "prenotify", "collect", "refund", "status", "provoke"] as const;
type Step = (typeof STEPS)[number];

/** Per-IP daily cap on the free simulations. */
const PROVOKES_PER_IP_PER_DAY = 60;

const send = (r: Reply) => json(r.body, r.status);

function stepOf(req: Request): Step | null {
  const last = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
  return (STEPS as readonly string[]).includes(last) ? (last as Step) : null;
}

/**
 * GET  /api/demo/status
 * POST /api/demo/{start|prenotify|collect|refund}   body { runId, token } after start
 * POST /api/demo/provoke                            body { case }
 *
 * A one-click demo on the DEMO rail with a house creditor and a house payer held by the server. Amounts are
 * 0.02 EURC and the refund returns it to the house payer, so a run only costs gas. Inert until the keys are set.
 */
export async function GET(req: Request): Promise<Response> {
  if (stepOf(req) !== "status") return methodNotAllowed("POST");
  return send(await stepStatus(getKv(), Date.now()));
}

export async function POST(req: Request): Promise<Response> {
  const step = stepOf(req);
  if (!step || step === "status") return json({ error: `Unknown step. Use ${STEPS.join(", ")}.` }, 404);
  const parsed = await readJson(req, 4_000);
  const body = parsed.ok && typeof parsed.value === "object" && parsed.value !== null ? (parsed.value as Record<string, unknown>) : {};
  const kv = getKv();

  if (step === "provoke") {
    const cap = await takeDaily(kv, "provoke", clientIp(req), PROVOKES_PER_IP_PER_DAY, Date.now());
    if (!cap.ok) return json({ error: "Daily limit for simulations reached for this address.", retryAfterSeconds: cap.retryAfterSeconds }, 429);
    return send(await provoke(body, kv));
  }

  const env = demoContext();
  if (!env.ok) return send(notConfigured(env.missing));
  const input = { runId: body["runId"], token: body["token"] };
  switch (step) {
    case "start":
      return send(await stepStart(env.ctx, kv, Date.now()));
    case "prenotify":
      return send(await stepPrenotify(env.ctx, kv, input));
    case "collect":
      return send(await stepCollect(env.ctx, kv, input));
    case "refund":
      return send(await stepRefund(env.ctx, kv, input));
  }
}
