// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice ERC-20 that returns `false` from transfer/transferFrom instead of reverting.
///         Used to test that _pushToken credits claimable on a false return.
contract MockReturnFalseToken is ERC20, ERC20Permit {
    constructor() ERC20("ReturnFalse", "RFF") ERC20Permit("ReturnFalse") {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    /// @dev Always returns false (never reverts) — used to test _pushToken fallback.
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    /// @dev Normal transferFrom so the rail can receive tokens via safeTransferFrom.
    ///      Only transfer() returns false; transferFrom works normally.
    function transferFrom(address from, address to, uint256 amount)
        public override returns (bool)
    {
        return super.transferFrom(from, to, amount);
    }
}
