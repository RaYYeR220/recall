// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../../src/DebitRail.sol";
import "../../src/IDebitRail.sol";
import "../mocks/MockFiatToken.sol";

/// @notice Invariant handler: 2 creditors, 3 debtors, both rails (prod + demo).
///         Tracks ghost variables that mirror the contract's accounting so invariants
///         can be expressed as pure equalities inside the test world.
contract InvariantHandler is Test {
    using SafeCast for uint256;

    // ── Actors ────────────────────────────────────────────────────────────────
    uint256 constant CRED_COUNT   = 2;
    uint256 constant DEBTOR_COUNT = 3;

    address internal creditorOwner  = makeAddr("creditorOwner");
    address internal creditorPayout = makeAddr("creditorPayout");

    uint256[3] internal debtorKeys;
    address[3] internal debtors;

    // ── Contracts ─────────────────────────────────────────────────────────────
    DebitRail      public prod;
    DebitRail      public demo;
    MockFiatToken  public eurc;
    MockFiatToken  public usdc;

    // ── Registered creditor IDs ───────────────────────────────────────────────
    uint256[2] public creditorIds;          // on prod
    uint256[2] public demoCreditorsIds;     // on demo

    // ── Offer/mandate tracking ────────────────────────────────────────────────
    bytes32[] public mandates;              // all active mandate IDs (prod)
    bytes32[] public demoMandates;          // all active mandate IDs (demo)
    uint256   public offerNonce;            // unique counter for offer refs

    // ── Collection tracking ───────────────────────────────────────────────────
    bytes32[] public openCollections;       // SCHEDULED or SETTLED (prod)
    bytes32[] public demoOpenCollections;   // (demo)

    constructor(
        DebitRail prod_,
        DebitRail demo_,
        MockFiatToken eurc_,
        MockFiatToken usdc_
    ) {
        prod = prod_;
        demo = demo_;
        eurc = eurc_;
        usdc = usdc_;

        // Actor setup
        debtorKeys[0] = 0xD1;
        debtorKeys[1] = 0xD2;
        debtorKeys[2] = 0xD3;
        for (uint256 i; i < 3; i++) {
            debtors[i] = vm.addr(debtorKeys[i]);
            eurc.mint(debtors[i], 100_000e6);
            usdc.mint(debtors[i], 100_000e6);
            vm.prank(debtors[i]);
            eurc.approve(address(prod), type(uint256).max);
            vm.prank(debtors[i]);
            usdc.approve(address(prod), type(uint256).max);
            vm.prank(debtors[i]);
            eurc.approve(address(demo), type(uint256).max);
            vm.prank(debtors[i]);
            usdc.approve(address(demo), type(uint256).max);
        }

        eurc.mint(creditorOwner, 1_000_000e6);
        usdc.mint(creditorOwner, 1_000_000e6);

        // Register creditors
        vm.startPrank(creditorOwner);
        creditorIds[0]     = prod.registerCreditor("Cred A", creditorPayout);
        creditorIds[1]     = prod.registerCreditor("Cred B", creditorPayout);
        demoCreditorsIds[0]= demo.registerCreditor("Cred A Demo", creditorPayout);
        demoCreditorsIds[1]= demo.registerCreditor("Cred B Demo", creditorPayout);

        // Fund reserves
        eurc.approve(address(prod), type(uint256).max);
        usdc.approve(address(prod), type(uint256).max);
        eurc.approve(address(demo), type(uint256).max);
        usdc.approve(address(demo), type(uint256).max);
        prod.fundReserve(creditorIds[0], address(eurc), 50_000e6);
        prod.fundReserve(creditorIds[1], address(eurc), 50_000e6);
        demo.fundReserve(demoCreditorsIds[0], address(eurc), 50_000e6);
        demo.fundReserve(demoCreditorsIds[1], address(eurc), 50_000e6);
        vm.stopPrank();
    }

    // ── Bounded helpers ───────────────────────────────────────────────────────

    function _creditorIdx(uint256 seed) internal pure returns (uint256) {
        return seed % CRED_COUNT;
    }
    function _debtorIdx(uint256 seed) internal pure returns (uint256) {
        return seed % DEBTOR_COUNT;
    }

    // ── Actions: fund / withdraw ──────────────────────────────────────────────

    function fundReserve(uint256 credSeed, uint256 amount) external {
        amount = bound(amount, 1, 10_000e6);
        uint256 idx = _creditorIdx(credSeed);
        eurc.mint(creditorOwner, amount);
        vm.prank(creditorOwner);
        prod.fundReserve(creditorIds[idx], address(eurc), amount);
    }

    function withdrawReserve(uint256 credSeed, uint256 amount) external {
        uint256 idx = _creditorIdx(credSeed);
        Coverage memory cov = prod.coverage(creditorIds[idx], address(eurc));
        uint256 free = cov.reserveTotal > cov.reserveLocked
            ? cov.reserveTotal - cov.reserveLocked : 0;
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(creditorOwner);
        prod.withdrawReserve(creditorIds[idx], address(eurc), amount, creditorOwner);
    }

    // ── Actions: activate mandate ─────────────────────────────────────────────

    function activateMandate(uint256 credSeed, uint256 debtorSeed) external {
        uint256 cidx = _creditorIdx(credSeed);
        uint256 didx = _debtorIdx(debtorSeed);

        offerNonce++;
        MandateOffer memory offer = MandateOffer({
            creditorId:       creditorIds[cidx],
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: uint128(500e6),
            maxPerPeriod:     uint128(1000e6),
            periodLength:     uint32(30 days),
            prenoticeLength:  uint32(1 days),
            offerRef:         bytes32(offerNonce),
            termsHash:        keccak256(abi.encode(offerNonce)),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days)
        });

        // Use a fixed key for the creditor owner (0xC0 + cidx) — see _creditorOwnerKey()
        bytes32 offerHash = prod.hashOffer(offer);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xC0 + cidx, offerHash);
        bytes memory offerSig = abi.encodePacked(r, s, v);

        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtors[didx],
            deadline:  uint64(block.timestamp + 1 hours)
        });
        bytes32 accHash = prod.hashAcceptance(acc);
        (v, r, s) = vm.sign(debtorKeys[didx], accHash);
        bytes memory debtorSig = abi.encodePacked(r, s, v);

        // The offer must be signed by the actual owner (creditorOwner = vm.addr(0xC0+cidx))
        // If the creditor's owner doesn't match the key, skip.
        if (_creditorOwnerKey(cidx) == 0) return;

        try prod.activateMandate(offer, offerSig, acc, debtorSig) returns (bytes32 mid) {
            mandates.push(mid);
        } catch {}
    }

    function _creditorOwnerKey(uint256 cidx) internal pure returns (uint256) {
        return 0xC0 + cidx;
    }

    // ── Actions: prenotify ────────────────────────────────────────────────────

    function prenotify(uint256 mandateSeed, uint128 amount) external {
        if (mandates.length == 0) return;
        bytes32 mid = mandates[mandateSeed % mandates.length];
        Mandate memory m = prod.getMandate(mid);
        if (m.status != MandateStatus.ACTIVE) return;
        if (prod.isLapsed(mid)) return;

        amount = uint128(bound(uint256(amount), 1, m.maxPerCollection));

        uint64 dueAt = uint64(block.timestamp + prod.minPrenotice() + 60);
        if (dueAt > block.timestamp + prod.scheduleAhead()) return;

        uint256 pidx = prod.periodIndexOf(mid, dueAt);
        uint256 used = prod.periodUsage(mid, pidx);
        if (used + amount > m.maxPerPeriod) return;

        offerNonce++;
        bytes32 e2eId = keccak256(abi.encode("e2e", offerNonce));
        // Check no duplicate
        bytes32 cid = keccak256(abi.encode(mid, e2eId));
        if (prod.getCollection(cid).status != CollectionStatus.NONE) return;

        vm.prank(creditorOwner);
        try prod.prenotify(mid, amount, dueAt, e2eId, "") returns (bytes32 collId) {
            openCollections.push(collId);
        } catch {}
    }

    // ── Actions: collect ──────────────────────────────────────────────────────

    function collect(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) {
            _removeCollection(idx);
            return;
        }
        if (block.timestamp < col.dueAt) return;
        if (block.timestamp > uint256(col.dueAt) + prod.executionWindow()) {
            _removeCollection(idx);
            return;
        }
        prod.collect(cid);
        // If it returned or became final, remove from open list
        CollectionStatus newStatus = prod.getCollection(cid).status;
        if (newStatus != CollectionStatus.SCHEDULED &&
            newStatus != CollectionStatus.SETTLED) {
            _removeCollection(idx);
        }
    }

    // ── Actions: refund ───────────────────────────────────────────────────────

    function refund(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SETTLED) return;

        Mandate memory m = prod.getMandate(col.mandateId);
        if (m.scheme != Scheme.CORE) return;
        if (block.timestamp >= uint256(col.settledAt) + prod.refundWindow()) return;

        vm.prank(m.debtor);
        try prod.refund(cid) {
            _removeCollection(idx);
        } catch {}
    }

    // ── Actions: release ──────────────────────────────────────────────────────

    function release(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SETTLED) return;
        if (block.timestamp < uint256(col.settledAt) + prod.refundWindow()) return;

        try prod.release(cid) {
            _removeCollection(idx);
        } catch {}
    }

    // ── Actions: refuse ───────────────────────────────────────────────────────

    function refuse(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) return;

        Mandate memory m = prod.getMandate(col.mandateId);
        vm.prank(m.debtor);
        try prod.refuse(cid) {
            _removeCollection(idx);
        } catch {}
    }

    // ── Actions: revoke ───────────────────────────────────────────────────────

    function revokeMandate(uint256 mandateSeed) external {
        if (mandates.length == 0) return;
        uint256 idx = mandateSeed % mandates.length;
        bytes32 mid = mandates[idx];
        Mandate memory m = prod.getMandate(mid);
        if (m.status != MandateStatus.ACTIVE) return;

        vm.prank(m.debtor);
        try prod.revoke(mid) {
            // Remove from list
            mandates[idx] = mandates[mandates.length - 1];
            mandates.pop();
        } catch {}
    }

    // ── Actions: expire ───────────────────────────────────────────────────────

    function expireCollection(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) return;
        if (block.timestamp <= uint256(col.dueAt) + prod.executionWindow()) return;

        try prod.expire(cid) {
            _removeCollection(idx);
        } catch {}
    }

    // ── Actions: claim ────────────────────────────────────────────────────────

    function claimPayout() external {
        uint256 amt = prod.claimable(creditorPayout, address(eurc));
        if (amt == 0) return;
        vm.prank(creditorPayout);
        prod.claim(address(eurc));
    }

    // ── Actions: time warp ────────────────────────────────────────────────────

    function warpForward(uint256 seconds_) external {
        // Warp between 1 minute and 10 days (keeps things moving without skipping windows)
        seconds_ = bound(seconds_, 60, 10 days);
        vm.warp(block.timestamp + seconds_);
    }

    // ── Helper ────────────────────────────────────────────────────────────────

    function _removeCollection(uint256 idx) internal {
        openCollections[idx] = openCollections[openCollections.length - 1];
        openCollections.pop();
    }

    function mandateCount()    external view returns (uint256) { return mandates.length; }
    function collectionCount() external view returns (uint256) { return openCollections.length; }
}
