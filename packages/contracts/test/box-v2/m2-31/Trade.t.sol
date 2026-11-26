// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {TokenCoordinator, LedgerProbe, BoxClones, BoxTokenV2Args, IBoxTokenV2, IHolderTokenHistoryV2} from "./Fixture.sol";
import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {CQATrader} from "../cq11-a/Fixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {BoxHookV2Args as A} from "../../../src/box-v2/libraries/BoxHookV2Args.sol";
import {IBoxHookV2, TradeBatchV2, IBoxHolderBatchNoticeV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";

import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

contract TradeCoordinator is TokenCoordinator {
    uint256 public effectiveOpenAt;
    uint256 public deadline;
    bool public gateOpen;
    function setGate(uint256 at) external { effectiveOpenAt = at; deadline = at + 30 days; gateOpen = true; }
}
// Gas probe with an actual fresh wallet recipient, including automatic enumeration/history writes.
contract WalletDriver {
    IPoolManager immutable pm;
    address immutable recipient;
    constructor(IPoolManager manager, address to) { pm = manager; recipient = to; }
    function buy(PoolKey memory key, uint256 amount, uint160 limit) external {
        pm.unlock(abi.encode(key, amount, limit));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (PoolKey memory key, uint256 amount, uint160 limit) = abi.decode(data, (PoolKey, uint256, uint160));
        BalanceDelta d = pm.swap(key, SwapParams(true, -int256(amount), limit), "");
        pm.settle{value: uint256(-int256(d.amount0()))}();
        pm.take(key.currency1, recipient, uint256(int256(d.amount1())));
        return "";
    }
}
contract LedgerTradeTest is Test {
    IPoolManager internal pm;
    TradeCoordinator internal c;
    IBoxTokenV2 internal t;
    IHolderTokenHistoryV2 internal history;
    IBoxHookV2 internal hook;
    LedgerProbe internal ledger;
    CQATrader internal trader;
    CQATrader internal router;
    CQATrader internal receiver;
    BoxLayoutV2.Curve internal layout;
    PoolKey internal key;
    WalletDriver internal gasTrader;
    address internal tokenImpl;
    uint256 internal RAISE = 4_206980085e9;
    function setUp() public {
        vm.warp(1_000_000); vm.roll(100);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        trader = new CQATrader(pm); router = new CQATrader(pm); receiver = new CQATrader(pm);
        ledger = new LedgerProbe();
        address ci = address(new TradeCoordinator());
        c = TradeCoordinator(BoxClones.create(BoxClones.initCode(ci, ""))); c.setGate(block.timestamp + 10);
        address ti = deployCode("BoxTokenV2Ledger.sol:BoxTokenV2Ledger", abi.encode(ci));
        tokenImpl = ti;
        t = IBoxTokenV2(BoxClones.create(BoxClones.initCode(ti,
            BoxTokenV2Args.encode(address(c), address(0), address(ledger), BoxSpecV1.ISSUANCE, "T", "T"))));
        history = IHolderTokenHistoryV2(address(t)); layout = BoxLayoutV2.curve(RAISE, false);
        A.Args memory a;
        a.token = address(t); a.sqrtP1 = layout.sqrtPriceEndX96; a.sqrtP0 = layout.sqrtPriceStartX96;
        a.launchRouter = address(router); a.kind = 2; a.tickLower = layout.tickLower; a.tickUpper = layout.tickUpper;
        a.liquidity = layout.liquidity; a.raise = RAISE; a.coordinator = address(c); a.receiver = address(receiver);
        a.tipMaxQ = RAISE / 100; a.stepMinQ = RAISE / 100000;
        address ext = deployCode("BoxHookV2Extension.sol:BoxHookV2Extension", abi.encode(pm));
        address hi = deployCode("BoxHookV2.sol:BoxHookV2", abi.encode(pm, ci, ext));
        uint160 middle = uint160(uint256(keccak256(abi.encode(c)))) & ((uint160(1) << 152) - 1);
        hook = IBoxHookV2(address((uint160(0x55) << 152) | (middle & ~uint160(0x3fff)) | 0x2ae0));
        vm.etch(address(hook), BoxClones.runtime(hi, bytes.concat(A.encode(a), abi.encodePacked(address(ledger)))));
        c.wire(address(pm), 0, address(c)); c.wire(address(pm), 1, address(t));
        c.wire(address(pm), 2, address(hook)); c.wire(address(pm), 5, address(receiver));
        c.wire(address(pm), 6, address(router)); c.wire(address(pm), 17, address(ledger));
        ledger.wire(address(t), address(hook));
        vm.startPrank(address(c)); t.initialize(); t.approve(address(hook), type(uint256).max);
        hook.initialize(); hook.launch(); vm.stopPrank();
        key = hook.poolKey();
        vm.deal(address(trader), RAISE * 10); vm.deal(address(router), RAISE); vm.deal(address(receiver), RAISE);
    }
    function _open() internal { vm.warp(c.effectiveOpenAt() + 384); vm.roll(block.number + 1); }
    function _buy() internal returns (BalanceDelta) {
        return trader.trade(key, true, -int256(RAISE / 10), layout.sqrtPriceEndX96);
    }
    function test_fourKindsSnapshotBeforeSettlementAndWeights() public {
        _open(); _buy();
        assertEq(ledger.supply(), 0, "first receipt cannot earn its own buy");
        assertEq(ledger.count(), 0, "ordinary contract has not registered");
        vm.prank(address(trader)); ledger.register();
        for (uint256 i; i < 4; ++i) {
            bool buy = i < 2; bool exactOut = i % 2 == 1;
            uint256 amount = buy ? (exactOut ? t.balanceOf(address(trader)) / 10 : RAISE / 100)
                : (exactOut ? RAISE / 10000 : t.balanceOf(address(trader)) / 100);
            uint256 cp = history.holderCheckpoint(); uint256 bal = t.balanceOf(address(trader));
            TradeBatchV2 memory before = hook.tradeBatch(buy ? 1 : 2);
            BalanceDelta d = trader.trade(key, buy, exactOut ? int256(amount) : -int256(amount),
                buy ? layout.sqrtPriceEndX96 : layout.sqrtPriceStartX96);
            assertEq(ledger.at(), cp); assertEq(ledger.supply(), bal); assertEq(ledger.count(), 1);
            assertEq(history.eligibleBalanceAt(address(trader), cp), bal);
            uint256 units = buy ? (uint256(-int256(d.amount0())) + 99) / 100
                : (uint256(-int256(d.amount1())) + 99) / 100;
            assertEq(ledger.weight(), units); assertEq(ledger.batch(), buy ? 1 : 2);
            assertEq(hook.tradeBatch(buy ? 1 : 2).tradeUnits, before.tradeUnits + units);
        }
    }
    function test_protocolTradesHaveNoHolderNotice() public {
        router.trade(key, true, -int256(RAISE / 10000), layout.sqrtPriceEndX96);
        assertEq(ledger.notices(), 0); assertGt(hook.tradeBatch(1).protocolUnits, 0);
        router.trade(key, true, -int256(RAISE / 1000), layout.sqrtPriceEndX96);
        assertEq(ledger.notices(), 1, "creator buy is user money");
        _open(); trader.trade(key, true, -int256(RAISE * 2), layout.sqrtPriceEndX96);
        vm.prank(address(c)); hook.migrate(layout.poolShare);
        assertTrue(hook.tradeBatch(1).closed); assertTrue(hook.tradeBatch(2).closed);
        uint256 n = ledger.notices(); vm.roll(block.number + 1);
        receiver.trade(key, true, -int256(RAISE / 1000), uint160(1 << 80));
        vm.roll(block.number + 1); hook.deepen(address(0));
        assertEq(ledger.notices(), n); assertGt(hook.tradeBatch(3).protocolUnits, 0);
        assertEq(hook.tradeBatch(3).tradeUnits, 0);
    }
    function test_hostileNoticesKeepDenominatorAndBothSidesClose() public {
        _open();
        for (uint256 mode = 1; mode <= 3; ++mode) {
            ledger.setMode(mode); _buy();
            trader.trade(key, false, -int256(t.balanceOf(address(trader)) / 10), layout.sqrtPriceStartX96);
        }
        assertEq(ledger.notices(), 0); assertGt(hook.tradeBatch(1).tradeUnits, 0);
        assertGt(hook.tradeBatch(2).tradeUnits, 0); assertEq(hook.tradeBatch(2).netP, 0, "curve sales accrue T");
        receiver.harvest(hook); assertTrue(hook.tradeBatch(1).closed); assertTrue(hook.tradeBatch(2).closed);
        assertEq(hook.currentTradeBatch(true), 3);
        _buy(); vm.prank(address(c)); hook.close();
        assertTrue(hook.tradeBatch(3).closed); assertTrue(hook.tradeBatch(4).closed);
    }
    function test_absentHookLedgerDoesNotRecordOrNotify() public {
        bytes memory code = address(hook).code;
        assembly ("memory-safe") { mstore(code, sub(mload(code), 20)) }
        vm.etch(address(hook), code); _open(); _buy();
        assertEq(ledger.notices(), 0); assertEq(hook.currentTradeBatch(true), 0);
        assertEq(hook.tradeBatch(1).tradeUnits, 0); receiver.harvest(hook);
        assertFalse(hook.tradeBatch(1).closed);
    }
    function test_noticeActivationCannotBreakFreshTokenSettlement() public {
        _open(); _assertNoticeBoundary(RAISE / 10);
    }
    function test_feeCheckpointNoticeStillLeavesWalletHistoryGas() public {
        RAISE = 340282366920938463376658674914100925496; setUp(); _open();
        bool ready;
        for (uint256 i; i < 128; ++i) {
            uint256 saved = vm.snapshotState();
            BalanceDelta bought = trader.trade(key, true, -int256(RAISE / 4), layout.sqrtPriceEndX96);
            if (hook.tradeBatch(1).netP != 0) { assertTrue(vm.revertToState(saved)); ready = true; break; }
            trader.trade(key, false, -int256(bought.amount1()), layout.sqrtPriceStartX96);
        }
        assertTrue(ready, "next buy must checkpoint backed fees");
        _assertNoticeBoundary(RAISE / 4);
        assertGt(hook.tradeBatch(1).netP, 0);
    }
    function _assertNoticeBoundary(uint256 amount) private {
        ledger.setMode(2);
        uint256 previousUnits = hook.tradeBatch(1).tradeUnits;
        gasTrader = new WalletDriver(pm, address(0xa11ce)); vm.deal(address(gasTrader), RAISE);
        bytes memory data = abi.encodeCall(WalletDriver.buy, (key, amount, layout.sqrtPriceEndX96));
        bool succeeded; uint256 lastSkip; uint256 firstCall; bytes32 settled;
        for (uint256 gasLimit = 200000; gasLimit <= 6000000; gasLimit += 50000) {
            uint256 saved = vm.snapshotState();
            (bool ok, bool called) = this.attempt(data, gasLimit);
            if (succeeded && !ok) emit log_named_uint("unsafe notice gas", gasLimit);
            assertFalse(succeeded && !ok, "more gas broke settlement");
            assertFalse(called && !ok, "notice consumed mandatory history gas");
            if (ok) {
                bytes32 observed = keccak256(abi.encode(hook.tradeBatch(1), address(gasTrader).balance,
                    t.balanceOf(address(pm)), t.balanceOf(address(0xa11ce)), history.holderCheckpoint()));
                if (succeeded) assertEq(observed, settled); else settled = observed;
                succeeded = true; assertEq(hook.tradeBatch(1).tradeUnits, previousUnits + (amount + 99) / 100);
                assertGt(t.balanceOf(address(0xa11ce)), 0);
                assertEq(history.holderCount(), 1);
                assertEq(history.eligibleSupplyAt(history.holderCheckpoint()), t.balanceOf(address(0xa11ce)));
                if (!called) lastSkip = gasLimit;
            }
            if (called && firstCall == 0) firstCall = gasLimit;
            assertTrue(vm.revertToState(saved));
        }
        assertGt(lastSkip, 0); assertGt(firstCall, lastSkip);
        while (firstCall - lastSkip > 1) {
            uint256 mid = (firstCall + lastSkip) / 2; uint256 saved = vm.snapshotState();
            (bool ok, bool called) = this.attempt(data, mid); assertTrue(ok, "activation boundary");
            if (called) firstCall = mid; else lastSkip = mid;
            assertTrue(vm.revertToState(saved));
        }
        emit log_named_uint("hook notice activation gas with ledger token", firstCall);
        vm.expectCall(address(ledger), 0, uint64(C.HOLDER_NOTICE_GAS),
            abi.encodeWithSelector(IBoxHolderBatchNoticeV2.onTradeFeeBatch.selector), uint64(1));
        (bool ok, bool called) = this.attempt(data, firstCall); assertTrue(ok && called);
    }
    function attempt(bytes calldata data, uint256 gasLimit) external returns (bool ok, bool called) {
        vm.cool(tokenImpl); vm.cool(address(t)); vm.cool(address(hook)); vm.cool(address(pm)); vm.cool(address(ledger)); vm.cool(address(gasTrader));
        vm.startStateDiffRecording(); (ok,) = address(gasTrader).call{gas: gasLimit}(data);
        VmSafe.AccountAccess[] memory calls = vm.stopAndReturnStateDiff();
        for (uint256 i; i < calls.length; ++i) if (calls[i].account == address(ledger)
            && calls[i].kind == VmSafe.AccountAccessKind.Call && calls[i].accessor == address(hook)) called = true;
    }
}
