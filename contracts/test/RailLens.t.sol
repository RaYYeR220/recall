// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/DebitRail.sol";
import "../src/IDebitRail.sol";
import "../src/RailLens.sol";
import "./DebitRailBase.t.sol";

/// @notice Tests for RailLens read-only views.
contract RailLensTest is DebitRailBase {
    RailLens internal lens;
    bytes32  internal mandateId;

    uint64 internal constant BASE_TIME = 1_700_000_000;

    function setUp() public override {
        vm.warp(BASE_TIME);
        super.setUp();
        // Register creditor, fund reserve (base setUp does not do this automatically)
        _registerCreditor1();
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 500e6);
        prod.fundReserve(creditorId1, address(eurc), 500e6);
        vm.stopPrank();

        lens = new RailLens(address(prod));
        // Activate a CORE EURC mandate for the default debtor so tests have something to query
        mandateId = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
    }

    function _defaultDueAt() internal view returns (uint64) {
        return uint64(block.timestamp + prod.minPrenotice() + 60);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // health()
    // ─────────────────────────────────────────────────────────────────────────

    function test_health_cleanRail() public view {
        (RailLens.TokenHealth memory eh, RailLens.TokenHealth memory uh) = lens.health();

        // Fresh rail with funded reserve (500e6 EURC funded in base setUp)
        assertEq(eh.token, address(eurc));
        assertTrue(eh.i1, "i1 should be true on clean rail");
        assertTrue(eh.i2, "i2 should be true on clean rail");
        assertTrue(eh.i3, "i3 should be true on clean rail");
        assertEq(eh.surplus, 0, "no surplus before any donation");

        // USDC: nothing funded
        assertEq(uh.token, address(usdc));
        assertTrue(uh.i1);
    }

    function test_health_flagsDonationAsSurplus() public {
        // Plain transfer to the rail — no accounting entry, only balance goes up
        uint256 donation = 1e6;
        eurc.mint(address(this), donation);
        eurc.transfer(address(prod), donation);

        (RailLens.TokenHealth memory h,) = lens.health();

        // I1 still true (balance > accounted is fine — only balance < accounted would break it)
        assertTrue(h.i1, "i1 should still be true after donation");
        // Surplus equals the donated amount
        assertEq(h.surplus, donation, "surplus should equal donation");
    }

    function test_health_afterCollect_i2Holds() public {
        // Collect a CORE collection and verify I2 holds
        bytes32 mid = mandateId;
        uint64  due = _defaultDueAt();
        vm.prank(creditorOwner);
        bytes32 cid = prod.prenotify(mid, 100e6, due, bytes32("LENS-H1"), "");

        vm.prank(debtor);
        eurc.approve(address(prod), type(uint256).max);

        vm.warp(due);
        prod.collect(cid);

        (RailLens.TokenHealth memory h,) = lens.health();
        assertTrue(h.i2, "i2 after CORE collect");
        assertTrue(h.i3, "i3 after CORE collect");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // debtorView()
    // ─────────────────────────────────────────────────────────────────────────

    function test_debtorView_returnsCollections() public {
        // mandateId activated in base setUp
        bytes32 mid = mandateId;

        // Schedule two collections
        vm.prank(debtor);
        eurc.approve(address(prod), type(uint256).max);

        uint64 due1 = _defaultDueAt();
        uint64 due2 = due1 + uint64(30 days) + uint64(prod.minPrenotice()) + 60;
        vm.startPrank(creditorOwner);
        bytes32 cid1 = prod.prenotify(mid, 50e6, due1, bytes32("LENS-D1"), "");
        /* bytes32 cid2 = */ prod.prenotify(mid, 50e6, due2, bytes32("LENS-D2"), "");
        vm.stopPrank();

        // Collect the first one
        vm.warp(due1);
        prod.collect(cid1);

        (RailLens.MandateView[] memory views,) = lens.debtorView(debtor, 0, 0);

        // At least the one mandate from base setUp
        bool found = false;
        for (uint256 i; i < views.length; i++) {
            if (views[i].id == mid) {
                found = true;
                assertEq(views[i].collectionCount, 2, "should have 2 total collections");
                assertEq(views[i].collections.length, 2, "both fit in newest-10 window");
                break;
            }
        }
        assertTrue(found, "mandate not in debtorView");
    }

    function test_debtorView_emptyForUnknownDebtor() public view {
        address nobody = address(0xDEAD);
        (RailLens.MandateView[] memory views,) = lens.debtorView(nobody, 0, 0);
        assertEq(views.length, 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // creditorView() — pagination
    // ─────────────────────────────────────────────────────────────────────────

    function test_creditorView_paginates() public {
        // Activate 4 mandates for creditorId1 (base setUp already activated 1 for CORE and 1 for B2B)
        // Activate 2 more with fresh debtors
        address debtor2 = makeAddr("debtor2");
        address debtor3 = makeAddr("debtor3");
        uint256 key2    = 0xFAB2;
        uint256 key3    = 0xFAB3;
        // key2/key3 must correspond to debtor2/debtor3
        vm.etch(vm.addr(key2), ""); // ensure vm.addr gives real address

        MandateOffer memory offer = _defaultOffer();
        offer.offerRef  = bytes32("PG-REF1");
        offer.termsHash = keccak256("pg1");
        bytes memory sig = _signOffer(prod, offer, creditorOwnerKey);

        // mint tokens & activate mandates for two extra debtors
        eurc.mint(debtor2, 10_000e6);
        eurc.mint(debtor3, 10_000e6);

        {
            MandateAcceptance memory acc = MandateAcceptance({
                offerHash: prod.hashOffer(offer),
                debtor:    vm.addr(key2),
                deadline:  uint64(block.timestamp + 1 hours)
            });
            bytes memory dSig = _signAcceptance(prod, acc, key2);
            prod.activateMandate(offer, sig, acc, dSig);
        }

        offer.offerRef  = bytes32("PG-REF2");
        offer.termsHash = keccak256("pg2");
        sig = _signOffer(prod, offer, creditorOwnerKey);
        {
            MandateAcceptance memory acc = MandateAcceptance({
                offerHash: prod.hashOffer(offer),
                debtor:    vm.addr(key3),
                deadline:  uint64(block.timestamp + 1 hours)
            });
            bytes memory dSig = _signAcceptance(prod, acc, key3);
            prod.activateMandate(offer, sig, acc, dSig);
        }

        // Total for creditorId1: 1 from setUp + 2 new = 3
        (, uint256 total) = lens.creditorView(creditorId1, 0, 0);
        assertGe(total, 3, "expected at least 3 mandates");

        // Page 1: first 2
        (RailLens.MandateView[] memory page1, uint256 t1) = lens.creditorView(creditorId1, 0, 2);
        assertEq(t1, total);
        assertEq(page1.length, 2);

        // Page 2: next items (total-2 remaining, which is 1 when total==3)
        (RailLens.MandateView[] memory page2,) = lens.creditorView(creditorId1, 2, 10);
        assertEq(page2.length, total - 2);

        // Offset beyond total returns empty
        (RailLens.MandateView[] memory empty,) = lens.creditorView(creditorId1, total + 10, 10);
        assertEq(empty.length, 0);
    }

    function test_coverageView_returnsCorrectTokens() public view {
        (Coverage memory e, Coverage memory u) =
            lens.coverageView(creditorId1);
        // EURC reserve was funded in base setUp
        assertGt(e.reserveTotal, 0, "eurc reserve should be funded");
        // USDC reserve not funded
        assertEq(u.reserveTotal, 0, "usdc reserve not funded");
    }
}
