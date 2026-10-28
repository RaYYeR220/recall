// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./DebitRailBase.t.sol";
import "./mocks/MockReturnFalseToken.sol";

/// @notice Tests for prenotify, refuse, cancel, collect, expire, period caps,
///         push-token false-return, and the _pushToken claimable fallback.
contract DebitRailCollectionTest is DebitRailBase {

    bytes32 internal mandateId;
    bytes32 internal mandateIdB2B;

    // Convenience: active CORE mandate on prod
    function setUp() public override {
        super.setUp();
        _registerCreditor1();

        // Fund reserve: 500 EURC
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 500e6);
        prod.fundReserve(creditorId1, address(eurc), 500e6);
        vm.stopPrank();

        // Activate CORE mandate
        MandateOffer memory offer = _defaultOffer();
        mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        // Give debtor an allowance
        vm.prank(debtor);
        eurc.approve(address(prod), type(uint256).max);

        // Activate B2B mandate (second offer, different offerRef)
        MandateOffer memory b2bOffer = _defaultOffer();
        b2bOffer.scheme   = Scheme.B2B;
        b2bOffer.offerRef = bytes32("REF-B2B");
        mandateIdB2B = _activateMandate(prod, b2bOffer, creditorOwnerKey, debtor, debtorKey);
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _scheduleCollection(
        bytes32 mid,
        uint128 amount,
        uint64  dueAt,
        bytes32 e2eId
    ) internal returns (bytes32 collectionId) {
        vm.prank(creditorOwner);
        collectionId = prod.prenotify(mid, amount, dueAt, e2eId, "");
    }

    function _defaultDueAt() internal view returns (uint64) {
        return uint64(block.timestamp + 2 days);
    }

    // ─── prenotify happy path ─────────────────────────────────────────────────

    function test_prenotify_happyPath() public {
        uint64 dueAt = _defaultDueAt();
        bytes32 cid  = _scheduleCollection(mandateId, 50e6, dueAt, bytes32("E2E-001"));

        Collection memory col = prod.getCollection(cid);
        assertEq(uint8(col.status), uint8(CollectionStatus.SCHEDULED));
        assertEq(col.amount, 50e6);
        assertEq(col.dueAt,  dueAt);
        assertEq(col.mandateId, mandateId);

        // Appears in collectionsOfMandate
        bytes32[] memory ids = prod.collectionsOfMandate(mandateId);
        assertEq(ids.length, 1);
        assertEq(ids[0], cid);
    }

    function test_prenotify_tooShort_reverts() public {
        // dueAt < now + scaled prenotice (1 day on prod)
        uint64 badDueAt = uint64(block.timestamp + 1 hours);
        vm.prank(creditorOwner);
        vm.expectRevert(PrenoticeTooShort.selector);
        prod.prenotify(mandateId, 50e6, badDueAt, bytes32("E2E-002"), "");
    }

    function test_prenotify_overCollectionCap_reverts() public {
        vm.prank(creditorOwner);
        vm.expectRevert(OverCollectionCap.selector);
        prod.prenotify(mandateId, 101e6, _defaultDueAt(), bytes32("E2E-003"), "");
    }

    function test_prenotify_duplicateE2E_reverts() public {
        _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("E2E-DUP"));
        vm.prank(creditorOwner);
        vm.expectRevert(AM05_Duplicate.selector);
        prod.prenotify(mandateId, 50e6, _defaultDueAt() + 1 days, bytes32("E2E-DUP"), "");
    }

    function test_prenotify_revokedMandate_reverts() public {
        vm.prank(debtor);
        prod.revoke(mandateId);
        vm.prank(creditorOwner);
        vm.expectRevert(MD01_NoValidMandate.selector);
        prod.prenotify(mandateId, 50e6, _defaultDueAt(), bytes32("E2E-REV"), "");
    }

    function test_prenotify_lapsedMandate_reverts() public {
        vm.warp(block.timestamp + 1080 days + 1);
        vm.prank(creditorOwner);
        vm.expectRevert(MD01_NoValidMandate.selector);
        prod.prenotify(mandateId, 50e6, uint64(block.timestamp + 2 days), bytes32("E2E-LAPSE"), "");
    }

    function test_prenotify_byOperator_ok() public {
        vm.prank(creditorOwner);
        prod.setOperator(creditorId1, operator, true);
        vm.prank(operator);
        bytes32 cid = prod.prenotify(mandateId, 50e6, _defaultDueAt(), bytes32("E2E-OP"), "");
        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.SCHEDULED));
    }

    function test_prenotify_byStranger_reverts() public {
        vm.prank(stranger);
        vm.expectRevert(NotCreditorAgent.selector);
        prod.prenotify(mandateId, 50e6, _defaultDueAt(), bytes32("E2E-STR"), "");
    }

    function test_prenotify_scheduleTooFar_reverts() public {
        uint64 tooFar = uint64(block.timestamp + 401 days);
        vm.prank(creditorOwner);
        vm.expectRevert(ScheduleTooFar.selector);
        prod.prenotify(mandateId, 50e6, tooFar, bytes32("E2E-FAR"), "");
    }

    // ─── period cap ──────────────────────────────────────────────────────────

    function test_periodCap_samePeriod_reverts() public {
        _scheduleCollection(mandateId, 100e6, _defaultDueAt(), bytes32("PC-1"));
        // maxPerPeriod=200e6; another 100e6 = 200e6 (ok)
        _scheduleCollection(mandateId, 100e6, _defaultDueAt() + 1 hours, bytes32("PC-2"));
        // 200e6 + 1 = over cap
        vm.prank(creditorOwner);
        vm.expectRevert(OverPeriodCap.selector);
        prod.prenotify(mandateId, 1e6, _defaultDueAt() + 2 hours, bytes32("PC-3"), "");
    }

    function test_periodCap_boundary() public {
        Mandate memory m = prod.getMandate(mandateId);
        // A dueAt exactly at the start of period 1 counts in period 1
        uint64 period1Start = m.activatedAt + uint64(30 days);
        // Ensure enough prenotice from current time
        vm.warp(period1Start - 2 days);

        // Fill period 0 fully
        _scheduleCollection(mandateId, 100e6, uint64(period1Start - 1 days), bytes32("B-P0-1"));
        _scheduleCollection(mandateId, 100e6, uint64(period1Start - 12 hours), bytes32("B-P0-2"));

        // dueAt = exactly period1Start → period index 1 → fresh usage
        uint64 dueAtP1 = period1Start;
        vm.prank(creditorOwner);
        bytes32 cid = prod.prenotify(mandateId, 100e6, dueAtP1, bytes32("B-P1-1"), "");
        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.SCHEDULED));
    }

    function test_periodCap_demoScaled() public {
        // Register creditor on demo and activate mandate
        vm.prank(creditorOwner);
        uint256 demoCid = demo.registerCreditor("Merchant Demo", creditorPayout);
        vm.startPrank(creditorOwner);
        eurc.approve(address(demo), 500e6);
        demo.fundReserve(demoCid, address(eurc), 500e6);
        vm.stopPrank();

        MandateOffer memory demoOffer = MandateOffer({
            creditorId:       demoCid,
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: 1e6,   // demo cap: <= 1e6
            maxPerPeriod:     2e6,   // demo cap: <= 2e6
            periodLength:     uint32(30 days), // legal seconds; scaled -> 30*86400/10080 = 257 s
            prenoticeLength:  uint32(1 days),
            offerRef:         bytes32("DEMO-REF"),
            termsHash:        keccak256("terms"),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days),
            timeScale:        10080,
            debtor:           address(0)
        });
        bytes32 dmid = _activateMandate(demo, demoOffer, creditorOwnerKey, debtor, debtorKey);

        // Scaled period: 30*86400/10080 = 257 s. Advance to period 1.
        Mandate memory dm = demo.getMandate(dmid);
        uint256 scaledPeriod = uint256(dm.periodLength) / demo.timeScale();

        vm.warp(dm.activatedAt + scaledPeriod);

        // dueAt in period 1 — prenotice is 8 s on demo
        uint64 dueAt = uint64(block.timestamp + 10);

        vm.prank(creditorOwner);
        // Amount must be <= maxPerCollection = 1e6 (demo safety cap)
        bytes32 cid = demo.prenotify(dmid, 1e6, dueAt, bytes32("DEMO-P1"), "");

        // period index 0 is the first period (activatedAt), period 1 starts at activatedAt + scaledPeriod
        assertEq(demo.periodIndexOf(dmid, uint64(dm.activatedAt)), 0);       // period 0
        assertEq(demo.periodIndexOf(dmid, uint64(dm.activatedAt + scaledPeriod)), 1); // period 1
        assertEq(uint8(demo.getCollection(cid).status), uint8(CollectionStatus.SCHEDULED));
    }

    function test_periodCap_releasedOnRefuse() public {
        bytes32 cid = _scheduleCollection(mandateId, 100e6, _defaultDueAt(), bytes32("REL-1"));
        assertEq(prod.periodUsage(mandateId, prod.periodIndexOf(mandateId, _defaultDueAt())), 100e6);

        vm.prank(debtor);
        prod.refuse(cid);

        assertEq(prod.periodUsage(mandateId, prod.periodIndexOf(mandateId, _defaultDueAt())), 0);
    }

    // ─── collect timing ───────────────────────────────────────────────────────

    function test_collect_tooEarly_reverts() public {
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("COL-E"));
        vm.expectRevert(TooEarly.selector);
        prod.collect(cid);
    }

    function test_collect_afterExecutionWindow_reverts() public {
        uint64 dueAt = _defaultDueAt();
        bytes32 cid  = _scheduleCollection(mandateId, 50e6, dueAt, bytes32("COL-W"));
        vm.warp(uint256(dueAt) + prod.executionWindow() + 1);
        vm.expectRevert(ExecutionWindowPassed.selector);
        prod.collect(cid);
    }

    function test_expire_afterWindow() public {
        uint64 dueAt = _defaultDueAt();
        bytes32 cid  = _scheduleCollection(mandateId, 50e6, dueAt, bytes32("EXP-1"));
        uint256 pidx = prod.periodIndexOf(mandateId, dueAt);
        assertEq(prod.periodUsage(mandateId, pidx), 50e6);

        vm.warp(uint256(dueAt) + prod.executionWindow() + 1);
        prod.expire(cid);

        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.EXPIRED));
        assertEq(prod.periodUsage(mandateId, pidx), 0); // usage released
    }

    function test_expire_beforeWindow_reverts() public {
        uint64 dueAt = _defaultDueAt();
        bytes32 cid  = _scheduleCollection(mandateId, 50e6, dueAt, bytes32("EXP-2"));
        vm.warp(dueAt); // at dueAt, still within window
        vm.expectRevert(TooEarly.selector);
        prod.expire(cid);
    }

    // ─── collect — reserve fully covers ──────────────────────────────────────

    function test_collect_reserveCovered_paysCreditorInFull() public {
        uint128 amount = 100e6;
        uint64  dueAt  = _defaultDueAt();
        bytes32 cid    = _scheduleCollection(mandateId, amount, dueAt, bytes32("FC-1"));

        vm.warp(dueAt);
        uint256 payoutBefore = eurc.balanceOf(creditorPayout);
        prod.collect(cid);

        Collection memory col = prod.getCollection(cid);
        assertEq(uint8(col.status), uint8(CollectionStatus.SETTLED));
        assertEq(col.locked, amount);
        assertEq(col.held,   0);

        // Creditor was paid the non-held part (all of it, since held=0)
        assertEq(eurc.balanceOf(creditorPayout) - payoutBefore, amount);

        // Coverage
        Coverage memory cov = prod.coverage(creditorId1, address(eurc));
        assertEq(cov.reserveLocked,  amount);
        assertEq(cov.openExposure,   amount);

        // Invariant I2
        assertEq(cov.openExposure, cov.reserveLocked + cov.held);
    }

    // ─── collect — partial reserve ────────────────────────────────────────────

    function test_collect_partialReserve_holdsRemainder() public {
        // Free reserve = 0.3 EURC; collect 1.0 EURC → locked=0.3, held=0.7
        // First drain all but 0.3 EURC of the 500e6 reserve
        vm.prank(creditorOwner);
        prod.withdrawReserve(creditorId1, address(eurc), 499_700_000, creditorOwner);
        // reserve now = 300_000 (0.3 EURC = 300_000 units at 6dp)

        uint128 amount = 1_000_000; // 1.0 EURC
        bytes32 cid    = _scheduleCollection(mandateId, amount, _defaultDueAt(), bytes32("PR-1"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        Collection memory col = prod.getCollection(cid);
        assertEq(col.locked, 300_000);
        assertEq(col.held,   700_000);

        Coverage memory cov = prod.coverage(creditorId1, address(eurc));
        assertEq(cov.reserveLocked, 300_000);
        assertEq(cov.held,          700_000);
        assertEq(cov.openExposure,  1_000_000);
        // Creditor received 0.3 EURC now (0.7 is held)
        // Invariant I2
        assertEq(cov.openExposure, cov.reserveLocked + cov.held);
    }

    // ─── collect — B2B ────────────────────────────────────────────────────────

    function test_collect_b2b_noLockNoHold() public {
        uint128 amount = 50e6;
        bytes32 cid    = _scheduleCollection(mandateIdB2B, amount, _defaultDueAt(), bytes32("B2B-1"));

        vm.warp(_defaultDueAt());
        uint256 before = eurc.balanceOf(creditorPayout);
        CollectionStatus st = prod.collect(cid);

        // B2B → FINAL immediately (no refund window, nothing to release)
        assertEq(uint8(st), uint8(CollectionStatus.FINAL));
        Collection memory col = prod.getCollection(cid);
        assertEq(uint8(col.status), uint8(CollectionStatus.FINAL));
        assertEq(col.locked, 0);
        assertEq(col.held,   0);

        // Full amount paid immediately
        assertEq(eurc.balanceOf(creditorPayout) - before, amount);

        // Coverage: no open exposure for B2B
        Coverage memory cov = prod.coverage(creditorId1, address(eurc));
        assertEq(cov.openExposure, 0);
    }

    function test_collect_b2b_isFinalImmediately() public {
        uint128 amount = 50e6;
        bytes32 cid    = _scheduleCollection(mandateIdB2B, amount, _defaultDueAt(), bytes32("B2B-FIN1"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        // Status is FINAL, not SETTLED
        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.FINAL));
        // settledAt is set
        assertGt(prod.getCollection(cid).settledAt, 0);
        // refundDeadline == settledAt for B2B (no refund window)
        assertEq(prod.refundDeadline(cid), uint256(prod.getCollection(cid).settledAt));
    }

    function test_release_b2b_reverts_WrongStatus() public {
        uint128 amount = 50e6;
        bytes32 cid    = _scheduleCollection(mandateIdB2B, amount, _defaultDueAt(), bytes32("B2B-REL1"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        // B2B is already FINAL; release() requires SETTLED → WrongStatus
        vm.warp(block.timestamp + prod.refundWindow() + 1);
        vm.expectRevert(WrongStatus.selector);
        prod.release(cid);
    }

    // ─── collect — returned cases ─────────────────────────────────────────────

    function test_collect_insufficientBalance_returnsAM04() public {
        // Drain debtor's balance
        uint256 bal = eurc.balanceOf(debtor);
        vm.prank(debtor);
        eurc.transfer(stranger, bal);

        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("AM04-1"));
        vm.warp(_defaultDueAt());
        CollectionStatus st = prod.collect(cid);

        assertEq(uint8(st), uint8(CollectionStatus.RETURNED));
        assertEq(prod.getCollection(cid).code, bytes4("AM04"));

        // Period usage released
        assertEq(prod.periodUsage(mandateId, prod.periodIndexOf(mandateId, _defaultDueAt())), 0);
    }

    function test_collect_noAllowance_returnsMS03() public {
        // Revoke the allowance
        vm.prank(debtor);
        eurc.approve(address(prod), 0);

        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("MS03-1"));
        vm.warp(_defaultDueAt());
        CollectionStatus st = prod.collect(cid);

        assertEq(uint8(st), uint8(CollectionStatus.RETURNED));
        assertEq(prod.getCollection(cid).code, bytes4("MS03"));
    }

    function test_collect_revokedAfterPrenotify_returnsMD01() public {
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("MD01-1"));

        // Revoke between prenotify and collect
        vm.prank(debtor);
        prod.revoke(mandateId);

        vm.warp(_defaultDueAt());
        CollectionStatus st = prod.collect(cid);

        assertEq(uint8(st), uint8(CollectionStatus.RETURNED));
        assertEq(prod.getCollection(cid).code, bytes4("MD01"));
    }

    // ─── refuse / cancel ──────────────────────────────────────────────────────

    function test_refuse_beforeCollect() public {
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("REF-1"));
        vm.prank(debtor);
        prod.refuse(cid);
        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.REFUSED));
        assertEq(prod.getCollection(cid).code, bytes4("MS02"));
    }

    function test_refuse_afterCollect_reverts() public {
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("REF-2"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);
        vm.prank(debtor);
        vm.expectRevert(WrongStatus.selector);
        prod.refuse(cid);
    }

    function test_refuse_byStranger_reverts() public {
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("REF-STR"));
        vm.prank(stranger);
        vm.expectRevert(NotDebtor.selector);
        prod.refuse(cid);
    }

    function test_cancel_byCreditor() public {
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("CAN-1"));
        vm.prank(creditorOwner);
        prod.cancel(cid);
        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.CANCELLED));
    }

    function test_cancel_byOperator() public {
        vm.prank(creditorOwner);
        prod.setOperator(creditorId1, operator, true);
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("CAN-OP"));
        vm.prank(operator);
        prod.cancel(cid);
        assertEq(uint8(prod.getCollection(cid).status), uint8(CollectionStatus.CANCELLED));
    }

    function test_cancel_byStranger_reverts() public {
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("CAN-STR"));
        vm.prank(stranger);
        vm.expectRevert(NotCreditorAgent.selector);
        prod.cancel(cid);
    }

    // ─── blocklistedPayout → claimable ───────────────────────────────────────

    function test_collect_blocklistedPayout_creditsClaimable() public {
        // Block the payout address in the token contract
        eurc.setBlocked(creditorPayout, true);

        uint128 amount = 50e6;
        bytes32 cid    = _scheduleCollection(mandateId, amount, _defaultDueAt(), bytes32("BLP-1"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        // Settled (no revert), and held=0 since reserve covers it fully
        Collection memory col = prod.getCollection(cid);
        assertEq(uint8(col.status), uint8(CollectionStatus.SETTLED));

        // The non-held part (full amount, held=0) went to claimable
        assertEq(prod.claimable(creditorPayout, address(eurc)), amount);
    }

    function test_claim_paysOut() public {
        eurc.setBlocked(creditorPayout, true);
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("CLM-1"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        // Unblock and claim
        eurc.setBlocked(creditorPayout, false);
        uint256 before = eurc.balanceOf(creditorPayout);
        vm.prank(creditorPayout);
        prod.claim(address(eurc));
        assertEq(eurc.balanceOf(creditorPayout) - before, 50e6);
        assertEq(prod.claimable(creditorPayout, address(eurc)), 0);
    }

    // ─── _pushToken returns-false path ────────────────────────────────────────

    function test_pushToken_returnsFalse_creditsClaimable() public {
        // MockReturnFalseToken: transferFrom works normally, transfer() returns false.
        // This tests that _pushToken correctly falls back to claimable on a false return.
        MockReturnFalseToken rft = new MockReturnFalseToken();
        rft.mint(creditorOwner, 1_000e6);

        // Deploy a fresh rail that accepts this token (as the "eurc" slot)
        DebitRail testRail = new DebitRail(
            address(rft),   // eurc slot -- the token we test with
            address(usdc),  // usdc slot (unused in this test)
            1,
            "Recall DebitRail",
            "test"
        );

        vm.startPrank(creditorOwner);
        uint256 rcid = testRail.registerCreditor("Merchant RFF", creditorPayout);
        // fundReserve uses safeTransferFrom -- this works because transferFrom is normal on RFF
        rft.approve(address(testRail), 500e6);
        testRail.fundReserve(rcid, address(rft), 500e6);
        vm.stopPrank();

        // withdrawReserve now uses _pushTokenStrict, which reverts TransferFailed (not claimable).
        vm.prank(creditorOwner);
        vm.expectRevert(TransferFailed.selector);
        testRail.withdrawReserve(rcid, address(rft), 100e6, creditorOwner);

        // Reserve accounting unchanged (revert rolled it back)
        Coverage memory cov = testRail.coverage(rcid, address(rft));
        assertEq(cov.reserveTotal, 500e6);
    }

    // ─── oneOff ───────────────────────────────────────────────────────────────

    function test_oneOff_becomesUsed() public {
        MandateOffer memory offer = _defaultOffer();
        offer.oneOff   = true;
        offer.offerRef = bytes32("ONE-OFF");
        bytes32 mid    = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        bytes32 cid = _scheduleCollection(mid, 50e6, _defaultDueAt(), bytes32("OO-1"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        assertEq(uint8(prod.getMandate(mid).status), uint8(MandateStatus.USED));
    }

    function test_oneOff_secondPrenotify_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.oneOff   = true;
        offer.offerRef = bytes32("ONE-OFF-2");
        bytes32 mid    = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        // First prenotify — ok
        _scheduleCollection(mid, 50e6, _defaultDueAt(), bytes32("OO2-1"));

        // Second prenotify — OneOffBusy
        vm.prank(creditorOwner);
        vm.expectRevert(OneOffBusy.selector);
        prod.prenotify(mid, 50e6, _defaultDueAt() + 1 days, bytes32("OO2-2"), "");
    }

    // ─── stats ────────────────────────────────────────────────────────────────

    function test_stats_incrementOnSettle() public {
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("STAT-1"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        (uint256 collected,, uint256 sc,,) = prod.stats(address(eurc));
        assertEq(collected, 50e6);
        assertEq(sc, 1);
    }

    function test_stats_incrementOnReturned() public {
        vm.prank(debtor); eurc.approve(address(prod), 0); // no allowance → MS03
        bytes32 cid = _scheduleCollection(mandateId, 50e6, _defaultDueAt(), bytes32("STAT-2"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        (,,, uint256 refundedCount, uint256 returnedCount) = prod.stats(address(eurc));
        assertEq(returnedCount, 1);
        assertEq(refundedCount, 0);
    }

    // ─── withdrawReserve after release ───────────────────────────────────────

    function test_withdrawReserve_afterRelease_ok() public {
        bytes32 cid = _scheduleCollection(mandateId, 100e6, _defaultDueAt(), bytes32("WR-REL"));
        vm.warp(_defaultDueAt());
        prod.collect(cid);

        // Within window: reserve has 500e6 total, 100e6 locked → free = 400e6.
        // Attempting to withdraw 500e6 (> free) must revert ReserveLocked.
        vm.prank(creditorOwner);
        vm.expectRevert(ReserveLocked.selector);
        prod.withdrawReserve(creditorId1, address(eurc), 500e6, creditorOwner);

        // After refund window: release frees the lock
        vm.warp(block.timestamp + prod.refundWindow() + 1);
        prod.release(cid);

        // Now locked = 0, free = 500e6 → can withdraw 100e6 without issue
        uint256 before = eurc.balanceOf(creditorOwner);
        vm.prank(creditorOwner);
        prod.withdrawReserve(creditorId1, address(eurc), 100e6, creditorOwner);
        assertEq(eurc.balanceOf(creditorOwner) - before, 100e6);
    }
}
