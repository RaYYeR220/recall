// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./DebitRailBase.t.sol";

/// @notice Tests for offer cancellation, mandate activation (happy + revert paths),
///         permit variant, ERC-1271, revoke, and time-scale views.
contract DebitRailMandateTest is DebitRailBase {

    function setUp() public override {
        super.setUp();
        _registerCreditor1();
        // Grant operator
        vm.prank(creditorOwner);
        prod.setOperator(creditorId1, operator, true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Happy path
    // ─────────────────────────────────────────────────────────────────────────

    function test_activate_happyPath() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        // Status
        Mandate memory m = prod.getMandate(mandateId);
        assertEq(uint8(m.status), uint8(MandateStatus.ACTIVE));
        assertEq(m.debtor,    debtor);
        assertEq(m.creditorId, creditorId1);
        assertEq(m.token,     address(eurc));
        assertEq(uint8(m.scheme), uint8(Scheme.CORE));

        // offerUses incremented
        assertEq(prod.offerUses(prod.hashOffer(offer)), 1);

        // Listed for debtor
        bytes32[] memory dMandates = prod.mandatesOfDebtor(debtor);
        assertEq(dMandates.length, 1);
        assertEq(dMandates[0], mandateId);

        // Listed for creditor
        bytes32[] memory cMandates = prod.mandatesOfCreditor(creditorId1);
        assertEq(cMandates.length, 1);
        assertEq(cMandates[0], mandateId);
    }

    function test_activate_emitsEvent() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 offerHash  = prod.hashOffer(offer);
        bytes32 mandateId  = keccak256(abi.encode(offerHash, debtor));

        vm.expectEmit(true, true, true, true);
        emit MandateActivated(
            mandateId, offerHash, creditorId1,
            debtor, address(eurc), uint8(Scheme.CORE)
        );

        _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);
    }

    function test_activate_anyoneCanSubmit() public {
        // The stranger submits (neither creditor nor debtor)
        MandateOffer memory offer = _defaultOffer();
        bytes32 offerHash = prod.hashOffer(offer);
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);

        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.prank(stranger);
        bytes32 mandateId = prod.activateMandate(offer, offerSig, acc, debtorSig);

        assertEq(uint8(prod.getMandate(mandateId).status), uint8(MandateStatus.ACTIVE));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tampered offer
    // ─────────────────────────────────────────────────────────────────────────

    function test_activate_rejectsTamperedOffer() public {
        MandateOffer memory offer = _defaultOffer();
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);

        // Tamper after signing — change termsHash (does not affect terms validation,
        // only the signature digest, so the check that fires is BadSignature)
        offer.termsHash = keccak256("different-terms");

        bytes32 tamperedHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: tamperedHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(BadSignature.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Operator-signed offer
    // ─────────────────────────────────────────────────────────────────────────

    function test_activate_operatorSignedOffer_ok() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, operatorKey, debtor, debtorKey);
        assertEq(uint8(prod.getMandate(mandateId).status), uint8(MandateStatus.ACTIVE));
    }

    function test_activate_strangerSignedOffer_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        bytes memory offerSig = _signOffer(prod, offer, strangerKey);

        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(BadSignature.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Expiry and cancellation
    // ─────────────────────────────────────────────────────────────────────────

    function test_activate_expiredOffer_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.validUntil = uint64(block.timestamp - 1); // already expired

        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(SignatureExpired.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    function test_activate_expiredAcceptance_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);

        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp - 1) // expired
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(SignatureExpired.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    function test_activate_cancelledOffer_reverts() public {
        MandateOffer memory offer = _defaultOffer();

        // Cancel the offer first
        vm.prank(creditorOwner);
        prod.cancelOffer(offer);

        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(OfferCancelled_.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    function test_activate_maxUsesReached_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.maxUses = 1;

        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);

        // First activation (debtor) — should succeed
        bytes32 offerHash = prod.hashOffer(offer);
        {
            MandateAcceptance memory acc = MandateAcceptance({
                offerHash: offerHash,
                debtor:    debtor,
                deadline:  uint64(block.timestamp + 1 days)
            });
            bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);
            prod.activateMandate(offer, offerSig, acc, debtorSig);
        }
        assertEq(prod.offerUses(offerHash), 1);

        // Second activation (debtor2) — should fail with OfferUsedUp
        {
            MandateAcceptance memory acc2 = MandateAcceptance({
                offerHash: offerHash,
                debtor:    debtor2,
                deadline:  uint64(block.timestamp + 1 days)
            });
            bytes memory debtorSig2 = _signAcceptance(prod, acc2, debtor2Key);
            vm.expectRevert(OfferUsedUp.selector);
            prod.activateMandate(offer, offerSig, acc2, debtorSig2);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Duplicate mandate
    // ─────────────────────────────────────────────────────────────────────────

    function test_activate_sameDebtorTwice_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        // Same offer, same debtor → MandateExists
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(MandateExists.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    function test_activate_differentDebtor_ok() public {
        MandateOffer memory offer = _defaultOffer();
        offer.maxUses = 0; // unlimited

        bytes32 id1 = _activateMandate(prod, offer, creditorOwnerKey, debtor,  debtorKey);
        bytes32 id2 = _activateMandate(prod, offer, creditorOwnerKey, debtor2, debtor2Key);

        // Two different mandate IDs
        assertTrue(id1 != id2);
        assertEq(prod.offerUses(prod.hashOffer(offer)), 2);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Invalid terms
    // ─────────────────────────────────────────────────────────────────────────

    function test_activate_prenoticeBelowMin_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.prenoticeLength = uint32(1 hours); // less than 1 day

        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(InvalidTerms.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    function test_activate_zeroMaxPerCollection_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.maxPerCollection = 0;

        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(InvalidTerms.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    function test_activate_periodCapBelowCollectionCap_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.maxPerCollection = 100e6;
        offer.maxPerPeriod     = 50e6; // less than per-collection

        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(InvalidTerms.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    function test_activate_tokenNotAllowed_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        offer.token = makeAddr("randoToken");

        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        vm.expectRevert(TokenNotAllowed.selector);
        prod.activateMandate(offer, offerSig, acc, debtorSig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // activateMandateWithPermit
    // ─────────────────────────────────────────────────────────────────────────

    function test_activateWithPermit_setsAllowance() public {
        MandateOffer memory offer = _defaultOffer();
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        PermitData memory p = _signPermit(
            eurc, debtor, debtorKey, address(prod), type(uint256).max, block.timestamp + 1 days
        );

        // Debtor has no prior allowance
        assertEq(eurc.allowance(debtor, address(prod)), 0);

        prod.activateMandateWithPermit(offer, offerSig, acc, debtorSig, p);

        // Allowance was set by permit
        assertEq(eurc.allowance(debtor, address(prod)), type(uint256).max);
    }

    function test_activateWithPermit_frontRunPermit_stillActivates() public {
        MandateOffer memory offer = _defaultOffer();
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        PermitData memory p = _signPermit(
            eurc, debtor, debtorKey, address(prod), type(uint256).max, block.timestamp + 1 days
        );

        // Simulate front-runner: apply the permit externally first
        eurc.permit(debtor, address(prod), p.value, p.deadline, p.v, p.r, p.s);
        assertEq(eurc.allowance(debtor, address(prod)), type(uint256).max);

        // activateMandateWithPermit should still succeed (permit reverts are swallowed)
        bytes32 mandateId = prod.activateMandateWithPermit(offer, offerSig, acc, debtorSig, p);
        assertEq(uint8(prod.getMandate(mandateId).status), uint8(MandateStatus.ACTIVE));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ERC-1271
    // ─────────────────────────────────────────────────────────────────────────

    function test_activate_erc1271Debtor_ok() public {
        // Deploy a smart wallet backed by debtorKey
        Mock1271Wallet wallet = new Mock1271Wallet(debtor);

        MandateOffer memory offer = _defaultOffer();
        bytes memory offerSig = _signOffer(prod, offer, creditorOwnerKey);
        bytes32 offerHash = prod.hashOffer(offer);

        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    address(wallet), // smart-wallet debtor
            deadline:  uint64(block.timestamp + 1 days)
        });

        // Sign with the EOA that backs the 1271 wallet
        bytes memory debtorSig = _signAcceptance(prod, acc, debtorKey);

        bytes32 mandateId = prod.activateMandate(offer, offerSig, acc, debtorSig);

        Mandate memory m = prod.getMandate(mandateId);
        assertEq(m.debtor, address(wallet));
        assertEq(uint8(m.status), uint8(MandateStatus.ACTIVE));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cross-instance replay protection
    // ─────────────────────────────────────────────────────────────────────────

    function test_signature_notReplayableAcrossInstances() public {
        // Register creditorId1 on DEMO as well
        vm.prank(creditorOwner);
        uint256 demoCid = demo.registerCreditor("Merchant A Demo", creditorPayout);

        MandateOffer memory offer = _defaultOffer();
        // Use the DEMO creditor ID
        offer.creditorId = demoCid;

        // Sign offer for DEMO rail
        bytes memory demoOfferSig = _signOffer(demo, offer, creditorOwnerKey);

        bytes32 demoOfferHash = demo.hashOffer(offer);
        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: demoOfferHash,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        bytes memory demoDebtorSig = _signAcceptance(demo, acc, debtorKey);

        // Submit to PROD — the domain separator is different → BadSignature
        // First we need creditorId = demoCid to exist on PROD (it doesn't)
        // The offer refers to a creditorId that exists only on demo.
        // Submitting to prod with the demo-signed sigs should fail because the domain
        // separator embeds the verifyingContract address.

        // Register same creditor on PROD to get the same ID
        vm.prank(creditorOwner);
        prod.registerCreditor("Merchant A Demo Prod", creditorPayout); // gets id 2 on prod

        // Use offer with creditorId=1 (already on prod) signed for DEMO → bad sig on PROD
        MandateOffer memory offer2 = _defaultOffer(); // uses creditorId1 (=1) on prod
        bytes memory demoOfferSig2 = _signOffer(demo, offer2, creditorOwnerKey); // signed for demo

        bytes32 prodOfferHashForDemoSig = prod.hashOffer(offer2);
        MandateAcceptance memory acc2 = MandateAcceptance({
            offerHash: prodOfferHashForDemoSig,
            debtor:    debtor,
            deadline:  uint64(block.timestamp + 1 days)
        });
        // Sign acceptance for DEMO (wrong domain)
        bytes32 demoAccHash = demo.hashAcceptance(acc2);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(debtorKey, demoAccHash);
        bytes memory wrongDebtorSig = abi.encodePacked(r, s, v);

        // The offer sig is for demo; when prod checks it, the domain is different → BadSignature
        bytes memory wrongOfferSig = _signOffer(demo, offer2, creditorOwnerKey);

        vm.expectRevert(BadSignature.selector);
        prod.activateMandate(offer2, wrongOfferSig, acc2, wrongDebtorSig);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Revoke
    // ─────────────────────────────────────────────────────────────────────────

    function test_revoke_byDebtor() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        vm.prank(debtor);
        prod.revoke(mandateId);

        assertEq(uint8(prod.getMandate(mandateId).status), uint8(MandateStatus.REVOKED));
    }

    function test_revoke_byCreditorOwner() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        vm.prank(creditorOwner);
        prod.revoke(mandateId);

        assertEq(uint8(prod.getMandate(mandateId).status), uint8(MandateStatus.REVOKED));
    }

    function test_revoke_byStranger_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        vm.prank(stranger);
        vm.expectRevert(NotDebtorOrCreditor.selector);
        prod.revoke(mandateId);
    }

    function test_revoke_alreadyRevoked_reverts() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        vm.prank(debtor);
        prod.revoke(mandateId);

        vm.prank(debtor);
        vm.expectRevert(WrongStatus.selector);
        prod.revoke(mandateId);
    }

    function test_revoke_emitsEvent() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        vm.expectEmit(true, false, false, true);
        emit MandateRevoked(mandateId, debtor);
        vm.prank(debtor);
        prod.revoke(mandateId);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // cancelOffer
    // ─────────────────────────────────────────────────────────────────────────

    function test_cancelOffer_byOwner() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 offerHash = prod.hashOffer(offer);

        assertFalse(prod.offerCancelled(offerHash));

        vm.prank(creditorOwner);
        prod.cancelOffer(offer);

        assertTrue(prod.offerCancelled(offerHash));
    }

    function test_cancelOffer_byOperator() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 offerHash = prod.hashOffer(offer);

        vm.prank(operator);
        prod.cancelOffer(offer);

        assertTrue(prod.offerCancelled(offerHash));
    }

    function test_cancelOffer_byStranger_reverts() public {
        MandateOffer memory offer = _defaultOffer();

        vm.prank(stranger);
        vm.expectRevert(NotCreditorAgent.selector);
        prod.cancelOffer(offer);
    }

    function test_cancelOffer_emitsEvent() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 offerHash = prod.hashOffer(offer);

        vm.expectEmit(true, false, false, false);
        emit OfferCancelled(offerHash);
        vm.prank(creditorOwner);
        prod.cancelOffer(offer);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Lapse
    // ─────────────────────────────────────────────────────────────────────────

    function test_isLapsed_afterLapsePeriod() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        assertFalse(prod.isLapsed(mandateId));

        // Warp past the lapse period (1080 days on prod timeScale=1)
        vm.warp(block.timestamp + 1080 days + 1);

        assertTrue(prod.isLapsed(mandateId));
    }

    function test_isLapsed_unknownMandate_false() public view {
        assertFalse(prod.isLapsed(bytes32(0)));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Time-scale views (prod vs demo)
    // ─────────────────────────────────────────────────────────────────────────

    function test_timeScale_views_prod() public view {
        // prod timeScale = 1 → legal-second values
        assertEq(prod.refundWindow(),    8 weeks);
        assertEq(prod.minPrenotice(),    1 days);
        assertEq(prod.executionWindow(), 5 days);
        assertEq(prod.lapsePeriod(),     1080 days);
        assertEq(prod.scheduleAhead(),   400 days);
    }

    function test_timeScale_views_demo() public view {
        // demo timeScale = 10080 (1 week = 1 minute in real seconds)
        // refundWindow: 8 weeks / 10080 = 4838400/10080 = 480
        assertEq(demo.refundWindow(),    480);
        // executionWindow: 5 days / 10080 = 432000/10080 = 42 → floor 900 wins
        assertEq(demo.executionWindow(), 900);
        // scheduleAhead: 400 days / 10080 = 34560000/10080 = 3428 → floor 86400 wins
        assertEq(demo.scheduleAhead(),   86400);
        // minPrenotice: 1 day / 10080 = 86400/10080 = 8
        assertEq(demo.minPrenotice(),    8);
        // lapsePeriod: 1080 days / 10080 = 93312000/10080 = 9257 (no floor)
        assertEq(demo.lapsePeriod(),     9257);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // periodIndexOf
    // ─────────────────────────────────────────────────────────────────────────

    function test_periodIndexOf_firstPeriod() public {
        MandateOffer memory offer = _defaultOffer();
        bytes32 mandateId = _activateMandate(prod, offer, creditorOwnerKey, debtor, debtorKey);

        Mandate memory m = prod.getMandate(mandateId);

        // Immediately at activatedAt → period 0
        assertEq(prod.periodIndexOf(mandateId, m.activatedAt), 0);

        // One period later → period 1
        uint64 oneperiodLater = m.activatedAt + uint64(30 days);
        assertEq(prod.periodIndexOf(mandateId, oneperiodLater), 1);

        // Slightly before the boundary → still period 0
        assertEq(prod.periodIndexOf(mandateId, oneperiodLater - 1), 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View stubs — mandatesOfDebtor / mandatesOfCreditor / collectionsOfMandate
    // ─────────────────────────────────────────────────────────────────────────

    function test_mandateListsGrow() public {
        MandateOffer memory offer = _defaultOffer();
        offer.maxUses = 0; // unlimited

        _activateMandate(prod, offer, creditorOwnerKey, debtor,  debtorKey);
        _activateMandate(prod, offer, creditorOwnerKey, debtor2, debtor2Key);

        assertEq(prod.mandatesOfDebtor(debtor).length,   1);
        assertEq(prod.mandatesOfDebtor(debtor2).length,  1);
        assertEq(prod.mandatesOfCreditor(creditorId1).length, 2);
    }
}
