import { createPublicClient, createWalletClient, http, type Address, type Chain, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  createRailClient,
  networkInfo,
  RAIL_INSTANCES,
  railAddresses,
  type RailClient,
  type RailInstance,
  type RailNetwork,
} from "../../sdk/src/index.js";

export const DEFAULT_APP_URL = "https://recall-debit.vercel.app";

export class OperatorKeyMissing extends Error {
  constructor() {
    super(
      "This tool sends a transaction, so it needs RECALL_OPERATOR_KEY: the private key of a wallet the creditor owner added as an operator. " +
        "Set it in the MCP server's environment and restart. Read-only tools work without it.",
    );
    this.name = "OperatorKeyMissing";
  }
}

/**
 * What the payer-assistant tools get. It has no wallet and no key by construction: the payer's key is never
 * given to this server, and nothing the payer tools can reach could sign with one.
 */
export interface ReadContext {
  network: RailNetwork;
  appUrl: string;
  publicClient: PublicClient;
  /** USDC and EURC addresses on this network. */
  tokens: { USDC: Address; EURC: Address };
  /** A read-only rail client (no wallet) for an instance. */
  reader: (instance: RailInstance) => RailClient;
  symbolOf: (token: Address) => string;
}

/** The merchant tools additionally get the operator wallet. Only the tools that send a transaction call `operator()`. */
export interface RecallContext extends ReadContext {
  operatorAddress: Address | undefined;
  /** A rail client signing with the operator key. Throws OperatorKeyMissing when no key is configured. */
  operator: (instance: RailInstance) => RailClient;
}

export interface ContextOptions {
  network?: RailNetwork;
  /** Hex private key of the operator wallet. Optional: without it only read-only tools work. */
  operatorKey?: string | undefined;
  rpcUrl?: string | undefined;
  appUrl?: string | undefined;
  /** Test hooks. */
  publicClient?: PublicClient;
  chain?: Chain;
  addresses?: Partial<Record<RailInstance, { rail: Address; lens: Address }>>;
  tokens?: { USDC: Address; EURC: Address };
}

export function parseNetwork(value: string | undefined): RailNetwork {
  if (value === undefined || value === "" || value === "arc") return "arc";
  if (value === "arc-testnet") return "arc-testnet";
  throw new Error(`NETWORK must be "arc" or "arc-testnet", got "${value}".`);
}

export function parseOperatorKey(value: string | undefined): PrivateKeyAccount | undefined {
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error("RECALL_OPERATOR_KEY must be a 0x-prefixed 32-byte hex private key.");
  return privateKeyToAccount(value as `0x${string}`);
}

export function contextFromEnv(env: Record<string, string | undefined>): RecallContext {
  return createContext({
    network: parseNetwork(env["NETWORK"]),
    operatorKey: env["RECALL_OPERATOR_KEY"],
    rpcUrl: env["RPC_URL"],
    appUrl: env["RECALL_APP_URL"],
  });
}

export function createContext(opts: ContextOptions = {}): RecallContext {
  const network = opts.network ?? "arc";
  const info = networkInfo(network);
  const chain = opts.chain ?? info.chain;
  const rpc = opts.rpcUrl ?? info.rpcUrl;
  const publicClient = opts.publicClient ?? (createPublicClient({ chain, transport: http(rpc) }));
  const account = parseOperatorKey(opts.operatorKey);
  const walletClient = account ? createWalletClient({ account, chain, transport: http(rpc) }) : undefined;
  const tokens = opts.tokens ?? { USDC: info.usdc.address, EURC: info.eurc.address };
  const appUrl = (opts.appUrl ?? DEFAULT_APP_URL).replace(/\/+$/, "");

  const addressesFor = (instance: RailInstance) => opts.addresses?.[instance] ?? railAddresses(network)[instance];
  const make = (instance: RailInstance, withWallet: boolean): RailClient =>
    createRailClient({
      network,
      instance,
      publicClient,
      ...(withWallet && walletClient ? { walletClient } : {}),
      addresses: addressesFor(instance),
    });

  const readers = new Map<RailInstance, RailClient>();
  const operators = new Map<RailInstance, RailClient>();
  for (const i of RAIL_INSTANCES) readers.set(i, make(i, false));

  return {
    network,
    appUrl,
    publicClient,
    tokens,
    operatorAddress: account?.address,
    reader: (instance) => readers.get(instance) as RailClient,
    operator(instance) {
      if (!walletClient) throw new OperatorKeyMissing();
      let c = operators.get(instance);
      if (!c) {
        c = make(instance, true);
        operators.set(instance, c);
      }
      return c;
    },
    symbolOf(token) {
      const t = token.toLowerCase();
      if (t === tokens.USDC.toLowerCase()) return "USDC";
      if (t === tokens.EURC.toLowerCase()) return "EURC";
      return token;
    },
  };
}
