// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title HostileToken
/// @notice TEST ONLY (M1-03): an ERC-20 whose switches make its transfers fail the ways ADR-0017 names. § 3's listing
/// checks refuse decimals outside 6-18, a fee on transfer and a token only allowed wallets may hold; § 8 counts as a
/// failed attempt any revert inside a step, such as a token paused by its issuer (Ondo, F88), a blocklisted pool or
/// converter (Circle, Paxos) or a fee switched on (PAXG, F83 G1). Every switch is off at deployment, and then the
/// token moves exactly. Switches act on `transfer` and `transferFrom` only; `mint` and `burn` ignore them (the
/// issuer's own moves, and test setup). Anyone may flip a switch. Methods follow `test/utils/MockTokens.sol`.
contract HostileToken {
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error Paused();
    /// A party (sender, receiver or spender, as Circle checks) is on the blocklist.
    error Blocked(address account);
    /// Allowlist-only: a party is not on the allowlist.
    error NotAllowed(address account);
    error FeeTooHigh(uint16 bps);

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    bool public paused;
    /// Fee on transfer, in basis points of the amount, burned: the receiver gets the rest.
    uint16 public feeBps;
    bool public allowlistOnly;
    mapping(address => bool) public blocked;
    mapping(address => bool) public allowed;
    /// Re-entry: after its balances move, the next transfer disarms and calls `reenterTarget` with `reenterData`, as a
    /// token hook would. A call that succeeds runs once. A call that reverts fails the transfer with its revert, and
    /// the disarm rolls back with it, so the token stays armed and every later transfer fails the same way: a
    /// persistent hostile token. A test that wants one failure, then a success, disarms it itself
    /// (`armReentry(address(0), "")`); no state the token writes can survive the revert, so it cannot disarm itself.
    address public reenterTarget;
    bytes public reenterData;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    // ============================================================================================ switches

    function setPaused(bool on) external {
        paused = on;
    }

    function setBlocked(address account, bool on) external {
        blocked[account] = on;
    }

    function setFeeBps(uint16 bps) external {
        if (bps > 10_000) revert FeeTooHigh(bps);
        feeBps = bps;
    }

    function setAllowlistOnly(bool on) external {
        allowlistOnly = on;
    }

    function setAllowed(address account, bool on) external {
        allowed[account] = on;
    }

    function armReentry(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    /// Any value, so a listing check's refusals (5, 19) can be tested beside 6-18.
    function setDecimals(uint8 decimals_) external {
        decimals = decimals_;
    }

    // ============================================================================================ ERC-20

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (blocked[msg.sender]) revert Blocked(msg.sender);
        uint256 allowed_ = allowance[from][msg.sender];
        if (allowed_ != type(uint256).max) allowance[from][msg.sender] = allowed_ - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (paused) revert Paused();
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);
        if (allowlistOnly) {
            if (!allowed[from]) revert NotAllowed(from);
            if (!allowed[to]) revert NotAllowed(to);
        }
        uint256 fee = amount * feeBps / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
        address target = reenterTarget;
        if (target != address(0)) {
            reenterTarget = address(0);
            (bool ok, bytes memory ret) = target.call(reenterData);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }
    }
}
