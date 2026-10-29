import { createPublicClient, createWalletClient, decodeEventLog, http, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  createRailClient,
  debitRailAbi,
  decodeRailError,
  networkInfo,
  railAddresses,
  txUrl,
  type RailClient,
  type RailError,
  type RailInstance,
  type RailNetwork,
} from "../../packages/sdk/src/index.js";
import { ENV_NAMES, readEnv } from "./env.js";

const clients = new Map<string, PublicClient>();

export function publicClientFor(network: RailNetwork): PublicClient {
  let c = clients.get(network);
  if (!c) {
    const info = networkInfo(network);
    c = createPublicClient({ chain: info.chain, transport: http(readEnv(ENV_NAMES.rpcUrl) ?? info.rpcUrl) });
    clients.set(network, c);
  }
  return c;
}

export function walletFor(network: RailNetwork, account: PrivateKeyAccount): WalletClient {
  const info = networkInfo(network);
  return createWalletClient({ account, chain: info.chain, transport: http(readEnv(ENV_NAMES.rpcUrl) ?? info.rpcUrl) });
}

export function railFor(network: RailNetwork, instance: RailInstance, account?: PrivateKeyAccount): RailClient {
  return createRailClient({
    network,
    instance,
    publicClient: publicClientFor(network),
    walletClient: account ? walletFor(network, account) : undefined,
  });
}

export function railAddress(network: RailNetwork, instance: RailInstance) {
  return railAddresses(network)[instance];
}

export async function waitForReceipt(network: RailNetwork, hash: Hex): Promise<TransactionReceipt> {
  return publicClientFor(network).waitForTransactionReceipt({ hash, timeout: 60_000 });
}

export interface DecodedEvent {
  name: string;
  args: Record<string, string>;
}

/** The rail events a receipt carries, decoded, with every value as a string. */
export function decodeRailEvents(receipt: TransactionReceipt, rail: string): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== rail.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: debitRailAbi, data: log.data, topics: log.topics });
      const args: Record<string, string> = {};
      for (const [k, v] of Object.entries((ev.args ?? {}) as Record<string, unknown>)) args[k] = String(v);
      out.push({ name: ev.eventName, args });
    } catch {
      /* not a rail event */
    }
  }
  return out;
}

export interface TxResult {
  txHash: Hex;
  explorerUrl: string;
  blockNumber: string;
  events: DecodedEvent[];
}

export async function toTxResult(network: RailNetwork, instance: RailInstance, hash: Hex): Promise<TxResult> {
  const receipt = await waitForReceipt(network, hash);
  if (receipt.status !== "success") throw Object.assign(new Error("The transaction reverted onchain."), { txHash: hash });
  return {
    txHash: hash,
    explorerUrl: txUrl(network, hash),
    blockNumber: receipt.blockNumber.toString(),
    events: decodeRailEvents(receipt, railAddress(network, instance).rail),
  };
}

export type Refusal = Pick<RailError, "name" | "code" | "message">;

export function refusalOf(e: unknown): Refusal {
  const d = decodeRailError(e);
  return { name: d.name, code: d.code, message: d.message };
}
