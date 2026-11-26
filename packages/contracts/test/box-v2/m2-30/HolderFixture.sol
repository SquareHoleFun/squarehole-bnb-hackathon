// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {IHolderLedgerV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {TradeBatchV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {M2SeamArgs} from "../../../src/box-v2/libraries/M2SeamArgs.sol";
import {HolderModel} from "../m2-00/HolderModel.sol";

// Independent snapshot fixture: intentionally copies all balances; production token uses binary-search history.
contract HistoryFixture {
    uint256 public holderCheckpoint;
    address public ledger;
    address[] public holders;
    mapping(address => bool) private seen;
    mapping(address => bool) private eligible;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => uint256) public eligibleSupplyAt;
    mapping(address => mapping(uint256 => uint256)) private snapshots;
    bool public refuseHistory;
    address constant SYSTEM = address(0x5151);
    constructor() { balanceOf[SYSTEM] = type(uint128).max; }
    function wire(address l) external { ledger = l; }
    function broken(bool b) external { refuseHistory = b; }
    function move(address from, address to, uint256 n, bool hint) external {
        if (n == 0 || from == to) return;
        balanceOf[from] -= n; balanceOf[to] += n;
        if (!seen[to] && to != SYSTEM) {
            seen[to] = true; holders.push(to);
            bytes memory code = to.code;
            eligible[to] = code.length == 0 || (code.length == 23 && bytes3(code) == hex"ef0100");
        }
        _snapshot();
        if (hint) IHolderLedgerV2(ledger).onTokenCheckpoint(holderCheckpoint, from, to);
    }
    function registerHolder(address h) external {
        require(msg.sender == ledger && h != SYSTEM, "register");
        if (eligible[h]) return;
        if (!seen[h]) { seen[h] = true; holders.push(h); }
        eligible[h] = true; _snapshot();
    }
    function _snapshot() private {
        ++holderCheckpoint;
        for (uint256 i; i < holders.length; ++i) {
            address h = holders[i]; uint256 n = eligible[h] ? balanceOf[h] : 0;
            snapshots[h][holderCheckpoint] = n; eligibleSupplyAt[holderCheckpoint] += n;
        }
    }
    function holderCount() external view returns (uint256) { return holders.length; }
    function holderAt(uint256 i) external view returns (address) { return holders[i]; }
    function eligibleBalanceAt(address h, uint256 c) external view returns (uint256) {
        require(!refuseHistory && c <= holderCheckpoint, "history"); return snapshots[h][c];
    }
}
contract BatchHookFixture {
    uint256 public tradeBatchTotalP;
    mapping(uint256 => TradeBatchV2) private batches;
    address public ledger;
    uint256 public pair;
    function wire(address l) external { ledger = l; }
    function currentTradeBatch(bool buy) external view returns (uint256) { return pair * 2 + (buy ? 1 : 2); }
    function tradeBatch(uint256 id) external view returns (TradeBatchV2 memory) { return batches[id]; }
    function trade(uint256 id, uint256 units, bool protocol, bool notice) external {
        if (protocol) batches[id].protocolUnits += units;
        else {
            batches[id].tradeUnits += units;
            if (notice) IHolderLedgerV2(ledger).onTradeFeeBatch(id, address(0xBAD), id % 2 == 1, units);
        }
    }
    function receipt(uint256 id, uint256 net, bool closed) external {
        tradeBatchTotalP = tradeBatchTotalP + net - batches[id].netP;
        batches[id].netP = net; batches[id].closed = closed;
    }
    function harvest() external returns (uint256, uint256, uint256) {
        batches[2 * pair + 1].closed = true; batches[2 * pair + 2].closed = true; ++pair;
        return (0, 0, 0);
    }
}
contract FundingFixture {
    mapping(uint256 => uint256) public holderBatchPaid;
    mapping(uint256 => bool) public holderBatchClosed;
    function close(uint256 id, uint256 n) external { holderBatchPaid[id] = n; holderBatchClosed[id] = true; }
}
contract PhaseFixture {
    bool public failed;
    bool public graduated;
    function fail() external { failed = true; }
}
contract ContractHolderFixture { receive() external payable {} }
contract RefusingHolderTip { receive() external payable { revert("tip"); } }

abstract contract HolderFixture is Test {
    IPoolManager internal pm;
    PoolDriver internal driver;
    HostileToken internal p;
    HistoryFixture internal t;
    BatchHookFixture internal hook;
    FundingFixture internal receiver;
    PhaseFixture internal coord;
    IHolderLedgerV2 internal ledger;
    HolderModel internal model;
    address internal constant SYSTEM = address(0x5151);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant PUSHER = address(0xC011EC7);
    function setUp() public virtual {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)))); driver = new PoolDriver(pm);
        p = new HostileToken("P", "P", 6); p.mint(address(driver), 1e36);
        t = new HistoryFixture(); hook = new BatchHookFixture(); coord = new PhaseFixture();
        // Collect threshold bytes remain: F127 self claims must ignore min=100 and tip cap=30.
        bytes memory args = new bytes(263);
        assembly ("memory-safe") { mstore(add(add(args, 32), 172), shl(128, 100)) mstore(add(add(args, 32), 188), shl(128, 30)) }
        receiver = FundingFixture(BoxClones.create(BoxClones.initCode(address(new FundingFixture()), args)));
        address code = deployCode("out/HolderLedgerV2.sol/HolderLedgerV2.json", abi.encode(pm));
        ledger = IHolderLedgerV2(BoxClones.create(BoxClones.initCode(code,
            M2SeamArgs.holder(address(coord), address(t), address(hook), address(receiver), address(p)))));
        t.wire(address(ledger)); hook.wire(address(ledger)); model = new HolderModel(SYSTEM);
    }
    function _move(address from, address to, uint256 n, bool hint) internal {
        t.move(from, to, n, hint); model.move(from, to, n, hint);
    }
    function _trade(uint256 id, uint256 n, bool protocol, bool notice) internal {
        hook.trade(id, n, protocol, notice); model.trade(id, n, protocol, notice);
    }
    function _close(uint256 id, uint256 n) internal {
        hook.receipt(id, n * 2, true); receiver.close(id, n);
        driver.mintClaims(Currency.wrap(address(p)), address(ledger), n); model.close(id, n);
    }
    function _settle(uint256 id, uint256 steps) internal returns (bool done) {
        done = ledger.settleBatch(id, steps); model.settle(id, steps);
        (bool complete, uint256 hc, uint256 nc, uint256 residue) = ledger.batchState(id);
        assertEq(complete, model.finalized(id)); assertEq(residue, model.residue(id));
        if (!complete) { assertEq(ledger.claimable(id, ALICE), 0); assertLt(nc, 100); assertLt(hc, 100); }
        else {
            assertEq(ledger.claimable(id, ALICE), model.credit(id, ALICE));
            assertEq(ledger.claimable(id, BOB), model.credit(id, BOB));
        }
    }
}
