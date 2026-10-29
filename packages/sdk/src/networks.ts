import { defineChain, getAddress, type Address, type Chain } from "viem";
import arcMainnetDeployment from "../../../deployments/5042.json";
import arcTestnetDeployment from "../../../deployments/5042002.json";

export type RailNetwork = "arc" | "arc-testnet";
export type RailInstance = "prod" | "demo";

export const RAIL_NETWORKS: readonly RailNetwork[] = ["arc", "arc-testnet"];
export const RAIL_INSTANCES: readonly RailInstance[] = ["prod", "demo"];

/** Time scale baked into each instance at construction. The demo runs 10080x faster (1 week = 1 minute). */
export const TIME_SCALE: Record<RailInstance, number> = { prod: 1, demo: 10080 };

/** Arc "Memo" predeploy. Wraps a call and attaches a memo id and memo data to the transaction. */
export const MEMO_ADDRESS: Address = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";

/** USDC and EURC both use 6 decimals as ERC-20s on Arc. */
export const TOKEN_DECIMALS = 6;

/**
 * Arc's native gas token IS USDC, exposed with 18 decimals natively and 6 as an ERC-20.
 * The SDK only ever moves the ERC-20 view.
 */
export const arcMainnet: Chain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

export const arcTestnet: Chain = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" } },
  testnet: true,
});

export interface TokenInfo {
  symbol: "EURC" | "USDC";
  address: Address;
  decimals: 6;
}

export interface NetworkInfo {
  network: RailNetwork;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  eurc: TokenInfo;
  usdc: TokenInfo;
  /**
   * Floor for maxFeePerGas (wei) applied by the client when the node's estimate is lower.
   * Matches the explicit fee used by scripts/lifecycle.ts, which is what Arc accepted in testing.
   */
  minFeePerGas: bigint;
}

const USDC_ADDRESS: Address = "0x3600000000000000000000000000000000000000";
const MIN_FEE_PER_GAS = 20_000_000_000n; // 20 gwei

const NETWORKS: Record<RailNetwork, NetworkInfo> = {
  arc: {
    network: "arc",
    chain: arcMainnet,
    chainId: 5042,
    rpcUrl: "https://rpc.mainnet.arc.io",
    explorer: "https://explorer.arc.io",
    eurc: { symbol: "EURC", address: getAddress("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1"), decimals: 6 },
    usdc: { symbol: "USDC", address: USDC_ADDRESS, decimals: 6 },
    minFeePerGas: MIN_FEE_PER_GAS,
  },
  "arc-testnet": {
    network: "arc-testnet",
    chain: arcTestnet,
    chainId: 5042002,
    rpcUrl: "https://rpc.testnet.arc.io",
    explorer: "https://explorer.testnet.arc.io",
    eurc: { symbol: "EURC", address: getAddress("0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a"), decimals: 6 },
    usdc: { symbol: "USDC", address: USDC_ADDRESS, decimals: 6 },
    minFeePerGas: MIN_FEE_PER_GAS,
  },
};

export function networkInfo(network: RailNetwork): NetworkInfo {
  const info = NETWORKS[network];
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- guards untyped callers
  if (!info) throw new Error(`Unknown Recall network "${String(network)}". Use "arc" or "arc-testnet".`);
  return info;
}

export function tokenBySymbol(network: RailNetwork, symbol: "EURC" | "USDC"): TokenInfo {
  const info = networkInfo(network);
  return symbol === "EURC" ? info.eurc : info.usdc;
}

/** Reverse lookup: which supported token (if any) lives at this address on this network. */
export function tokenByAddress(network: RailNetwork, address: Address): TokenInfo | undefined {
  const info = networkInfo(network);
  const a = address.toLowerCase();
  if (info.eurc.address.toLowerCase() === a) return info.eurc;
  if (info.usdc.address.toLowerCase() === a) return info.usdc;
  return undefined;
}

export function txUrl(network: RailNetwork, hash: string): string {
  return `${networkInfo(network).explorer}/tx/${hash}`;
}

export function addressUrl(network: RailNetwork, address: string): string {
  return `${networkInfo(network).explorer}/address/${address}`;
}

interface DeploymentJson {
  prod: { rail: string; lens: string };
  demo: { rail: string; lens: string };
}

function fromDeployment(json: DeploymentJson): Record<RailInstance, { rail: Address; lens: Address }> {
  return {
    prod: { rail: getAddress(json.prod.rail), lens: getAddress(json.prod.lens) },
    demo: { rail: getAddress(json.demo.rail), lens: getAddress(json.demo.lens) },
  };
}

const ADDRESSES: Record<RailNetwork, Record<RailInstance, { rail: Address; lens: Address }>> = {
  arc: fromDeployment(arcMainnetDeployment),
  "arc-testnet": fromDeployment(arcTestnetDeployment),
};

/** Rail and lens addresses for both instances, read from deployments/<chainId>.json. */
export function railAddresses(network: RailNetwork): Record<RailInstance, { rail: Address; lens: Address }> {
  const a = ADDRESSES[network];
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- guards untyped callers
  if (!a) throw new Error(`Unknown Recall network "${String(network)}". Use "arc" or "arc-testnet".`);
  return a;
}
