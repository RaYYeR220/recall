import {
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  keccak256,
  stringToHex,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { debitRailAbi, railLensAbi } from "./abi";
import {
  acceptanceTypedData,
  debtorActionTypedData,
  offerTypedData,
  permitTypedData,
  railDomain,
  toPermitData,
  type RailDomain,
} from "./eip712";
import { memoAbi } from "./erc20";
import {
  MEMO_ADDRESS,
  TIME_SCALE,
  networkInfo,
  railAddresses,
  type RailInstance,
  type RailNetwork,
} from "./networks";
import {
  ActionKind,
  type ActionKindName,
  type DebtorAction,
  type MandateAcceptance,
  type MandateOffer,
  type PermitData,
  type SignedDebtorAction,
} from "./types";

export interface RailClientConfig {
  network: RailNetwork;
  instance: RailInstance;
  publicClient: PublicClient;
  /** Needed for anything that signs or sends. Reads work without it. */
  walletClient?: WalletClient;
  /** Base URL of a relay that submits signatures for payers who have no gas. */
  relayUrl?: string;
  /** Override the rail and lens addresses (local forks, tests). Defaults to deployments/<chainId>.json. */
  addresses?: { rail: Address; lens: Address };
  /** Override the maxFeePerGas floor (wei). Defaults to the network's floor. */
  minFeePerGas?: bigint;
  /** Override fetch (tests, server runtimes). */
  fetch?: typeof fetch;
}

export interface MemoOptions {
  /**
   * Route the call through Arc's Memo predeploy when the sender is an EOA, so the transaction
   * carries the end-to-end ID and remittance text. Default true. Falls back to a direct call for
   * smart-contract senders and on chains without the predeploy.
   */
  viaMemo?: boolean;
}

export interface CollectOptions extends MemoOptions {
  /** Remittance text to attach as memo data. The rail does not store it, so it is empty unless you pass it. */
  remittanceInfo?: string;
}

export interface SignDebtorActionOptions {
  /** Unix seconds. Defaults to one hour after the latest block. */
  deadline?: bigint;
  /** Defaults to the debtor's current nonce on the rail. */
  nonce?: bigint;
}

export class RelayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RelayError";
    this.status = status;
  }
}

/** Encodes a call routed through the Memo predeploy: memo(target, data, memoId, memoData). */
export function encodeMemoCall(target: Address, data: Hex, memoId: Hex, remittanceInfo: string): Hex {
  return encodeFunctionData({
    abi: memoAbi,
    functionName: "memo",
    args: [target, data, memoId, remittanceInfo ? stringToHex(remittanceInfo) : "0x"],
  });
}

/** JSON.stringify that writes bigints as decimal strings. */
export function serializeForRelay(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

const ONE_GWEI = 1_000_000_000n;
const toBig = (n: bigint | number) => (typeof n === "bigint" ? n : BigInt(n));

export function createRailClient(config: RailClientConfig) {
  const { network, instance, publicClient, walletClient, relayUrl } = config;
  const info = networkInfo(network);
  const { rail, lens } = config.addresses ?? railAddresses(network)[instance];
  const minFeePerGas = config.minFeePerGas ?? info.minFeePerGas;
  const doFetch = config.fetch ?? fetch;

  let domainPromise: Promise<RailDomain> | undefined;
  const domain = (): Promise<RailDomain> => {
    domainPromise ??= railDomain(publicClient, rail).catch((e: unknown) => {
      domainPromise = undefined;
      throw e;
    });
    return domainPromise;
  };

  function requireWallet(): { wallet: WalletClient; account: Account } {
    if (!walletClient) throw new Error("This action needs a walletClient.");
    const account = walletClient.account;
    if (!account) throw new Error("The walletClient has no account.");
    return { wallet: walletClient, account };
  }

  let memoPresent = false;
  async function memoAvailable(): Promise<boolean> {
    if (memoPresent) return true;
    const code = await publicClient.getCode({ address: MEMO_ADDRESS });
    memoPresent = !!code && code !== "0x";
    return memoPresent;
  }

  async function isEoa(address: Address): Promise<boolean> {
    const code = await publicClient.getCode({ address });
    return !code || code === "0x";
  }

  async function feeOverrides(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }> {
    try {
      const est = await publicClient.estimateFeesPerGas({ chain: publicClient.chain, type: "eip1559" });
      const maxFeePerGas = est.maxFeePerGas > minFeePerGas ? est.maxFeePerGas : minFeePerGas;
      const prio = est.maxPriorityFeePerGas > 0n ? est.maxPriorityFeePerGas : ONE_GWEI;
      return { maxFeePerGas, maxPriorityFeePerGas: prio > maxFeePerGas ? maxFeePerGas : prio };
    } catch {
      return {};
    }
  }

  /** Simulates the call (so a revert surfaces with its data before any gas is spent), then sends it. */
  async function send(to: Address, data: Hex, memo?: { id: Hex; remittanceInfo: string }): Promise<Hex> {
    const { wallet, account } = requireWallet();
    let target = to;
    let calldata = data;
    if (memo && (await isEoa(account.address)) && (await memoAvailable())) {
      target = MEMO_ADDRESS;
      calldata = encodeMemoCall(to, data, memo.id, memo.remittanceInfo);
    }
    await publicClient.call({ account, to: target, data: calldata });
    const fees = await feeOverrides();
    return wallet.sendTransaction({ account, chain: wallet.chain ?? null, to: target, data: calldata, ...fees });
  }

  async function postRelay(path: string, body: unknown): Promise<Hex> {
    if (!relayUrl) throw new Error("No relayUrl configured on this client.");
    const res = await doFetch(`${relayUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: serializeForRelay(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    const obj = (typeof json === "object" && json !== null ? json : {}) as { txHash?: unknown; error?: unknown };
    if (!res.ok) {
      const msg = typeof obj.error === "string" ? obj.error : text.slice(0, 300) || res.statusText;
      throw new RelayError(res.status, msg);
    }
    if (typeof obj.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(obj.txHash)) {
      throw new RelayError(res.status, "Relay response had no txHash.");
    }
    return obj.txHash as Hex;
  }

  const num = (n: bigint | number) => toBig(n);

  return {
    network,
    instance,
    rail,
    lens,
    timeScale: TIME_SCALE[instance],
    publicClient,

    // ── hashing helpers (offline once the domain is cached) ─────────────────
    domain,
    async offerHash(offer: MandateOffer): Promise<Hex> {
      return hashTypedData(offerTypedData(await domain(), offer));
    },
    async mandateId(offer: MandateOffer, debtor: Address): Promise<Hex> {
      const offerHash = hashTypedData(offerTypedData(await domain(), offer));
      return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [offerHash, debtor]));
    },
    collectionId(mandateId: Hex, e2eId: Hex): Hex {
      return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [mandateId, e2eId]));
    },

    // ── signing (wallet account signs) ──────────────────────────────────────
    /** Creditor (owner or operator) signs a mandate offer. */
    async signOffer(offer: MandateOffer): Promise<Hex> {
      const { wallet, account } = requireWallet();
      return wallet.signTypedData({ account, ...offerTypedData(await domain(), offer) });
    },
    /** Debtor signs acceptance of an offer. */
    async signAcceptance(offer: MandateOffer, opts: { deadline?: bigint } = {}) {
      const { wallet, account } = requireWallet();
      const d = await domain();
      const acceptance: MandateAcceptance = {
        offerHash: hashTypedData(offerTypedData(d, offer)),
        debtor: account.address,
        deadline: opts.deadline ?? (await publicClient.getBlock()).timestamp + 3600n,
      };
      const sig = await wallet.signTypedData({ account, ...acceptanceTypedData(d, acceptance) });
      return { acceptance, sig };
    },
    /** Debtor signs an EIP-2612 permit letting the rail pull `value` of `token`. */
    async signPermit(token: Address, value: bigint, deadline: bigint): Promise<PermitData> {
      const { wallet, account } = requireWallet();
      const typed = await permitTypedData(publicClient, token, account.address, rail, value, deadline);
      const sig = await wallet.signTypedData({ account, ...typed });
      return toPermitData(sig, value, deadline);
    },
    /** Debtor signs a REFUND, REVOKE or REFUSE that anyone can submit. `target` is a collectionId (REVOKE: a mandateId). */
    async signDebtorAction(
      kind: ActionKindName,
      target: Hex,
      opts: SignDebtorActionOptions = {},
    ): Promise<SignedDebtorAction> {
      const { wallet, account } = requireWallet();
      const nonce =
        opts.nonce ??
        (await publicClient.readContract({
          address: rail,
          abi: debitRailAbi,
          functionName: "nonces",
          args: [account.address],
        }));
      const action: DebtorAction = {
        kind: ActionKind[kind],
        target,
        nonce,
        deadline: opts.deadline ?? (await publicClient.getBlock()).timestamp + 3600n,
      };
      const sig = await wallet.signTypedData({ account, ...debtorActionTypedData(await domain(), action) });
      return { action, debtor: account.address, sig };
    },

    // ── writes (wallet account sends; every call is simulated first) ────────
    /** Activates a mandate. Anyone may submit; the payer needs no gas. With `permit`, also sets the allowance. */
    activate(
      offer: MandateOffer,
      offerSig: Hex,
      acceptance: MandateAcceptance,
      debtorSig: Hex,
      permit?: PermitData,
    ): Promise<Hex> {
      const data = permit
        ? encodeFunctionData({
            abi: debitRailAbi,
            functionName: "activateMandateWithPermit",
            args: [offer, offerSig, acceptance, debtorSig, permit],
          })
        : encodeFunctionData({
            abi: debitRailAbi,
            functionName: "activateMandate",
            args: [offer, offerSig, acceptance, debtorSig],
          });
      return send(rail, data);
    },

    /** Schedules a collection (creditor owner or operator). Routed via the Memo predeploy for EOAs. */
    prenotify(
      mandateId: Hex,
      amount: bigint,
      dueAt: bigint,
      e2eId: Hex,
      remittanceInfo: string,
      { viaMemo = true }: MemoOptions = {},
    ): Promise<Hex> {
      const data = encodeFunctionData({
        abi: debitRailAbi,
        functionName: "prenotify",
        args: [mandateId, amount, dueAt, e2eId, remittanceInfo],
      });
      return send(rail, data, viaMemo ? { id: e2eId, remittanceInfo } : undefined);
    },

    /** Executes a due collection. Anyone may call. Memo id is the collection's stored e2eId. */
    async collect(collectionId: Hex, { viaMemo = true, remittanceInfo = "" }: CollectOptions = {}): Promise<Hex> {
      const data = encodeFunctionData({ abi: debitRailAbi, functionName: "collect", args: [collectionId] });
      let memo: { id: Hex; remittanceInfo: string } | undefined;
      if (viaMemo) {
        const col = await publicClient.readContract({
          address: rail,
          abi: debitRailAbi,
          functionName: "getCollection",
          args: [collectionId],
        });
        // An unknown collection has no e2eId: call directly so the rail's own error comes back.
        if (BigInt(col.e2eId) !== 0n) memo = { id: col.e2eId, remittanceInfo };
      }
      return send(rail, data, memo);
    },

    /** Payer claims a full refund on a CORE collection inside the refund window. */
    refund: (collectionId: Hex): Promise<Hex> =>
      send(rail, encodeFunctionData({ abi: debitRailAbi, functionName: "refund", args: [collectionId] })),
    /** Payer refuses a SCHEDULED collection. */
    refuse: (collectionId: Hex): Promise<Hex> =>
      send(rail, encodeFunctionData({ abi: debitRailAbi, functionName: "refuse", args: [collectionId] })),
    /** Payer or creditor owner revokes a mandate. */
    revoke: (mandateId: Hex): Promise<Hex> =>
      send(rail, encodeFunctionData({ abi: debitRailAbi, functionName: "revoke", args: [mandateId] })),
    /** Anyone releases a SETTLED CORE collection after its refund window. */
    release: (collectionId: Hex): Promise<Hex> =>
      send(rail, encodeFunctionData({ abi: debitRailAbi, functionName: "release", args: [collectionId] })),

    /** Submits a payer's signed action directly from this wallet (the submitter pays gas, not the payer). */
    executeDebtorAction: (action: DebtorAction, debtor: Address, sig: Hex): Promise<Hex> =>
      send(
        rail,
        encodeFunctionData({ abi: debitRailAbi, functionName: "executeDebtorAction", args: [action, debtor, sig] }),
      ),

    // ── relay (POST to relayUrl) ─────────────────────────────────────────────
    /** POST {relayUrl}/debtor-action. The relay submits and pays gas; resolves with the tx hash. */
    relayDebtorAction: (action: DebtorAction, debtor: Address, sig: Hex): Promise<Hex> =>
      postRelay("/debtor-action", { network, instance, rail, action, debtor, sig }),
    /** POST {relayUrl}/activate. The relay submits and pays gas; resolves with the tx hash. */
    relayActivate: (
      offer: MandateOffer,
      offerSig: Hex,
      acceptance: MandateAcceptance,
      debtorSig: Hex,
      permit?: PermitData,
    ): Promise<Hex> => postRelay("/activate", { network, instance, rail, offer, offerSig, acceptance, debtorSig, permit }),

    // ── reads ────────────────────────────────────────────────────────────────
    /** A payer's mandates with their newest collections. `limit` 0 = all remaining. */
    async debtorView(addr: Address, offset: bigint | number = 0, limit: bigint | number = 0) {
      const [views, total] = await publicClient.readContract({
        address: lens,
        abi: railLensAbi,
        functionName: "debtorView",
        args: [addr, num(offset), num(limit)],
      });
      return { views, total };
    },
    /** A creditor's mandates with their newest collections. */
    async creditorView(creditorId: bigint | number, offset: bigint | number = 0, limit: bigint | number = 0) {
      const [views, total] = await publicClient.readContract({
        address: lens,
        abi: railLensAbi,
        functionName: "creditorView",
        args: [num(creditorId), num(offset), num(limit)],
      });
      return { views, total };
    },
    /** Full collection history for a mandate, oldest first. */
    async collectionsPage(mandateId: Hex, offset: bigint | number = 0, limit: bigint | number = 0) {
      const [page, total] = await publicClient.readContract({
        address: lens,
        abi: railLensAbi,
        functionName: "collectionsPage",
        args: [mandateId, num(offset), num(limit)],
      });
      return { page, total };
    },
    /** Reserve coverage for a creditor in both tokens. */
    async coverage(creditorId: bigint | number) {
      const [eurc, usdc] = await publicClient.readContract({
        address: lens,
        abi: railLensAbi,
        functionName: "coverageView",
        args: [num(creditorId)],
      });
      return { eurc, usdc };
    },
    /** Solvency invariants i1/i2/i3 for both tokens. */
    async health() {
      const [eurc, usdc] = await publicClient.readContract({ address: lens, abi: railLensAbi, functionName: "health" });
      return { eurc, usdc };
    },
    getCollection: (collectionId: Hex) =>
      publicClient.readContract({ address: rail, abi: debitRailAbi, functionName: "getCollection", args: [collectionId] }),
    getMandate: (mandateId: Hex) =>
      publicClient.readContract({ address: rail, abi: debitRailAbi, functionName: "getMandate", args: [mandateId] }),
    /** Unix seconds until which a CORE collection can be refunded. */
    refundDeadline: (collectionId: Hex): Promise<bigint> =>
      publicClient.readContract({
        address: rail,
        abi: debitRailAbi,
        functionName: "refundDeadline",
        args: [collectionId],
      }),
    /** Current nonce the rail expects in the next signed debtor action. */
    nonce: (debtor: Address): Promise<bigint> =>
      publicClient.readContract({ address: rail, abi: debitRailAbi, functionName: "nonces", args: [debtor] }),
    /** Scaled windows in seconds, as enforced by this instance. */
    async windows() {
      const read = <F extends "refundWindow" | "minPrenotice" | "executionWindow" | "lapsePeriod" | "scheduleAhead">(
        functionName: F,
      ) => publicClient.readContract({ address: rail, abi: debitRailAbi, functionName });
      const [refundWindow, minPrenotice, executionWindow, lapsePeriod, scheduleAhead] = await Promise.all([
        read("refundWindow"),
        read("minPrenotice"),
        read("executionWindow"),
        read("lapsePeriod"),
        read("scheduleAhead"),
      ]);
      return { refundWindow, minPrenotice, executionWindow, lapsePeriod, scheduleAhead };
    },
  };
}

export type RailClient = ReturnType<typeof createRailClient>;
