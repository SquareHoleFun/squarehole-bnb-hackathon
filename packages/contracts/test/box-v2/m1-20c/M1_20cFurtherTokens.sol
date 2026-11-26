// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";

// TEST ONLY (M1-20-c, the implementer's further tests; `docs/evidence/SH-V2-M1-20C.md`). Tokens and helpers the red
// tests' files do not cover: answers outside ERC-20's happy path, a token that refuses one direction only, a slow
// `initialHolder()`, a registry that does not answer, and a gas finder for the holder read's cap.

/// @notice An exact token with a free `mint`; the tokens below change one thing each.
abstract contract KitBaseToken {
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external view virtual returns (uint256) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _spend(address from, uint256 amount) internal {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @notice USDT's shape: `transfer` and `transferFrom` answer nothing, and move exactly.
contract KitNoReturnToken is KitBaseToken {
    function decimals() external pure override returns (uint256) {
        return 6;
    }

    function transfer(address to, uint256 amount) external {
        _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external {
        _spend(from, amount);
        _move(from, to, amount);
    }
}

/// @notice Answers false and moves nothing.
contract KitFalseToken is KitBaseToken {
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @notice An exact token but for one sender: `stuck` cannot send it, or `taxed` pays `feeBps` (burned) on what it
/// sends. Set on the PoolManager, each refuses only the way out of it.
contract KitOneWayToken is KitBaseToken {
    error CannotSend(address from);

    address public stuck;
    address public taxed;
    uint256 public feeBps;

    function setStuck(address account) external {
        stuck = account;
    }

    function setTaxed(address account, uint256 bps) external {
        (taxed, feeBps) = (account, bps);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spend(from, amount);
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal override {
        if (from == stuck) revert CannotSend(from);
        uint256 fee = from == taxed ? amount * feeBps / 10_000 : 0;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
    }
}

/// @notice `decimals()` answers 18 as two words (`LONG`) or 256 in one (`WIDE`); ERC-20's `uint8` fits neither.
contract KitOddDecimalsToken is KitBaseToken {
    bool public immutable long;

    constructor(bool long_) {
        long = long_;
    }

    function decimals() external view override returns (uint256) {
        if (!long) return 256;
        assembly ("memory-safe") {
            mstore(0, 18)
            mstore(32, 0)
            return(0, 64)
        }
    }
}

/// @notice A registry at the ERC-1820 address whose every call reverts.
contract KitRevertingRegistry {
    fallback() external {
        revert("no answer");
    }
}

/// @notice Counts calls: a token's callback during the probe bumps it, and the probe's revert takes the bump back.
contract KitCounter {
    uint256 public count;

    function bump() external {
        ++count;
    }
}

/// @notice An exact token whose `initialHolder()` spends `burn` gas before it names `holder` cleanly; handed less, it
/// runs out of gas, as a real read starved below its need does.
contract KitSlowHolderToken is KitBaseToken {
    address public immutable holder;
    uint256 public immutable burn;

    constructor(address holder_, uint256 burn_) {
        (holder, burn) = (holder_, burn_);
    }

    function initialHolder() external view returns (address) {
        uint256 start = gasleft();
        while (start - gasleft() < burn) {}
        return holder;
    }
}

/// @notice Whether `initialHolder()` answers one word when handed exactly `gasCap` (the holder read's own call).
contract KitHolderGasFinder {
    function reads(address token, uint256 gasCap) external view returns (bool ok) {
        bytes4 selector = IBoxToken.initialHolder.selector;
        assembly ("memory-safe") {
            mstore(0, selector)
            ok := staticcall(gasCap, token, 0, 4, 0, 32)
            // A second statement: Yul evaluates arguments right to left, so one expression would read the old size.
            ok := and(ok, eq(returndatasize(), 32))
        }
    }
}
