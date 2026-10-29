# Review Recall in five minutes

Everything below is live on Arc mainnet. No wallet is needed for any step.

1. **The idea, in one screen.** Open <https://recall-debit.vercel.app>. The card is the object a payer receives: a debit, its eight-week refund window, the reserve that backs it, and the button that takes the money back.

2. **A real debit with a real eight-week refund window.** Open the payer view for our house payer on the prod rail:
   <https://recall-debit.vercel.app/pay?watch=0x9504990A13C51Bd55c73cFc470994AFD26d6fb47&rail=prod>
   A 0.05 EURC collection by "Northwind Gym", pre-notified a day ahead and collected on 29 October, is refundable until 24 December 2026. The window is the statutory one, not compressed. The mandate, the notice, the collection and the reserve lock are all on-chain ([PROOF.md](PROOF.md#a-real-mandate-on-the-prod-rail)).

3. **Watch the contract refuse.** Open <https://recall-debit.vercel.app/proof>. The three solvency invariants are read from the contract every 15 seconds. Below them is the ledger: every action and every refusal is a mainnet transaction you can open, and each refusal is a mined, reverted transaction with its error named (`ReserveLocked`, `RefundWindowClosed`, `NoRefundRightB2B`, `BadSignature` for a demo signature replayed on prod, and more).

4. **Run one yourself.** Open <https://recall-debit.vercel.app/demo> and press "Run a live debit". On the demo rail one week lasts one minute: you sign a mandate without gas, the debit is announced, collected, and refunded, all on mainnet, with explorer links at every step. "Try to break it" shows the refusals.

5. **How it was built.** Arc Studio project: <https://studio.arc.io/app/3449f08c-35f4-4216-af3d-c8ed28ce3d4c>. The contracts, the Foundry suite (unit, fuzz and invariant tests over both instances), the deployment and lifecycle scripts, the SDK, the app and the serverless functions were written in Arc Studio from our briefs, turn by turn.

6. **Check it from your machine.**
   ```bash
   git clone https://github.com/RaYYeR220/recall && cd recall
   git submodule update --init && bun install
   forge test                     # contracts
   cd packages/sdk && bun test    # SDK
   cd ../.. && bun scripts/verify-onchain.ts   # re-checks every proof transaction and the live invariants on mainnet
   ```

Contracts (all verified on Sourcify): DebitRail prod [`0x8a91…75B0`](https://explorer.arc.io/address/0x8a91eB44cF5d213C2230A42D1DF84585224075B0), demo [`0x62A2…7667`](https://explorer.arc.io/address/0x62A2E0a97138370F6b77823A1f1d4DF6CA507667).
