// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./IDebitRail.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  RailLens -- read-only aggregation views for DebitRail
/// @notice Deployed as a separate, stateless contract pointing at a single DebitRail instance.
///         Every function is a pure view; no state mutations.
contract RailLens {
    IDebitRail public immutable rail;

    uint256 private constant MAX_COLLECTIONS_IN_VIEW = 10;

    struct MandateView {
        bytes32      id;
        Mandate      mandate;
        uint256      collectionCount; // total collections ever (not just open)
        Collection[] collections;     // newest up to MAX_COLLECTIONS_IN_VIEW
    }

    struct TokenHealth {
        address token;
        uint256 balance;
        uint256 reserves;
        uint256 held;
        uint256 claimables;
        uint256 surplus;
        uint256 lockedTotal;
        uint256 exposureTotal;
        bool    i1; // balance >= reserves + held + claimables
        bool    i2; // exposureTotal == lockedTotal + held
        bool    i3; // lockedTotal <= reserves
    }

    constructor(address rail_) {
        rail = IDebitRail(rail_);
    }

    // ── debtorView (paginated) ────────────────────────────────────────────────

    /// @notice Returns a paginated slice of a debtor's mandates with their newest collections.
    /// @param offset  Zero-based index of the first mandate to return.
    /// @param limit   Max mandates to return (0 = all remaining).
    function debtorView(address debtor, uint256 offset, uint256 limit)
        external view
        returns (MandateView[] memory views, uint256 total)
    {
        bytes32[] memory mids = rail.mandatesOfDebtor(debtor);
        return _paginateMandates(mids, offset, limit);
    }

    // ── creditorView (paginated) ──────────────────────────────────────────────

    /// @notice Returns a paginated slice of a creditor's mandates with their newest collections.
    function creditorView(uint256 creditorId, uint256 offset, uint256 limit)
        external view
        returns (MandateView[] memory views, uint256 total)
    {
        bytes32[] memory mids = rail.mandatesOfCreditor(creditorId);
        return _paginateMandates(mids, offset, limit);
    }

    // ── collectionsPage ───────────────────────────────────────────────────────

    /// @notice Returns a paginated slice of the full collection history for a mandate.
    /// @param offset  Zero-based index (0 = oldest).
    /// @param limit   Max collections to return (0 = all remaining).
    function collectionsPage(bytes32 mandateId, uint256 offset, uint256 limit)
        external view
        returns (Collection[] memory page, uint256 total)
    {
        bytes32[] memory cids = rail.collectionsOfMandate(mandateId);
        total = cids.length;
        if (offset >= total) {
            page = new Collection[](0);
            return (page, total);
        }
        uint256 available = total - offset;
        uint256 count     = (limit == 0 || limit > available) ? available : limit;
        page = new Collection[](count);
        for (uint256 i; i < count; i++) {
            page[i] = rail.getCollection(cids[offset + i]);
        }
    }

    // ── coverageView ──────────────────────────────────────────────────────────

    function coverageView(uint256 creditorId)
        external view
        returns (Coverage memory eurcCov, Coverage memory usdcCov)
    {
        address eurcAddr = _callAddress(address(rail), bytes4(keccak256("eurc()")));
        address usdcAddr = _callAddress(address(rail), bytes4(keccak256("usdc()")));
        eurcCov = rail.coverage(creditorId, eurcAddr);
        usdcCov = rail.coverage(creditorId, usdcAddr);
    }

    // ── health ────────────────────────────────────────────────────────────────

    function health()
        external view
        returns (TokenHealth memory eurcHealth, TokenHealth memory usdcHealth)
    {
        address eurcAddr = _callAddress(address(rail), bytes4(keccak256("eurc()")));
        address usdcAddr = _callAddress(address(rail), bytes4(keccak256("usdc()")));
        eurcHealth = _tokenHealth(eurcAddr);
        usdcHealth = _tokenHealth(usdcAddr);
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    function _paginateMandates(bytes32[] memory mids, uint256 offset, uint256 limit)
        internal view
        returns (MandateView[] memory views, uint256 total)
    {
        total = mids.length;
        if (offset >= total) {
            views = new MandateView[](0);
            return (views, total);
        }
        uint256 available = total - offset;
        uint256 count     = (limit == 0 || limit > available) ? available : limit;
        views = new MandateView[](count);
        for (uint256 i; i < count; i++) {
            views[i] = _buildMandateView(mids[offset + i]);
        }
    }

    function _buildMandateView(bytes32 mid)
        internal view
        returns (MandateView memory v)
    {
        v.id      = mid;
        v.mandate = rail.getMandate(mid);

        bytes32[] memory cids = rail.collectionsOfMandate(mid);
        v.collectionCount = cids.length;

        // Return only the newest MAX_COLLECTIONS_IN_VIEW collections.
        uint256 retCount = cids.length > MAX_COLLECTIONS_IN_VIEW
            ? MAX_COLLECTIONS_IN_VIEW
            : cids.length;
        v.collections = new Collection[](retCount);
        uint256 start = cids.length - retCount;
        for (uint256 j; j < retCount; j++) {
            v.collections[j] = rail.getCollection(cids[start + j]);
        }
    }

    function _callAddress(address target, bytes4 selector) internal view returns (address result) {
        (bool ok, bytes memory ret) = target.staticcall(abi.encodePacked(selector));
        require(ok && ret.length == 32, "RailLens: address call failed");
        result = abi.decode(ret, (address));
    }

    function _tokenHealth(address token)
        internal view
        returns (TokenHealth memory h)
    {
        h.token   = token;
        h.balance = IERC20(token).balanceOf(address(rail));

        (h.reserves, h.held, h.claimables) = rail.accounted(token);
        h.lockedTotal   = rail.lockedTotal(token);
        h.exposureTotal = rail.exposureTotal(token);

        uint256 accSum = h.reserves + h.held + h.claimables;
        h.i1      = h.balance >= accSum;
        h.surplus = h.balance >= accSum ? h.balance - accSum : 0;
        h.i2      = h.exposureTotal == h.lockedTotal + h.held;
        h.i3      = h.lockedTotal <= h.reserves;
    }
}
