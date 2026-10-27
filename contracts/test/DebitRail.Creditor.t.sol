// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./DebitRailBase.t.sol";

/// @notice Tests for creditor registration, operators, and reserves.
contract DebitRailCreditorTest is DebitRailBase {

    function setUp() public override {
        super.setUp();
    }

    // ── Registration ─────────────────────────────────────────────────────────

    function test_registerCreditor_assignsSequentialIds() public {
        vm.prank(creditorOwner);
        uint256 id1 = prod.registerCreditor("Merchant A", creditorPayout);

        vm.prank(creditorOwner2);
        uint256 id2 = prod.registerCreditor("Merchant B", creditorPayout2);

        assertEq(id1, 1, "first id");
        assertEq(id2, 2, "second id");
        assertEq(prod.creditorCount(), 2);

        Creditor memory c1 = prod.getCreditor(id1);
        assertEq(c1.owner,  creditorOwner);
        assertEq(c1.payout, creditorPayout);
        assertEq(c1.name,   "Merchant A");

        Creditor memory c2 = prod.getCreditor(id2);
        assertEq(c2.owner,  creditorOwner2);
    }

    function test_registerCreditor_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit CreditorRegistered(1, creditorOwner, creditorPayout, "Merchant A");
        vm.prank(creditorOwner);
        prod.registerCreditor("Merchant A", creditorPayout);
    }

    function test_registerCreditor_zeroPayoutReverts() public {
        vm.prank(creditorOwner);
        vm.expectRevert(ZeroAddress.selector);
        prod.registerCreditor("Merchant", address(0));
    }

    // ── setOperator ──────────────────────────────────────────────────────────

    function test_setOperator_onlyOwner() public {
        _registerCreditor1();

        // Owner can grant operator
        vm.prank(creditorOwner);
        prod.setOperator(creditorId1, operator, true);
        assertTrue(prod.isOperator(creditorId1, operator));

        // Stranger cannot
        vm.prank(stranger);
        vm.expectRevert(NotCreditorOwner.selector);
        prod.setOperator(creditorId1, operator, false);

        // Owner can revoke
        vm.prank(creditorOwner);
        prod.setOperator(creditorId1, operator, false);
        assertFalse(prod.isOperator(creditorId1, operator));
    }

    function test_setOperator_zeroAddressReverts() public {
        _registerCreditor1();
        vm.prank(creditorOwner);
        vm.expectRevert(ZeroAddress.selector);
        prod.setOperator(creditorId1, address(0), true);
    }

    function test_setOperator_emitsEvent() public {
        _registerCreditor1();
        vm.expectEmit(true, true, false, true);
        emit OperatorSet(creditorId1, operator, true);
        vm.prank(creditorOwner);
        prod.setOperator(creditorId1, operator, true);
    }

    // ── setPayout ────────────────────────────────────────────────────────────

    function test_setPayout_onlyOwner() public {
        _registerCreditor1();
        address newPayout = makeAddr("newPayout");

        vm.prank(stranger);
        vm.expectRevert(NotCreditorOwner.selector);
        prod.setPayout(creditorId1, newPayout);

        vm.prank(creditorOwner);
        prod.setPayout(creditorId1, newPayout);
        assertEq(prod.getCreditor(creditorId1).payout, newPayout);
    }

    // ── fundReserve ──────────────────────────────────────────────────────────

    function test_fundReserve_increasesTotal() public {
        _registerCreditor1();

        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 500e6);
        prod.fundReserve(creditorId1, address(eurc), 500e6);
        vm.stopPrank();

        Coverage memory cov = prod.coverage(creditorId1, address(eurc));
        assertEq(cov.reserveTotal,  500e6);
        assertEq(cov.reserveLocked, 0);
        assertEq(cov.held,          0);

        (uint256 reserves,,) = prod.accounted(address(eurc));
        assertEq(reserves, 500e6);
    }

    function test_fundReserve_anyoneCanFund() public {
        _registerCreditor1();

        eurc.mint(stranger, 100e6);
        vm.startPrank(stranger);
        eurc.approve(address(prod), 100e6);
        prod.fundReserve(creditorId1, address(eurc), 100e6);
        vm.stopPrank();

        Coverage memory cov = prod.coverage(creditorId1, address(eurc));
        assertEq(cov.reserveTotal, 100e6);
    }

    function test_fundReserve_tokenNotAllowedReverts() public {
        _registerCreditor1();
        address rando = makeAddr("randoToken");
        vm.prank(creditorOwner);
        vm.expectRevert(TokenNotAllowed.selector);
        prod.fundReserve(creditorId1, rando, 100e6);
    }

    function test_fundReserve_zeroAmountReverts() public {
        _registerCreditor1();
        vm.prank(creditorOwner);
        vm.expectRevert(ZeroAmount.selector);
        prod.fundReserve(creditorId1, address(eurc), 0);
    }

    function test_fundReserve_emitsEvent() public {
        _registerCreditor1();
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 200e6);
        vm.expectEmit(true, true, false, true);
        emit ReserveFunded(creditorId1, address(eurc), creditorOwner, 200e6);
        prod.fundReserve(creditorId1, address(eurc), 200e6);
        vm.stopPrank();
    }

    // ── withdrawReserve ──────────────────────────────────────────────────────

    function test_withdrawReserve_onlyOwner() public {
        _registerCreditor1();

        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 300e6);
        prod.fundReserve(creditorId1, address(eurc), 300e6);
        vm.stopPrank();

        // Stranger cannot withdraw
        vm.prank(stranger);
        vm.expectRevert(NotCreditorOwner.selector);
        prod.withdrawReserve(creditorId1, address(eurc), 100e6, stranger);

        // Owner can withdraw to any address
        address beneficiary = makeAddr("beneficiary");
        vm.prank(creditorOwner);
        prod.withdrawReserve(creditorId1, address(eurc), 100e6, beneficiary);
        assertEq(eurc.balanceOf(beneficiary), 100e6);

        Coverage memory cov = prod.coverage(creditorId1, address(eurc));
        assertEq(cov.reserveTotal, 200e6);
    }

    function test_withdrawReserve_fullFreeBalance() public {
        _registerCreditor1();
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 500e6);
        prod.fundReserve(creditorId1, address(eurc), 500e6);
        prod.withdrawReserve(creditorId1, address(eurc), 500e6, creditorOwner);
        vm.stopPrank();

        assertEq(prod.coverage(creditorId1, address(eurc)).reserveTotal, 0);
    }

    function test_withdrawReserve_zeroAmountReverts() public {
        _registerCreditor1();
        vm.prank(creditorOwner);
        vm.expectRevert(ZeroAmount.selector);
        prod.withdrawReserve(creditorId1, address(eurc), 0, creditorPayout);
    }

    function test_withdrawReserve_zeroAddressReverts() public {
        _registerCreditor1();
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 100e6);
        prod.fundReserve(creditorId1, address(eurc), 100e6);
        vm.expectRevert(ZeroAddress.selector);
        prod.withdrawReserve(creditorId1, address(eurc), 100e6, address(0));
        vm.stopPrank();
    }

    function test_withdrawReserve_lockedPortionReverts() public {
        // We can't lock without collections (next turn), so we just test
        // that withdrawing more than the total reverts with ReserveLocked.
        _registerCreditor1();
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 100e6);
        prod.fundReserve(creditorId1, address(eurc), 100e6);
        vm.expectRevert(ReserveLocked.selector);
        prod.withdrawReserve(creditorId1, address(eurc), 101e6, creditorOwner);
        vm.stopPrank();
    }

    function test_withdrawReserve_emitsEvent() public {
        _registerCreditor1();
        vm.startPrank(creditorOwner);
        eurc.approve(address(prod), 200e6);
        prod.fundReserve(creditorId1, address(eurc), 200e6);
        vm.expectEmit(true, true, false, true);
        emit ReserveWithdrawn(creditorId1, address(eurc), creditorOwner, 100e6);
        prod.withdrawReserve(creditorId1, address(eurc), 100e6, creditorOwner);
        vm.stopPrank();
    }

    // ── claim ─────────────────────────────────────────────────────────────────

    function test_claim_nothingToClaimReverts() public {
        vm.prank(debtor);
        vm.expectRevert(NothingToClaim.selector);
        prod.claim(address(eurc));
    }

    function test_claim_tokenNotAllowedReverts() public {
        vm.prank(debtor);
        vm.expectRevert(TokenNotAllowed.selector);
        prod.claim(makeAddr("randoToken"));
    }

    // ── Unknown creditor ─────────────────────────────────────────────────────

    function test_getCreditor_unknownReverts() public {
        vm.expectRevert(UnknownCreditor.selector);
        prod.getCreditor(999);
    }

    function test_fundReserve_unknownCreditorReverts() public {
        vm.expectRevert(UnknownCreditor.selector);
        prod.fundReserve(999, address(eurc), 1e6);
    }
}
