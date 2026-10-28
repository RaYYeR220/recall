// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../src/DebitRail.sol";
import "../src/IDebitRail.sol";
import "../src/RailLens.sol";
import "./mocks/MockFiatToken.sol";
import "./mocks/Mock1271Wallet.sol";
import "./DebitRailBase.t.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Change-1: EIP-7702 signature fix
// ─────────────────────────────────────────────────────────────────────────────
contract ChangeOne_EIP7702SigTest is DebitRailBase {
    function setUp() public override {
        super.setUp();
        creditorId1 = _registerCreditor1();
    }

    function test_eoaOffer_accepted() public {
        bytes32 mid = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
        assertTrue(mid != bytes32(0));
    }

    function test_1271Wallet_offer_accepted() public {
        Mock1271Wallet wallet = new Mock1271Wallet(creditorOwner);
        vm.prank(address(wallet));
        uint256 wcid = prod.registerCreditor("Wallet Merchant", creditorPayout);
        MandateOffer memory offer = _defaultOffer();
        offer.creditorId = wcid;
        offer.debtor = address(0);
        // wallet.isValidSignature delegates to creditorOwner EOA sig -- accepted
        bytes32 mid = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);
        assertTrue(mid != bytes32(0));
    }

    function test_highS_operatorSig_rejected() public {
        vm.prank(creditorOwner);
        prod.setOperator(creditorId1, operator, true);

        MandateOffer memory offer = _defaultOffer();
        bytes32 digest = prod.hashOffer(offer);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorKey, digest);

        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 highS = bytes32(N - uint256(s));
        bytes memory malSig = abi.encodePacked(r, highS, v);

        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: digest,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);
        vm.expectRevert(BadSignature.selector);
        prod.activateMandate(offer, malSig, acc, debtorSig);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-2: Demo safety
// ─────────────────────────────────────────────────────────────────────────────
contract ChangeTwo_DemoSafetyTest is DebitRailBase {
    function setUp() public override {
        super.setUp();
        creditorId1 = _registerCreditor1();
    }

    function test_constructor_emptyName_reverts() public {
        vm.expectRevert("EmptyDomainName");
        new DebitRail(address(eurc), address(usdc), 1, "", "prod");
    }

    function test_constructor_badTokenA_reverts() public {
        vm.expectRevert("NoCode");
        new DebitRail(address(0xBEEF), address(usdc), 1, "Recall DebitRail", "prod");
    }

    function test_constructor_badTokenB_reverts() public {
        vm.expectRevert("NoCode");
        new DebitRail(address(eurc), address(0xCAFE), 1, "Recall DebitRail", "prod");
    }

    function test_demo_maxPerCollection_cap() public {
        vm.prank(creditorOwner);
        uint256 dcid = demo.registerCreditor("Demo Cred", creditorPayout);
        MandateOffer memory offer = MandateOffer({
            creditorId:       dcid,
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: 1_000_001,
            maxPerPeriod:     2e6,
            periodLength:     uint32(30 days),
            prenoticeLength:  uint32(1 days),
            offerRef:         bytes32("CAP-TEST"),
            termsHash:        keccak256("terms"),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days),
            timeScale:        10080,
            debtor:           address(0)
        });
        bytes memory sig = _signOffer(demo, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: demo.hashOffer(offer),
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory dSig = _signAcceptance(demo, acc, debtorKey);
        vm.expectRevert(InvalidTerms.selector);
        demo.activateMandate(offer, sig, acc, dSig);
    }

    function test_demo_maxPerPeriod_cap() public {
        vm.prank(creditorOwner);
        uint256 dcid = demo.registerCreditor("Demo Cred2", creditorPayout);
        MandateOffer memory offer = MandateOffer({
            creditorId:       dcid,
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: 1e6,
            maxPerPeriod:     2_000_001,
            periodLength:     uint32(30 days),
            prenoticeLength:  uint32(1 days),
            offerRef:         bytes32("CAP-PER"),
            termsHash:        keccak256("terms"),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days),
            timeScale:        10080,
            debtor:           address(0)
        });
        bytes memory sig = _signOffer(demo, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: demo.hashOffer(offer),
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory dSig = _signAcceptance(demo, acc, debtorKey);
        vm.expectRevert(InvalidTerms.selector);
        demo.activateMandate(offer, sig, acc, dSig);
    }

    function test_timeScale_mismatch_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.timeScale = 10080;  // wrong for prod (timeScale = 1)
        bytes memory sig = _signOffer(prod, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: prod.hashOffer(offer),
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory dSig = _signAcceptance(prod, acc, debtorKey);
        vm.expectRevert(WrongTimeScale.selector);
        prod.activateMandate(offer, sig, acc, dSig);
    }

    function test_timeScale_correct_passes() public {
        bytes32 mid = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
        assertTrue(mid != bytes32(0));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-3: Bound offers to debtor
// ─────────────────────────────────────────────────────────────────────────────
contract ChangeThree_BoundOfferTest is DebitRailBase {
    function setUp() public override {
        super.setUp();
        creditorId1 = _registerCreditor1();
    }

    function test_boundOffer_correctDebtor_ok() public {
        MandateOffer memory offer = _defaultOffer();
        offer.debtor = debtor;
        bytes32 mid = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);
        assertTrue(mid != bytes32(0));
    }

    function test_boundOffer_wrongDebtor_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.debtor = debtor;
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: prod.hashOffer(offer),
            debtor:    debtor2,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory d2Sig = _signAcceptance(prod, acc, debtor2Key);
        vm.expectRevert(NotOfferedDebtor.selector);
        prod.activateMandate(offer, offerSig, acc, d2Sig);
    }

    function test_openOffer_anyDebtor_ok() public {
        MandateOffer memory offer = _defaultOffer(); // debtor = address(0)
        bytes32 mid2 = _activateMandate(prod, offer, creditorOwnerKey, debtor2, debtor2Key);
        assertTrue(mid2 != bytes32(0));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-4: Permit path hardening
// ─────────────────────────────────────────────────────────────────────────────
contract ChangeFour_PermitPathTest is DebitRailBase {
    function setUp() public override {
        super.setUp();
        creditorId1 = _registerCreditor1();
    }

    function test_permitPath_badToken_reverts() public {
        // Use an unrecognised token address — _requireAllowedToken fires before permit() is called.
        MockFiatToken foreign = new MockFiatToken("FOREIGN", "FRGN");
        MandateOffer memory offer = _defaultOffer();
        offer.token = address(foreign);
        PermitData memory perm = _signPermit(eurc, debtor, debtorKey,
            address(prod), 100e6, uint64(block.timestamp + 1 days));
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: prod.hashOffer(offer),
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory dSig = _signAcceptance(prod, acc, debtorKey);
        vm.expectRevert(TokenNotAllowed.selector);
        prod.activateMandateWithPermit(offer, offerSig, acc, dSig, perm);
    }

    function test_permitPath_alreadyActive_returnsExisting() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 offerHash = prod.hashOffer(offer);
        bytes32 mid1 = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        PermitData memory perm = _signPermit(eurc, debtor, debtorKey,
            address(prod), 100e6, uint64(block.timestamp + 1 days));
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory dSig = _signAcceptance(prod, acc, debtorKey);
        bytes32 mid2 = prod.activateMandateWithPermit(offer, offerSig, acc, dSig, perm);
        assertEq(mid1, mid2, "should return existing mandate id");
    }

    function test_permitPath_permitFailed_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        PermitData memory perm;
        perm.value    = 100e6;
        perm.deadline = uint64(block.timestamp + 1 days);
        // sign with strangerKey — permit() will fail; allowance stays 0 -> PermitFailed
        bytes32 domainSep = eurc.DOMAIN_SEPARATOR();
        bytes32 structHash = keccak256(abi.encode(
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
            debtor, address(prod), perm.value, eurc.nonces(debtor), perm.deadline
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSep, structHash));
        (perm.v, perm.r, perm.s) = vm.sign(strangerKey, digest);

        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: prod.hashOffer(offer),
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory dSig = _signAcceptance(prod, acc, debtorKey);
        vm.expectRevert(PermitFailed.selector);
        prod.activateMandateWithPermit(offer, offerSig, acc, dSig, perm);
    }

    function test_permitPath_happy() public {
        MandateOffer memory offer = _defaultOffer();
        PermitData memory perm = _signPermit(eurc, debtor, debtorKey,
            address(prod), 100e6, uint64(block.timestamp + 1 days));
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: prod.hashOffer(offer),
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory dSig = _signAcceptance(prod, acc, debtorKey);
        bytes32 mid = prod.activateMandateWithPermit(offer, offerSig, acc, dSig, perm);
        assertTrue(mid != bytes32(0));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-5: Claims (claimFor)
// ─────────────────────────────────────────────────────────────────────────────
contract ChangeFive_ClaimsTest is DebitRailBase {
    function setUp() public override {
        super.setUp();
        creditorId1 = _registerCreditor1();
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 500e6);
        prod.fundReserve(creditorId1, address(eurc), 500e6);
        vm.stopPrank();
    }

    function test_claimFor_success() public {
        bytes32 mid = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
        Mandate memory m = prod.getMandate(mid);
        uint64 dueAt = uint64(m.activatedAt + m.periodLength + 1);
        vm.prank(creditorOwner);
        bytes32 cid = prod.prenotify(mid, 50e6, dueAt, bytes32("CF-1"), "");
        vm.prank(debtor);
        eurc.approve(address(prod), 100e6);
        vm.warp(dueAt);
        prod.collect(cid);

        uint256 claimAmt = prod.claimable(creditorPayout, address(eurc));
        if (claimAmt > 0) {
            uint256 bef = eurc.balanceOf(creditorPayout);
            prod.claimFor(creditorPayout, address(eurc));
            assertEq(prod.claimable(creditorPayout, address(eurc)), 0);
            assertEq(eurc.balanceOf(creditorPayout), bef + claimAmt);
        }
    }

    function test_claimFor_zeroClaimable_reverts() public {
        // NothingToClaim when claimable == 0
        vm.expectRevert(NothingToClaim.selector);
        prod.claimFor(stranger, address(eurc));
    }

    function test_claimFor_zeroAddress_reverts() public {
        vm.expectRevert(ZeroAddress.selector);
        prod.claimFor(address(0), address(eurc));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-6: Unbounded loops replaced with per-mandate counter; RailLens pages
// ─────────────────────────────────────────────────────────────────────────────
contract ChangeSix_LoopsAndPaginationTest is DebitRailBase {
    RailLens internal lens;

    function setUp() public override {
        super.setUp();
        creditorId1 = _registerCreditor1();
        lens = new RailLens(address(prod));
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 2_000e6);
        prod.fundReserve(creditorId1, address(eurc), 2_000e6);
        vm.stopPrank();
    }

    function test_collectionsOpenCount_increments() public {
        bytes32 mid = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
        assertEq(prod.collectionsOpenCount(mid), 0);

        Mandate memory m = prod.getMandate(mid);
        uint64 due1 = uint64(m.activatedAt + m.periodLength + 1);
        vm.prank(creditorOwner);
        bytes32 cid = prod.prenotify(mid, 50e6, due1, bytes32("OC-1"), "");
        assertEq(prod.collectionsOpenCount(mid), 1, "one open after prenotify");

        // Refuse removes from open count
        vm.prank(debtor);
        prod.refuse(cid);
        assertEq(prod.collectionsOpenCount(mid), 0, "zero open after refuse");
    }

    function test_debtorView_pagination() public {
        MandateOffer memory o1 = _defaultOffer(); o1.offerRef = bytes32("PG-A");
        MandateOffer memory o2 = _defaultOffer(); o2.offerRef = bytes32("PG-B");
        bytes32 mid1 = _activateMandate(prod, o1, creditorOwnerKey, debtor, debtorKey);
        bytes32 mid2 = _activateMandate(prod, o2, creditorOwnerKey, debtor, debtorKey);

        (RailLens.MandateView[] memory page0, uint256 total) = lens.debtorView(debtor, 0, 1);
        assertEq(page0.length, 1);
        assertEq(total, 2);

        (RailLens.MandateView[] memory page1,) = lens.debtorView(debtor, 1, 1);
        assertEq(page1.length, 1);
        assertTrue(page0[0].id != page1[0].id);
        assertTrue(page0[0].id == mid1 || page0[0].id == mid2);
    }

    function test_debtorView_limit0_returnsAll() public {
        MandateOffer memory o1 = _defaultOffer(); o1.offerRef = bytes32("LA-A");
        MandateOffer memory o2 = _defaultOffer(); o2.offerRef = bytes32("LA-B");
        _activateMandate(prod, o1, creditorOwnerKey, debtor, debtorKey);
        _activateMandate(prod, o2, creditorOwnerKey, debtor, debtorKey);
        (RailLens.MandateView[] memory all, uint256 total) = lens.debtorView(debtor, 0, 0);
        assertEq(all.length, total);
        assertGe(total, 2);
    }

    function test_collectionsPage_paginates() public {
        bytes32 mid = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
        Mandate memory m = prod.getMandate(mid);
        vm.prank(debtor);
        eurc.approve(address(prod), 300e6);

        uint64 due1 = uint64(m.activatedAt + m.periodLength     + 1);
        uint64 due2 = uint64(m.activatedAt + m.periodLength * 2 + 1);
        uint64 due3 = uint64(m.activatedAt + m.periodLength * 3 + 1);

        vm.prank(creditorOwner);
        bytes32 c1 = prod.prenotify(mid, 50e6, due1, bytes32("CP-1"), "");
        vm.warp(due1); prod.collect(c1);

        vm.prank(creditorOwner);
        bytes32 c2 = prod.prenotify(mid, 50e6, due2, bytes32("CP-2"), "");
        vm.warp(due2); prod.collect(c2);

        vm.prank(creditorOwner);
        bytes32 c3 = prod.prenotify(mid, 50e6, due3, bytes32("CP-3"), "");
        vm.warp(due3); prod.collect(c3);

        (Collection[] memory p0, uint256 total) = lens.collectionsPage(mid, 0, 2);
        assertEq(total, 3);
        assertEq(p0.length, 2);

        (Collection[] memory p1,) = lens.collectionsPage(mid, 2, 2);
        assertEq(p1.length, 1);
    }

    function test_mandateView_collectionCount_matches() public {
        bytes32 mid = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
        Mandate memory m = prod.getMandate(mid);
        vm.prank(debtor);
        eurc.approve(address(prod), 200e6);

        uint64 due1 = uint64(m.activatedAt + m.periodLength     + 1);
        uint64 due2 = uint64(m.activatedAt + m.periodLength * 2 + 1);

        vm.prank(creditorOwner);
        bytes32 c1 = prod.prenotify(mid, 50e6, due1, bytes32("CC-1"), "");
        vm.warp(due1); prod.collect(c1);

        vm.prank(creditorOwner);
        bytes32 c2 = prod.prenotify(mid, 50e6, due2, bytes32("CC-2"), "");
        vm.warp(due2); prod.collect(c2);

        (RailLens.MandateView[] memory views,) = lens.debtorView(debtor, 0, 0);
        bool found;
        for (uint256 i; i < views.length; i++) {
            if (views[i].id == mid) {
                assertEq(views[i].collectionCount, 2);
                found = true;
            }
        }
        assertTrue(found);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-7: Lapse — lastActivityAt updated on RETURNED (refund = MS03)
// ─────────────────────────────────────────────────────────────────────────────
contract ChangeSeven_LapseTest is DebitRailBase {
    function setUp() public override {
        super.setUp();
        creditorId1 = _registerCreditor1();
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 500e6);
        prod.fundReserve(creditorId1, address(eurc), 500e6);
        vm.stopPrank();
    }

    function test_lastActivityAt_updatedOnSettled_collect() public {
        // Change-7: lastActivityAt must be updated when collect produces SETTLED.
        bytes32 mid = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
        Mandate memory m = prod.getMandate(mid);

        vm.prank(debtor);
        eurc.approve(address(prod), 100e6);

        uint64 due1 = uint64(m.activatedAt + m.periodLength + 1);
        vm.prank(creditorOwner);
        bytes32 cid = prod.prenotify(mid, 50e6, due1, bytes32("L7-S"), "");
        vm.warp(due1);

        uint64 before = uint64(block.timestamp);
        CollectionStatus st = prod.collect(cid);
        assertEq(uint8(st), uint8(CollectionStatus.SETTLED), "should settle");

        Mandate memory mAfter = prod.getMandate(mid);
        assertGe(mAfter.lastActivityAt, before,
            "lastActivityAt updated on SETTLED collect");
    }

    function test_lastActivityAt_updatedOnReturned_collect_failedTransfer() public {
        // Verify lastActivityAt is updated when collect produces RETURNED (MS03 — no allowance).
        bytes32 mid2 = _activateMandate(
            prod,
            _makeOffer2(bytes32("L7-MS03")),
            creditorOwnerKey, debtor2, debtor2Key
        );
        Mandate memory m2 = prod.getMandate(mid2);

        uint64 due2 = uint64(m2.activatedAt + m2.periodLength + 1);
        vm.prank(creditorOwner);
        bytes32 cid2 = prod.prenotify(mid2, 50e6, due2, bytes32("L7-MS03-C"), "");

        vm.warp(due2);
        uint64 before = uint64(block.timestamp);

        // debtor2 has no allowance -> collect returns RETURNED MS03
        CollectionStatus st = prod.collect(cid2);
        assertEq(uint8(st), uint8(CollectionStatus.RETURNED), "collect returned MS03");

        Mandate memory m2After = prod.getMandate(mid2);
        assertGe(m2After.lastActivityAt, before,
            "lastActivityAt updated on RETURNED (MS03 collect)");
    }

    function _makeOffer2(bytes32 ref) internal view returns (MandateOffer memory) {
        return MandateOffer({
            creditorId:       creditorId1,
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: 100e6,
            maxPerPeriod:     200e6,
            periodLength:     uint32(30 days),
            prenoticeLength:  uint32(1 days),
            offerRef:         ref,
            termsHash:        keccak256("terms"),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days),
            timeScale:        1,
            debtor:           address(0)
        });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Change-8: NatSpec behaviour — operator cancel scope; period cap raw storage
// ─────────────────────────────────────────────────────────────────────────────
contract ChangeEight_NatSpecBehaviorTest is DebitRailBase {
    function setUp() public override {
        super.setUp();
        creditorId1 = _registerCreditor1();
    }

    function test_operator_can_cancel_anyOffer() public {
        vm.prank(creditorOwner);
        prod.setOperator(creditorId1, operator, true);

        MandateOffer memory offer = _defaultOffer();

        // operator cancels an offer it did not create
        vm.prank(operator);
        prod.cancelOffer(offer);

        // Activating now reverts (offer cancelled)
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: prod.hashOffer(offer),
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory dSig = _signAcceptance(prod, acc, debtorKey);
        vm.expectRevert(OfferCancelled_.selector);
        prod.activateMandate(offer, offerSig, acc, dSig);
    }

    function test_periodLength_stored_raw_prod() public {
        bytes32 mid = _activateMandate(prod, _defaultOffer(), creditorOwnerKey, debtor, debtorKey);
        Mandate memory m = prod.getMandate(mid);
        assertEq(m.periodLength, 30 days, "periodLength stored raw (seconds)");
        assertEq(prod.timeScale(), 1, "prod timeScale = 1");
    }

    function test_periodLength_stored_raw_demo() public {
        vm.prank(creditorOwner);
        uint256 dcid = demo.registerCreditor("Demo NS", creditorPayout);
        MandateOffer memory offer = MandateOffer({
            creditorId:       dcid,
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: 1e6,
            maxPerPeriod:     2e6,
            periodLength:     uint32(30 days),
            prenoticeLength:  uint32(1 days),
            offerRef:         bytes32("NS-DEMO"),
            termsHash:        keccak256("terms"),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days),
            timeScale:        10080,
            debtor:           address(0)
        });
        bytes32 mid = _activateMandate(demo, offer, creditorOwnerKey, debtor, debtorKey);
        Mandate memory m = demo.getMandate(mid);
        assertEq(m.periodLength, 30 days, "raw periodLength stored");
        assertEq(demo.timeScale(), 10080);
        uint256 effectivePeriod = m.periodLength / demo.timeScale();
        assertGe(effectivePeriod, 200);
        assertLe(effectivePeriod, 300);
    }
}
