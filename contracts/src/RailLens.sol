// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./IDebitRail.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  RailLens -- read-only aggregation views for DebitRail
/// @notice Deployed as a separate, stateless contract pointing at a single DebitRail instance.
///         Every function is a pure view; no state mutations.
contract RailLens {
    IDebitRail public immutable rail;

    // Struct types referencing top-level types from IDebitRail.sol (not namespaced)
    struct MandateView {
        bytes32      id;
        Mandate      mandate;
        Collection[] collections;
    }

    struct TokenHealth {
        address token;
        uint256 balance;       // token.balanceOf(rail)
        uint256 reserves;      // Sum of reserveTotal across all creditors
        uint256 held;          // Sum of held across all creditors
        uint256 claimables;    // Sum of all claimable balances
        uint256 surplus;       // balance - (reserves+held+claimables); >0 if tokens were donated directly
        uint256 lockedTotal;   // rail.lockedTotal(token)
        uint256 exposureTotal; // rail.exposureTotal(token)
        bool    i1;            // balance >= reserves + held + claimables
        bool    i2;            // exposureTotal == lockedTotal + held  (CORE accounting)
        bool    i3;            // lockedTotal <= reserves
    }

    constructor(address rail_) {
        rail = IDebitRail(rail_);
    }

    // ── debtorView ────────────────────────────────────────────────────────────

    /// @notice Returns all mandates for a debtor, each with its full collection history.
    function debtorView(address debtor)
        external view
        returns (MandateView[] memory views)
    {
        bytes32[] memory mids = rail.mandatesOfDebtor(debtor);
        views = new MandateView[](mids.length);
        for (uint256 i; i < mids.length; i++) {
            views[i] = _buildMandateView(mids[i]);
        }
    }

    // ── creditorView ──────────────────────────────────────────────────────────

    /// @notice Returns a paginated slice of a creditor's mandates with their collections.
    /// @param creditorId  The creditor to query.
    /// @param offset      Zero-based index of the first item to return.
    /// @param limit       Maximum number of items (0 = all remaining).
    /// @return views      The paginated slice.
    /// @return total      Total mandate count for this creditor.
    function creditorView(uint256 creditorId, uint256 offset, uint256 limit)
        external view
        returns (MandateView[] memory views, uint256 total)
    {
        bytes32[] memory mids = rail.mandatesOfCreditor(creditorId);
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

    // ── coverageView ──────────────────────────────────────────────────────────

    /// @notice Returns EURC and USDC coverage for a creditor in one call.
    /// @dev    rail.eurc() / rail.usdc() are exposed as immutables on DebitRail but not on IDebitRail.
    ///         We call them via a low-level selector to avoid coupling RailLens to the concrete type.
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

    /// @notice Returns invariant health for both tokens.
    ///   i1: balance >= accounted sum (no shortfall).
    ///   i2: exposureTotal == lockedTotal + held (CORE accounting consistency).
    ///   i3: lockedTotal <= reserves (no lock can exceed total reserve).
    ///   surplus: how much above the accounted sum the contract holds (donations).
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

    function _buildMandateView(bytes32 mid)
        internal view
        returns (MandateView memory v)
    {
        v.id      = mid;
        v.mandate = rail.getMandate(mid);

        bytes32[] memory cids = rail.collectionsOfMandate(mid);
        v.collections = new Collection[](cids.length);
        for (uint256 j; j < cids.length; j++) {
            v.collections[j] = rail.getCollection(cids[j]);
        }
    }

    /// @dev Call a zero-argument function that returns an address, e.g. eurc() or usdc().
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
