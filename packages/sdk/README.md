# @recall/sdk

TypeScript SDK for Recall DebitRail. Depends on `viem` only.

```ts
import { createPublicClient, http } from "viem";
import { createRailClient, networkInfo } from "@recall/sdk";

const info = networkInfo("arc");
const publicClient = createPublicClient({ chain: info.chain, transport: http(info.rpcUrl) });
const rail = createRailClient({ network: "arc", instance: "demo", publicClient });

const { views } = await rail.debtorView("0x...");
const health = await rail.health();
```

## Modules

| File | What it gives you |
| --- | --- |
| `abi.ts` | `debitRailAbi`, `railLensAbi`, generated from `contracts/out` by `scripts/gen-abi.ts` |
| `networks.ts` | chains, token addresses, `railAddresses(network)` from `deployments/*.json`, `TIME_SCALE` |
| `eip712.ts` | `railDomain`, `offerTypedData`, `acceptanceTypedData`, `debtorActionTypedData`, `permitTypedData` |
| `terms.ts` | `mandateText`, `termsHash`, `refToBytes32` |
| `links.ts` | `encodeCheckoutLink`, `decodeCheckoutLink`, `verifyOfferSignature` |
| `client.ts` | `createRailClient` (activate, prenotify, collect, refund, refuse, revoke, release, signing, relay, reads) |
| `errors.ts` | `decodeRailError`, `returnCodeLabel` |
| `camt054.ts` | `toCamt054` (ISO 20022 camt.054.001.08) and `toCsv` |

## Conventions

- Amounts are `bigint` in token units (6 decimals for EURC and USDC).
- `periodLength` and `prenoticeLength` in an offer are LEGAL seconds. The contract divides by the instance time scale.
- The EIP-712 domain is read from the contract, never hardcoded: the two instances have different names.
- Every write simulates first, so a revert comes back with its data. Pass the error to `decodeRailError`.
- `prenotify` and `collect` go through Arc's Memo predeploy for EOA senders (`viaMemo`, default true) and fall back to a direct call for smart-contract senders or chains without the predeploy.

## Checkout links

`encodeCheckoutLink(base, payload)` puts the payload in the URL fragment (`#r=<base64url JSON>`), so it never reaches a server. `decodeCheckoutLink` checks the shape, the instance time scale, and that the terms text hashes to the signed `termsHash`. Call `verifyOfferSignature` before showing the link as valid.

## Relay protocol

When `relayUrl` is set, `relayActivate` POSTs to `{relayUrl}/activate` and `relayDebtorAction` to `{relayUrl}/debtor-action`. Bodies are JSON with bigints as decimal strings. The relay answers `{ "txHash": "0x..." }`, or a non-2xx status with `{ "error": "..." }`.

## Tests

```bash
bun test      # from packages/sdk; starts a local anvil with both rails deployed
```
