import { RAIL_INSTANCES, type RailInstance } from "../packages/sdk/src/index.js";
import { railFor } from "./_lib/chain.js";
import { configuredNetwork } from "./_lib/env.js";
import { json, methodNotAllowed } from "./_lib/http.js";

const TTL_MS = 15_000;
let cache: { at: number; network: string; body: Record<string, unknown> } | undefined;

/** GET: read-only RailLens.health() for both rails, cached for 15 seconds. Needs no keys. */
export async function GET(): Promise<Response> {
  const network = configuredNetwork();
  const now = Date.now();
  if (cache && cache.network === network && now - cache.at < TTL_MS) {
    return json({ ...cache.body, cached: true }, 200, { "cache-control": "public, s-maxage=15, stale-while-revalidate=15" });
  }
  const rails = {} as Record<RailInstance, unknown>;
  const block = await railFor(network, "prod").publicClient.getBlockNumber();
  await Promise.all(
    RAIL_INSTANCES.map(async (instance) => {
      const rail = railFor(network, instance);
      const h = await rail.health();
      rails[instance] = { rail: rail.rail, lens: rail.lens, eurc: h.eurc, usdc: h.usdc };
    }),
  );
  const body = { network, blockNumber: block.toString(), checkedAt: new Date(now).toISOString(), rails };
  cache = { at: now, network, body };
  return json({ ...body, cached: false }, 200, { "cache-control": "public, s-maxage=15, stale-while-revalidate=15" });
}

export function POST(): Response {
  return methodNotAllowed("GET");
}
