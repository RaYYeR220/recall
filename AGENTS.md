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
- Relay protocol the SDK expects: POST `{relayUrl}/activate` and `{relayUrl}/debtor-action`, answer `{ txHash }`.
- Known: `scripts/lifecycle.ts` has pre-existing lint/type errors that make `bun run check` fail; the SDK and the new scripts are clean.
