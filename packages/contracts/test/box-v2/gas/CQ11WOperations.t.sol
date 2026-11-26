// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";
import {GasBudget} from "./GasBudget.sol";
import {M132aBase} from "../m1-32a/M132aBase.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CQAAsset, CQATrader} from "../cq11-a/Fixture.sol";

contract WRefusingTip {
    receive() external payable {
        assembly ("memory-safe") { invalid() }
    }

    function fail(BoxCoordinatorV2 c) external {
        c.fail();
    }
}

contract WForeignCoin is CQAAsset {
    bool public blocked;

    function setBlocked(bool value) external {
        blocked = value;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!blocked, "blocked conversion");
        return super.transfer(to, amount);
    }
}

/// Reports a conservative transaction estimate: cold call delta plus intrinsic calldata gas, no refunds.
/// Setup and salt mining are outside each measured interval. Budgets include at least 25% observed margin.
contract CQ11WOperationsTest is M132aBase {
    BoxCoordinatorV2 internal box;
    BoxReceiverV2 internal receiver;
    IBoxHookV2 internal hook;
    BoxTokenV2 internal token;
    CQATrader internal trader;
    PoolKey internal key;
    BoxLayoutV2.Curve internal curve;

    function setUp() public override {
        super.setUp();
        box = _create(_spec());
        receiver = BoxReceiverV2(box.receiver());
        hook = IBoxHookV2(box.hook());
        token = BoxTokenV2(box.token());
        curve = BoxLayoutV2.curve(box.raise(), false);
        key = hook.poolKey();
        trader = new CQATrader(pm);
        vm.deal(address(trader), 100 ether);
        vm.deal(address(this), 100 ether);
        vm.warp(box.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
    }
    receive() external payable {}

    function _measure(string memory label, address target, bytes memory data, uint256 value, uint256 budget)
        internal
        returns (bytes memory ret)
    {
        assertLe(budget, 16_777_216, "transaction ceiling");
        _coldRelease();
        vm.cool(address(box));
        vm.cool(address(receiver));
        vm.cool(address(hook));
        vm.cool(address(token));
        vm.cool(address(trader));
        vm.cool(target);
        uint256 intrinsic = GasBudget.intrinsic(data);
        uint256 before_ = gasleft();
        bool ok;
        (ok, ret) = target.call{value: value, gas: budget - intrinsic}(data);
        uint256 used = GasBudget.transaction(before_ - gasleft(), data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        }
        emit log_named_uint(label, used);
        assertLe((used * 125 + 99) / 100, budget, "25 percent gas margin");
    }

    function _fill() internal {
        for (uint256 i; i < 5 && !hook.closed(); ++i) {
            trader.trade(key, true, -int256(curve.raise / 4), curve.sqrtPriceEndX96);
        }
        assertTrue(hook.closed());
    }

    function _graduate() internal {
        _fill();
        box.graduate();
        assertTrue(box.graduated());
    }

    function _trade(bool buy, int256 amount, uint160 limit, string memory label) internal {
        _measure(label, address(trader), abi.encodeCall(CQATrader.trade, (key, buy, amount, limit)), 0, 900_000);
    }

    function test_buyAndSaleEachSwapKind() public {
        _trade(true, -int256(0.1 ether), curve.sqrtPriceEndX96, "buy exact in");
        _trade(true, int256(1e22), curve.sqrtPriceEndX96, "buy exact out");
        _trade(false, -int256(1e22), curve.sqrtPriceStartX96, "sale exact in");
        _trade(false, int256(0.001 ether), curve.sqrtPriceStartX96, "sale exact out");
        assertEq(hook.saleFeesPending(), 0, "curve T fees do not mint P");
    }

    function test_graduationAndCollect() public {
        _fill();
        _measure("graduation", address(box), abi.encodeCall(BoxCoordinatorV2.graduate, ()), 0, 9_000_000);
        assertTrue(box.graduated());
        _measure(
            "collect with tip", address(receiver), abi.encodeCall(BoxReceiverV2.collect, (address(0x710))), 0, 5_000_000
        );
        assertLe(receiver.booked(address(0)), pm.balanceOf(address(receiver), 0));
    }

    function test_burnBuybackAndDeepenWithTips() public {
        // Keep this established-keeper case. FINAL2-GAS separately pins first-wallet linked P tips
        // with mandatory ledger history and twice headroom; refusing recipients remain fail-safe.
        vm.deal(address(0x710), 1);
        vm.deal(address(0x711), 1);
        _graduate();
        receiver.collect(address(0));
        uint256 supply = token.totalSupply();
        vm.roll(block.number + 1);
        bytes memory ret = _measure(
            "burn buy-back with tip",
            address(receiver),
            abi.encodeCall(BoxReceiverV2.buyBack, (address(0x710))),
            0,
            8_000_000
        );
        (ProtocolSkip skip, uint256 spent, uint256 bought, uint256 tip) =
            abi.decode(ret, (ProtocolSkip, uint256, uint256, uint256));
        assertEq(uint256(skip), 0);
        assertGt(spent, 0);
        assertGt(bought, 0);
        assertEq(supply - token.totalSupply() + receiver.tBurnPending(), bought);
        assertGt(tip, 0);
        assertLe(tip, spent / 20);
        assertEq(address(0x710).balance, 1 + tip);
        vm.roll(block.number + 1);
        ret = _measure(
            "deepen with tip", address(hook), abi.encodeCall(IBoxHookV2.deepen, (address(0x711))), 0, 8_000_000
        );
        (skip, spent,, tip) = abi.decode(ret, (ProtocolSkip, uint256, uint256, uint256));
        assertEq(uint256(skip), 0);
        assertGt(spent, 0);
        assertGt(tip, 0);
        assertLe(tip, spent / 20);
        assertEq(address(0x711).balance, 1 + tip);
    }

    function test_failureClaimAndLateMoney() public {
        trader.trade(key, true, -int256(0.1 ether), curve.sqrtPriceEndX96);
        vm.warp(box.deadline());
        _measure("fail deadline", address(box), abi.encodeCall(BoxCoordinatorV2.fail, ()), 0, 12_000_000);
        assertTrue(box.failed());
        uint256 t = token.balanceOf(address(trader));
        vm.prank(address(trader));
        token.transfer(address(this), t);
        token.approve(address(box), t);
        _measure("last claim", address(box), abi.encodeCall(BoxCoordinatorV2.claim, (t, address(this))), 0, 8_000_000);
        (, uint256 left) = box.claimState();
        assertEq(left, 0);
        // Return late P through the real royalty intake; after the last claim it stays locked in the pot.
        _measure(
            "late royalty P",
            address(receiver),
            abi.encodeCall(BoxReceiverV2.fundRoyalty, (address(0), 1 ether)),
            1 ether,
            900_000
        );
        (uint256 retained,) = box.claimState();
        assertGe(retained, 1 ether);
    }

    function test_sevenDayHatchWithStipends() public {
        _fill();
        vm.warp(hook.closedAt() + 7 days);
        _measure("seven-day hatch", address(box), abi.encodeCall(BoxCoordinatorV2.fail, ()), 0, 12_000_000);
        assertTrue(box.failed());
        assertEq(C.TIP_GAS, 2_800_000);
        assertEq(C.BURN_GAS, 2_500_000);
        assertEq(C.SWEEP_GAS, 1_600_000);
    }

    function test_RC5_foreignRoyaltyRejectedBeforeCustody() public {
        uint256 beforeBalance = address(receiver).balance;
        (bool ok,) = address(receiver).call(abi.encodeWithSignature("fundRoyalty(address,uint256)", address(0xDEAD), 1));
        assertFalse(ok, "RC5: receiver accepts only P");
        assertEq(address(receiver).balance, beforeBalance);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.settle{value: amount}();
        pm.mint(to, 0, amount);
        return "";
    }

    function test_lateMoneyAfterLastClaimHasNoSweep() public {
        vm.warp(box.deadline());
        box.fail();
        vm.prank(CREATOR);
        box.claim(0, CREATOR);
        pm.unlock(abi.encode(address(box), 1 ether));
        uint256 owed = receiver.fitOwed();
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), owed);
        NoFailureSweep.check(address(box));
    }

    function test_starvedFailureRevertsBeforeAnyMoneyCanBeLost() public {
        vm.warp(box.deadline());
        uint256 supply = token.totalSupply();
        (bool ok,) = address(box).call{gas: 150_000}(abi.encodeCall(BoxCoordinatorV2.fail, ()));
        assertFalse(ok);
        assertFalse(box.failed());
        assertEq(token.totalSupply(), supply);
        _measure(
            "failure retry after starvation", address(box), abi.encodeCall(BoxCoordinatorV2.fail, ()), 0, 12_000_000
        );
        assertTrue(box.failed());
    }

    function test_burnRetryFitsNamedStipendWithMargin() public {
        _graduate();
        receiver.collect(address(0));
        vm.roll(block.number + 1);
        vm.mockCallRevert(address(token), abi.encodeWithSignature("burn(uint256)"), hex"bad0");
        receiver.buyBack(address(0));
        uint256 held = receiver.tBurnPending();
        assertGt(held, 0);
        vm.clearMockedCalls();
        uint256 supply = token.totalSupply();
        _coldRelease();
        vm.cool(address(receiver));
        vm.cool(address(token));
        uint256 before_ = gasleft();
        receiver.burnPending();
        uint256 used = before_ - gasleft();
        emit log_named_uint("complete burn retry", used);
        assertLe(used * 2, 1_000_000, "twice receiver-specific burn allowance");
        assertEq(receiver.tBurnPending(), 0);
        assertEq(supply - token.totalSupply(), held);
    }

    function test_realRoyaltyRouterFlushToReceiver() public {
        BoxSpec memory s = _collectionSpec();
        s.addOns = new AddOn[](1);
        s.addOns[0] = AddOn(4, abi.encode(uint16(500), uint8(1)));
        s.creatorFeeRecipient = address(this);
        BoxCoordinatorV2 c = _create(s);
        vm.deal(c.royaltyRouter(), 1 ether);
        _measure("royalty router flush", c.royaltyRouter(), abi.encodeCall(BoxRoyaltyRouterV2.flush, ()), 0, 1_500_000);
        assertEq(c.royaltyRouter().balance, 0);
        assertEq(pm.balanceOf(c.receiver(), 0), 1 ether);
    }

    function test_fitAndPlatformPaymentsHaveAnExitAndBlockedFitRetries() public {
        _graduate();
        receiver.collect(address(0));
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        assertGt(fit, 0);
        assertGt(platform, 0);
        // The deliberately non-payable local Safe double refuses the first payment.
        assertEq(receiver.payFit(), 0);
        assertEq(receiver.fitOwed(), fit);
        vm.etch(fitSafe, hex"00");
        uint256 before_ = fitSafe.balance;
        _measure("pay FIT after retry", address(receiver), abi.encodeCall(BoxReceiverV2.payFit, ()), 0, 4_000_000);
        assertEq(fitSafe.balance - before_, fit);
        assertEq(receiver.fitOwed(), 0);
        before_ = address(this).balance;
        _measure("pay platform", address(receiver), abi.encodeCall(BoxReceiverV2.payPlatform, ()), 0, 4_000_000);
        assertEq(address(this).balance - before_, platform);
        assertEq(receiver.platformOwed(), 0);
    }

    function test_creatorKeepHasAnAuthorizedExit() public {
        BoxSpec memory s = _spec();
        s.buyers.a.leg = 1;
        s.buyers.a.dest = 2;
        s.sellers.a.leg = 1;
        s.sellers.a.dest = 2;
        s.creatorFeeRecipient = CREATOR;
        box = _create(s);
        receiver = BoxReceiverV2(box.receiver());
        hook = IBoxHookV2(box.hook());
        token = BoxTokenV2(box.token());
        key = hook.poolKey();
        curve = BoxLayoutV2.curve(box.raise(), false);
        vm.warp(box.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
        _graduate();
        receiver.collect(address(0));
        (uint256 owed,) = receiver.creatorOwed(address(0));
        assertGt(owed, 0);
        vm.expectRevert();
        receiver.claimCreator(address(0), address(this));
        vm.prank(CREATOR);
        uint256 paid = receiver.claimCreator(address(0), CREATOR);
        assertEq(paid, owed);
        (owed,) = receiver.creatorOwed(address(0));
        assertEq(owed, 0);
    }

    function test_refusedTipCannotBlockFailure() public {
        WRefusingTip caller = new WRefusingTip();
        vm.warp(box.deadline());
        _measure("failure with refused tip", address(caller), abi.encodeCall(WRefusingTip.fail, (box)), 0, 12_000_000);
        assertTrue(box.failed());
        assertEq(address(caller).balance, 0);
        assertGt(box.quoteClaim(0), 0);
    }

    function test_nonemptyRouterSweepFitsStipend() public {
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot,) = box.claimState();
        vm.deal(box.launchRouter(), 1 ether);
        _coldRelease();
        address router = box.launchRouter();
        vm.cool(router);
        bytes memory data = abi.encodeCall(IBoxLaunchRouter.sweep, ());
        uint256 before_ = gasleft();
        (bool ok,) = router.call{gas: C.SWEEP_GAS}(data);
        uint256 used = before_ - gasleft();
        assertTrue(ok);
        assertLe((used * 125 + 99) / 100, C.SWEEP_GAS, "inner sweep margin");
        emit log_named_uint("nonempty router sweep call", used);
        emit log_named_uint("nonempty router sweep transaction", GasBudget.transaction(used, data));
        (uint256 afterPot,) = box.claimState();
        assertEq(afterPot - pot, 1 ether);
    }

    function test_unloadedArtGateCanFailWithinBudget() public {
        BoxCoordinatorV2 c = _create(_collectionSpec());
        assertFalse(c.gateOpen());
        vm.warp(c.openAt() + 14 days);
        _measure("fail closed gate", address(c), abi.encodeCall(BoxCoordinatorV2.failClosed, ()), 0, 12_000_000);
        assertTrue(c.failed());
    }
}
