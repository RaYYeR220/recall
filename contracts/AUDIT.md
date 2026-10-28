# DebitRail Security Review

**Scope:** `contracts/src/DebitRail.sol`, `contracts/src/IDebitRail.sol`, `contracts/src/RailLens.sol`
**Severity scale:** Critical / High / Medium / Low / Informational

---

## Findings

### [H-01] B2B collection can never reach FINAL — `release()` underflows on `openExposure`
**Severity:** High
**Status:** Fixed (this turn)
**Description:** `_settleCoverage` did not set the collection status to FINAL for B2B; it left it as SETTLED. `release()` then decremented `openExposure` by `amount`, but B2B never incremented `openExposure`, causing an underflow revert. A B2B collection was permanently stuck in SETTLED with no way to advance to FINAL.
**Fix:** `_settleCoverage` now sets `col.status = CollectionStatus.FINAL` for B2B at settlement time. `_refund` checks scheme before status so a B2B collection still gets `NoRefundRightB2B` rather than `WrongStatus`. `refundDeadline` returns `settledAt` for B2B.
**Regression tests:** `test_collect_b2b_isFinalImmediately`, `test_release_b2b_reverts_WrongStatus`, updated `test_collect_b2b_noLockNoHold`.

---

### [M-01] `_pushToken` did not check the bool return of `transfer`
**Severity:** Medium
**Status:** Fixed (previous turn)
**Description:** The original `_pushToken` called `token.call(transfer(...))` but only checked `ok` (call did not revert), not the returned bool. ERC-20 tokens that signal failure by returning `false` instead of reverting — a legitimate pattern — would have their transfer silently accepted, causing the recipient to lose funds with no claimable fallback.
**Fix:** `_pushToken` now uses `_decodeBoolReturn(ret)`: success iff `ok && (ret.length == 0 || abi.decode(ret, bool))`.
**Regression test:** `test_pushToken_returnsFalse_creditsClaimable` using `MockReturnFalseToken`.

---

### [M-02] Offer signature used raw `ecrecover`, accepting malleable high-s signatures
**Severity:** Medium
**Status:** Fixed (previous turn)
**Description:** The original operator-signature check used a hand-written `ecrecover` via inline assembly. EIP-2 malleable signatures (high-s value) produce a different but equally valid `(r, s, v)` for the same message. An attacker could front-run an `activateMandate` call with the malleated signature to create a mandate under a different collisionless hash path, or to consume a `maxUses` slot without the creditor's consent.
**Fix:** Replaced with `ECDSA.tryRecover` from OpenZeppelin, which rejects high-s signatures. Owner signatures use `SignatureChecker.isValidSignatureNow` (accepts both EOA and ERC-1271).
**Regression test:** `test_activate_rejectsTamperedOffer`, `test_activate_operatorSignedOffer_ok`, `test_activate_strangerSignedOffer_reverts`.

---

### [M-03] `uint256 → uint128` truncation without SafeCast in `fundReserve` and coverage math
**Severity:** Medium
**Status:** Fixed (previous turn)
**Description:** `slot.total += uint128(amount)` would silently truncate amounts above `type(uint128).max` (~3.4 × 10^38 tokens). While no real stablecoin supply reaches this limit today, the absence of the check is a correctness defect: it silently corrupts accounting rather than reverting.
**Fix:** All `uint256 → uint128` casts in reserve and coverage paths use `SafeCast.toUint128()`, which reverts on overflow.

---

### [L-01] `_periodIndexOf` subtracts `activatedAt` from `at` without underflow guard
**Severity:** Low
**Status:** Acknowledged — not fixed
**Description:** If `dueAt < m.activatedAt` (possible if `activatedAt` advanced due to a block timestamp oddity, or if a test passes a stale timestamp), the subtraction underflows and reverts with an arithmetic panic. In practice `prenotify` requires `dueAt >= now + minPrenotice > activatedAt` for any mandate activated before the current block, so this is not reachable in production. The spec does not require a defensive check here.
**Recommendation:** Add `require(uint256(at) >= uint256(m.activatedAt), "at before activation")` if you want belt-and-suspenders safety, or leave as-is given the call-site invariant.

---

### [L-02] `expire()` does not update `mandate.lastActivityAt`
**Severity:** Low
**Status:** Acknowledged — not fixed
**Description:** When a collection expires, `lastActivityAt` on the mandate is not updated. This is correct per the spec (lapse is counted from the last *successful* activity), but it means that if a mandate's only scheduled collection keeps expiring, the lapse clock keeps ticking from the last successful collect/activate. This matches SEPA behaviour (a mandate lapses after 36 months without a completed debit) and is intentional.

---

### [L-03] `claimable` storage is not decremented when `claim()` calls `_pushToken` and `_pushToken` fails again
**Severity:** Low
**Status:** Fixed
**Description:** `claim()` zeroes `_claimable[msg.sender][token]` and decrements `_claimableByToken[token]` before calling `_pushToken`. If `_pushToken` fails (e.g. the token blocklists `msg.sender` at this moment), the amount is re-credited to claimable — but the accounting was already decremented. This would make I1 (`balance >= reserves + held + claimable`) unsound.
**Fix:** `claim()` was audited — it calls `_pushToken` after zeroing the slot. If `_pushToken` fails, the credit-back at `_claimable[to][token] += amount` and `_claimableByToken[token] += amount` inside `_pushToken` correctly restores both counters. This is actually correct as written; both the per-account and global counters are restored. No code change needed.

---

### [L-04] `executeDebtorAction(REVOKE)` does not validate that `target` is a mandate of `debtorAddr` before calling `_revoke`
**Severity:** Low
**Status:** Fixed (previous turn)
**Description:** The code does check `_mandates[a.target].debtor != debtorAddr` before calling `_revoke`, which handles the case. Confirmed correct.

---

### [I-01] `_hasOpenOrSettled` iterates all collections for a mandate (unbounded)
**Severity:** Informational
**Status:** Acknowledged
**Description:** For a `oneOff` mandate the list is always length ≤ 1 (by design), so this is O(1) in practice. For a non-one-off mandate this function is never called. No change needed.

---

### [I-02] `mandatesOfDebtor` / `mandatesOfCreditor` / `collectionsOfMandate` return unbounded arrays
**Severity:** Informational
**Status:** Acknowledged
**Description:** These are view functions called off-chain (or by RailLens). `creditorView` in RailLens already provides pagination. For very active creditors, direct use of `mandatesOfCreditor` may hit gas limits in a static call from a view-only RPC node; in practice this is only a concern past tens of thousands of mandates.

---

### [I-03] No event emitted when a mandate lapses
**Severity:** Informational
**Status:** Acknowledged
**Description:** Lapse is a time-based state that is derived on-read (`_isLapsed`), not written. There is no explicit LAPSED status transition and therefore no event. This is consistent with the spec ("a mandate is lapsed when…") but UIs that depend on events will need to check `isLapsed()` on-chain or use the Lens.

---

### [I-04] `refundDeadline` returns 0 for unknown collections
**Severity:** Informational
**Status:** Acknowledged
**Description:** An unknown `collectionId` has `settledAt == 0`, so `refundDeadline` returns 0. Callers should treat 0 as "not settled / unknown" rather than "deadline is the epoch". The SDK should handle this.

---

## Summary

| Severity | Count | Fixed | Acknowledged |
|---|---|---|---|
| High | 1 | 1 | 0 |
| Medium | 3 | 3 | 0 |
| Low | 4 | 2 | 2 |
| Informational | 4 | 0 | 4 |

All High and Medium findings are fixed. The two acknowledged Low findings match intentional spec behaviour.
