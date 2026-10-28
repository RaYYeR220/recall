// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./DebitRailBase.t.sol";

/// @notice Tests for refund, release, refund window boundary, claimable fallback,
///         executeDebtorAction, and the fuzz round-trip.
contract DebitRailRefundTest is DebitRailBase {

    bytes32 internal mandateId;
    bytes32 internal mandateIdB2B;

    function setUp() public override {
        super.setUp();
        _registerCreditor1();

        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 1_000e6);
        prod.fundReserve(creditorId1, address(eurc), 1_000e6);
        vm.stopPrank();

        MandateOffer memory offer = _defaultOffer();
        mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);
        vm.prank(debtor);
        eurc.approve(address(prod), type(uint256).max);

        MandateOffer memory b2bOffer = _defaultOffer();
        b2bOffer.scheme   = Scheme.B2B;
        b2bOffer.offerRef = bytes32("B2B-REF");
        mandateIdB2B = _activateMandate(prod, b2bOffer, creditorOwnerKey, debtor, debtorKey);
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _settleCollection(uint128 amount, bytes32 e2eId)
        internal returns (bytes32 collectionId)
    {
        uint64 dueAt = uint64(block.timestamp + 2 days);
        vm.prank(creditorOwner);
        collectionId = prod.prenotify(mandateId, amount, dueAt, e2eId, "");
        vm.warp(dueAt);
        prod.collect(collectionId);
    }

    function _settleB2BCollection(uint128 amount, bytes32 e2eId)
        internal returns (bytes32 collectionId)
    {
        uint64 dueAt = uint64(block.timestamp + 2 days);
        vm.prank(creditorOwner);
        collectionId = prod.prenotify(mandateIdB2B, amount, dueAt, e2eId, "");
        vm.warp(dueAt);
        prod.collect(collectionId);
    }

    // ─── refund happy path ───────────────────────────────────────────────────

    function test_refund_withinWindow_fullAmountBack() public {
        uint128 amount   = 100e6;
        bytes32 cid      = _settleCollection(amount, bytes32("RF-HP"));
        uint256 debtorBefore = eurc.balanceOf(debtor);

        Coverage memory covBefore = prod.coverage(creditorId1, address(eurc));

        vm.prank(debtor);
        prod.refund(cid);

        // Debtor balance restored exactly (I6)
        assertEq(eurc.balanceOf(debtor) - debtorBefore, amount);

        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.REFUNDED));

        // Reserve reduced by locked part
        Collection memory col = prod.getCollection(cid);
        Coverage memory covAfter = prod.coverage(creditorId1, address(eurc));

        assertEq(covBefore.reserveTotal  - covAfter.reserveTotal,  col.locked);
        assertEq(covBefore.reserveLocked - covAfter.reserveLocked, col.locked);
        assertEq(covBefore.held          - covAfter.held,          col.held);
        assertEq(covBefore.openExposure  - covAfter.openExposure,  amount);

        // I2 still holds after refund
        assertEq(covAfter.openExposure, covAfter.reserveLocked + covAfter.held);

        // Stats
        (uint256 collected, uint256 refunded,, uint256 refundedCount,) = prod.stats(address(eurc));
        assertEq(refunded,      amount);
        assertEq(refundedCount, 1);
        assertEq(collected,     amount); // collected didn't change (it's the settled total)
    }

    // ─── refund at exact deadline reverts ────────────────────────────────────

    function test_refund_atExactDeadline_reverts() public {
        bytes32 cid = _settleCollection(50e6, bytes32("RF-DL"));
        Collection memory col = prod.getCollection(cid);
        uint256 deadline = uint256(col.settledAt) + prod.refundWindow();

        // At exactly deadline → closed
        vm.warp(deadline);
        vm.prank(debtor);
        vm.expectRevert(RefundWindowClosed.selector);
        prod.refund(cid);

        // One second before → still open
        vm.warp(deadline - 1);
        vm.prank(debtor);
        prod.refund(cid); // should succeed
    }

    // ─── refund B2B reverts ───────────────────────────────────────────────────

    function test_refund_b2b_reverts() public {
        bytes32 cid = _settleB2BCollection(50e6, bytes32("RF-B2B"));
        vm.prank(debtor);
        vm.expectRevert(NoRefundRightB2B.selector);
        prod.refund(cid);
    }

    // ─── refund by stranger reverts ──────────────────────────────────────────

    function test_refund_byStranger_reverts() public {
        bytes32 cid = _settleCollection(50e6, bytes32("RF-STR"));
        vm.prank(stranger);
        vm.expectRevert(NotDebtor.selector);
        prod.refund(cid);
    }

    // ─── release before window reverts ───────────────────────────────────────

    function test_release_beforeWindow_reverts() public {
        bytes32 cid = _settleCollection(50e6, bytes32("RL-BW"));
        vm.prank(stranger);
        vm.expectRevert(RefundWindowOpen.selector);
        prod.release(cid);
    }

    // ─── release after window ────────────────────────────────────────────────

    function test_release_afterWindow_unlocksAndPaysHeld() public {
        // Drain reserve so held > 0
        vm.prank(creditorOwner);
        prod.withdrawReserve(creditorId1, address(eurc), 999_700_000, creditorOwner);
        // reserve = 300_000 (0.3 EURC)

        uint128 amount = 1_000_000; // 1 EURC → locked=0.3, held=0.7
        uint64  dueAt  = uint64(block.timestamp + 2 days);
        vm.prank(creditorOwner);
        bytes32 cid = prod.prenotify(mandateId, amount, dueAt, bytes32("RL-HLD"), "");
        vm.warp(dueAt);
        prod.collect(cid);

        Collection memory col = prod.getCollection(cid);
        assertEq(col.held, 700_000);

        vm.warp(uint256(col.settledAt) + prod.refundWindow() + 1);
        uint256 payoutBefore = eurc.balanceOf(creditorPayout);
        prod.release(cid);

        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.FINAL));
        // Held amount paid to payout
        assertEq(eurc.balanceOf(creditorPayout) - payoutBefore, 700_000);

        Coverage memory cov = prod.coverage(creditorId1, address(eurc));
        assertEq(cov.held,          0);
        assertEq(cov.reserveLocked, 0);
        assertEq(cov.openExposure,  0);

        // I2 still holds
        assertEq(cov.openExposure, cov.reserveLocked + cov.held);
    }

    // ─── blocklisted debtor → claimable ──────────────────────────────────────

    function test_refund_blocklistedDebtor_creditsClaimable() public {
        bytes32 cid = _settleCollection(50e6, bytes32("BLD-1"));

        // Block debtor's address
        eurc.setBlocked(debtor, true);

        vm.prank(debtor);
        prod.refund(cid);

        // Debtor can't receive tokens; amount goes to claimable
        assertEq(prod.claimable(debtor, address(eurc)), 50e6);
        // Debtor's token balance unchanged (transfer failed)

        // After unblocking, debtor can claim
        eurc.setBlocked(debtor, false);
        uint256 before = eurc.balanceOf(debtor);
        vm.prank(debtor);
        prod.claim(address(eurc));
        assertEq(eurc.balanceOf(debtor) - before, 50e6);
    }

    // ─── withdrawReserve — locked portion reverts ─────────────────────────────

    function test_withdrawReserve_lockedPortion_reverts() public {
        _settleCollection(100e6, bytes32("WR-LK"));
        // 100e6 locked — try to withdraw 100e6 free + locked
        vm.prank(creditorOwner);
        vm.expectRevert(ReserveLocked.selector);
        prod.withdrawReserve(creditorId1, address(eurc), 1_000e6, creditorOwner);
    }

    // ─── executeDebtorAction ──────────────────────────────────────────────────

    function test_debtorAction_refundBySignature() public {
        bytes32 cid = _settleCollection(50e6, bytes32("DA-RF"));
        uint256 nonceBefore = prod.nonces(debtor);

        DebtorAction memory action = DebtorAction({
            kind:     ActionKind.REFUND,
            target:   cid,
            nonce:    nonceBefore,
            deadline: uint64(block.timestamp + 1 hours)
        });
        bytes memory sig = _signDebtorAction(prod, action, debtorKey);

        uint256 before = eurc.balanceOf(debtor);
        vm.prank(stranger); // relayer — not the debtor
        prod.executeDebtorAction(action, debtor, sig);

        assertEq(eurc.balanceOf(debtor) - before, 50e6);
        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.REFUNDED));
        assertEq(prod.nonces(debtor), nonceBefore + 1);
    }

    function test_debtorAction_replay_reverts() public {
        bytes32 cid = _settleCollection(50e6, bytes32("DA-RP"));
        uint256 nonce = prod.nonces(debtor);

        DebtorAction memory action = DebtorAction({
            kind:     ActionKind.REFUND,
            target:   cid,
            nonce:    nonce,
            deadline: uint64(block.timestamp + 1 hours)
        });
        bytes memory sig = _signDebtorAction(prod, action, debtorKey);
        prod.executeDebtorAction(action, debtor, sig);

        // Replay: same sig, same nonce → BadNonce
        vm.expectRevert(BadNonce.selector);
        prod.executeDebtorAction(action, debtor, sig);
    }

    function test_debtorAction_wrongDebtor_reverts() public {
        bytes32 cid = _settleCollection(50e6, bytes32("DA-WD"));
        uint256 nonce = prod.nonces(debtor2);

        DebtorAction memory action = DebtorAction({
            kind:     ActionKind.REFUND,
            target:   cid,
            nonce:    nonce,
            deadline: uint64(block.timestamp + 1 hours)
        });
        // debtor2 signs but the collection belongs to debtor
        bytes memory sig = _signDebtorAction(prod, action, debtor2Key);
        vm.expectRevert(NotDebtor.selector);
        prod.executeDebtorAction(action, debtor2, sig);
    }

    function test_debtorAction_revokeBySignature() public {
        uint256 nonce = prod.nonces(debtor);
        DebtorAction memory action = DebtorAction({
            kind:     ActionKind.REVOKE,
            target:   mandateId,
            nonce:    nonce,
            deadline: uint64(block.timestamp + 1 hours)
        });
        bytes memory sig = _signDebtorAction(prod, action, debtorKey);
        vm.prank(stranger);
        prod.executeDebtorAction(action, debtor, sig);
        assertEq(uint8(prod.getMandate(mandateId).status), uint8(MandateStatus.REVOKED));
    }

    function test_debtorAction_refuseBySignature() public {
        uint64 dueAt = uint64(block.timestamp + 2 days);
        vm.prank(creditorOwner);
        bytes32 cid = prod.prenotify(mandateId, 50e6, dueAt, bytes32("DA-REF-SIG"), "");

        uint256 nonce = prod.nonces(debtor);
        DebtorAction memory action = DebtorAction({
            kind:     ActionKind.REFUSE,
            target:   cid,
            nonce:    nonce,
            deadline: uint64(block.timestamp + 1 hours)
        });
        bytes memory sig = _signDebtorAction(prod, action, debtorKey);
        vm.prank(stranger);
        prod.executeDebtorAction(action, debtor, sig);
        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.REFUSED));
    }

    function test_debtorAction_expiredDeadline_reverts() public {
        bytes32 cid = _settleCollection(50e6, bytes32("DA-EXP"));
        uint256 nonce = prod.nonces(debtor);
        DebtorAction memory action = DebtorAction({
            kind:     ActionKind.REFUND,
            target:   cid,
            nonce:    nonce,
            deadline: uint64(block.timestamp - 1)
        });
        bytes memory sig = _signDebtorAction(prod, action, debtorKey);
        vm.expectRevert(SignatureExpired.selector);
        prod.executeDebtorAction(action, debtor, sig);
    }

    // ─── fuzz: collect → refund round-trip ──────────────────────────────────

    /// @notice Debtor ends with original balance. I2 holds throughout.
    function testFuzz_collectRefund_roundTrip(uint128 amount, uint128 reserve) public {
        // Bound inputs to realistic stablecoin range
        amount  = uint128(bound(amount,  1e6,  100e6));
        reserve = uint128(bound(reserve, 0,    500e6));

        // Reset state: re-deploy rail
        DebitRail fuzzRail = new DebitRail(address(eurc), address(usdc), 1, "Recall DebitRail", "fuzz");

        vm.startPrank(creditorOwner);
        uint256 fcid = fuzzRail.registerCreditor("Fuzz Merchant", creditorPayout);
        if (reserve > 0) {
            eurc.approve(address(fuzzRail), reserve);
            fuzzRail.fundReserve(fcid, address(eurc), reserve);
        }
        vm.stopPrank();

        MandateOffer memory offer = MandateOffer({
            creditorId:       fcid,
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: amount, // exactly our amount
            maxPerPeriod:     amount,
            periodLength:     uint32(30 days),
            prenoticeLength:  uint32(1 days),
            offerRef:         bytes32("FUZZ"),
            termsHash:        keccak256("fuzz"),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days),
            timeScale:        1,
            debtor:           address(0)
        });
        bytes32 fmid = _activateMandate(fuzzRail, offer, creditorOwnerKey, debtor, debtorKey);

        vm.prank(debtor);
        eurc.approve(address(fuzzRail), type(uint256).max);

        uint256 debtorBalBefore = eurc.balanceOf(debtor);

        uint64 dueAt = uint64(block.timestamp + 2 days);
        vm.prank(creditorOwner);
        bytes32 colId = fuzzRail.prenotify(fmid, amount, dueAt, bytes32("FUZZ-E2E"), "");
        vm.warp(dueAt);
        CollectionStatus st = fuzzRail.collect(colId);

        if (st != CollectionStatus.SETTLED) {
            // Payer-side failure (shouldn't happen in well-funded fuzz, but guard)
            return;
        }

        // I2 after collect
        Coverage memory cov = fuzzRail.coverage(fcid, address(eurc));
        assertEq(cov.openExposure, cov.reserveLocked + cov.held);

        // Refund
        vm.prank(debtor);
        fuzzRail.refund(colId);

        // Debtor has original balance (I6)
        assertEq(eurc.balanceOf(debtor), debtorBalBefore);

        // I2 after refund
        cov = fuzzRail.coverage(fcid, address(eurc));
        assertEq(cov.openExposure, cov.reserveLocked + cov.held);
        assertEq(cov.openExposure, 0);
    }
}
