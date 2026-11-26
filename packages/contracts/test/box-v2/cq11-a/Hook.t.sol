// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11ARealFixture} from "./RealFixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SwapMath} from "v4-core/src/libraries/SwapMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxHookV2Base} from "../../../src/box-v2/BoxHookV2Base.sol";
import {CQAAsset} from "./Fixture.sol";

/// C3/C15: real deployed parts, real manager callbacks and settlement. For swap kinds that the
/// router/receiver do not expose publicly, impersonate only the caller of pm.swap inside an unlock;
/// do not replace any part's code. Public router.buy and receiver.buyBack are tested separately.
abstract contract CQ11AHookMatrixBase is CQ11ARealFixture {
    using StateLibrary for IPoolManager;
    struct Expected { uint160 price; uint256 input; uint256 output; uint256 lpFee; uint256 saleFee; }
    struct Before {
        uint160 price;
        uint128 liquidity;
        uint256 growth;
        uint256 tGrowth;
        uint256 sales;
        uint256 claims;
        uint256 mark;
        uint256 pBalance;
        uint256 tBalance;
        uint256 managerP;
        uint256 managerT;
        bytes32 state;
    }
    function _state() internal view returns (bytes32) {
        (uint160 price, int24 tick, uint24 protocol, uint24 fee) = pm.getSlot0(hook.poolId());
        (uint256 g0, uint256 g1) = pm.getFeeGrowthGlobals(hook.poolId());
        bytes32 poolState = keccak256(abi.encode(price, tick, protocol, fee, g0, g1));
        return keccak256(abi.encode(poolState, hook.saleFeesPending(),
            hook.lastProtocolBlock(), hook.closedAt(), _claims(address(receiver)), _claims(address(box)),
            receiver.booked(address(p)), receiver.creatorP(), hook.depthBudget()));
    }
    function _before(address sender) internal view returns (Before memory b) {
        (b.price,,,) = pm.getSlot0(hook.poolId());
        b.liquidity = pm.getLiquidity(hook.poolId());
        (b.growth, b.tGrowth) = pm.getFeeGrowthGlobals(hook.poolId());
        b.sales = hook.saleFeesPending(); b.claims = _claims(address(receiver));
        b.mark = hook.lastProtocolBlock(); b.state = _state();
        b.pBalance = p.balanceOf(sender); b.tBalance = t.balanceOf(sender);
        b.managerP = p.balanceOf(address(pm)); b.managerT = t.balanceOf(address(pm));
    }
    function _prepare(uint8 phase, uint8 who) internal returns (address sender) {
        _open(); _buy(RAISE / 10);
        if (phase == 2) _graduate();
        if (phase == 0) vm.warp(box.effectiveOpenAt() + 120);
        sender = who == 0 ? address(router) : who == 1 ? address(receiver) : address(trader);
        if (sender != address(trader)) {
            uint256 gift = t.balanceOf(address(trader)) / 4;
            vm.prank(address(trader)); t.transfer(sender, gift);
            p.mint(sender, RAISE);
        }
    }
    function _attempt(address sender, SwapParams memory params) external returns (BalanceDelta) {
        require(msg.sender == address(this));
        return abi.decode(pm.unlock(abi.encode(sender, params)), (BalanceDelta));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address sender, SwapParams memory params) = abi.decode(data, (address, SwapParams));
        vm.startPrank(sender);
        BalanceDelta d = pm.swap(key, params, "");
        _settle(key.currency0, d.amount0(), sender);
        _settle(key.currency1, d.amount1(), sender);
        vm.stopPrank();
        return abi.encode(d);
    }
    function _settle(Currency c, int128 delta, address sender) internal {
        if (delta > 0) pm.take(c, sender, uint256(int256(delta)));
        else if (delta < 0) {
            pm.sync(c);
            CQAAsset(Currency.unwrap(c)).transfer(address(pm), uint256(-int256(delta)));
            pm.settle();
        }
    }
    function _reject(address sender, SwapParams memory params, Before memory b, bytes memory reason, bool after_) internal {
        vm.expectRevert(abi.encodeWithSelector(CustomRevert.WrappedError.selector, address(hook),
            after_ ? IHooks.afterSwap.selector : IHooks.beforeSwap.selector, reason, abi.encodePacked(Hooks.HookCallFailed.selector)));
        this._attempt(sender, params);
        assertEq(_state(), b.state, "rejected swap rolls back fees, pool, ledgers and step mark");
        assertEq(p.balanceOf(sender), b.pBalance); assertEq(t.balanceOf(sender), b.tBalance);
        assertEq(p.balanceOf(address(pm)), b.managerP); assertEq(t.balanceOf(address(pm)), b.managerT);
    }
    function _case(uint8 phase, uint8 who, uint8 kind, bool partFill) internal {
        address sender = _prepare(phase, who);
        bool buy = kind < 2; bool exactIn = kind % 2 == 0;
        Before memory b = _before(sender);
        uint160 limit = buy ? b.price - b.price / (partFill ? 100000000 : 1000)
            : b.price + b.price / (partFill ? 100000000 : 1000);
        uint256 amount = buy == exactIn ? RAISE / 1000000 : t.balanceOf(sender) / 1000000;
        SwapParams memory params = SwapParams(buy, exactIn ? -int256(amount) : int256(amount), limit);
        if (who == 1 && (!buy || phase != 2)) {
            _reject(sender, params, b, abi.encodeWithSelector(buy ? BoxHookV2Base.NotGraduated.selector : IBoxHookV2.ReceiverCannotSell.selector), false);
            return;
        }
        if (phase == 0 && buy && who != 0) {
            _reject(sender, params, b, abi.encodeWithSelector(IBoxHookV2.BuyThroughLaunchRouter.selector, address(router), hook.windowEndsAt()), false);
            return;
        }
        Expected memory e;
        (e.price, e.input, e.output, e.lpFee) = SwapMath.computeSwapStep(
            b.price, limit, b.liquidity, exactIn ? -int256(amount) : int256(amount), 10000);
        BalanceDelta d = this._attempt(sender, params);

        _checkTrade(sender, buy, b, e, d);
        assertEq(hook.lastProtocolBlock(), who == 1 ? block.number : b.mark);
        if (partFill) assertEq(e.price, limit, "partial fill reaches limit");
        else if (exactIn) assertEq(e.input + e.lpFee, amount); else assertEq(e.output, amount);
    }
    function _checkTrade(address sender, bool buy, Before memory b, Expected memory e, BalanceDelta d) internal view {
        assertEq(int256(d.amount0()), buy ? -int256(e.input + e.lpFee) : int256(e.output), "exact P delta including fee");
        assertEq(int256(d.amount1()), buy ? int256(e.output) : -int256(e.input + e.lpFee), "exact T delta including fee");
        assertEq(p.balanceOf(sender), uint256(int256(b.pBalance) + d.amount0()));
        assertEq(t.balanceOf(sender), uint256(int256(b.tBalance) + d.amount1()));
        assertEq(p.balanceOf(address(pm)), uint256(int256(b.managerP) - d.amount0()));
        assertEq(t.balanceOf(address(pm)), uint256(int256(b.managerT) - d.amount1()));
        (uint160 price,,, uint24 storedFee) = pm.getSlot0(hook.poolId());
        assertEq(price, e.price); assertEq(storedFee, 10000, "fixed LP fee never changes");
        (uint256 growth, uint256 tGrowth) = pm.getFeeGrowthGlobals(hook.poolId());
        assertEq(growth - b.growth, buy ? FullMath.mulDiv(e.lpFee, 1 << 128, b.liquidity) : 0, "exact P LP accrual");
        assertEq(tGrowth - b.tGrowth, buy ? 0 : FullMath.mulDiv(e.lpFee, 1 << 128, b.liquidity), "exact T LP accrual"); assertEq(hook.saleFeesPending(), b.sales + e.saleFee);
        assertEq(_claims(address(receiver)), b.claims + e.saleFee, "sale fee minted once");
    }
}

contract CQ11AHookTest is CQ11AHookMatrixBase {
    function test_C3_window_router_buyExactIn() public { _case(0, 0, 0, false); }
    function test_C15_partial_window_router_buyExactIn() public { _case(0, 0, 0, true); }
    function test_C3_window_router_buyExactOut() public { _case(0, 0, 1, false); }
    function test_C15_partial_window_router_buyExactOut() public { _case(0, 0, 1, true); }
    function test_C3_window_router_saleExactIn() public { _case(0, 0, 2, false); }
    function test_C15_partial_window_router_saleExactIn() public { _case(0, 0, 2, true); }
    function test_C3_window_router_saleExactOut() public { _case(0, 0, 3, false); }
    function test_C15_partial_window_router_saleExactOut() public { _case(0, 0, 3, true); }
    function test_C3_window_receiver_buyExactIn() public { _case(0, 1, 0, false); }
    function test_C15_partial_window_receiver_buyExactIn() public { _case(0, 1, 0, true); }
    function test_C3_window_receiver_buyExactOut() public { _case(0, 1, 1, false); }
    function test_C15_partial_window_receiver_buyExactOut() public { _case(0, 1, 1, true); }
    function test_C3_window_receiver_saleExactIn() public { _case(0, 1, 2, false); }
    function test_C15_partial_window_receiver_saleExactIn() public { _case(0, 1, 2, true); }
    function test_C3_window_receiver_saleExactOut() public { _case(0, 1, 3, false); }
    function test_C15_partial_window_receiver_saleExactOut() public { _case(0, 1, 3, true); }
    function test_C3_window_other_buyExactIn() public { _case(0, 2, 0, false); }
    function test_C15_partial_window_other_buyExactIn() public { _case(0, 2, 0, true); }
    function test_C3_window_other_buyExactOut() public { _case(0, 2, 1, false); }
    function test_C15_partial_window_other_buyExactOut() public { _case(0, 2, 1, true); }
    function test_C3_window_other_saleExactIn() public { _case(0, 2, 2, false); }
    function test_C15_partial_window_other_saleExactIn() public { _case(0, 2, 2, true); }
    function test_C3_window_other_saleExactOut() public { _case(0, 2, 3, false); }
    function test_C15_partial_window_other_saleExactOut() public { _case(0, 2, 3, true); }
    function test_C3_open_router_buyExactIn() public { _case(1, 0, 0, false); }
    function test_C15_partial_open_router_buyExactIn() public { _case(1, 0, 0, true); }
    function test_C3_open_router_buyExactOut() public { _case(1, 0, 1, false); }
    function test_C15_partial_open_router_buyExactOut() public { _case(1, 0, 1, true); }
    function test_C3_open_router_saleExactIn() public { _case(1, 0, 2, false); }
    function test_C15_partial_open_router_saleExactIn() public { _case(1, 0, 2, true); }
    function test_C3_open_router_saleExactOut() public { _case(1, 0, 3, false); }
    function test_C15_partial_open_router_saleExactOut() public { _case(1, 0, 3, true); }
    function test_C3_open_receiver_buyExactIn() public { _case(1, 1, 0, false); }
    function test_C15_partial_open_receiver_buyExactIn() public { _case(1, 1, 0, true); }
    function test_C3_open_receiver_buyExactOut() public { _case(1, 1, 1, false); }
    function test_C15_partial_open_receiver_buyExactOut() public { _case(1, 1, 1, true); }
    function test_C3_open_receiver_saleExactIn() public { _case(1, 1, 2, false); }
    function test_C15_partial_open_receiver_saleExactIn() public { _case(1, 1, 2, true); }
    function test_C3_open_receiver_saleExactOut() public { _case(1, 1, 3, false); }
    function test_C15_partial_open_receiver_saleExactOut() public { _case(1, 1, 3, true); }
    function test_C3_open_other_buyExactIn() public { _case(1, 2, 0, false); }
    function test_C15_partial_open_other_buyExactIn() public { _case(1, 2, 0, true); }
    function test_C3_open_other_buyExactOut() public { _case(1, 2, 1, false); }
    function test_C15_partial_open_other_buyExactOut() public { _case(1, 2, 1, true); }
    function test_C3_open_other_saleExactIn() public { _case(1, 2, 2, false); }
    function test_C15_partial_open_other_saleExactIn() public { _case(1, 2, 2, true); }
    function test_C3_open_other_saleExactOut() public { _case(1, 2, 3, false); }
    function test_C15_partial_open_other_saleExactOut() public { _case(1, 2, 3, true); }
    function test_C3_graduated_router_buyExactIn() public { _case(2, 0, 0, false); }
    function test_C15_partial_graduated_router_buyExactIn() public { _case(2, 0, 0, true); }
    function test_C3_graduated_router_buyExactOut() public { _case(2, 0, 1, false); }
    function test_C15_partial_graduated_router_buyExactOut() public { _case(2, 0, 1, true); }
    function test_C3_graduated_router_saleExactIn() public { _case(2, 0, 2, false); }
    function test_C15_partial_graduated_router_saleExactIn() public { _case(2, 0, 2, true); }
    function test_C3_graduated_router_saleExactOut() public { _case(2, 0, 3, false); }
    function test_C15_partial_graduated_router_saleExactOut() public { _case(2, 0, 3, true); }
    function test_C3_graduated_receiver_buyExactIn() public { _case(2, 1, 0, false); }
    function test_C15_partial_graduated_receiver_buyExactIn() public { _case(2, 1, 0, true); }
    function test_C3_graduated_receiver_buyExactOut() public { _case(2, 1, 1, false); }
    function test_C15_partial_graduated_receiver_buyExactOut() public { _case(2, 1, 1, true); }
    function test_C3_graduated_receiver_saleExactIn() public { _case(2, 1, 2, false); }
    function test_C15_partial_graduated_receiver_saleExactIn() public { _case(2, 1, 2, true); }
    function test_C3_graduated_receiver_saleExactOut() public { _case(2, 1, 3, false); }
    function test_C15_partial_graduated_receiver_saleExactOut() public { _case(2, 1, 3, true); }
    function test_C3_graduated_other_buyExactIn() public { _case(2, 2, 0, false); }
    function test_C15_partial_graduated_other_buyExactIn() public { _case(2, 2, 0, true); }
    function test_C3_graduated_other_buyExactOut() public { _case(2, 2, 1, false); }
    function test_C15_partial_graduated_other_buyExactOut() public { _case(2, 2, 1, true); }
    function test_C3_graduated_other_saleExactIn() public { _case(2, 2, 2, false); }
    function test_C15_partial_graduated_other_saleExactIn() public { _case(2, 2, 2, true); }
    function test_C3_graduated_other_saleExactOut() public { _case(2, 2, 3, false); }
    function test_C15_partial_graduated_other_saleExactOut() public { _case(2, 2, 3, true); }
}
