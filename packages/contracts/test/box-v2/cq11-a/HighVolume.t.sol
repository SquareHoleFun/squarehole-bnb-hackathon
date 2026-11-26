// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";
import {CQ11ARealFixture, FeeBatchV2} from "./RealFixture.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract CQ11AHighVolumeTest is CQ11ARealFixture {
    using StateLibrary for IPoolManager;
    // Call the authorized new selector so the red test compiles before the shape exists.
    function _closedResidue() internal view returns (uint256) {
        (bool ok, bytes memory result) = address(hook).staticcall(abi.encodeWithSignature("closedTResidue()"));
        assertTrue(ok, "closed pool must expose exact per-pool T residue");
        return abi.decode(result, (uint256));
    }
    function test_C11_livePoolReportsNoClosedResidue() public view {
        assertEq(_closedResidue(), 0, "live liquidity remains redeemable");
    }
    uint256 internal volume;
    uint256 internal sales;
    function _volume(uint256 rounds) internal {
        _make(LARGE); _open();
        for (uint256 i; i < rounds; ++i) {
            BalanceDelta buy = _buy(LARGE / 4);
            volume += uint256(-int256(buy.amount0()));
            uint256 before = _claims(address(receiver));
            trader.trade(key, false, -int256(buy.amount1()), layout.sqrtPriceStartX96);
            sales += _claims(address(receiver)) - before;
        }
        assertGt(volume / 100, uint256(uint128(type(int128).max)), "accumulated LP fees exceed int128");
        assertFalse(hook.closed());
        assertEq(hook.saleFeesPending(), sales);
    }
    function test_C3_highVolumeHarvestConservesAndResets() public {
        _volume(205);
        FeeBatchV2 memory b = receiver.collect(address(0));
        assertGt(b.buyersP, uint256(uint128(type(int128).max)));
        assertEq(b.sellersP, sales);
        assertEq(b.qToReserve, LARGE / 1000);
        assertEq(_claims(address(box)), LARGE / 1000);
        assertEq(_claims(address(receiver)), b.buyersP + b.sellersP);
        assertEq(hook.saleFeesPending(), 0);
        b = receiver.collect(address(0));
        assertEq(b.buyersP + b.sellersP + b.qToReserve, 0);
    }
    function test_C6_highVolumeGraduationAndRewardExit() public {
        _volume(205); _fill();
        box.graduate();
        assertTrue(box.graduated());
        assertGt(hook.pairedLiquidity(), 0);
        assertEq(box.rewardOf(address(this)), LARGE / 1000);
        assertEq(box.claimReward(address(0xBEEF)), LARGE / 1000);
        assertEq(p.balanceOf(address(0xBEEF)), LARGE / 1000);
        receiver.collect(address(0));
        assertEq(hook.saleFeesPending(), 0);
    }
    function test_C11_highVolumeCloseConservesAndHasClaimExit() public {
        _volume(205);
        (uint160 spot,,,) = pm.getSlot0(hook.poolId());
        (uint128 liquidity, uint256 last,) = pm.getPositionInfo(hook.poolId(), address(hook), layout.tickLower, layout.tickUpper, bytes32(0));
        (uint256 growth,) = pm.getFeeGrowthInside(hook.poolId(), layout.tickLower, layout.tickUpper);
        uint256 fees = FullMath.mulDiv(growth - last, liquidity, 1 << 128);
        uint256 principal = SqrtPriceMath.getAmount0Delta(spot, layout.sqrtPriceStartX96, liquidity, false);
        uint256 total = principal + fees + _claims(address(box)) + _claims(address(receiver));
        uint256 beforeTip = p.balanceOf(address(this));
        vm.warp(box.deadline());
        box.fail();
        assertTrue(box.failed()); assertTrue(hook.failed());
        (uint256 pot, uint256 left) = box.claimState();
        uint256 accounted = pot + _claims(address(receiver)) + p.balanceOf(address(this)) - beforeTip;
        assertLe(accounted, total);
        assertApproxEqAbs(accounted, total, 2, "only bounded removal rounding remains");
        assertEq(_claims(address(hook)), 0);
        // The empty-holder case isolates pool rounding inventory from redeemable T.
        // Removing all PoolManager T from the denominator would break the separate claims case below.
        emit log_named_uint("remaining PoolManager T", t.balanceOf(address(pm)));
        assertEq(t.balanceOf(address(trader)), 0, "all trader T was sold back");
        assertEq(t.balanceOf(address(pm)), t.totalSupply(), "remaining supply is entirely pool residue");
        assertEq(pm.balanceOf(address(hook), uint160(address(t))), 0);
        assertEq(pm.balanceOf(address(receiver), uint160(address(t))), 0);
        assertEq(pm.balanceOf(address(box), uint160(address(t))), 0);
        assertEq(left, t.balanceOf(address(trader)));
        assertEq(_closedResidue(), t.balanceOf(address(pm)));
        vm.startPrank(address(trader));
        t.approve(address(box), type(uint256).max);
        if (left != 0) box.claim(left, address(0xBEEF));
        vm.stopPrank();
        if (left == 0) box.claim(0, address(0xBEEF));
        assertEq(p.balanceOf(address(0xBEEF)), pot);
        assertEq(_claims(address(box)), 0);
        uint256 fit = receiver.fitOwed();
        trader.gift(address(p), address(box), 12345);
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        assertEq(_claims(address(box)), 12345);
    }

    function test_C11_failureCountsRedeemableManagerClaimsButNotPoolResidue() public {
        _volume(205);
        _buy(LARGE / 100);
        uint256 held = t.balanceOf(address(trader));
        uint256 redeemable = held / 3;
        address owner = address(0xACDC);
        trader.gift(address(t), owner, redeemable);
        assertEq(pm.balanceOf(owner, uint160(address(t))), redeemable);
        vm.warp(box.deadline());
        box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        // A PM claim is backed by real T that its owner can redeem and surrender.
        // PM balance also contains this pool's irrecoverable rounding inventory.
        assertGt(t.balanceOf(address(pm)), redeemable);
        assertEq(t.totalSupply(), held + t.balanceOf(address(pm)) - redeemable);
        assertEq(left, held, "only holder T plus redeemable claims are outstanding");
        assertEq(_closedResidue(), t.balanceOf(address(pm)) - redeemable);
        assertEq(pm.balanceOf(owner, uint160(address(t))), redeemable, "closure cannot confiscate claims");
        // Redeem the unrelated ERC-6909 backing and surrender every legitimately outstanding T.
        vm.prank(owner);
        pm.setOperator(address(this), true);
        pm.unlock(abi.encode(owner, redeemable));
        vm.startPrank(owner);
        t.approve(address(box), redeemable);
        uint256 first = box.claim(redeemable, address(0xBEEF));
        vm.stopPrank();
        vm.startPrank(address(trader));
        t.approve(address(box), held - redeemable);
        uint256 last = box.claim(held - redeemable, address(0xBEEF));
        vm.stopPrank();
        assertEq(first + last, pot, "the entire pot has an exit");
        assertEq(p.balanceOf(address(0xBEEF)), pot);
        (pot, left) = box.claimState();
        assertEq(pot + left, 0);
        uint256 fit = receiver.fitOwed();
        trader.gift(address(p), address(box), 12345);
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        assertEq(_claims(address(box)), 12345);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address owner, uint256 amount) = abi.decode(data, (address, uint256));
        pm.burn(owner, uint160(address(t)), amount);
        pm.take(Currency.wrap(address(t)), owner, amount);
        return "";
    }
    function test_C3_highVolumeCreatorFeesHaveAnExit() public {
        _volume(410); _fill(); box.graduate();
        receiver.collect(address(0));
        uint256 owed = receiver.creatorP();
        assertGt(owed, uint256(uint128(type(int128).max)), "real accumulated creator fees exceed one manager delta");
        assertEq(receiver.claimCreator(address(p), address(0xCAFE)), owed);
        assertEq(p.balanceOf(address(0xCAFE)), owed);
        assertEq(receiver.creatorP(), 0);
        assertLe(receiver.booked(address(p)), _claims(address(receiver)));
        assertEq(receiver.claimCreator(address(p), address(0xCAFE)), 0, "cannot claim twice");
    }
    function test_C3_curveSaleVolumeNeverMintsP() public {
        _volume(410);
        assertEq(sales, 0, "curve sales charge T instead of P");
        FeeBatchV2 memory b = receiver.collect(address(0));
        assertEq(b.sellersP, sales);
    }
}
