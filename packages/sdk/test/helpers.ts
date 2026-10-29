import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { debitRailAbi } from "../src/abi";
import { erc20Abi } from "../src/erc20";
import type { RailInstance } from "../src/networks";
import { TIME_SCALE } from "../src/networks";

const REPO = join(import.meta.dir, "..", "..", "..");

function artifact(path: string): { abi: Abi; bytecode: Hex } {
  const full = join(REPO, "contracts", "out", path);
  if (!existsSync(full)) throw new Error(`Missing ${path}. Run "forge build" first.`);
  const json = JSON.parse(readFileSync(full, "utf8")) as { abi: Abi; bytecode: { object: Hex } };
  return { abi: json.abi, bytecode: json.bytecode.object };
}

// Anvil's well-known dev keys.
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
] as const;

export interface InstanceEnv {
  instance: RailInstance;
  rail: Address;
  lens: Address;
}

export interface TestEnv {
  rpcUrl: string;
  publicClient: PublicClient;
  accounts: {
    deployer: PrivateKeyAccount;
    creditor: PrivateKeyAccount;
    operator: PrivateKeyAccount;
    debtor: PrivateKeyAccount;
    stranger: PrivateKeyAccount;
    relayer: PrivateKeyAccount;
  };
  wallet(account: PrivateKeyAccount): WalletClient;
  eurc: Address;
  usdc: Address;
  prod: InstanceEnv;
  demo: InstanceEnv;
  /** Registered creditor on both instances, owner = accounts.creditor. */
  creditorId: Record<RailInstance, bigint>;
  increaseTime(seconds: number): Promise<void>;
  setCode(address: Address, code: Hex): Promise<void>;
  snapshot(): Promise<Hex>;
  revert(id: Hex): Promise<void>;
}

export const anvilAvailable = Bun.which("anvil") !== null;

let envPromise: Promise<TestEnv> | undefined;
let anvilProc: ReturnType<typeof Bun.spawn> | undefined;

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result as T;
}

async function boot(): Promise<TestEnv> {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  anvilProc = Bun.spawn(["anvil", "--port", String(port), "--silent"], { stdout: "ignore", stderr: "ignore" });
  process.on("exit", () => anvilProc?.kill());

  for (let i = 0; i < 100; i++) {
    try {
      await rpc<string>(rpcUrl, "eth_chainId");
      break;
    } catch {
      await Bun.sleep(100);
    }
    if (i === 99) throw new Error("anvil did not start");
  }

  const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) }) as PublicClient;
  const [deployer, creditor, operator, debtor, stranger, relayer] = KEYS.map((k) => privateKeyToAccount(k));
  const accounts = {
    deployer: deployer,
    creditor: creditor,
    operator: operator,
    debtor: debtor,
    stranger: stranger,
    relayer: relayer,
  };
  const wallet = (account: PrivateKeyAccount): WalletClient =>
    createWalletClient({ account, chain: foundry, transport: http(rpcUrl) });

  const deployerWallet = wallet(accounts.deployer);
  async function deploy(path: string, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = artifact(path);
    const hash = await deployerWallet.deployContract({ abi, bytecode, args, account: accounts.deployer, chain: foundry });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`deploy failed: ${path}`);
    return receipt.contractAddress;
  }
  async function send(w: WalletClient, to: Address, abi: Abi, functionName: string, args: unknown[]): Promise<void> {
    const hash = await w.writeContract({ address: to, abi, functionName, args, account: w.account!, chain: foundry });
    await publicClient.waitForTransactionReceipt({ hash });
  }

  const eurc = await deploy("MockFiatToken.sol/MockFiatToken.json", ["EURC", "EURC"]);
  const usdc = await deploy("MockFiatToken.sol/MockFiatToken.json", ["USDC", "USDC"]);
  const tokenAbi = artifact("MockFiatToken.sol/MockFiatToken.json").abi;

  const instances = {} as Record<RailInstance, InstanceEnv>;
  const creditorId = {} as Record<RailInstance, bigint>;
  const names: Record<RailInstance, string> = {
    prod: "Recall DebitRail",
    demo: "Recall DebitRail DEMO (1 week = 1 minute)",
  };
  for (const instance of ["prod", "demo"] as const) {
    const rail = await deploy("DebitRail.sol/DebitRail.json", [eurc, usdc, TIME_SCALE[instance], names[instance], instance]);
    const lens = await deploy("RailLens.sol/RailLens.json", [rail]);
    instances[instance] = { instance, rail, lens };

    const cw = wallet(accounts.creditor);
    await send(cw, rail, debitRailAbi, "registerCreditor", ["Test Merchant", accounts.creditor.address]);
    creditorId[instance] = await publicClient.readContract({ address: rail, abi: debitRailAbi, functionName: "creditorCount" });
    await send(cw, rail, debitRailAbi, "setOperator", [creditorId[instance], accounts.operator.address, true]);

    // Fund the creditor's reserve (EURC) so collections are backed.
    await send(deployerWallet, eurc, tokenAbi, "mint", [accounts.creditor.address, parseUnits("10000", 6)]);
    await send(cw, eurc, erc20ApprovalAbi, "approve", [rail, parseUnits("5000", 6)]);
    await send(cw, rail, debitRailAbi, "fundReserve", [creditorId[instance], eurc, parseUnits("5000", 6)]);
  }
  // Payer holds EURC.
  await send(deployerWallet, eurc, tokenAbi, "mint", [accounts.debtor.address, parseUnits("1000", 6)]);

  return {
    rpcUrl,
    publicClient,
    accounts,
    wallet,
    eurc,
    usdc,
    prod: instances.prod,
    demo: instances.demo,
    creditorId,
    async increaseTime(seconds) {
      await rpc(rpcUrl, "evm_increaseTime", [seconds]);
      await rpc(rpcUrl, "evm_mine", []);
    },
    async setCode(address, code) {
      await rpc(rpcUrl, "anvil_setCode", [address, code]);
    },
    snapshot: () => rpc<Hex>(rpcUrl, "evm_snapshot"),
    async revert(id) {
      await rpc(rpcUrl, "evm_revert", [id]);
    },
  };
}

const erc20ApprovalAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const satisfies Abi;

/** Boots one anvil with both rails deployed, shared by every test file in the run. */
export function getEnv(): Promise<TestEnv> {
  envPromise ??= boot();
  return envPromise;
}

export function stopAnvil(): void {
  anvilProc?.kill();
}

export { erc20Abi };
