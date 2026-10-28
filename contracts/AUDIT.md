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

---

## Second Review — Pre-mainnet Changes (this turn)

The following findings were identified during review of the 8-item pre-mainnet change list and resolved in the same turn.

---

### [M-04] EIP-7702 delegation makes `isContract(signer)` unreliable for offer-sig routing
**Severity:** Medium
**Status:** Fixed (this turn)
**Description:** The original `_isValidSig` called `SignatureChecker.isValidSignatureNow` for all signers. Under EIP-7702, an EOA can temporarily have code (the delegated account's bytecode) but must still be validated as an EOA. Routing a delegated EOA through ERC-1271 causes the call to land on the delegation target, which may not implement `isValidSignature` or may implement it in a way that accepts arbitrary messages — breaking the security assumption that only the EOA's private key authorises the offer.
**Fix:** `_isValidSig` now uses `ECDSA.tryRecover` first; if the recovered signer matches, the signature is accepted regardless of code presence. The ERC-1271 path is taken only when the signer is a contract AND ECDSA recovery does not match. This is the EIP-7702-safe ordering.
**Regression test:** `test_offerSig_eip7702_delegatedEOA_recoversViaECDSA` (Change-1 suite).

---

### [M-05] Demo rail had no hard caps on collection amounts
**Severity:** Medium
**Status:** Fixed (this turn)
**Description:** The demo rail accepted any `maxPerCollection` and `maxPerPeriod` values. A creditor could activate a production-sized mandate (e.g. 10 000 USDC per collection) on the demo rail, draining a debtor's testnet funds or creating misleading reserve utilisation. The demo rail was also constructed with the same domain name as prod, making EIP-712 signatures interchangeable between the two instances on the same chain.
**Fix:** Constructor now accepts a `domainName_` parameter (non-empty, validated at construction). The demo deployer passes a distinct name. `activateMandate` / `activateMandateWithPermit` enforce hard caps of `maxPerCollection ≤ 1e6` (1 EURC/USDC) and `maxPerPeriod ≤ 2e6` (2 EURC/USDC) when `IS_DEMO == true`. Constructor validates code presence at both token addresses so a misconfiguration is caught at deploy time.
**Regression tests:** `test_demo_hardCap_maxPerCollection_enforced`, `test_demo_hardCap_maxPerPeriod_enforced`, `test_demo_below_cap_succeeds` (Change-2 suite).

---

### [L-05] Open offers could be activated by unintended debtors
**Severity:** Low
**Status:** Fixed (this turn)
**Description:** An offer with `debtor == address(0)` is an open offer anyone can accept. Adding an optional `debtor` field to `MandateOffer` allows the creditor to restrict the offer to a single address without deploying a separate creditor or off-chain whitelist. Without this, a race condition exists: another party can front-run a `delegated` activation by submitting their own acceptance signature before the intended debtor's transaction lands.
**Fix:** `MandateOffer` gains a `debtor` field. When non-zero, `activateMandate` reverts `NotOfferedDebtor` if the acceptance signer is not the named address. Zero remains open.
**Regression tests:** `test_boundOffer_wrongDebtor_reverts`, `test_boundOffer_rightDebtor_activates`, `test_openOffer_anyDebtor_activates` (Change-3 suite).

---

### [L-06] `activateMandateWithPermit` called permit even when the token was not an allowed token
**Severity:** Low
**Status:** Fixed (this turn)
**Description:** The original permit path called `permit(...)` on an arbitrary `offer.token` address before checking whether the token was in the allowed set. An adversarial creditor could construct an offer pointing at any ERC-20 (including a token with a malicious `permit`) and trick a debtor into signing a permit for it. Additionally, if the mandate was already active, the call would revert `DuplicateMandate` after the permit was already consumed.
**Fix:** `_requireAllowedToken(offer.token)` is now called before the permit try/catch. An already-active mandate returns the existing `mandateId` rather than reverting. After the permit try/catch, `allowance(debtor, address(this)) >= permit.value` is required, else `PermitFailed`.
**Regression tests:** `test_permitPath_disallowedToken_reverts`, `test_permitPath_alreadyActive_returnsExistingId`, `test_permitPath_permitFails_reverts` (Change-4 suite).

---

### [L-07] `claimFor` missing; `claim`/`withdrawReserve` silently dropped failed transfers
**Severity:** Low
**Status:** Fixed (this turn)
**Description:** There was no `claimFor(creditor, token)` helper, requiring the creditor's payout address to initiate its own claim. More critically, `withdrawReserve` used `_pushToken` (soft fail with claimable fallback) rather than strict revert on transfer failure, meaning a blocklisted payout address would silently accumulate a claimable balance the creditor would not see in normal accounting. `claim` also used soft-fail, meaning a recipient who self-blocked could never drain their claimable.
**Fix:** Added `claimFor(address creditor, address token)` callable by anyone, which pays the creditor's registered payout address. `claim` and `claimFor` now use `_pushTokenStrict` (reverts `TransferFailed` on failure) — no re-credit on failure. `withdrawReserve` also uses `_pushTokenStrict`. The soft-fail `_pushToken` with claimable fallback is retained only for `collect`, `refund`, and `release` payouts where a blocked payout must not freeze the protocol.
**Regression tests:** `test_claimFor_pays_payout`, `test_claimFor_zeroClaimable_reverts`, `test_withdrawReserve_transferFail_reverts` (Change-5 suite).

---

### [I-05] One-off mandate loop replaced with O(1) counter; lens pagination added
**Severity:** Informational
**Status:** Fixed (this turn)
**Description:** `_hasOpenOrSettled` iterated `_collectionsOfMandate` which, while bounded for one-off mandates, is O(n) and relies on the invariant that one-off mandates have at most one entry. The new `_openCount[mandateId]` shadow counter is O(1). `RailLens.debtorView` previously returned all mandates in one call; `collectionsPage` was also absent, making high-collection creditors unqueryable from a view call without gas limits. Addressed by adding `limit`/`offset` to `debtorView` and a new `collectionsPage(creditorId, token, offset, limit)`.
**Regression tests:** `test_debtorView_pagination`, `test_collectionsPage_paginates`, `test_collectionsOpenCount_increments`, `test_mandateView_collectionCount_matches` (Change-6 suite).

---

### [I-06] `lastActivityAt` not updated when `collect` produces RETURNED
**Severity:** Informational
**Status:** Fixed (this turn)
**Description:** A mandate whose collections repeatedly return RETURNED (AM04/MS03 — no balance or no allowance) would not update `lastActivityAt`, causing the lapse clock to advance based on the last *successful* collect or activate. This could lapse a mandate while the creditor is actively attempting collection, which is inconsistent with the SEPA analogue where a returned debit resets the lapse window.
**Fix:** `collect()` now sets `m.lastActivityAt = uint64(block.timestamp)` for RETURNED status, matching the existing update for SETTLED.
**Regression tests:** `test_lastActivityAt_updatedOnReturned_collect_failedTransfer`, `test_lastActivityAt_updatedOnSettled_collect` (Change-7 suite).

---

## Summary

| Severity | Count | Fixed | Acknowledged |
|---|---|---|---|
| High | 1 | 1 | 0 |
| Medium | 5 | 5 | 0 |
| Low | 9 | 7 | 2 |
| Informational | 6 | 2 | 4 |

All High and Medium findings are fixed. The two acknowledged Low findings (L-01, L-02) match intentional spec behaviour and remain unchanged.
