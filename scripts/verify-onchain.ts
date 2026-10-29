/**
 * Read-only check of a Recall deployment against the chain. No keys, no transactions.
 *
 *   bun run scripts/verify-onchain.ts                 # Arc mainnet
 *   bun run scripts/verify-onchain.ts --network arc-testnet
 *   bun run scripts/verify-onchain.ts --rpc https://...   # override the RPC endpoint
 *
 * It checks:
 *   1. every transaction listed in proof/*.json: receipt found, status success, block, `to`;
 *   2. both rails and lenses: code present, timeScale, EIP-712 domain name, lens points at the rail;
 *   3. health() on both lenses (solvency invariants i1, i2, i3 for EURC and USDC).
 *
 * Exits 1 when any row fails.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import {
  MEMO_ADDRESS,
  RAIL_INSTANCES,
  TIME_SCALE,
  createRailClient,
  debitRailAbi,
  networkInfo,
  railAddresses,
  railDomain,
  railLensAbi,
  txUrl,
  type RailInstance,
  type RailNetwork,
} from "../packages/sdk/src";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const networkArg = arg("--network") ?? "arc";
if (networkArg !== "arc" && networkArg !== "arc-testnet") {
  console.error(`Unknown --network "${networkArg}". Use arc or arc-testnet.`);
  process.exit(2);
}
const network: RailNetwork = networkArg;
const info = networkInfo(network);
const rpcUrl = arg("--rpc") ?? info.rpcUrl;
const publicClient = createPublicClient({ chain: info.chain, transport: http(rpcUrl) }) as PublicClient;

interface Deployment {
  chainId: number;
  block: number;
  eurc: Address;
  usdc: Address;
}
const deployment = JSON.parse(readFileSync(join(root, "deployments", `${info.chainId}.json`), "utf8")) as Deployment;
const addrs = railAddresses(network);

// ── result table ─────────────────────────────────────────────────────────────

type Status = "PASS" | "FAIL" | "WARN" | "SKIP";
interface Row {
  group: string;
  subject: string;
  status: Status;
  detail: string;
}
const rows: Row[] = [];
const add = (group: string, subject: string, status: Status, detail: string) =>
  rows.push({ group, subject, status, detail });

// ── 1. proof transactions ────────────────────────────────────────────────────

interface ProofTx {
  file: string;
  label: string;
  hash: Hex;
  expectedBlock?: bigint;
  expectedTo?: string;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const HASH_KEYS = ["hash", "txHash", "transactionHash", "tx"] as const;
const LABEL_KEYS = ["step", "label", "name", "description"] as const;

function collectTxs(file: string, node: unknown, label: string, out: Map<string, ProofTx>): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => collectTxs(file, n, `${label}[${i}]`, out));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const o = node as Record<string, unknown>;
  const own = LABEL_KEYS.map((k) => o[k]).find((v): v is string => typeof v === "string") ?? label;
  for (const k of HASH_KEYS) {
    const v = o[k];
    if (typeof v === "string" && HASH.test(v)) {
      const key = v.toLowerCase();
      if (!out.has(key)) {
        const block = o["blockNumber"] ?? o["block"];
        const to = o["to"];
        out.set(key, {
          file,
          label: own,
          hash: v as Hex,
          expectedBlock: typeof block === "number" || typeof block === "string" ? BigInt(block) : undefined,
          expectedTo: typeof to === "string" ? to : undefined,
        });
      }
    }
  }
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "object") collectTxs(file, v, `${own}.${k}`, out);
  }
}

const knownTargets = new Map<string, string>();
for (const inst of RAIL_INSTANCES) {
  knownTargets.set(addrs[inst].rail.toLowerCase(), `${inst} rail`);
  knownTargets.set(addrs[inst].lens.toLowerCase(), `${inst} lens`);
}
knownTargets.set(deployment.eurc.toLowerCase(), "EURC");
knownTargets.set(deployment.usdc.toLowerCase(), "USDC");
knownTargets.set(MEMO_ADDRESS.toLowerCase(), "Memo predeploy");

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
}

async function checkProofs(): Promise<void> {
  const dir = join(root, "proof");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
  if (files.length === 0) {
    add("proof", "proof/*.json", "WARN", "no proof files found, so no transactions were checked");
    return;
  }

  const txs = new Map<string, ProofTx>();
  for (const f of files) {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch (e) {
      add("proof", f, "FAIL", `not valid JSON: ${(e as Error).message}`);
      continue;
    }
    const meta = (typeof json === "object" && json !== null ? json : {}) as { network?: unknown; chainId?: unknown };
    if ((typeof meta.network === "string" && meta.network !== network) || (typeof meta.chainId === "number" && meta.chainId !== info.chainId)) {
      add("proof", f, "SKIP", `belongs to ${String(meta.network ?? meta.chainId)}, not ${network}`);
      continue;
    }
    const before = txs.size;
    collectTxs(f, json, f, txs);
    if (txs.size === before) add("proof", f, "WARN", "no transaction hashes found in this file");
  }

  const list = [...txs.values()];
  const results = await mapLimit(list, 4, async (t): Promise<Row> => {
    const subject = `${t.hash.slice(0, 10)}…${t.hash.slice(-6)}`;
    const group = `proof ${t.file}`;
    try {
      const receipt = await withRetry(() => publicClient.getTransactionReceipt({ hash: t.hash }));
      const problems: string[] = [];
      if (receipt.status !== "success") problems.push(`status ${receipt.status}`);
      if (receipt.blockNumber < BigInt(deployment.block)) problems.push(`block ${receipt.blockNumber} is before the deployment block ${deployment.block}`);
      if (t.expectedBlock !== undefined && receipt.blockNumber !== t.expectedBlock) problems.push(`block ${receipt.blockNumber}, proof says ${t.expectedBlock}`);
      const to = receipt.to?.toLowerCase();
      const toName = to ? knownTargets.get(to) : undefined;
      if (!to) problems.push("contract creation, not a call");
      else if (!toName) problems.push(`to ${receipt.to} is not a Recall contract, token or the Memo predeploy`);
      if (t.expectedTo && to && t.expectedTo.toLowerCase() !== to) problems.push(`to ${receipt.to}, proof says ${t.expectedTo}`);
      const detail = `${t.label} | block ${receipt.blockNumber} | to ${toName ?? receipt.to ?? "?"}`;
      return { group, subject, status: problems.length ? "FAIL" : "PASS", detail: problems.length ? `${problems.join("; ")} | ${detail}` : detail };
    } catch (e) {
      return { group, subject, status: "FAIL", detail: `${t.label} | receipt not found (${(e as Error).message.split("\n")[0]})` };
    }
  });
  rows.push(...results);
}

// ── 2 + 3. contracts and health ──────────────────────────────────────────────

const DOMAIN_NAME: Record<RailInstance, string> = {
  prod: "Recall DebitRail",
  demo: "Recall DebitRail DEMO (1 week = 1 minute)",
};

async function checkInstance(inst: RailInstance): Promise<void> {
  const { rail, lens } = addrs[inst];
  const group = `${inst} instance`;

  for (const [what, address] of [["rail", rail], ["lens", lens]] as const) {
    const code = await withRetry(() => publicClient.getCode({ address }));
    add(group, `${what} code`, code && code !== "0x" ? "PASS" : "FAIL", address);
  }

  try {
    const [ts, label, lensRail, domain] = await withRetry(() =>
      Promise.all([
        publicClient.readContract({ address: rail, abi: debitRailAbi, functionName: "timeScale" }),
        publicClient.readContract({ address: rail, abi: debitRailAbi, functionName: "label" }),
        publicClient.readContract({ address: lens, abi: railLensAbi, functionName: "rail" }),
        railDomain(publicClient, rail),
      ]),
    );
    add(group, "timeScale", ts === TIME_SCALE[inst] ? "PASS" : "FAIL", `${ts} (expected ${TIME_SCALE[inst]})`);
    add(group, "label", label === inst ? "PASS" : "FAIL", `"${label}"`);
    add(group, "lens.rail()", lensRail.toLowerCase() === rail.toLowerCase() ? "PASS" : "FAIL", lensRail);
    add(group, "EIP-712 domain", domain.name === DOMAIN_NAME[inst] && domain.chainId === info.chainId && domain.verifyingContract.toLowerCase() === rail.toLowerCase() ? "PASS" : "FAIL", `"${domain.name}" chain ${domain.chainId}`);
  } catch (e) {
    add(group, "rail reads", "FAIL", (e as Error).message.split("\n")[0] ?? "read failed");
  }

  try {
    const client = createRailClient({ network, instance: inst, publicClient });
    const h = await withRetry(() => client.health());
    for (const [sym, t] of [["EURC", h.eurc], ["USDC", h.usdc]] as const) {
      const ok = t.i1 && t.i2 && t.i3;
      const expectedToken = sym === "EURC" ? deployment.eurc : deployment.usdc;
      const tokenOk = t.token.toLowerCase() === expectedToken.toLowerCase();
      add(
        group,
        `health() ${sym}`,
        ok && tokenOk ? "PASS" : "FAIL",
        `i1=${t.i1} i2=${t.i2} i3=${t.i3} | balance ${t.balance} reserves ${t.reserves} held ${t.held} claimables ${t.claimables} surplus ${t.surplus}${tokenOk ? "" : ` | token ${t.token} != ${expectedToken}`}`,
      );
    }
  } catch (e) {
    add(group, "health()", "FAIL", (e as Error).message.split("\n")[0] ?? "read failed");
  }
}

// ── run + print ──────────────────────────────────────────────────────────────

console.log(`Recall onchain verification: ${info.chain.name} (chain ${info.chainId})`);
console.log(`RPC ${rpcUrl}\n`);

try {
  const chainId = await withRetry(() => publicClient.getChainId());
  if (chainId !== info.chainId) {
    console.error(`RPC reports chain ${chainId}, expected ${info.chainId}. Aborting.`);
    process.exit(2);
  }
} catch (e) {
  console.error(`Cannot reach the RPC: ${(e as Error).message.split("\n")[0]}`);
  process.exit(2);
}

await checkProofs();
for (const inst of RAIL_INSTANCES) await checkInstance(inst);

const w = (key: keyof Row) => Math.max(key.length, ...rows.map((r) => r[key].length));
const wGroup = Math.min(w("group"), 34);
const wSubject = Math.min(w("subject"), 26);
const line = (g: string, s: string, st: string, d: string) =>
  `${g.padEnd(wGroup)}  ${s.padEnd(wSubject)}  ${st.padEnd(4)}  ${d}`;

console.log(line("GROUP", "CHECK", "RES", "DETAIL"));
console.log("-".repeat(wGroup + wSubject + 20));
for (const r of rows) console.log(line(r.group.slice(0, wGroup), r.subject.slice(0, wSubject), r.status, r.detail));

const count = (s: Status) => rows.filter((r) => r.status === s).length;
console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("WARN")} warnings, ${count("SKIP")} skipped`);
const proofChecked = rows.filter((r) => r.group.startsWith("proof ") && (r.status === "PASS" || r.status === "FAIL")).length;
console.log(`${proofChecked} proof transaction(s) checked. Explorer: ${txUrl(network, "<hash>").replace("/tx/<hash>", "")}`);

process.exit(count("FAIL") > 0 ? 1 : 0);
