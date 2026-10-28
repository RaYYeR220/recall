// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../../src/DebitRail.sol";
import "../../src/IDebitRail.sol";
import "../mocks/MockFiatToken.sol";

/// @notice Invariant handler: 2 creditors, 3 debtors, both rails (prod + demo).
///         Tracks ghost variables that mirror the contract's accounting so invariants
///         can be expressed as pure equalities inside the test world.
///
///         Ghost action counters let afterInvariant() print a campaign summary to
///         confirm every state is actually reached across 256 runs × 64 depth.
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
    uint256[2] public creditorIds;       // on prod
    uint256[2] public demoCreditorsIds;  // on demo

    // ── Offer/mandate tracking ────────────────────────────────────────────────
    bytes32[] public mandates;           // active mandate IDs (prod)
    bytes32[] public demoMandates;       // active mandate IDs (demo)
    uint256   public offerNonce;         // unique counter for offer refs

    // ── Collection tracking ───────────────────────────────────────────────────
    bytes32[] public openCollections;     // SCHEDULED or SETTLED (prod)
    bytes32[] public demoOpenCollections; // (demo)

    // ── Ghost action counters ─────────────────────────────────────────────────
    uint256 public ghost_activations;
    uint256 public ghost_prenotifies;
    uint256 public ghost_settled;
    uint256 public ghost_returned;
    uint256 public ghost_refunded;
    uint256 public ghost_released;
    uint256 public ghost_refused;
    uint256 public ghost_revoked;
    uint256 public ghost_expired;
    uint256 public ghost_claims;

    // Same counters for demo rail
    uint256 public ghost_demo_activations;
    uint256 public ghost_demo_prenotifies;
    uint256 public ghost_demo_settled;
    uint256 public ghost_demo_returned;
    uint256 public ghost_demo_refunded;
    uint256 public ghost_demo_released;
    uint256 public ghost_demo_refused;
    uint256 public ghost_demo_revoked;
    uint256 public ghost_demo_expired;
    uint256 public ghost_demo_claims;

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

        // Register creditors on both rails
        vm.startPrank(creditorOwner);
        creditorIds[0]      = prod.registerCreditor("Cred A", creditorPayout);
        creditorIds[1]      = prod.registerCreditor("Cred B", creditorPayout);
        demoCreditorsIds[0] = demo.registerCreditor("Cred A Demo", creditorPayout);
        demoCreditorsIds[1] = demo.registerCreditor("Cred B Demo", creditorPayout);

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

    function _creditorIdx(uint256 seed) internal pure returns (uint256) { return seed % CRED_COUNT; }
    function _debtorIdx(uint256 seed)   internal pure returns (uint256) { return seed % DEBTOR_COUNT; }

    // ── Fund / withdraw (prod only — reserve invariants are token-level) ───────

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

    // ── Activate mandate — prod ───────────────────────────────────────────────

    function activateMandate(uint256 credSeed, uint256 debtorSeed) external {
        uint256 cidx = _creditorIdx(credSeed);
        uint256 didx = _debtorIdx(debtorSeed);
        offerNonce++;

        MandateOffer memory offer = _makeOffer(creditorIds[cidx], prod);
        bytes32 offerHash = prod.hashOffer(offer);
        bytes memory offerSig = _sign(0xC0 + cidx, offerHash);

        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtors[didx],
            deadline:  uint64(block.timestamp + 1 hours)
        });
        bytes memory debtorSig = _sign(debtorKeys[didx], prod.hashAcceptance(acc));

        try prod.activateMandate(offer, offerSig, acc, debtorSig) returns (bytes32 mid) {
            mandates.push(mid);
            ghost_activations++;
        } catch {}
    }

    // ── Activate mandate — demo ───────────────────────────────────────────────

    function activateMandateDemo(uint256 credSeed, uint256 debtorSeed) external {
        uint256 cidx = _creditorIdx(credSeed);
        uint256 didx = _debtorIdx(debtorSeed);
        offerNonce++;

        MandateOffer memory offer = _makeOffer(demoCreditorsIds[cidx], demo); // uses demo.timeScale()
        bytes32 offerHash = demo.hashOffer(offer);
        bytes memory offerSig = _sign(0xC0 + cidx, offerHash);

        MandateAcceptance memory acc = MandateAcceptance({
            offerHash: offerHash,
            debtor:    debtors[didx],
            deadline:  uint64(block.timestamp + 1 hours)
        });
        bytes memory debtorSig = _sign(debtorKeys[didx], demo.hashAcceptance(acc));

        try demo.activateMandate(offer, offerSig, acc, debtorSig) returns (bytes32 mid) {
            demoMandates.push(mid);
            ghost_demo_activations++;
        } catch {}
    }

    // ── Prenotify — prod ──────────────────────────────────────────────────────

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
        if (prod.periodUsage(mid, pidx) + amount > m.maxPerPeriod) return;
        offerNonce++;
        bytes32 e2eId = keccak256(abi.encode("e2e", offerNonce));
        if (prod.getCollection(keccak256(abi.encode(mid, e2eId))).status != CollectionStatus.NONE) return;
        vm.prank(creditorOwner);
        try prod.prenotify(mid, amount, dueAt, e2eId, "") returns (bytes32 collId) {
            openCollections.push(collId);
            ghost_prenotifies++;
        } catch {}
    }

    // ── Prenotify — demo ──────────────────────────────────────────────────────

    function prenotifyDemo(uint256 mandateSeed, uint128 amount) external {
        if (demoMandates.length == 0) return;
        bytes32 mid = demoMandates[mandateSeed % demoMandates.length];
        Mandate memory m = demo.getMandate(mid);
        if (m.status != MandateStatus.ACTIVE) return;
        if (demo.isLapsed(mid)) return;
        amount = uint128(bound(uint256(amount), 1, m.maxPerCollection));
        uint64 dueAt = uint64(block.timestamp + demo.minPrenotice() + 10);
        if (dueAt > block.timestamp + demo.scheduleAhead()) return;
        uint256 pidx = demo.periodIndexOf(mid, dueAt);
        if (demo.periodUsage(mid, pidx) + amount > m.maxPerPeriod) return;
        offerNonce++;
        bytes32 e2eId = keccak256(abi.encode("e2eD", offerNonce));
        if (demo.getCollection(keccak256(abi.encode(mid, e2eId))).status != CollectionStatus.NONE) return;
        vm.prank(creditorOwner);
        try demo.prenotify(mid, amount, dueAt, e2eId, "") returns (bytes32 collId) {
            demoOpenCollections.push(collId);
            ghost_demo_prenotifies++;
        } catch {}
    }

    // ── Collect — prod ────────────────────────────────────────────────────────

    function collect(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) { _removeFromProd(idx); return; }
        if (block.timestamp < col.dueAt) return;
        if (block.timestamp > uint256(col.dueAt) + prod.executionWindow()) { _removeFromProd(idx); return; }
        prod.collect(cid);
        CollectionStatus st = prod.getCollection(cid).status;
        if (st == CollectionStatus.SETTLED)  { ghost_settled++;  }
        else if (st == CollectionStatus.RETURNED) { ghost_returned++; _removeFromProd(idx); }
        else if (st == CollectionStatus.FINAL)    { ghost_settled++;  _removeFromProd(idx); }
    }

    // ── Collect — demo ────────────────────────────────────────────────────────

    function collectDemo(uint256 collSeed) external {
        if (demoOpenCollections.length == 0) return;
        uint256 idx = collSeed % demoOpenCollections.length;
        bytes32 cid = demoOpenCollections[idx];
        Collection memory col = demo.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) { _removeFromDemo(idx); return; }
        if (block.timestamp < col.dueAt) return;
        if (block.timestamp > uint256(col.dueAt) + demo.executionWindow()) { _removeFromDemo(idx); return; }
        demo.collect(cid);
        CollectionStatus st = demo.getCollection(cid).status;
        if (st == CollectionStatus.SETTLED)       { ghost_demo_settled++;  }
        else if (st == CollectionStatus.RETURNED) { ghost_demo_returned++; _removeFromDemo(idx); }
        else if (st == CollectionStatus.FINAL)    { ghost_demo_settled++;  _removeFromDemo(idx); }
    }

    // ── Refund — prod ─────────────────────────────────────────────────────────

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
        try prod.refund(cid) { ghost_refunded++; _removeFromProd(idx); } catch {}
    }

    // ── Refund — demo ─────────────────────────────────────────────────────────

    function refundDemo(uint256 collSeed) external {
        if (demoOpenCollections.length == 0) return;
        uint256 idx = collSeed % demoOpenCollections.length;
        bytes32 cid = demoOpenCollections[idx];
        Collection memory col = demo.getCollection(cid);
        if (col.status != CollectionStatus.SETTLED) return;
        Mandate memory m = demo.getMandate(col.mandateId);
        if (m.scheme != Scheme.CORE) return;
        if (block.timestamp >= uint256(col.settledAt) + demo.refundWindow()) return;
        vm.prank(m.debtor);
        try demo.refund(cid) { ghost_demo_refunded++; _removeFromDemo(idx); } catch {}
    }

    // ── Release — prod ────────────────────────────────────────────────────────

    function release(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SETTLED) return;
        if (block.timestamp < uint256(col.settledAt) + prod.refundWindow()) return;
        try prod.release(cid) { ghost_released++; _removeFromProd(idx); } catch {}
    }

    // ── Release — demo ────────────────────────────────────────────────────────

    function releaseDemo(uint256 collSeed) external {
        if (demoOpenCollections.length == 0) return;
        uint256 idx = collSeed % demoOpenCollections.length;
        bytes32 cid = demoOpenCollections[idx];
        Collection memory col = demo.getCollection(cid);
        if (col.status != CollectionStatus.SETTLED) return;
        if (block.timestamp < uint256(col.settledAt) + demo.refundWindow()) return;
        try demo.release(cid) { ghost_demo_released++; _removeFromDemo(idx); } catch {}
    }

    // ── Refuse — prod ─────────────────────────────────────────────────────────

    function refuse(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) return;
        Mandate memory m = prod.getMandate(col.mandateId);
        vm.prank(m.debtor);
        try prod.refuse(cid) { ghost_refused++; _removeFromProd(idx); } catch {}
    }

    // ── Refuse — demo ─────────────────────────────────────────────────────────

    function refuseDemo(uint256 collSeed) external {
        if (demoOpenCollections.length == 0) return;
        uint256 idx = collSeed % demoOpenCollections.length;
        bytes32 cid = demoOpenCollections[idx];
        Collection memory col = demo.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) return;
        Mandate memory m = demo.getMandate(col.mandateId);
        vm.prank(m.debtor);
        try demo.refuse(cid) { ghost_demo_refused++; _removeFromDemo(idx); } catch {}
    }

    // ── Revoke — prod ─────────────────────────────────────────────────────────

    function revokeMandate(uint256 mandateSeed) external {
        if (mandates.length == 0) return;
        uint256 idx = mandateSeed % mandates.length;
        bytes32 mid = mandates[idx];
        Mandate memory m = prod.getMandate(mid);
        if (m.status != MandateStatus.ACTIVE) return;
        vm.prank(m.debtor);
        try prod.revoke(mid) {
            ghost_revoked++;
            mandates[idx] = mandates[mandates.length - 1];
            mandates.pop();
        } catch {}
    }

    // ── Revoke — demo ─────────────────────────────────────────────────────────

    function revokeMandateDemo(uint256 mandateSeed) external {
        if (demoMandates.length == 0) return;
        uint256 idx = mandateSeed % demoMandates.length;
        bytes32 mid = demoMandates[idx];
        Mandate memory m = demo.getMandate(mid);
        if (m.status != MandateStatus.ACTIVE) return;
        vm.prank(m.debtor);
        try demo.revoke(mid) {
            ghost_demo_revoked++;
            demoMandates[idx] = demoMandates[demoMandates.length - 1];
            demoMandates.pop();
        } catch {}
    }

    // ── Expire — prod ─────────────────────────────────────────────────────────

    function expireCollection(uint256 collSeed) external {
        if (openCollections.length == 0) return;
        uint256 idx = collSeed % openCollections.length;
        bytes32 cid = openCollections[idx];
        Collection memory col = prod.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) return;
        if (block.timestamp <= uint256(col.dueAt) + prod.executionWindow()) return;
        try prod.expire(cid) { ghost_expired++; _removeFromProd(idx); } catch {}
    }

    // ── Expire — demo ─────────────────────────────────────────────────────────

    function expireCollectionDemo(uint256 collSeed) external {
        if (demoOpenCollections.length == 0) return;
        uint256 idx = collSeed % demoOpenCollections.length;
        bytes32 cid = demoOpenCollections[idx];
        Collection memory col = demo.getCollection(cid);
        if (col.status != CollectionStatus.SCHEDULED) return;
        if (block.timestamp <= uint256(col.dueAt) + demo.executionWindow()) return;
        try demo.expire(cid) { ghost_demo_expired++; _removeFromDemo(idx); } catch {}
    }

    // ── Claim — prod ──────────────────────────────────────────────────────────

    function claimPayout() external {
        uint256 amt = prod.claimable(creditorPayout, address(eurc));
        if (amt == 0) return;
        vm.prank(creditorPayout);
        prod.claim(address(eurc));
        ghost_claims++;
    }

    // ── Claim — demo ──────────────────────────────────────────────────────────

    function claimPayoutDemo() external {
        uint256 amt = demo.claimable(creditorPayout, address(eurc));
        if (amt == 0) return;
        vm.prank(creditorPayout);
        demo.claim(address(eurc));
        ghost_demo_claims++;
    }

    // ── Time warp ─────────────────────────────────────────────────────────────

    function warpForward(uint256 seconds_) external {
        // Warp between 1 minute and 10 days
        seconds_ = bound(seconds_, 60, 10 days);
        vm.warp(block.timestamp + seconds_);
    }

    // ── afterInvariant campaign summary ──────────────────────────────────────

    function afterInvariant() external view {
        console.log("=== Invariant campaign summary ===");
        console.log("PROD rail:");
        console.log("  activations   :", ghost_activations);
        console.log("  prenotifies   :", ghost_prenotifies);
        console.log("  settled       :", ghost_settled);
        console.log("  returned      :", ghost_returned);
        console.log("  refunded      :", ghost_refunded);
        console.log("  released      :", ghost_released);
        console.log("  refused       :", ghost_refused);
        console.log("  revoked       :", ghost_revoked);
        console.log("  expired       :", ghost_expired);
        console.log("  claims        :", ghost_claims);
        console.log("DEMO rail:");
        console.log("  activations   :", ghost_demo_activations);
        console.log("  prenotifies   :", ghost_demo_prenotifies);
        console.log("  settled       :", ghost_demo_settled);
        console.log("  returned      :", ghost_demo_returned);
        console.log("  refunded      :", ghost_demo_refunded);
        console.log("  released      :", ghost_demo_released);
        console.log("  refused       :", ghost_demo_refused);
        console.log("  revoked       :", ghost_demo_revoked);
        console.log("  expired       :", ghost_demo_expired);
        console.log("  claims        :", ghost_demo_claims);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function _makeOffer(uint256 creditorId, DebitRail rail)
        internal view returns (MandateOffer memory)
    {
        uint32 ts = rail.timeScale();
        // Demo caps: maxPerCollection <= 1e6, maxPerPeriod <= 2e6
        uint128 maxCol = ts > 1 ? uint128(1e6)  : uint128(500e6);
        uint128 maxPer = ts > 1 ? uint128(2e6)  : uint128(1000e6);
        return MandateOffer({
            creditorId:       creditorId,
            token:            address(eurc),
            scheme:           Scheme.CORE,
            oneOff:           false,
            maxPerCollection: maxCol,
            maxPerPeriod:     maxPer,
            periodLength:     uint32(30 days),
            prenoticeLength:  uint32(1 days),
            offerRef:         bytes32(offerNonce),
            termsHash:        keccak256(abi.encode(offerNonce)),
            maxUses:          0,
            validUntil:       uint64(block.timestamp + 365 days),
            timeScale:        ts,
            debtor:           address(0)
        });
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _removeFromProd(uint256 idx) internal {
        openCollections[idx] = openCollections[openCollections.length - 1];
        openCollections.pop();
    }

    function _removeFromDemo(uint256 idx) internal {
        demoOpenCollections[idx] = demoOpenCollections[demoOpenCollections.length - 1];
        demoOpenCollections.pop();
    }

    function mandateCount()     external view returns (uint256) { return mandates.length; }
    function collectionCount()  external view returns (uint256) { return openCollections.length; }
    function demoMandateCount() external view returns (uint256) { return demoMandates.length; }
    function demoCollectionCount() external view returns (uint256) { return demoOpenCollections.length; }
}
