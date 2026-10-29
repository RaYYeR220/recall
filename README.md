# Recall

**Direct debit for stablecoins, with the refund right built in.**

Recall brings the rules of SEPA Direct Debit (Core) to EURC and USDC on [Arc](https://arc.io): a payer signs a mandate once, every collection is announced before it runs, any announced collection can be refused, and for eight weeks after a collection the payer can take it back with one click. An immutable contract enforces all of it. The merchant is paid at once, and every refundable cent stays backed by the merchant's reserve or by funds the contract holds back.

Live on Arc mainnet · EURC & USDC · no owner, no upgrades, no fees.

- **App:** <https://recall-debit.vercel.app> · try a live debit on mainnet at [/demo](https://recall-debit.vercel.app/demo), no wallet needed
- **Review in five minutes:** [JUDGES.md](JUDGES.md) · what we claim and how to check it: [CLAIMS.md](CLAIMS.md)
- **Proof (every claim is an explorer link):** [PROOF.md](PROOF.md)
- **Contracts:** [`contracts/src`](contracts/src) · security review: [`contracts/AUDIT.md`](contracts/AUDIT.md)
- **Built in Arc Studio:** [project workspace](https://studio.arc.io/app/3449f08c-35f4-4216-af3d-c8ed28ce3d4c)

---

## Why

Pull payments are how most of the world pays for subscriptions, utilities, gyms and rent. In Europe that's SEPA Direct Debit: about 22 billion payments a year, trusted because the payer is protected by rules, not by the merchant's goodwill.

Stablecoins have no equivalent. On-chain "direct debits" today are allowances: once money is pulled it is gone. There is no notice of what will be taken, no limit the merchant cannot exceed in practice, and no way back. That makes stablecoins a poor fit for recurring billing, exactly where they should shine.

Recall is the missing piece: a pull payment a normal person can trust.

## How it works

1. **The merchant (creditor)** registers, funds a reserve in EURC or USDC, and signs a **mandate offer**: token, scheme (Core or B2B), per-collection and per-period caps, pre-notice, a reference, the hash of the mandate text, how many payers may use it and until when. The offer travels as a checkout link.
2. **The payer (debtor)** opens the link, reads the mandate in plain language and signs an **acceptance** plus an EIP-2612 permit. Anyone can submit the two signatures, so the payer never needs gas.
3. Before every collection the merchant **pre-notifies** the amount, due date and an end-to-end ID. The payer can **refuse** it before it runs.
4. On or after the due date anyone can **collect**. If the payer is short, the collection is **returned** with an ISO 20022 reason code instead of failing.
5. On a Core collection the merchant is paid at once **as far as the free reserve covers it**: that part of the reserve is locked. Whatever the reserve doesn't cover is **held** by the contract.
6. For eight weeks the payer can **refund** any Core collection, by transaction or by signature. The full amount comes back instantly from held funds and the locked reserve.
7. After eight weeks anyone can **release** the collection: the reserve unlocks and held funds go to the merchant.

### SEPA rule → Recall

| SEPA Direct Debit | Recall, enforced by contract |
|---|---|
| Signed mandate with a unique reference | EIP-712 offer signed by the merchant + acceptance signed by the payer; `mandateId = hash(offer, payer)` |
| Pre-notification (14 days unless agreed) | `prenotify` must be at least the mandate's pre-notice ahead (minimum one day) |
| Payer may limit amount and periodicity | per-collection and per-period caps in the signed offer |
| Payer may refuse a collection before it runs | `refuse` → `MS02` |
| Refund within 8 weeks, no questions asked (Core) | `refund` within `refundWindow()`, paid instantly → `MD06` |
| B2B scheme: no refund right | `scheme = B2B`: final at once, nothing locked or held |
| Mandate lapses after 36 months unused | collections refused after `lapsePeriod()` without activity → `MD01` |
| R-transactions with reason codes | `AM04` insufficient funds · `MS02` refused · `MS03` other · `MD01` no valid mandate · `MD06` refund · `AM05` duplicate |

We don't implement SEPA's 13-month "unauthorised debit" claim: every collection on Recall requires the payer's signature verified on-chain, so an unauthorised collection can't exist.

### Two instances, one bytecode

The contract takes an immutable `timeScale`:

- **prod** (`timeScale = 1`): the real windows. Eight weeks is eight weeks.
- **demo** (`timeScale = 10080`): one week lasts one minute, so the whole refund window opens and closes in eight minutes. Same code, real tokens. Its EIP-712 domain is named "Recall DebitRail DEMO (1 week = 1 minute)", every offer must carry the rail's time scale, and demo terms are capped at one token per collection, so nobody can be talked into signing demo terms by mistake.

## Guarantees

The contract keeps these invariants on every path (tested with Foundry invariant fuzzing across both instances, and readable live through `RailLens.health()`):

- **I1** `balance ≥ reserves + held + claimable` per token (a direct transfer to the contract shows up as surplus, owned by no one)
- **I2** open refund exposure `==` locked reserve `+` held funds, per merchant and token
- **I3** locked reserve `≤` total reserve
- **I4** every collection inside its refund window can be refunded in full, at any moment
- **I5** no collection exceeds its per-collection cap; no period exceeds its per-period cap
- **I6** a refund returns exactly what was collected

Other properties: no owner, no admin, no upgrade, no pause, no fees. Payer-side failures never revert a collection; they return it with a code. Payouts and refunds to addresses a token issuer has blocked fall back to a claimable balance. Signatures work for plain EOAs, EIP-7702-delegated EOAs and ERC-1271 smart wallets.

## Deployments

Arc mainnet (chain 5042), all verified on Sourcify:

| | Address |
|---|---|
| DebitRail · prod | [`0x8a91eB44cF5d213C2230A42D1DF84585224075B0`](https://explorer.arc.io/address/0x8a91eB44cF5d213C2230A42D1DF84585224075B0) |
| RailLens · prod | [`0x806336C15B2a0972A8Cf5aBE609Fa11af955Cb6F`](https://explorer.arc.io/address/0x806336C15B2a0972A8Cf5aBE609Fa11af955Cb6F) |
| DebitRail · demo | [`0x62A2E0a97138370F6b77823A1f1d4DF6CA507667`](https://explorer.arc.io/address/0x62A2E0a97138370F6b77823A1f1d4DF6CA507667) |
| RailLens · demo | [`0xb97657400f385FE1db436B8c6924FF5C7c5C32cF`](https://explorer.arc.io/address/0xb97657400f385FE1db436B8c6924FF5C7c5C32cF) |

Arc testnet (5042002): see [`deployments/5042002.json`](deployments/5042002.json).

Tokens: EURC `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1`, USDC (ERC-20 interface) `0x3600000000000000000000000000000000000000`.

## Built with Arc Studio

Recall was built in [Arc Studio](https://studio.arc.io), Circle's onchain coding agent, from the first contract to the app. We wrote the product brief, the contract interface and the test plan, and Arc Studio wrote and reviewed the Solidity, the Foundry test suite (unit, fuzz and invariant tests), the deployment script, the end-to-end lifecycle runner and the app, and deployed both instances to Arc testnet. We reviewed every turn, sent fixes back through Studio, had the contract reviewed independently, rehearsed the full lifecycle on a local fork of Arc mainnet, and then deployed to mainnet ourselves (Arc Studio deploys to testnet only).

## Run it

```bash
bun install
git submodule update --init       # forge-std
forge test                        # contracts (Solidity 0.8.28, via-IR)
bun run dev                       # the app
```

End-to-end lifecycle on any rail (needs funded keys in the environment: `CREDITOR_KEY`, `DEBTOR_KEY`, `DEBTOR2_KEY`, `RELAYER_KEY`):

```bash
bun scripts/lifecycle.ts --network arc-testnet --instance demo
```

## Honest limits

- **Friendly fraud is possible, exactly as in SEPA Core.** A payer can use a service and then refund within eight weeks. That's the point of the Core scheme; merchants who can't accept it use the B2B scheme, where collections are final.
- **The relayer is a convenience, not a dependency.** Gasless activation and gasless refunds go through a relayer we run, with daily caps. Every action can also be sent directly from the payer's wallet.
- **Period caps use fixed windows** anchored at activation and keyed on each collection's due date, so up to two periods' worth can land around a boundary.
- **Circle can block addresses.** A collection from a blocked payer is returned (`MS03`); a payout or refund to a blocked address is credited as claimable instead of reverting.
- **Not audited by a third-party firm.** The contract has an AI-assisted review inside Arc Studio plus an independent review with proof-of-concept tests (see `contracts/AUDIT.md`), a fuzzed invariant suite and a mainnet-fork rehearsal. Use small amounts.

## License

MIT
