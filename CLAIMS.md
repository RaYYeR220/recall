# Claims and their evidence

Every public statement about Recall, tagged by how you can check it.

- **VERIFIED-LIVE**: a mainnet transaction or a live contract read you can open now.
- **REPRODUCIBLE**: a test or script in this repo you can run.
- **DESIGN**: true by construction of the code, explained, not separately measured.
- **NOT CLAIMED**: listed at the end so nobody reads more into the project than is there.

| Claim | Tier | Evidence |
|---|---|---|
| The contracts are deployed on Arc mainnet and verified | VERIFIED-LIVE | [PROOF.md › Contracts](PROOF.md#contracts), Sourcify exact match |
| A real mandate, notice, collection and reserve lock exist on the prod rail with the statutory eight-week window | VERIFIED-LIVE | [PROOF.md › prod](PROOF.md#a-real-mandate-on-the-prod-rail) |
| The full lifecycle (gasless mandate, collect, gasless refund, partial hold and release, B2B, AM04 return, refusal, revocation) ran on mainnet | VERIFIED-LIVE | two runs in `proof/arc-demo-lifecycle-run*.json` |
| The contract refuses: early collection, over-cap notice, withdrawal of locked reserve, refund after the window, refund of a B2B debit, notice on a revoked mandate, wrong time scale, cross-instance signature replay | VERIFIED-LIVE | eight mined, reverted transactions in `proof/arc-demo-refusals.json` |
| Every refundable cent is backed (I1–I3) | VERIFIED-LIVE + REPRODUCIBLE | `RailLens.health()` on [/proof](https://recall-debit.vercel.app/proof); invariant suite in `contracts/test/invariant` |
| A refund always returns exactly the collected amount, inside the window, at any moment (I4, I6) | REPRODUCIBLE | invariant and fuzz tests |
| Payer-side failures return a collection with a reason code instead of reverting | REPRODUCIBLE + VERIFIED-LIVE | `test_collect_insufficientBalance_returnsAM04`; the AM04 transaction in the lifecycle runs |
| Real USDC moves through the contract from the app itself (one-click demo, clicked in a browser) | VERIFIED-LIVE | two complete app runs in [PROOF.md › Through the app](PROOF.md#through-the-app-in-usdc) |
| The payer never needs gas | VERIFIED-LIVE | relayed `activateMandateWithPermit` and `executeDebtorAction` transactions in PROOF.md |
| EOAs, EIP-7702-delegated EOAs and ERC-1271 wallets can all sign | REPRODUCIBLE | signature tests in `contracts/test` |
| A demo-rail signature can't be used on the prod rail | VERIFIED-LIVE | the `BadSignature` refusal in PROOF.md |
| No owner, no admin, no upgrade, no pause, no fees | DESIGN | `contracts/src/DebitRail.sol` has no privileged roles |
| Built in Arc Studio | VERIFIED-LIVE | the Arc Studio project linked in [JUDGES.md](JUDGES.md) |

## Not claimed

- **No third-party audit.** The contract was reviewed inside Arc Studio and by an independent reviewer with proof-of-concept tests (`contracts/AUDIT.md`); no audit firm has looked at it.
- **No production users.** The only mandates on mainnet are ours.
- **No legal equivalence with SEPA.** Recall implements SEPA Core's rules for payer protection; it is not a SEPA scheme member and makes no regulatory claim.
- **No 13-month "unauthorised debit" claim path.** Every collection needs the payer's on-chain-verified signature, so the case it covers can't arise; this is a design choice, not an omission we hide.
- **The relayer and keeper are run by us.** They are conveniences with daily caps; every action can be sent directly instead.
