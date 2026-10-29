/**
 * Recall DebitRail — end-to-end lifecycle script
 *
 * Usage:
 *   bun run scripts/lifecycle.ts --network arc-testnet --instance demo
 *
 * Required env vars:
 *   CREDITOR_KEY   private key of the creditor (registers, funds reserve, signs offers)
 *   DEBTOR_KEY     private key of primary debtor
 *   RELAYER_KEY    private key of the relayer (submits sigs, pays gas)
 *   DEBTOR2_KEY    private key of a second debtor with NO token balance (for AM04 test)
 *   EURC_ADDRESS   EURC token address
 *   VITE_USDC_ADDRESS  USDC token address (VITE_ prefix so Vite exposes it too)
 *
 * Reads:  deployments/<chainId>.json
 * Writes: proof/<network>-<instance>-lifecycle.json
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  encodeFunctionData,
  decodeErrorResult,
  domainSeparator,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type Chain,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { debitRailAbi } from "../packages/sdk/src/abi";
import { defineChain } from "viem";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const HERE = fileURLToPath(new URL(".", import.meta.url));

// ── Chain definitions ────────────────────────────────────────────────────────

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.testnet.arc.io" },
  },
});

const arcMainnet = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.arc.io"] } },
  blockExplorers: {
    default: { name: "Arc Explorer", url: "https://explorer.arc.io" },
  },
});

// ── ABI fragments ────────────────────────────────────────────────────────────

const ERC20_ABI = [
  { name: "approve",     type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf",   type: "function", stateMutability: "view",       inputs: [{ name: "account", type: "address" }],                                      outputs: [{ type: "uint256" }] },
  { name: "permit",      type: "function", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [] },
  { name: "nonces",      type: "function", stateMutability: "view",       inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "DOMAIN_SEPARATOR", type: "function", stateMutability: "view",  inputs: [], outputs: [{ type: "bytes32" }] },
  { name: "name",        type: "function", stateMutability: "view",       inputs: [], outputs: [{ type: "string" }] },
  { name: "version",     type: "function", stateMutability: "view",       inputs: [], outputs: [{ type: "string" }] },
] as const;

// The full, typed ABI generated from the compiled contract (packages/sdk/src/abi.ts).
const RAIL_ABI = debitRailAbi;

const LENS_ABI = [
  { name: "health", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "eurcHealth", type: "tuple", components: [{ name: "token", type: "address" }, { name: "balance", type: "uint256" }, { name: "reserves", type: "uint256" }, { name: "held", type: "uint256" }, { name: "claimables", type: "uint256" }, { name: "surplus", type: "uint256" }, { name: "lockedTotal", type: "uint256" }, { name: "exposureTotal", type: "uint256" }, { name: "i1", type: "bool" }, { name: "i2", type: "bool" }, { name: "i3", type: "bool" }] }, { name: "usdcHealth", type: "tuple", components: [{ name: "token", type: "address" }, { name: "balance", type: "uint256" }, { name: "reserves", type: "uint256" }, { name: "held", type: "uint256" }, { name: "claimables", type: "uint256" }, { name: "surplus", type: "uint256" }, { name: "lockedTotal", type: "uint256" }, { name: "exposureTotal", type: "uint256" }, { name: "i1", type: "bool" }, { name: "i2", type: "bool" }, { name: "i3", type: "bool" }] }] },
] as const;

// Errors from IDebitRail for simulation decoding
const RAIL_ERRORS = [
  { name: "TooEarly",            type: "error", inputs: [] },
  { name: "PrenoticeTooShort",   type: "error", inputs: [] },
  { name: "OverCollectionCap",   type: "error", inputs: [] },
  { name: "OverPeriodCap",       type: "error", inputs: [] },
  { name: "RefundWindowClosed",  type: "error", inputs: [] },
  { name: "ReserveLocked",       type: "error", inputs: [] },
  { name: "NoRefundRightB2B",    type: "error", inputs: [] },
  { name: "WrongStatus",         type: "error", inputs: [] },
  { name: "ExecutionWindowPassed", type: "error", inputs: [] },
] as const;

// ── Arg parsing ──────────────────────────────────────────────────────────────

function getArg(flag: string, def?: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (def !== undefined) return def;
  throw new Error(`Missing required argument: ${flag}`);
}

const network  = getArg("--network",  "arc-testnet");
// Each run gets its own references so a rerun against the same rail never collides (AM05 / MandateExists).
const RUN = Date.now().toString(36);
const ref = (label: string): Hex => stringToHex(`${label}-${RUN}`.slice(0, 32), { size: 32 });
const MANDATE_TEXT =
  "By signing this mandate you authorise Northwind Gym to send instructions to collect payments from your wallet, " +
  "and the Recall DebitRail contract to collect them in accordance with these instructions. You will be notified of " +
  "every amount and date in advance. You are entitled to a refund of any collection within eight weeks of it, with no questions asked.";
const instance = getArg("--instance", "demo");

const NETWORKS: Record<string, { chain: Chain; chainId: number; explorer: string }> = {
  "arc-testnet": { chain: arcTestnet, chainId: 5042002, explorer: "https://explorer.testnet.arc.io" },
  "arc":         { chain: arcMainnet, chainId: 5042,    explorer: "https://explorer.arc.io" },
};

const net = NETWORKS[network];
if (!net) throw new Error(`Unknown network: ${network}`);

// ── Key loading ──────────────────────────────────────────────────────────────

function requireKey(name: string): Hex {
  const val = process.env[name];
  if (!val) throw new Error(`Missing env var: ${name}`);
  return val.startsWith("0x") ? (val as Hex) : (`0x${val}`);
}

const creditorAccount = privateKeyToAccount(requireKey("CREDITOR_KEY"));
const debtorAccount   = privateKeyToAccount(requireKey("DEBTOR_KEY"));
const relayerAccount  = privateKeyToAccount(requireKey("RELAYER_KEY"));
const debtor2Account  = privateKeyToAccount(requireKey("DEBTOR2_KEY"));

const EURC_ADDR = (process.env.EURC_ADDRESS ?? "") as Address;
const USDC_ADDR = (process.env.VITE_USDC_ADDRESS ?? "") as Address;
if (!EURC_ADDR || !USDC_ADDR) throw new Error("Missing EURC_ADDRESS or VITE_USDC_ADDRESS");

// ── Deployment manifest ──────────────────────────────────────────────────────

const deployFile = join(HERE, "..", "deployments", `${net.chainId}.json`);
const deployment = JSON.parse(readFileSync(deployFile, "utf8")) as {
  prod: { rail: Address; lens: Address };
  demo: { rail: Address; lens: Address };
};
const railAddr = deployment[instance as "prod" | "demo"].rail;
const lensAddr = deployment[instance as "prod" | "demo"].lens;

// ── Clients ──────────────────────────────────────────────────────────────────

// --rpc overrides the chain's default endpoint (for example a local fork for a rehearsal run).
const rpcUrl = getArg("--rpc", net.chain.rpcUrls.default.http[0]);
const pub = createPublicClient({ chain: net.chain, transport: http(rpcUrl) });
const relayer  = createWalletClient({ chain: net.chain, transport: http(rpcUrl), account: relayerAccount });
const creditor = createWalletClient({ chain: net.chain, transport: http(rpcUrl), account: creditorAccount });
const debtor_w = createWalletClient({ chain: net.chain, transport: http(rpcUrl), account: debtorAccount });

function txLink(hash: Hex): string {
  return `${net.explorer}/tx/${hash}`;
}

// ── Logging / proof ──────────────────────────────────────────────────────────

interface ProofEntry { step: string; hash?: Hex; link?: string; detail?: unknown }
const proof: ProofEntry[] = [];
let stepIdx = 0;

async function step(label: string, fn: () => Promise<{ hash?: Hex; detail?: unknown }>): Promise<{ hash?: Hex; detail?: unknown }> {
  stepIdx++;
  console.log(`\n[${stepIdx}] ${label}`);
  const result = await fn();
  const entry: ProofEntry = { step: label, ...result };
  if (result.hash) entry.link = txLink(result.hash);
  proof.push(entry);
  if (result.hash) console.log(`    tx: ${txLink(result.hash)}`);
  if (result.detail) console.log(`    `, JSON.stringify(result.detail, null, 2).split("\n").join("\n    "));
  return result;
}

async function simulate(label: string, fn: () => Promise<unknown>): Promise<void> {
  stepIdx++;
  console.log(`\n[${stepIdx}] SIMULATE ${label}`);
  try {
    await fn();
    console.log(`    result: no revert (unexpected)`);
    proof.push({ step: `SIMULATE ${label}`, detail: { result: "no revert" } });
  } catch (e: unknown) {
    const err = e as { data?: Hex; message?: string };
    let decoded = "unknown";
    if (err.data) {
      for (const errDef of RAIL_ERRORS) {
        try {
          const r = decodeErrorResult({ abi: [errDef] as const, data: err.data });
          decoded = r.errorName;
          break;
        } catch { /* continue */ }
      }
    }
    console.log(`    reverts: ${decoded} (data: ${err.data ?? err.message})`);
    proof.push({ step: `SIMULATE ${label}`, detail: { revert: decoded, data: err.data } });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const USDC = (n: number | string) => parseUnits(String(n), 6);
const fmt6 = (n: bigint) => formatUnits(n, 6);

async function waitAndMine(hash: Hex): Promise<void> {
  await pub.waitForTransactionReceipt({ hash });
}

async function send(
  client: WalletClient,
  to: Address,
  data: Hex
): Promise<Hex> {
  if (!client.account) throw new Error("wallet client has no account");
  const hash = await client.sendTransaction({
    account: client.account,
    chain: client.chain ?? null,
    to,
    data,
    // Arc testnet requires explicit gas price >= 20 gwei
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  await waitAndMine(hash);
  return hash;
}

async function now(): Promise<bigint> {
  const block = await pub.getBlock();
  return block.timestamp;
}

async function waitSeconds(secs: number): Promise<void> {
  console.log(`    waiting ${secs}s for on-chain time...`);
  await new Promise(r => setTimeout(r, secs * 1000 + 3000));
}

// ── EIP-712 signing helpers ──────────────────────────────────────────────────

const OFFER_TYPES = {
  MandateOffer: [
    { name: "creditorId",       type: "uint256" },
    { name: "token",            type: "address" },
    { name: "scheme",           type: "uint8"   },
    { name: "oneOff",           type: "bool"    },
    { name: "maxPerCollection", type: "uint128" },
    { name: "maxPerPeriod",     type: "uint128" },
    { name: "periodLength",     type: "uint32"  },
    { name: "prenoticeLength",  type: "uint32"  },
    { name: "offerRef",         type: "bytes32" },
    { name: "termsHash",        type: "bytes32" },
    { name: "maxUses",          type: "uint32"  },
    { name: "validUntil",       type: "uint64"  },
    { name: "timeScale",        type: "uint32"  },
    { name: "debtor",           type: "address" },
  ],
};

const ACCEPTANCE_TYPES = {
  MandateAcceptance: [
    { name: "offerHash", type: "bytes32" },
    { name: "debtor",    type: "address" },
    { name: "deadline",  type: "uint64"  },
  ],
};

const DEBTOR_ACTION_TYPES = {
  DebtorAction: [
    { name: "kind",     type: "uint8"   },
    { name: "target",   type: "bytes32" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint64"  },
  ],
};

const PERMIT_TYPES = {
  Permit: [
    { name: "owner",    type: "address" },
    { name: "spender",  type: "address" },
    { name: "value",    type: "uint256" },
    { name: "nonce",    type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

let _domainName: string | undefined;
async function getDomain(): Promise<{ name: string; version: string; chainId: number; verifyingContract: Address }> {
  if (!_domainName) {
    const result = await pub.readContract({ address: railAddr, abi: [{ name: "eip712Domain", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "fields", type: "bytes1" }, { name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }, { name: "salt", type: "bytes32" }, { name: "extensions", type: "uint256[]" }] }] as const, functionName: "eip712Domain" });
    _domainName = result[1] ?? "Recall DebitRail";
  }
  return { name: _domainName, version: "1", chainId: net.chainId, verifyingContract: railAddr };
}

async function signOffer(offer: Record<string, unknown>): Promise<Hex> {
  const domain = await getDomain();
  return creditorAccount.signTypedData({
    domain,
    types: OFFER_TYPES,
    primaryType: "MandateOffer",
    message: offer,
  });
}

async function signAcceptance(acc: Record<string, unknown>): Promise<Hex> {
  const domain = await getDomain();
  return debtorAccount.signTypedData({
    domain,
    types: ACCEPTANCE_TYPES,
    primaryType: "MandateAcceptance",
    message: acc,
  });
}

async function signDebtorAction(a: Record<string, unknown>): Promise<Hex> {
  const domain = await getDomain();
  return debtorAccount.signTypedData({
    domain,
    types: DEBTOR_ACTION_TYPES,
    primaryType: "DebtorAction",
    message: a,
  });
}

async function signPermit(
  tokenAddr: Address,
  spender: Address,
  value: bigint,
  deadline: bigint
): Promise<{ v: number; r: Hex; s: Hex }> {
  const nonce = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "nonces", args: [debtorAccount.address] });
  // The permit domain belongs to the token: read its name and version instead of assuming them.
  const [tokenName, tokenVersion] = await Promise.all([
    pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "name" }),
    pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "version" }),
  ]);
  const domain = { name: tokenName, version: tokenVersion, chainId: net.chainId, verifyingContract: tokenAddr };
  const domainSep = await pub.readContract({ address: tokenAddr, abi: ERC20_ABI, functionName: "DOMAIN_SEPARATOR" });
  if (domainSeparator({ domain }) !== domainSep) throw new Error(`Permit domain mismatch for ${tokenAddr}`);
  const sig = await debtorAccount.signTypedData({
    domain,
    types: PERMIT_TYPES,
    primaryType: "Permit",
    message: { owner: debtorAccount.address, spender, value, nonce, deadline },
  });
  // Split into v/r/s
  const r = sig.slice(0, 66) as Hex;
  const s = ("0x" + sig.slice(66, 130)) as Hex;
  const v = parseInt(sig.slice(130, 132), 16);
  return { v, r, s };
}

// ── Main ─────────────────────────────────────────────────────────────────────

console.log(`\nRecall DebitRail Lifecycle — ${network} / ${instance}`);
console.log(`Rail:    ${railAddr}`);
console.log(`Lens:    ${lensAddr}`);
console.log(`Creditor: ${creditorAccount.address}`);
console.log(`Debtor:   ${debtorAccount.address}`);
console.log(`Relayer:  ${relayerAccount.address}`);

// ── Step a: Register creditor, fund reserve ──────────────────────────────────

let creditorId = 0n;

await step("a1: registerCreditor Northwind Gym", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "registerCreditor", args: ["Northwind Gym", creditorAccount.address] });
  const hash = await send(creditor, railAddr, data);
  // Read creditorId from event (simplification: use creditorCount which just incremented)
  // creditorId is always the incremented count; we can read it from the tx receipt logs
  const receipt = await pub.getTransactionReceipt({ hash });
  // CreditorRegistered(uint256 indexed creditorId,...) — topic[1] is the id
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase());
  creditorId = log ? BigInt(log.topics[1] ?? "1") : 1n;
  return { hash, detail: { creditorId: creditorId.toString() } };
});

await step("a2: approve EURC for fundReserve", async () => {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [railAddr, USDC(10)] });
  const hash = await send(creditor, EURC_ADDR, data);
  return { hash };
});

await step("a3: fundReserve 0.10 EURC", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "fundReserve", args: [creditorId, EURC_ADDR, USDC("0.10")] });
  const hash = await send(creditor, railAddr, data);
  return { hash };
});

await step("a4: approve USDC for fundReserve", async () => {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [railAddr, USDC(10)] });
  const hash = await send(creditor, USDC_ADDR, data);
  return { hash };
});

await step("a5: fundReserve 0.10 USDC", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "fundReserve", args: [creditorId, USDC_ADDR, USDC("0.10")] });
  const hash = await send(creditor, railAddr, data);
  return { hash };
});

// ── Step b: CORE monthly EURC mandate via activateMandateWithPermit ──────────

const t0 = await now();
const validUntil = t0 + 7n * 24n * 3600n;
const accDeadline = t0 + 3600n;

const offer = {
  creditorId,
  token:            EURC_ADDR,
  scheme:           0, // CORE
  oneOff:           false,
  maxPerCollection: USDC("0.20"),
  maxPerPeriod:     USDC("0.40"),
  periodLength:     30 * 24 * 3600, // 30 days legal
  prenoticeLength:  86400,           // 1 day legal
  offerRef:         ref("NW-CORE"),
  termsHash:        keccak256(stringToHex(MANDATE_TEXT)),
  maxUses:          0,
  validUntil,
  timeScale:         1,          // wall-clock seconds (prod)
  debtor:           "0x0000000000000000000000000000000000000000" as `0x${string}`, // open offer
};

let mandateId: Hex = "0x";

await step("b1: creditor signs offer", async () => {
  await Promise.resolve();
  return { detail: { offer: { ...offer, creditorId: offer.creditorId.toString(), maxPerCollection: offer.maxPerCollection.toString(), maxPerPeriod: offer.maxPerPeriod.toString(), validUntil: offer.validUntil.toString() } } };
});

const offerSig = await signOffer(offer);

// Get the offer hash from the contract view
const offerHash = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "hashOffer", args: [offer] });

const acc = { offerHash, debtor: debtorAccount.address, deadline: accDeadline };
const debtorSig = await signAcceptance(acc);

// Build permit for 0.20 EURC (max single collection)
const permitDeadline = t0 + 3600n;
const permitSig = await signPermit(EURC_ADDR, railAddr, USDC("0.20"), permitDeadline);

await step("b2: relayer submits activateMandateWithPermit", async () => {
  const permitData = { value: USDC("0.20"), deadline: permitDeadline, v: permitSig.v, r: permitSig.r, s: permitSig.s };
  const data = encodeFunctionData({
    abi: RAIL_ABI,
    functionName: "activateMandateWithPermit",
    args: [offer, offerSig, acc, debtorSig, permitData],
  });
  const hash = await send(relayer, railAddr, data);
  const receipt = await pub.getTransactionReceipt({ hash });
  // MandateActivated — topic[1] is mandateId
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase() && l.topics.length >= 2);
  mandateId = (log?.topics[1] ?? "0x00");
  return { hash, detail: { mandateId } };
});

// ── Step c: prenotify 0.05 EURC, wait, collect → SETTLED ────────────────────

const minPre = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "minPrenotice" });
const dueAt1 = await now() + minPre + 5n;

let coll1Id: Hex = "0x";

await step("c1: prenotify 0.05 EURC", async () => {
  const e2eId = ref("e2e001");
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "prenotify", args: [mandateId, USDC("0.05"), dueAt1, e2eId, "Gym membership May"] });
  const hash = await send(creditor, railAddr, data);
  const receipt = await pub.getTransactionReceipt({ hash });
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase());
  coll1Id = (log?.topics[1] ?? "0x00");
  return { hash, detail: { collectionId: coll1Id, dueAt: dueAt1.toString() } };
});

// approve enough for the collect
await step("c2: debtor approves 0.05 EURC", async () => {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [railAddr, USDC("0.20")] });
  const hash = await send(debtor_w, EURC_ADDR, data);
  return { hash };
});

await waitSeconds(Number(minPre) + 6);

await step("c3: collect → SETTLED (fully covered)", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "collect", args: [coll1Id] });
  const hash = await send(relayer, railAddr, data);
  const col = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "getCollection", args: [coll1Id] });
  return { hash, detail: { status: col.status, locked: fmt6(col.locked), held: fmt6(col.held) } };
});

// ── Step d: debtor signs REFUND action, relayer submits ──────────────────────

const debtorNonce1 = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "nonces", args: [debtorAccount.address] });
const actionDeadline1 = await now() + 3600n;
const refundAction = { kind: 0, target: coll1Id, nonce: debtorNonce1, deadline: actionDeadline1 };
const refundSig = await signDebtorAction(refundAction);

await step("d: relayer submits executeDebtorAction REFUND → REFUNDED", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "executeDebtorAction", args: [refundAction, debtorAccount.address, refundSig] });
  const hash = await send(relayer, railAddr, data);
  const col = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "getCollection", args: [coll1Id] });
  const bal = await pub.readContract({ address: EURC_ADDR, abi: ERC20_ABI, functionName: "balanceOf", args: [debtorAccount.address] });
  return { hash, detail: { status: col.status, debtorEurcBalance: fmt6(bal) } };
});

// ── Step e: prenotify 0.15 EURC (more than free reserve) → locked+held split ─

// Reserve is 0.10 EURC; after refund it's back since refund unwinds locked from reserve.
// So free is still 0.10. Scheduling 0.15 → locked=0.10, held=0.05.
const dueAt2 = await now() + minPre + 5n;
let coll2Id: Hex;

await step("e1: prenotify 0.15 EURC (locked+held split)", async () => {
  const e2eId = ref("e2e002");
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "prenotify", args: [mandateId, USDC("0.15"), dueAt2, e2eId, "Gym membership June"] });
  const hash = await send(creditor, railAddr, data);
  const receipt = await pub.getTransactionReceipt({ hash });
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase());
  coll2Id = (log?.topics[1] ?? "0x00");
  return { hash, detail: { collectionId: coll2Id } };
});

// Need debtor to have approved full 0.15
await step("e2: debtor approves 0.15 EURC", async () => {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [railAddr, USDC("0.20")] });
  const hash = await send(debtor_w, EURC_ADDR, data);
  return { hash };
});

await waitSeconds(Number(minPre) + 6);

await step("e3: collect → SETTLED (locked + held split)", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "collect", args: [coll2Id] });
  const hash = await send(relayer, railAddr, data);
  const col = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "getCollection", args: [coll2Id] });
  const cov = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "coverage", args: [creditorId, EURC_ADDR] });
  return { hash, detail: { status: col.status, locked: fmt6(col.locked), held: fmt6(col.held), reserveLocked: fmt6(cov.reserveLocked), coverageHeld: fmt6(cov.held) } };
});

const refundWindowSecs = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "refundWindow" });
console.log(`\n    Waiting ${Number(refundWindowSecs)}s for refund window to close...`);
await waitSeconds(Number(refundWindowSecs) + 5);

await step("e4: release → FINAL (refund window closed)", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "release", args: [coll2Id] });
  const hash = await send(relayer, railAddr, data);
  const col = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "getCollection", args: [coll2Id] });
  return { hash, detail: { status: col.status } };
});

// ── Step f: USDC B2B one-off → FINAL immediately ─────────────────────────────

const t1 = await now();
const offerB2B = {
  creditorId,
  token:            USDC_ADDR,
  scheme:           1, // B2B
  oneOff:           true,
  maxPerCollection: USDC("0.10"),
  maxPerPeriod:     USDC("0.10"),
  periodLength:     30 * 24 * 3600,
  prenoticeLength:  86400,
  offerRef:         ref("b2b"),
  termsHash:        keccak256(stringToHex(MANDATE_TEXT)),
  maxUses:          1,
  validUntil:       t1 + 7200n,
  timeScale:         1,
  debtor:           debtorAccount.address, // B2B bound to specific debtor
};

const offerB2BSig   = await signOffer(offerB2B);
const offerB2BHash  = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "hashOffer", args: [offerB2B] });
const accB2B        = { offerHash: offerB2BHash, debtor: debtorAccount.address, deadline: t1 + 3600n };
const debtorSigB2B  = await signAcceptance(accB2B);

let mandateB2BId: Hex;
let collB2BId: Hex;

await step("f1: activate B2B one-off USDC mandate", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "activateMandate", args: [offerB2B, offerB2BSig, accB2B, debtorSigB2B] });
  const hash = await send(relayer, railAddr, data);
  const receipt = await pub.getTransactionReceipt({ hash });
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase() && l.topics.length >= 2);
  mandateB2BId = (log?.topics[1] ?? "0x00");
  return { hash, detail: { mandateId: mandateB2BId } };
});

const dueAtB2B = await now() + minPre + 5n;

await step("f2: prenotify 0.05 USDC", async () => {
  const e2eId = ref("e2e003");
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "prenotify", args: [mandateB2BId, USDC("0.05"), dueAtB2B, e2eId, "B2B one-off"] });
  const hash = await send(creditor, railAddr, data);
  const receipt = await pub.getTransactionReceipt({ hash });
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase());
  collB2BId = (log?.topics[1] ?? "0x00");
  return { hash, detail: { collectionId: collB2BId } };
});

await step("f3: debtor approves 0.05 USDC", async () => {
  const data = encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [railAddr, USDC("0.10")] });
  const hash = await send(debtor_w, USDC_ADDR, data);
  return { hash };
});

await waitSeconds(Number(minPre) + 6);

await step("f4: collect B2B → FINAL immediately", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "collect", args: [collB2BId] });
  const hash = await send(relayer, railAddr, data);
  const col = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "getCollection", args: [collB2BId] });
  return { hash, detail: { status: col.status, code: col.code } };
});

// ── Step g: RETURNED AM04 — debtor2 has no balance ───────────────────────────

// Use the same CORE mandate for debtor2 — but debtor2 is different from debtor.
// We need a fresh mandate for debtor2. Use a new offer.
const t2 = await now();
const offerAM04 = {
  creditorId,
  token:            EURC_ADDR,
  scheme:           0, // CORE
  oneOff:           false,
  maxPerCollection: USDC("0.10"),
  maxPerPeriod:     USDC("0.20"),
  periodLength:     30 * 24 * 3600,
  prenoticeLength:  86400,
  offerRef:         ref("am04"),
  termsHash:        keccak256(stringToHex(MANDATE_TEXT)),
  maxUses:          0,
  validUntil:       t2 + 7200n,
  timeScale:         1,
  debtor:           "0x0000000000000000000000000000000000000000" as `0x${string}`,
};

const offerAM04Sig  = await signOffer(offerAM04);
const offerAM04Hash = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "hashOffer", args: [offerAM04] });

// debtor2 signs acceptance
const accAM04 = { offerHash: offerAM04Hash, debtor: debtor2Account.address, deadline: t2 + 3600n };
const debtor2AccSig = await debtor2Account.signTypedData({
  domain: await getDomain(),
  types: ACCEPTANCE_TYPES,
  primaryType: "MandateAcceptance",
  message: accAM04,
});

let mandateAM04Id: Hex;
let collAM04Id: Hex;

await step("g1: activate mandate for debtor2 (no balance)", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "activateMandate", args: [offerAM04, offerAM04Sig, accAM04, debtor2AccSig] });
  const hash = await send(relayer, railAddr, data);
  const receipt = await pub.getTransactionReceipt({ hash });
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase() && l.topics.length >= 2);
  mandateAM04Id = (log?.topics[1] ?? "0x00");
  return { hash, detail: { mandateId: mandateAM04Id, debtor: debtor2Account.address } };
});

const dueAtAM04 = await now() + minPre + 5n;

await step("g2: prenotify 0.05 EURC for debtor2", async () => {
  const e2eId = ref("e2e004");
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "prenotify", args: [mandateAM04Id, USDC("0.05"), dueAtAM04, e2eId, "AM04 test"] });
  const hash = await send(creditor, railAddr, data);
  const receipt = await pub.getTransactionReceipt({ hash });
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase());
  collAM04Id = (log?.topics[1] ?? "0x00");
  return { hash, detail: { collectionId: collAM04Id } };
});

await waitSeconds(Number(minPre) + 6);

await step("g3: collect → RETURNED AM04 (no balance)", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "collect", args: [collAM04Id] });
  const hash = await send(relayer, railAddr, data);
  const col = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "getCollection", args: [collAM04Id] });
  return { hash, detail: { status: col.status, code: col.code } };
});

// ── Step h: refuse + revoke + prenotify reverts MD01 ─────────────────────────

// Use a fresh mandate for h — the original mandateId
const dueAtH = await now() + minPre + 5n;
let collHId: Hex = "0x";

await step("h1: prenotify for CORE mandate", async () => {
  const e2eId = ref("e2e005");
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "prenotify", args: [mandateId, USDC("0.05"), dueAtH, e2eId, "To be refused"] });
  const hash = await send(creditor, railAddr, data);
  const receipt = await pub.getTransactionReceipt({ hash });
  const log = receipt.logs.find(l => l.address.toLowerCase() === railAddr.toLowerCase());
  collHId = (log?.topics[1] ?? "0x00");
  return { hash, detail: { collectionId: collHId } };
});

const debtorNonce2 = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "nonces", args: [debtorAccount.address] });
const actionDeadline2 = await now() + 3600n;

// Debtor refuses via executeDebtorAction (kind=2: REFUSE)
const refuseAction = { kind: 2, target: collHId, nonce: debtorNonce2, deadline: actionDeadline2 };
const refuseSig = await signDebtorAction(refuseAction);

await step("h2: debtor refuses collection via executeDebtorAction", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "executeDebtorAction", args: [refuseAction, debtorAccount.address, refuseSig] });
  const hash = await send(relayer, railAddr, data);
  const col = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "getCollection", args: [collHId] });
  return { hash, detail: { status: col.status, code: col.code } };
});

// Debtor revokes mandate via executeDebtorAction (kind=1: REVOKE)
const debtorNonce3 = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "nonces", args: [debtorAccount.address] });
const revokeAction = { kind: 1, target: mandateId, nonce: debtorNonce3, deadline: await now() + 3600n };
const revokeSig = await signDebtorAction(revokeAction);

await step("h3: debtor revokes mandate via executeDebtorAction", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "executeDebtorAction", args: [revokeAction, debtorAccount.address, revokeSig] });
  const hash = await send(relayer, railAddr, data);
  const m = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "getMandate", args: [mandateId] });
  return { hash, detail: { mandateStatus: m.status } };
});

// ── Step i: simulations ───────────────────────────────────────────────────────

await simulate("collect too early (TooEarly)", async () => {
  // Use a future dueAt — schedule a new prenotify on the AM04 mandate then try to collect early
  const e2eId = ref("sim001");
  const farDue = await now() + minPre + 3600n;
  // We need a still-active mandate: use mandateAM04Id
  await pub.call({
    to: creditorAccount.address, // dummy — we're calling the rail via simulateContract
  });
  // Use simulateContract for the early collect:
  const simData = encodeFunctionData({ abi: RAIL_ABI, functionName: "prenotify", args: [mandateAM04Id, USDC("0.05"), farDue, e2eId, "sim"] });
  await pub.call({ to: railAddr, data: simData, account: creditorAccount.address });
  // The prenotify works; now collect before dueAt
  await pub.call({ to: railAddr, data: simData, account: creditorAccount.address });
  // now simulate collect on the (non-existent) cid
  throw new Error("simulation placeholder - no early collect possible without mining");
});

await simulate("prenotify over period cap (OverPeriodCap)", async () => {
  // mandateId is now REVOKED so prenotify will give MD01 — use mandateAM04Id
  const e2eId = ref("sim002");
  const dueAtSim = await now() + minPre + 5n;
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "prenotify", args: [mandateAM04Id, USDC("0.15"), dueAtSim, e2eId, "over cap"] });
  const result = await pub.call({ to: railAddr, data, account: creditorAccount.address });
  if (result.data && result.data !== "0x") throw Object.assign(new Error("call returned revert data"), { data: result.data });
});

await simulate("refund after window (RefundWindowClosed)", async () => {
  // coll2Id is FINAL; try refund
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "refund", args: [coll2Id] });
  const result = await pub.call({ to: railAddr, data, account: debtorAccount.address });
  if (result.data && result.data !== "0x") throw Object.assign(new Error("call returned revert data"), { data: result.data });
});

await simulate("withdraw locked reserve (ReserveLocked)", async () => {
  // Try to withdraw entire EURC reserve while some might be locked
  const cov = await pub.readContract({ address: railAddr, abi: RAIL_ABI, functionName: "coverage", args: [creditorId, EURC_ADDR] });
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "withdrawReserve", args: [creditorId, EURC_ADDR, cov.reserveTotal, creditorAccount.address] });
  const result = await pub.call({ to: railAddr, data, account: creditorAccount.address });
  if (result.data && result.data !== "0x") throw Object.assign(new Error("call returned revert data"), { data: result.data });
});

await simulate("refund B2B collection (NoRefundRightB2B)", async () => {
  const data = encodeFunctionData({ abi: RAIL_ABI, functionName: "refund", args: [collB2BId] });
  const result = await pub.call({ to: railAddr, data, account: debtorAccount.address });
  if (result.data && result.data !== "0x") throw Object.assign(new Error("call returned revert data"), { data: result.data });
});

// ── Final health summary ──────────────────────────────────────────────────────

const [eurcH, usdcH] = await pub.readContract({ address: lensAddr, abi: LENS_ABI, functionName: "health" });

const healthSummary = {
  eurc: {
    balance:      fmt6(eurcH.balance),
    reserves:     fmt6(eurcH.reserves),
    held:         fmt6(eurcH.held),
    claimables:   fmt6(eurcH.claimables),
    surplus:      fmt6(eurcH.surplus),
    lockedTotal:  fmt6(eurcH.lockedTotal),
    exposureTotal:fmt6(eurcH.exposureTotal),
    i1: eurcH.i1, i2: eurcH.i2, i3: eurcH.i3,
  },
  usdc: {
    balance:      fmt6(usdcH.balance),
    reserves:     fmt6(usdcH.reserves),
    held:         fmt6(usdcH.held),
    claimables:   fmt6(usdcH.claimables),
    surplus:      fmt6(usdcH.surplus),
    lockedTotal:  fmt6(usdcH.lockedTotal),
    exposureTotal:fmt6(usdcH.exposureTotal),
    i1: usdcH.i1, i2: usdcH.i2, i3: usdcH.i3,
  },
};

console.log("\n=== Final Health ===");
console.log(JSON.stringify(healthSummary, null, 2));
proof.push({ step: "health()", detail: healthSummary });

// Write proof
mkdirSync(join(HERE, "..", "proof"), { recursive: true });
const proofPath = join(HERE, "..", "proof", `${network}-${instance}-lifecycle.json`);
writeFileSync(proofPath, JSON.stringify({ network, instance, rail: railAddr, lens: lensAddr, steps: proof }, null, 2));
console.log(`\nProof written to proof/${network}-${instance}-lifecycle.json`);
console.log("\nDone.");
