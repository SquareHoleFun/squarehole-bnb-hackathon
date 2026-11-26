// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/// @dev Reference for ordered one-item pages, seed funding, gate and custody disposition.
/// Approval and receipt counters stand for a successful T pull; no ERC-20/721 deployment claim.
contract ShopModel {
    address immutable creator;
    address immutable loader;
    uint256 immutable committedSeed;
    uint256 receivedSeed;
    uint256 seedAllowance;
    uint256 liquid;
    uint256 claims;
    bool chunks;
    bool failed;
    bool committed;
    bool completed;
    bytes32 remaining;
    uint32 count;
    mapping(uint256 => bool) seen;
    bool public open;
    uint256 public loaded;
    uint256 public excluded;
    address public returnedTo;
    uint256 public returnedT; // Must stay zero, including after a successful burn.
    uint256 returned;
    modifier onlyLoader() { require(msg.sender == loader, "loader"); _; }
    constructor(address c, address l, uint256 seed) { creator = c; loader = l; committedSeed = seed; }
    /// @dev Fixed creator only: model the approval given to the shop on T, without moving funds.
    function approveSeed(uint256 amount) external {
        require(msg.sender == creator, "creator"); seedAllowance = amount;
    }
    /// @dev Anyone pulls exactly the approved commitment once, before completion/failure.
    function fundSeed() external {
        require(!failed && !completed && !seedReady(), "phase");
        require(seedAllowance >= committedSeed, "approval");
        seedAllowance -= committedSeed; receivedSeed = committedSeed; liquid += committedSeed;
    }
    function seedReady() public view returns (bool) { return receivedSeed == committedSeed; }
    function budgetT() external view returns (uint256) { return failed ? 0 : liquid; }
    function commit(bytes32 root, uint32 n) external onlyLoader {
        require(!failed && !committed && (n == 0) == (root == 0), "commit");
        committed = true; remaining = root; count = n;
    }
    function chunksReady() external onlyLoader { require(!failed); chunks = true; open = completed; }
    function load(uint256 id, bytes32 next) external onlyLoader {
        require(committed && !failed && !completed && loaded < count && !seen[id], "phase/duplicate");
        require(remaining == keccak256(abi.encode(address(0x721), id, uint8(0), next)), "hash");
        require(loaded + 1 != count || next == 0, "terminal");
        seen[id] = true; remaining = next; ++loaded;
    }
    /// @dev Anyone completes the loader; this abstracts its authenticated coordinator notification.
    /// Chunks may finish before or after notification, but neither path can reopen a failed shop.
    function complete() external {
        require(!failed && !completed, "phase");
        require(committed && loaded == count && remaining == 0, "set");
        require(seedReady(), "seed");
        completed = true; open = chunks;
    }
    function addClaims(uint256 amount) external onlyLoader { require(!failed); claims += amount; }
    function fail() external onlyLoader { require(!failed); failed = true; open = false; excluded = liquid + claims; }
    function returnItems() external returns (uint256 amount) {
        require(failed, "phase"); amount = loaded - returned; returned = loaded; returnedTo = creator;
    }
    function burn(bool succeeds) external returns (uint256 amount) {
        require(failed, "phase"); if (!succeeds) return 0;
        amount = excluded; liquid = 0; claims = 0; excluded = 0;
    }
}
