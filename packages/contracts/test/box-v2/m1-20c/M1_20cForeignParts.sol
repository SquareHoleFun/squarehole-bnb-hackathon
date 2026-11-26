// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IListingChecksHost, ListingChecks} from "../../../src/box-v2/libraries/ListingChecks.sol";

// TEST ONLY (M1-20-c, review round 1; `docs/evidence/SH-V2-M1-20C.md`). Tokens and a host that make the transfer
// probe meet revert data it did not write: a delta left in the PoolManager (`CurrencyNotSettled`), a Panic, a token
// that tells the PoolManager other balances than it tells the host, short answers, and a host whose
// `probeTransfers` answers whatever a test sets.

/// @notice An exact token whose `balanceOf` a token below may change; a free `mint`.
abstract contract KitViewToken {
    uint256 public totalSupply;
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) public allowance;

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function balanceOf(address account) external view virtual returns (uint256) {
        return _balances[account];
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        _balances[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        _balances[from] -= amount;
        _balances[to] += amount;
    }
}

/// @notice Armed, its `transfer` into the PoolManager also mints itself one ERC-6909 unit there, a debt nobody pays,
/// so the probe's `unlock` reverts `CurrencyNotSettled()`. Every balance moves exactly.
contract KitDeltaToken is KitViewToken {
    IPoolManager public immutable pm;
    bool public armed;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function arm(bool on) external {
        armed = on;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _move(msg.sender, to, amount);
        if (armed && to == address(pm)) pm.mint(address(this), uint256(uint160(address(this))), 1);
        return true;
    }
}

/// @notice `balanceOf(huge)` answers `type(uint256).max`, so the probe's `before + amount` overflows (a Panic).
contract KitHugeBalanceToken is KitViewToken {
    address public huge;

    function setHuge(address account) external {
        huge = account;
    }

    function balanceOf(address account) external view override returns (uint256) {
        return account == huge ? type(uint256).max : _balances[account];
    }
}

/// @notice Tells the PoolManager other balances than everyone else: its reads revert (`sync` fails), or answer twice
/// the balance (`settle` pays twice the amount). The host's reads see the true, exact balances.
contract KitTwoFacedToken is KitViewToken {
    error NotForThePoolManager();

    address public immutable pm;
    bool public immutable reverts;

    constructor(address pm_, bool reverts_) {
        (pm, reverts) = (pm_, reverts_);
    }

    function balanceOf(address account) external view override returns (uint256) {
        if (msg.sender != pm) return _balances[account];
        if (reverts) revert NotForThePoolManager();
        return 2 * _balances[account];
    }
}

/// @notice Moves exactly, then answers `length` bytes (1-31), the first 0x01: neither nothing nor one word. To the
/// PoolManager alone it answers true, so its own transfer check (v4's `CurrencyLibrary.transfer`) cannot refuse it
/// first and only the probe's reading of the answer is left.
contract KitShortAnswerToken is KitViewToken {
    address public immutable pm;
    uint256 public immutable length;

    constructor(address pm_, uint256 length_) {
        (pm, length) = (pm_, length_);
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _move(msg.sender, to, amount);
        if (msg.sender != pm) _answer();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        if (msg.sender != pm) _answer();
        return true;
    }

    function _answer() private view {
        uint256 n = length;
        assembly ("memory-safe") {
            mstore(0, 0)
            mstore8(0, 1)
            return(0, n)
        }
    }
}

/// @notice A host whose `probeTransfers` answers what a test set: it returns, or reverts with `answer`, raw. Its
/// `checkTransfers` is the library's, so the reading of that answer is the library's own.
contract KitOddHost is IListingChecksHost {
    bool public returnsNormally;
    bytes public answer;

    function setAnswer(bool returnsNormally_, bytes calldata revertData) external {
        (returnsNormally, answer) = (returnsNormally_, revertData);
    }

    function checkTransfers(address token, address funder) external {
        ListingChecks.checkTransfers(token, funder);
    }

    function probeTransfers(address, address) external view {
        if (returnsNormally) return;
        bytes memory data = answer;
        assembly ("memory-safe") {
            revert(add(data, 0x20), mload(data))
        }
    }

    function unlockCallback(bytes calldata) external pure returns (bytes memory) {
        revert("not used");
    }
}
