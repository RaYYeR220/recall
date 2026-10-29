# Recall DebitRail

> Built with Arc Studio - money-powered apps in minutes

Project memory for the Recall DebitRail contracts.

---

## What This App Does

Recall is direct debit for stablecoins (EURC and USDC on Arc), with the payer's refund right built in. Think SEPA Direct Debit Core rules enforced by an immutable, ownerless contract instead of a bank.

## Tech Stack

- Frontend: React 18, Vite, TypeScript, Tailwind CSS
- Web3: wagmi v2, viem v2, ConnectKit
- Contracts: Solidity 0.8.28 + Foundry. Sources in `contracts/src/`, unit tests in `contracts/test/*.t.sol`.
- Chain: Arc Testnet (Chain ID: 5042002) / Arc Mainnet
- Tokens: EURC + USDC (6 decimals each)

## Contract Sources

- `contracts/src/IDebitRail.sol` — types, events, errors, full interface
- `contracts/src/DebitRail.sol` — implementation (immutable, ownerless, no upgrade)
- `contracts/src/RailLens.sol` — read-only aggregation views

## Deployed Addresses — Arc Testnet (chain 5042002)

Deployment block: 69414753  
Deployer: `0xb439B11e5073DD6bBdA9aC5d9a96871ec25deA1d`

| Contract       | Address |
|---|---|
| prod rail      | `0xE75f4d48B1Ab0f1e66B5b93bc207A0A22207521A` |
| prod lens      | `0x3F3f47cAc634FB3FCA50142612bC0b1CC285F05D` |
| demo rail      | `0x1b81ad8aA1E4b92FCD9B4f8a864b1225047CFECF` |
| demo lens      | `0x36157eCDA79956c6e864a0Aa22498B5f4493407a` |
| EURC           | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
| USDC           | `0x3600000000000000000000000000000000000000` |

Explorer: https://explorer.testnet.arc.io

Manifest: `deployments/5042002.json`

## Build & Test

```bash
bun run contracts:build   # forge build
bun run contracts:test    # forge test (126 tests, 8 invariants)
```

## Lifecycle Script

```bash
bun run scripts/lifecycle.ts --network arc-testnet --instance demo
```

Requires: `CREDITOR_KEY`, `DEBTOR_KEY`, `RELAYER_KEY`, `DEBTOR2_KEY`, `EURC_ADDRESS`, `VITE_USDC_ADDRESS`

## Key Files

- `contracts/src/DebitRail.sol` — main contract
- `contracts/src/RailLens.sol` — read-only lens
- `contracts/script/Deploy.s.sol` — deployment script
- `scripts/lifecycle.ts` — end-to-end lifecycle runner
- `deployments/5042002.json` — Arc Testnet deployment manifest
- `contracts/AUDIT.md` — security review findings

## TypeScript SDK (packages/sdk)

- `@recall/sdk`, viem only. Source in `packages/sdk/src`, tests in `packages/sdk/test` (`bun run sdk:test`, boots a local anvil with both rails).
- `src/abi.ts` is generated: `forge build && bun run sdk:abi`. Do not edit by hand.
- `bun run verify:onchain` is a read-only mainnet check (receipts listed in `proof/*.json`, `health()` on both lenses).
- Relay protocol: one endpoint, `POST /api/relay` (the app's `RELAY_URL`), JSON `{ network, instance, kind: activate | action | permit, payload }`; answer `{ txHash }` or `{ error, refusal? }`. Implemented in `api/relay.ts` (inert until RELAYER_KEY is set); when it is unavailable the app offers "Submit it myself".


## Web app (src/)

- Routes: `/` landing, `/pay` payer, `/m/:link` mandate signing, stubs for `/merchant`, `/proof`, `/demo`, `/developers`. Screens live in `src/screens`, shared UI in `src/components`, reads in `src/hooks`.
- Design: "Dark notice" tokens in `src/index.css` and `src/styles/recall.css`; the hero and the debit notice are ported from the approved reference.
- Network badge (mainnet default, persisted in localStorage `recall.network`); instance (prod/demo) is a per-page toggle (`/pay?i=demo`). `/pay?as=0x...` watches any address read-only.
- Checkout links: `/m/<token>` or `/m/x#r=<token>` (token = SDK `encodeCheckoutToken`). Long mandate texts should use the fragment form.
- `src/tracing.ts` and `src/console-capture.ts` only load in dev or when framed by https://studio.arc.io (`src/studio-bridge.ts`); they post only to that pinned origin.
- Arc testnet: the addresses in `deployments/5042002.json` currently have no contract code. The app shows a "not live" panel there.

- Checkout links: the creditor name in a link is NOT trusted. The /m/:link page runs `verifyCheckoutLink` (signature, on-chain name, text rebuilt by `mandateTextForOffer` equals `terms`, time scale) and blocks signing on any mismatch. Merchant-side text must come from `mandateTextForOffer`.

## Part 2 (merchant console, proof, demo, developers, functions)

- Routes: `/merchant` (src/screens/MerchantScreen.tsx + merchant/*), `/proof`, `/demo`, `/developers`. Everything reads the chain; no mock data.
- Functions in `api/` (see `api/README.md` for routes and env). Shared logic in `api/_lib`; tests in `api/test` (`bun run api:test`). `vercel.json` rewrites the SPA and sets the function duration.
- The demo's "Try to break it" is simulation only. A case is `live` (simulated now), `replayed` (the exact recorded mainnet calldata run against current state) or `recorded`; the response says which and whether the expected error was reproduced.
- Creditor discovery and statements scan logs with `scanWindows` (9,000-block windows from the deployment block, never block 0).
- Merchant text must come from `mandateTextForOffer`; the offer form already does.
