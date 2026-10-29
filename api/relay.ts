import { encodeFunctionData } from "viem";
import { debitRailAbi, networkInfo, railAddresses } from "@recall/sdk";
import { accountFromEnv, configuredNetwork, ENV_NAMES } from "./_lib/env";
import { json, clientIp, methodNotAllowed, readJson } from "./_lib/http";
import { getKv } from "./_lib/kv";
import { publicClientFor, railFor } from "./_lib/chain";
import { handleRelay, type RelayRequest } from "./_lib/relay-core";

/**
 * POST { network, instance, kind: "activate" | "action", payload }
 *
 * Lets a payer with no gas activate a mandate or act on a debit by handing over signatures. The relayer only
 * ever calls the two deployed rails, simulates first, and signs with RELAYER_KEY from the environment.
 * Inert (503) until that key is set.
 */
export async function POST(req: Request): Promise<Response> {
  const network = configuredNetwork();
  const relayer = accountFromEnv(ENV_NAMES.relayerKey);
  const info = networkInfo(network);

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return json({ error: parsedBody.error }, 400);

  const callData = (r: RelayRequest) =>
    r.kind === "activate"
      ? r.permit
        ? encodeFunctionData({ abi: debitRailAbi, functionName: "activateMandateWithPermit", args: [r.offer, r.offerSig, r.acceptance, r.debtorSig, r.permit] })
        : encodeFunctionData({ abi: debitRailAbi, functionName: "activateMandate", args: [r.offer, r.offerSig, r.acceptance, r.debtorSig] })
      : encodeFunctionData({ abi: debitRailAbi, functionName: "executeDebtorAction", args: [r.action, r.debtor, r.sig] });

  const out = await handleRelay(parsedBody.value, {
    network,
    tokens: [info.eurc.address, info.usdc.address],
    configured: relayer !== null,
    kv: getKv(),
    ip: clientIp(req),
    nowMs: Date.now(),
    simulate: async (instance, r) => {
      await publicClientFor(network).call({ account: relayer ?? undefined, to: railAddresses(network)[instance].rail, data: callData(r) });
    },
    send: (instance, r) => {
      const rail = railFor(network, instance, relayer ?? undefined);
      return r.kind === "activate"
        ? rail.activate(r.offer, r.offerSig, r.acceptance, r.debtorSig, r.permit)
        : rail.executeDebtorAction(r.action, r.debtor, r.sig);
    },
  });
  return json(out.body, out.status, out.headers);
}

export function GET(): Response {
  return methodNotAllowed("POST");
}
