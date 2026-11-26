// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IHolderLedgerV2, IHolderTokenHistoryV2, HolderLedgerLimitsV2 as H} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// @dev TEST ONLY optional-call helper: full cap or skip, no return/revert-data copy.
library M2OptionalCall {
    /// @dev Fixture continuation reserve for isolated payouts; production measurements belong to M2-60.
    uint256 internal constant PAYOUT_RESERVE_GAS = 200_000;
    function run(address target, bytes memory data, uint256 cap, uint256 reserve) internal returns (bool ok) {
        if (target == address(0) || gasleft() < cap + cap / 63 + reserve + 20_000) return false;
        assembly ("memory-safe") { ok := call(cap, target, 0, add(data, 32), mload(data), 0, 0) }
    }
}

/// @dev TEST ONLY token/history double. Owner supplies excluded fixed roles before mint and wires ledger once.
/// Owner-only mint, callback fault switches and burn refusal are fixture controls, not production selectors.
contract LedgerTokenMock is IHolderTokenHistoryV2 {
    struct Point { uint256 at; uint256 value; }
    address private immutable owner = msg.sender;
    address public ledger;
    address public callbackTarget;
    bool public skipCallbacks;
    bool public refuseBurn;
    uint256 public totalSupply;
    uint256 public holderCheckpoint;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public excluded;
    mapping(address => bool) private eligible;
    address[] private holders;
    mapping(address => Point[]) private history;
    Point[] private supplies;
    uint256 private supply;
    modifier upstream() { require(msg.sender == owner, "fixture owner"); _; }
    constructor(address[] memory systems) {
        excluded[address(0)] = true; excluded[address(this)] = true;
        for (uint256 i; i < systems.length; ++i) excluded[systems[i]] = true;
    }
    function wire(address target) external upstream { require(ledger == address(0)); ledger = target; callbackTarget = target; }
    function setCallbackTarget(address target) external upstream { callbackTarget = target; }
    function setSkipCallbacks(bool value) external upstream { skipCallbacks = value; }
    function setRefuseBurn(bool value) external upstream { refuseBurn = value; }
    function mint(address to, uint256 amount) external upstream { _move(address(0), to, amount); }
    function burn(uint256 amount) external { require(!refuseBurn, "burn refused"); _move(msg.sender, address(0), amount); }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { require(to != address(0)); _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(to != address(0));
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        _move(from, to, amount); return true;
    }
    function wallet(address who) public view returns (bool) {
        bytes memory code = who.code;
        return code.length == 0 || (code.length == 23 && bytes3(code) == hex"ef0100");
    }
    function _enable(address who) private {
        if (eligible[who] || excluded[who]) return;
        eligible[who] = true; holders.push(who); supply += balanceOf[who];
    }
    function _move(address from, address to, uint256 amount) private {
        if (from != address(0)) require(balanceOf[from] >= amount, "balance");
        if (from == to || amount == 0) return;
        // Auto-eligibility is classified at FIRST receipt only, never reclassified after a code change.
        if (history[to].length == 0 && wallet(to)) _enable(to);
        if (from == address(0)) totalSupply += amount; else balanceOf[from] -= amount;
        if (to == address(0)) totalSupply -= amount; else balanceOf[to] += amount;
        if (eligible[from]) supply -= amount;
        if (eligible[to]) supply += amount;
        ++holderCheckpoint; _write(from); _write(to); supplies.push(Point(holderCheckpoint, supply));
        if (!skipCallbacks) M2OptionalCall.run(callbackTarget,
            abi.encodeCall(IHolderLedgerV2.onTokenCheckpoint, (holderCheckpoint, from, to)),
            C.TOKEN_SETTLEMENT_GAS, H.TOKEN_SETTLEMENT_RESERVE_GAS);
    }
    function _write(address who) private { history[who].push(Point(holderCheckpoint, eligible[who] ? balanceOf[who] : 0)); }
    function registerHolder(address who) external {
        require(msg.sender == ledger && !excluded[who], "registration");
        if (eligible[who]) return;
        _enable(who); ++holderCheckpoint; _write(who); supplies.push(Point(holderCheckpoint, supply));
    }
    function _at(Point[] storage points, uint256 at) private view returns (uint256) {
        require(at <= holderCheckpoint, "future"); uint256 lo; uint256 hi = points.length;
        while (lo < hi) { uint256 mid = (lo + hi) / 2; if (points[mid].at <= at) lo = mid + 1; else hi = mid; }
        return lo == 0 ? 0 : points[lo - 1].value;
    }
    function eligibleBalanceAt(address who, uint256 at) external view returns (uint256) { return _at(history[who], at); }
    function eligibleSupplyAt(uint256 at) external view returns (uint256) { return _at(supplies, at); }
    function holderCount() external view returns (uint256) { return holders.length; }
    function holderAt(uint256 i) external view returns (address) { return holders[i]; }
}

/// @dev TEST ONLY: configurable successful, reverting, full-stipend and large-revert-data callback targets.
contract HostileLedger {
    uint8 public mode; uint256 public calls;
    function setMode(uint8 value) external { mode = value; }
    fallback() external {
        if (mode == 1) revert("ledger refused");
        if (mode == 2) { assembly ("memory-safe") { for {} 1 {} {} } }
        if (mode == 3) { assembly ("memory-safe") { revert(0, 65536) } }
        ++calls;
    }
}
