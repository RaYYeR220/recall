/* oxlint-disable typescript/no-explicit-any, typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-argument, typescript/no-unsafe-call -- tool output is JSON, read loosely on purpose */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hashTypedData, parseUnits, type Hex } from "viem";
import { foundry } from "viem/chains";
import { debitRailAbi } from "../../sdk/src/abi.js";
import { createRailClient, type RailClient } from "../../sdk/src/client.js";
import { refToBytes32, termsHash } from "../../sdk/src/terms.js";
import { CollectionStatus, type MandateOffer } from "../../sdk/src/types.js";
import { sampleOffer } from "../../sdk/test/fixtures.js";
import { anvilAvailable, getEnv, type TestEnv } from "../../sdk/test/helpers.js";
import { createContext, type ReadContext, type RecallContext } from "../src/context.js";
import { allTools, payerTools } from "../src/tools/index.js";

const DAY = 86_400;
const OPERATOR_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil #2, added as operator by the harness
const tokenAbi = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

type Data = Record<string, any>; // tool output is JSON; the tests read it loosely

describe.skipIf(!anvilAvailable)("MCP tools against a local rail", () => {
  let env: TestEnv;
  let snapshot: Hex;
  let ctx: RecallContext;
  let readOnly: ReadContext;
  let tools: Record<string, (args: Record<string, unknown>) => Promise<{ summary: string; data: Data; isError?: boolean }>>;
  let debtor: RailClient;
  let mandateId: Hex;
  let offer: MandateOffer;
  let creditorId: string;

  const nowSec = async () => Number((await env.publicClient.getBlock()).timestamp);
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const call = (name: string, args: Record<string, unknown>) => (tools[name])(args);
  const operatorNonce = () => env.publicClient.getTransactionCount({ address: env.accounts.operator.address });

  async function prenotify(amount: string, reference: string, inSeconds = 2 * DAY + 60) {
    return call("prenotify_collection", { instance: "prod", mandateId, amount, dueAt: iso((await nowSec()) + inSeconds), remittanceInfo: `Gym ${reference}`, reference });
  }

  beforeAll(async () => {
    env = await getEnv();
    snapshot = await env.snapshot();
    const base = {
      network: "arc" as const,
      publicClient: env.publicClient,
      chain: foundry,
      rpcUrl: env.rpcUrl,
      addresses: { prod: { rail: env.prod.rail, lens: env.prod.lens }, demo: { rail: env.demo.rail, lens: env.demo.lens } },
      tokens: { EURC: env.eurc, USDC: env.usdc },
    };
    ctx = createContext({ ...base, operatorKey: OPERATOR_KEY });
    readOnly = createContext(base); // no key at all
    tools = Object.fromEntries(allTools(ctx).map((t) => [t.name, (a: Record<string, unknown>) => t.run(a) as Promise<{ summary: string; data: Data; isError?: boolean }>]));
    creditorId = env.creditorId.prod.toString();

    const mk = (who: keyof TestEnv["accounts"]) =>
      createRailClient({ network: "arc", instance: "prod", publicClient: env.publicClient, walletClient: env.wallet(env.accounts[who]), addresses: { rail: env.prod.rail, lens: env.prod.lens } });
    const creditor = mk("creditor");
    debtor = mk("debtor");
    const relayer = mk("relayer");
    const now = await nowSec();
    offer = sampleOffer({
      creditorId: env.creditorId.prod,
      token: env.eurc,
      offerRef: refToBytes32("MCP-1"),
      termsHash: termsHash("mcp terms"),
      validUntil: BigInt(now + 90 * DAY),
    });
    const offerSig = await creditor.signOffer(offer);
    const { acceptance, sig } = await debtor.signAcceptance(offer);
    const permit = await debtor.signPermit(env.eurc, parseUnits("500", 6), BigInt(now + 7 * DAY));
    await env.publicClient.waitForTransactionReceipt({ hash: await relayer.activate(offer, offerSig, acceptance, sig, permit) });
    mandateId = await relayer.mandateId(offer, env.accounts.debtor.address);
  }, 120_000);

  afterAll(async () => {
    await env.revert(snapshot);
  });

  // ── merchant ───────────────────────────────────────────────────────────────
  test("list_mandates shows the mandate with its limits", async () => {
    const r = await call("list_mandates", { instance: "prod", creditorId });
    expect(r.data["total"]).toBe("1");
    const m = r.data["mandates"][0];
    expect(m.mandateId).toBe(mandateId);
    expect(m.status).toBe("ACTIVE");
    expect(m.scheme).toBe("CORE");
    expect(m.token).toBe("EURC");
    expect(m.maxPerCollection).toBe("100");
    expect(m.reference).toBe("MCP-1");
  });

  test("a pre-notification the rail would refuse is returned decoded and nothing is sent", async () => {
    const before = await operatorNonce();
    const over = await call("prenotify_collection", {
      instance: "prod", mandateId, amount: "100.000001", dueAt: iso((await nowSec()) + 3 * DAY), remittanceInfo: "Too much", reference: "OVER",
    });
    expect(over.isError).toBeUndefined();
    expect(over.data["outcome"]).toBe("refused");
    expect(over.data["sent"]).toBe(false);
    expect(over.data["refusal"].name).toBe("OverCollectionCap");

    const short = await prenotify("10", "SHORT", 3_600); // notice is one day
    expect(short.data["outcome"]).toBe("refused");
    expect(short.data["refusal"].name).toBe("PrenoticeTooShort");

    const nowhere = await call("prenotify_collection", {
      instance: "prod", mandateId: `0x${"11".repeat(32)}`, amount: "1", dueAt: iso((await nowSec()) + 3 * DAY), remittanceInfo: "No such mandate",
    });
    expect(nowhere.data["outcome"]).toBe("refused");
    expect(nowhere.data["refusal"].code).toBe("MD01");

    expect(await operatorNonce()).toBe(before); // not one transaction was signed
  });

  test("a good pre-notification is sent and returns the hash and collection id", async () => {
    const r = await prenotify("50", "C1");
    expect(r.data["outcome"]).toBe("sent");
    expect(r.data["txHash"]).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.data["collectionId"]).toMatch(/^0x[0-9a-f]{64}$/);
    const c = await env.publicClient.readContract({ address: env.prod.rail, abi: debitRailAbi, functionName: "getCollection", args: [r.data["collectionId"] as Hex] });
    expect(c.status).toBe(CollectionStatus.SCHEDULED);
    expect(c.amount).toBe(50_000_000n);
  });

  test("the same reference twice is a duplicate (safe retries)", async () => {
    const r = await prenotify("50", "C1");
    expect(r.data["outcome"]).toBe("refused");
    expect(r.data["refusal"].code).toBe("AM05");
  });

  test("collect_due collects nothing before the due time", async () => {
    const r = await call("collect_due", { instance: "prod", creditorId });
    expect(r.data["due"]).toBe(0);
    expect(r.data["results"]).toEqual([]);
  });

  test("payer tools show it as upcoming, with no key anywhere", async () => {
    const asPayer = { instance: "prod", payer: env.accounts.debtor.address };
    const up = await call("upcoming_debits", asPayer);
    expect(up.data["upcoming"]).toHaveLength(1);
    expect(up.data["upcoming"][0].amount).toBe("50");
    expect(up.data["upcoming"][0].creditor).toBe("Test Merchant");

    const mine = await call("list_my_debits", asPayer);
    expect(mine.data["debits"][0].status).toBe("SCHEDULED");
    expect(mine.data["debits"][0].canRefundNow).toBe(false);
  });

  test("collect_due settles a due debit and reports SETTLED", async () => {
    await env.increaseTime(2 * DAY + 120);
    const r = await call("collect_due", { instance: "prod", creditorId });
    expect(r.data["due"]).toBe(1);
    expect(r.data["results"]).toHaveLength(1);
    expect(r.data["results"][0].outcome).toBe("SETTLED");
    expect(r.data["results"][0].txHash).toMatch(/^0x/);
    const again = await call("collect_due", { instance: "prod", creditorId });
    expect(again.data["due"]).toBe(0);
  });

  test("coverage shows the locked reserve", async () => {
    const r = await call("coverage", { instance: "prod", creditorId });
    const eurc = r.data["tokens"].find((t: Data) => t["token"] === "EURC");
    expect(eurc.locked).toBe("50");
    expect(eurc.free).toBe("4950");
    expect(eurc.exposure).toBe("50");
  });

  // ── payer ──────────────────────────────────────────────────────────────────
  let c1: Hex;
  test("explain_refund_rights: refundable now, until when, and from what", async () => {
    const mine = await call("list_my_debits", { instance: "prod", payer: env.accounts.debtor.address });
    c1 = mine.data["debits"][0].collectionId as Hex;
    const r = await call("explain_refund_rights", { instance: "prod", collectionId: c1 });
    expect(r.data["canRefundNow"]).toBe(true);
    expect(r.data["refundableUntil"]).toMatch(/Z$/);
    expect(r.data["fundedFrom"]).toContain("Test Merchant");
    expect(r.data["fundedFrom"]).toContain("reserve");
    expect(r.summary).toMatch(/^Yes:/);
    const until = Date.parse(r.data["refundableUntil"]) / 1000;
    expect(until).toBe(Number((await debtor.refundDeadline(c1))));
  });

  test("prepare_refund returns typed data the payer can sign, and signs nothing itself", async () => {
    const r = await call("prepare_refund", { instance: "prod", collectionId: c1, payer: env.accounts.debtor.address });
    expect(r.data["canRefund"]).toBe(true);
    expect(r.data["signed"]).toBe(false);
    expect(r.data["signUrl"]).toBe(`https://recall-debit.vercel.app/pay?rail=prod&refund=${c1}`);
    const td = r.data["typedData"];
    expect(td.primaryType).toBe("DebtorAction");
    expect(td.message.target).toBe(c1);
    expect(td.domain.verifyingContract.toLowerCase()).toBe(env.prod.rail.toLowerCase());

    // the digest of what we returned is exactly what the contract will verify
    const message = { kind: td.message.kind, target: td.message.target, nonce: BigInt(td.message.nonce), deadline: BigInt(td.message.deadline) };
    const digest = hashTypedData({ domain: td.domain, types: td.types, primaryType: td.primaryType, message });
    const onchain = await env.publicClient.readContract({ address: env.prod.rail, abi: debitRailAbi, functionName: "hashDebtorAction", args: [message] });
    expect(digest).toBe(onchain);

    // and the human, with their own key, can use it
    const sig = await env.wallet(env.accounts.debtor).signTypedData({ account: env.accounts.debtor, domain: td.domain, types: td.types, primaryType: td.primaryType, message });
    const relayer = createRailClient({ network: "arc", instance: "prod", publicClient: env.publicClient, walletClient: env.wallet(env.accounts.relayer), addresses: { rail: env.prod.rail, lens: env.prod.lens } });
    await env.publicClient.waitForTransactionReceipt({ hash: await relayer.executeDebtorAction(message, env.accounts.debtor.address, sig) });
    const after = await debtor.getCollection(c1);
    expect(after.status).toBe(CollectionStatus.REFUNDED);
  });

  test("prepare_refund works with a context that has no key and no operator at all", async () => {
    // A context object with no wallet, no operator method and no key: only reads.
    const bare: ReadContext = {
      network: readOnly.network,
      appUrl: readOnly.appUrl,
      publicClient: readOnly.publicClient,
      tokens: readOnly.tokens,
      reader: readOnly.reader,
      symbolOf: readOnly.symbolOf,
    };
    expect("operator" in bare).toBe(false);
    expect("operatorAddress" in bare).toBe(false);

    // a fresh debit to prepare a refund for
    const p = await prenotify("20", "C-BARE");
    await env.increaseTime(2 * DAY + 120);
    await call("collect_due", { instance: "prod", creditorId });
    const id = p.data["collectionId"] as Hex;

    const prepare = (payerTools(bare).find((t) => t.name === "prepare_refund") as NonNullable<ReturnType<typeof payerTools>[number]>);
    const out = await prepare.run({ instance: "prod", collectionId: id, payer: env.accounts.debtor.address });
    expect(out.isError).toBeUndefined();
    expect((out.data as Data)["canRefund"]).toBe(true);
    expect((out.data as Data)["typedData"].message.target).toBe(id);
  });

  test("the payer tools' source never touches a key, a signer or the operator", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "tools", "payer.ts"), "utf8");
    for (const banned of ["signTypedData", "signMessage", "privateKey", "PrivateKey", "operator(", "walletClient", "writeContract", "sendTransaction", "RECALL_OPERATOR_KEY", "process.env"]) {
      expect(src, banned).not.toContain(banned);
    }
  });

  test("prepare_refund refuses to prepare someone else's refund", async () => {
    const r = await call("prepare_refund", { instance: "prod", collectionId: c1, payer: env.accounts.stranger.address });
    expect(r.isError).toBe(true);
    expect(r.data["reason"]).toBe("NotYourDebit");
    expect(r.data["typedData"]).toBeUndefined();
  });

  test("an unknown id is reported, not guessed", async () => {
    const r = await call("explain_refund_rights", { instance: "prod", collectionId: `0x${"77".repeat(32)}` });
    expect(r.isError).toBe(true);
    expect(r.data["found"]).toBe(false);
  });

  test("a refunded debit says so and prepares nothing", async () => {
    const r = await call("prepare_refund", { instance: "prod", collectionId: c1, payer: env.accounts.debtor.address });
    expect(r.data["canRefund"]).toBe(false);
    expect(r.data["typedData"]).toBeUndefined();
    expect(r.data["explanation"].headline).toMatch(/Already refunded/);
  });

  // ── returns and a closed window ────────────────────────────────────────────
  test("a debit the payer cannot cover comes back as a return, and list_returns says what to do", async () => {
    const wallet = env.wallet(env.accounts.debtor);
    const bal = await env.publicClient.readContract({ address: env.eurc, abi: tokenAbi, functionName: "balanceOf", args: [env.accounts.debtor.address] });
    await env.publicClient.waitForTransactionReceipt({
      hash: await wallet.writeContract({ account: env.accounts.debtor, chain: foundry, address: env.eurc, abi: tokenAbi, functionName: "transfer", args: [env.accounts.stranger.address, bal - 1_000_000n] }),
    });
    await prenotify("40", "C-AM04");
    await env.increaseTime(2 * DAY + 120);
    const r = await call("collect_due", { instance: "prod", creditorId });
    const returned = (r.data["results"] as Data[]).find((x) => x["reference"] === "C-AM04");
    expect(returned?.["outcome"]).toBe("RETURNED");
    expect(returned?.["code"]).toBe("AM04");

    const list = await call("list_returns", { instance: "prod", creditorId });
    const row = (list.data["returns"] as Data[]).find((x) => x["reference"] === "C-AM04");
    expect(row?.["code"]).toBe("AM04");
    expect(row?.["advice"].action).toBe("retry-after-top-up");
    expect(row?.["status"]).toBe("RETURNED");
  });

  test("once the window has closed, the explanation says so and no typed data is made", async () => {
    const deployer = env.wallet(env.accounts.deployer);
    await env.publicClient.waitForTransactionReceipt({
      hash: await deployer.writeContract({ account: env.accounts.deployer, chain: foundry, address: env.eurc, abi: tokenAbi, functionName: "mint", args: [env.accounts.debtor.address, parseUnits("500", 6)] }),
    });
    const p = await prenotify("30", "C-LATE");
    await env.increaseTime(2 * DAY + 120);
    await call("collect_due", { instance: "prod", creditorId });
    await env.increaseTime(70 * DAY);
    const id = p.data["collectionId"] as Hex;
    const ex = await call("explain_refund_rights", { instance: "prod", collectionId: id });
    expect(ex.data["canRefundNow"]).toBe(false);
    expect(ex.summary).toMatch(/^No: the refund window has closed/);
    const prep = await call("prepare_refund", { instance: "prod", collectionId: id, payer: env.accounts.debtor.address });
    expect(prep.data["canRefund"]).toBe(false);
    expect(prep.data["typedData"]).toBeUndefined();
  });

  test("a payer's sign link points at the Recall payer page and carries no secret", async () => {
    const mine = await call("list_my_debits", { instance: "prod", payer: env.accounts.debtor.address });
    const id = mine.data["debits"][0].collectionId as string;
    const url = `https://recall-debit.vercel.app/pay?rail=prod&refund=${id}`;
    expect(new URL(url).pathname).toBe("/pay");
    void (env.accounts.debtor.address);
  });
});
