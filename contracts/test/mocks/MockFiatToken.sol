// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice Mock stablecoin with 6 decimals and a blocklist, mimicking USDC/EURC behaviour.
///         `setBlocked(addr, true)` makes any transfer to or from `addr` revert,
///         exactly as Circle's on-chain blocklist does.
contract MockFiatToken is ERC20, ERC20Permit {
    uint8 private constant DECIMALS = 6;

    mapping(address => bool) private _blocked;

    constructor(string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC20Permit(name_)
    {}

    // ── Admin helpers (unrestricted in tests) ─────────────────────────────────

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocked(address account, bool blocked) external {
        _blocked[account] = blocked;
    }

    // ── Overrides ─────────────────────────────────────────────────────────────

    function decimals() public pure override returns (uint8) {
        return DECIMALS;
    }

    /// @dev Blocklist check on every transfer (including transferFrom).
    function _update(address from, address to, uint256 value) internal override {
        require(!_blocked[from], "MockFiatToken: sender blocked");
        require(!_blocked[to],   "MockFiatToken: recipient blocked");
        super._update(from, to, value);
    }
}
