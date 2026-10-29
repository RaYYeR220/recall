import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeFunctionData, parseUnits, toHex, type Address, type Hex } from "viem";
import { debitRailAbi } from "../src/abi";
import { createRailClient, encodeMemoCall, RelayError, serializeForRelay, type RailClient } from "../src/client";
import { decodeRailError, returnCodeLabel } from "../src/errors";
import { memoAbi, erc20Abi } from "../src/erc20";
import { MEMO_ADDRESS } from "../src/networks";
import { refToBytes32, termsHash } from "../src/terms";
import { ActionKind, CollectionStatus, MandateStatus, ZERO_ADDRESS, type MandateOffer } from "../src/types";
import { bytes32, rejection, sampleOffer } from "./fixtures";
import { anvilAvailable, getEnv, type TestEnv } from "./helpers";

const DAY = 86_400n;

describe.skipIf(!anvilAvailable)("RailClient against a local rail", () => {
  let env: TestEnv;
  let snapshot: Hex;
  let creditor: RailClient;
  let operator: RailClient;
  let debtor: RailClient;
  let relayer: RailClient;
  let offer: MandateOffer;
  let mandateId: Hex;
  const e2e1 = refToBytes32("E2E-0001");
  const e2e2 = refToBytes32("E2E-0002");
  let collection1: Hex;
  let collection2: Hex;
  let now: bigint;

  const mk = (who: keyof TestEnv["accounts"]) =>
    createRailClient({
      network: "arc",
      instance: "prod",
      publicClient: env.publicClient,
      walletClient: env.wallet(env.accounts[who]),
      addresses: { rail: env.prod.rail, lens: env.prod.lens },
    });

  async function mined(hash: Hex) {
    const r = await env.publicClient.waitForTransactionReceipt({ hash });
    expect(r.status).toBe("success");
    return r;
  }

  async function failure(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      return decodeRailError(e);
    }
    throw new Error("expected the call to revert");
  }

  beforeAll(async () => {
    env = await getEnv();
    snapshot = await env.snapshot();
    creditor = mk("creditor");
    operator = mk("operator");
    debtor = mk("debtor");
    relayer = mk("relayer");
    now = (await env.publicClient.getBlock()).timestamp;
    offer = sampleOffer({
      creditorId: env.creditorId.prod,
      token: env.eurc,
      offerRef: refToBytes32("FLOW-1"),
      termsHash: termsHash("flow terms"),
      validUntil: now + 30n * DAY,
    });
  }, 120_000);

  afterAll(async () => {
    await env.setCode(MEMO_ADDRESS, "0x");
    await env.revert(snapshot);
  });

  test("a relayer activates the mandate with the payer's acceptance and permit (payer pays no gas)", async () => {
    const offerSig = await creditor.signOffer(offer);
    const { acceptance, sig } = await debtor.signAcceptance(offer);
    const permit = await debtor.signPermit(env.eurc, parseUnits("500", 6), now + 7n * DAY);
    const gasBefore = await env.publicClient.getBalance({ address: env.accounts.debtor.address });

    await mined(await relayer.activate(offer, offerSig, acceptance, sig, permit));

    mandateId = await relayer.mandateId(offer, env.accounts.debtor.address);
    const m = await relayer.getMandate(mandateId);
    expect(m.status).toBe(MandateStatus.ACTIVE);
    expect(m.debtor).toBe(env.accounts.debtor.address);
    expect(await env.publicClient.getBalance({ address: env.accounts.debtor.address })).toBe(gasBefore);
    const allowance = await env.publicClient.readContract({
      address: env.eurc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [env.accounts.debtor.address, env.prod.rail],
    });
    expect(allowance).toBe(parseUnits("500", 6));
  });

  test("offerHash and mandateId agree with the contract", async () => {
    const onchain = await env.publicClient.readContract({
      address: env.prod.rail,
      abi: debitRailAbi,
      functionName: "hashOffer",
      args: [offer],
    });
    expect(await relayer.offerHash(offer)).toBe(onchain);
  });

  test("an operator pre-notifies a collection (direct call when there is no Memo predeploy)", async () => {
    const dueAt = now + 2n * DAY + 600n;
    const hash = await operator.prenotify(mandateId, parseUnits("50", 6), dueAt, e2e1, "Membership November");
    await mined(hash);
    const tx = await env.publicClient.getTransaction({ hash });
    expect(tx.to?.toLowerCase()).toBe(env.prod.rail.toLowerCase());
    collection1 = operator.collectionId(mandateId, e2e1);
    const c = await operator.getCollection(collection1);
    expect(c.status).toBe(CollectionStatus.SCHEDULED);
    expect(c.e2eId).toBe(e2e1);
    expect(c.amount).toBe(parseUnits("50", 6));
  });

  test("collecting early reverts with a decodable TooEarly", async () => {
    const err = await failure(relayer.collect(collection1));
    expect(err.name).toBe("TooEarly");
    expect(err.message).toBe("This collection is not due yet.");
  });

  test("after the due date anyone collects, and the lens reports healthy reserves", async () => {
    await env.increaseTime(Number(2n * DAY + 700n));
    await mined(await relayer.collect(collection1));
    const c = await relayer.getCollection(collection1);
    expect(c.status).toBe(CollectionStatus.SETTLED);

    const deadline = await relayer.refundDeadline(collection1);
    const w = await relayer.windows();
    expect(deadline).toBe(c.settledAt + w.refundWindow);

    const health = await relayer.health();
    for (const h of [health.eurc, health.usdc]) expect([h.i1, h.i2, h.i3]).toEqual([true, true, true]);
    const cov = await relayer.coverage(env.creditorId.prod);
    expect(cov.eurc.reserveLocked).toBe(parseUnits("50", 6));
    expect(cov.eurc.openExposure).toBe(parseUnits("50", 6));
  });

  test("the payer signs a REFUND, a relayer submits it, the replay is rejected", async () => {
    const signed = await debtor.signDebtorAction("REFUND", collection1);
    expect(signed.action.kind).toBe(ActionKind.REFUND);
    expect(signed.action.nonce).toBe(0n);

    await mined(await relayer.executeDebtorAction(signed.action, signed.debtor, signed.sig));
    expect((await relayer.getCollection(collection1)).status).toBe(CollectionStatus.REFUNDED);
    expect(await relayer.nonce(env.accounts.debtor.address)).toBe(1n);

    const err = await failure(relayer.executeDebtorAction(signed.action, signed.debtor, signed.sig));
    expect(err.name).toBe("BadNonce");
  });

  test("an expired signed action is rejected", async () => {
    const signed = await debtor.signDebtorAction("REVOKE", mandateId, { deadline: 1n });
    const err = await failure(relayer.executeDebtorAction(signed.action, signed.debtor, signed.sig));
    expect(err.name).toBe("SignatureExpired");
  });

  test("the payer refuses a scheduled collection with a signature", async () => {
    const dueAt = (await env.publicClient.getBlock()).timestamp + 2n * DAY;
    await mined(await operator.prenotify(mandateId, parseUnits("20", 6), dueAt, e2e2, "Extra"));
    collection2 = operator.collectionId(mandateId, e2e2);
    const signed = await debtor.signDebtorAction("REFUSE", collection2);
    await mined(await relayer.executeDebtorAction(signed.action, signed.debtor, signed.sig));
    const c = await relayer.getCollection(collection2);
    expect(c.status).toBe(CollectionStatus.REFUSED);
    expect(returnCodeLabel(c.code)).toBe("Refused by the payer");
  });

  test("lens reads: debtorView, creditorView and collectionsPage", async () => {
    const dv = await debtor.debtorView(env.accounts.debtor.address);
    expect(dv.total).toBe(1n);
    expect(dv.views[0]?.id).toBe(mandateId);
    expect(dv.views[0]?.collectionCount).toBe(2n);

    const cv = await creditor.creditorView(env.creditorId.prod, 0, 10);
    expect(cv.total).toBe(1n);
    expect((await creditor.creditorView(env.creditorId.prod, 5)).views).toEqual([]);

    const page = await creditor.collectionsPage(mandateId, 0, 1);
    expect(page.total).toBe(2n);
    expect(page.page.length).toBe(1);
    expect(page.page[0]?.e2eId).toBe(e2e1);
    expect((await creditor.collectionsPage(mandateId, 1)).page[0]?.e2eId).toBe(e2e2);
  });

  describe("Memo predeploy routing", () => {
    beforeAll(async () => {
      // A contract that just STOPs: calls to it succeed and do nothing, so we can inspect the calldata.
      await env.setCode(MEMO_ADDRESS, "0x00");
    });
    afterAll(async () => {
      await env.setCode(MEMO_ADDRESS, "0x");
    });

    test("prenotify from an EOA is wrapped in memo(target, data, e2eId, utf8(remittanceInfo))", async () => {
      const e2e = refToBytes32("MEMO-PRE");
      const dueAt = (await env.publicClient.getBlock()).timestamp + 2n * DAY;
      const hash = await operator.prenotify(mandateId, parseUnits("5", 6), dueAt, e2e, "Memo test é");
      await mined(hash);
      const tx = await env.publicClient.getTransaction({ hash });
      expect(tx.to?.toLowerCase()).toBe(MEMO_ADDRESS.toLowerCase());
      expect(tx.from.toLowerCase()).toBe(env.accounts.operator.address.toLowerCase());

      const memo = decodeFunctionData({ abi: memoAbi, data: tx.input });
      const [target, data, memoId, memoData] = memo.args;
      expect(target.toLowerCase()).toBe(env.prod.rail.toLowerCase());
      expect(memoId).toBe(e2e);
      expect(memoData).toBe(toHex("Memo test é"));
      const inner = decodeFunctionData({ abi: debitRailAbi, data });
      expect(inner.functionName).toBe("prenotify");
      expect(inner.args?.[3]).toBe(e2e);
      expect(inner.args?.[4]).toBe("Memo test é");
    });

    test("viaMemo: false calls the rail directly", async () => {
      const e2e = refToBytes32("MEMO-DIRECT");
      const dueAt = (await env.publicClient.getBlock()).timestamp + 2n * DAY;
      const hash = await operator.prenotify(mandateId, parseUnits("5", 6), dueAt, e2e, "Direct", { viaMemo: false });
      await mined(hash);
      const tx = await env.publicClient.getTransaction({ hash });
      expect(tx.to?.toLowerCase()).toBe(env.prod.rail.toLowerCase());
      expect((await operator.getCollection(operator.collectionId(mandateId, e2e))).status).toBe(
        CollectionStatus.SCHEDULED,
      );
    });

    test("collect uses the stored e2eId as memo id", async () => {
      const hash = await relayer.collect(collection2, { remittanceInfo: "Extra" });
      // collection2 is REFUSED, so the real rail would reject it. The STOP memo accepts, which is what we inspect.
      const tx = await env.publicClient.getTransaction({ hash });
      expect(tx.to?.toLowerCase()).toBe(MEMO_ADDRESS.toLowerCase());
      const [target, data, memoId, memoData] = decodeFunctionData({ abi: memoAbi, data: tx.input }).args;
      expect(target.toLowerCase()).toBe(env.prod.rail.toLowerCase());
      expect(memoId).toBe(e2e2);
      expect(memoData).toBe(toHex("Extra"));
      expect(decodeFunctionData({ abi: debitRailAbi, data }).functionName).toBe("collect");
    });

    test("collect on an unknown collection skips the memo so the rail's own error comes back", async () => {
      const err = await failure(relayer.collect(`0x${"99".repeat(32)}`));
      expect(err.name).not.toBe("UnknownError");
    });

    test("encodeMemoCall handles empty remittance text", () => {
      const data = encodeMemoCall(env.prod.rail, "0x1234", e2e1, "");
      expect(decodeFunctionData({ abi: memoAbi, data }).args[3]).toBe("0x");
    });
  });

  test("the payer revokes the mandate", async () => {
    await mined(await debtor.revoke(mandateId));
    expect((await debtor.getMandate(mandateId)).status).toBe(MandateStatus.REVOKED);
    const err = await failure(operator.prenotify(mandateId, 1_000_000n, 1n, refToBytes32("LATE"), "x", { viaMemo: false }));
    expect(err.code).toBe("MD01");
  });

  test("a client without a wallet can read but not write", async () => {
    const ro = createRailClient({
      network: "arc",
      instance: "prod",
      publicClient: env.publicClient,
      addresses: { rail: env.prod.rail, lens: env.prod.lens },
    });
    expect((await ro.health()).eurc.token.toLowerCase()).toBe(env.eurc.toLowerCase());
    expect((await rejection(ro.revoke(mandateId))).message).toMatch(/walletClient/);
  });
});

describe("relay", () => {
  type Call = { url: string; init: RequestInit };
  function relayClient(respond: () => Response) {
    const calls: Call[] = [];
    const fetchMock = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(respond());
    }) as unknown as typeof fetch;
    // No chain calls happen on the relay path, so a throwaway public client is enough.
    const client = createRailClient({
      network: "arc",
      instance: "demo",
      publicClient: {} as never,
      relayUrl: "https://relay.example/api/",
      fetch: fetchMock,
    });
    return { client, calls };
  }

  const action = { kind: ActionKind.REFUND, target: bytes32("22"), nonce: 3n, deadline: 1_900_000_000n };
  const debtorAddr: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
  const TX = `0x${"cd".repeat(32)}`;

  test("relayDebtorAction POSTs JSON with bigints as strings and returns the tx hash", async () => {
    const { client, calls } = relayClient(() => Response.json({ txHash: TX }));
    const hash = await client.relayDebtorAction(action, debtorAddr, "0x1234");
    expect(hash).toBe(TX as Hex);
    expect(calls[0]?.url).toBe("https://relay.example/api/debtor-action");
    expect(calls[0]?.init.method).toBe("POST");
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body["action"]).toEqual({ kind: 0, target: action.target, nonce: "3", deadline: "1900000000" });
    expect(body["debtor"]).toBe(debtorAddr);
    expect(body["instance"]).toBe("demo");
    expect(body["sig"]).toBe("0x1234");
  });

  test("relayActivate POSTs the offer, acceptance and permit", async () => {
    const { client, calls } = relayClient(() => Response.json({ txHash: TX }));
    const offer = sampleOffer({ timeScale: 10080 });
    const acceptance = { offerHash: bytes32("11"), debtor: debtorAddr, deadline: 5n };
    const permit = { value: 7n, deadline: 9n, v: 27, r: bytes32("01"), s: bytes32("02") };
    await client.relayActivate(offer, "0xaa", acceptance, "0xbb", permit);
    expect(calls[0]?.url).toBe("https://relay.example/api/activate");
    const body = JSON.parse(calls[0]?.init.body as string) as { offer: Record<string, unknown>; permit: Record<string, unknown> };
    expect(body.offer["maxPerCollection"]).toBe("100000000");
    expect(body.offer["debtor"]).toBe(ZERO_ADDRESS);
    expect(body.permit["value"]).toBe("7");
  });

  test("relay errors surface with status and message", async () => {
    const { client } = relayClient(() => Response.json({ error: "slow down" }, { status: 429 }));
    const err = await client.relayDebtorAction(action, debtorAddr, "0x12").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).status).toBe(429);
    expect((err as RelayError).message).toBe("slow down");
  });

  test("a response without a tx hash is an error", async () => {
    const { client } = relayClient(() => Response.json({ ok: true }));
    expect((await rejection(client.relayDebtorAction(action, debtorAddr, "0x12"))).message).toMatch(/txHash/);
  });

  test("without a relayUrl, relaying is refused", async () => {
    const client = createRailClient({ network: "arc", instance: "prod", publicClient: {} as never });
    expect((await rejection(client.relayDebtorAction(action, debtorAddr, "0x12"))).message).toMatch(/relayUrl/);
  });

  test("serializeForRelay writes bigints as decimal strings", () => {
    expect(serializeForRelay({ a: 1n, b: [2n], c: "x" })).toBe('{"a":"1","b":["2"],"c":"x"}');
  });
});
