import process from "node:process";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { RailNetwork } from "../../packages/sdk/src/index.js";

/** Every secret and setting the functions read. Values come from the environment only; nothing is ever defaulted to a key. */
export const ENV_NAMES = {
  network: "NETWORK",
  relayerKey: "RELAYER_KEY",
  demoCreditorKey: "DEMO_CREDITOR_KEY",
  demoDebtorKey: "DEMO_DEBTOR_KEY",
  cronSecret: "CRON_SECRET",
  keeperCreditors: "KEEPER_CREDITORS",
  rpcUrl: "RPC_URL",
} as const;

export function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** `arc` (mainnet) unless NETWORK says `arc-testnet`. Anything else is a configuration error. */
export function configuredNetwork(): RailNetwork {
  const v = readEnv(ENV_NAMES.network);
  if (v === undefined || v === "arc") return "arc";
  if (v === "arc-testnet") return "arc-testnet";
  throw new Error(`NETWORK must be "arc" or "arc-testnet", got "${v}".`);
}

const KEY = /^0x[0-9a-fA-F]{64}$/;

/** A signer from an env var, or null when the variable is unset or not a 32-byte hex key. */
export function accountFromEnv(name: string): PrivateKeyAccount | null {
  const v = readEnv(name);
  if (!v || !KEY.test(v)) return null;
  return privateKeyToAccount(v as `0x${string}`);
}

export function missingEnv(names: string[]): string[] {
  return names.filter((n) => accountFromEnv(n) === null);
}

/** Parses KEEPER_CREDITORS, e.g. "prod:1,demo:2" into tracked creditors. Bad entries are skipped. */
export function parseKeeperCreditors(raw: string | undefined): { instance: "prod" | "demo"; creditorId: bigint }[] {
  if (!raw) return [];
  const out: { instance: "prod" | "demo"; creditorId: bigint }[] = [];
  for (const part of raw.split(",")) {
    const [inst, id] = part.trim().split(":");
    if ((inst === "prod" || inst === "demo") && id && /^\d+$/.test(id) && BigInt(id) > 0n) {
      out.push({ instance: inst, creditorId: BigInt(id) });
    }
  }
  return out;
}
