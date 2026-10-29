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
| `links.ts` | `encodeCheckoutLink`, `decodeCheckoutLink`, `encodeCheckoutToken`, `decodeCheckoutToken`, `verifyOfferSignature` |
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

`encodeCheckoutLink(base, payload)` puts the payload in the URL fragment (`#r=<base64url JSON>`), so it never reaches a server. `decodeCheckoutLink` checks the shape, the instance time scale, and that the terms text hashes to the signed `termsHash`. The creditor name inside a link is unauthenticated display data. Always call `verifyCheckoutLink(publicClient, rail, decoded)` before showing or signing: it verifies the offer signature, reads the creditor name from the rail (returned as `creditorName`, shown instead of the link's), rebuilds the mandate text with `mandateTextForOffer` from the offer's own fields and requires it to equal `terms` exactly, and checks the time scale. Merchants must write their text with `mandateTextForOffer` too. Show every limit from `decoded.offer`, never from the text.

## Relay protocol

`relayUrl` is a single endpoint (the app uses `/api/relay`). `relayActivate`, `relayDebtorAction` and `relayPermit` all POST JSON to it, as `{ network, instance, kind, payload }` with `kind` set to `"activate"`, `"action"` or `"permit"`. Bigints are decimal strings. The relay answers `{ "txHash": "0x..." }`, or a non-2xx status with `{ "error": "..." }`. An unreachable relay, or one that answers with something other than JSON (for example a dev server's HTML page), throws `RelayError` so the caller can offer to submit the transaction itself.

## Tests

```bash
bun test      # from packages/sdk; starts a local anvil with both rails deployed
```

## What the contracts guarantee

The SDK talks to an immutable, ownerless contract (no admin, no upgrade, no pause, no fees). It keeps these invariants on every path, and `health()` reports the first three live:

- **I1** balance >= reserves + held + claimable, per token
- **I2** open refund exposure == locked reserve + held funds
- **I3** locked reserve <= total reserve
- **I4** every collection inside its refund window can be refunded in full, at any moment
- **I5** no collection exceeds its per-collection cap, no period its per-period cap
- **I6** a refund returns exactly what was collected

Two instances share one bytecode: `prod` (`timeScale` 1) and `demo` (`timeScale` 10080, one week lasts one minute). Reason codes used: `AM04` insufficient funds, `MS02` refused, `MS03` other, `MD01` no valid mandate, `MD06` refund, `AM05` duplicate (`returnCodeLabel` explains each).
