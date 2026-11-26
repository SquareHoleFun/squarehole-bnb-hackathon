// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CQ11ARealFixture} from "./RealFixture.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
contract CQ11AClosedInventoryTest is CQ11ARealFixture {
    using StateLibrary for IPoolManager;
    function test_C11_otherPoolPositionIsNotClosedPoolResidue() public {
        _open(); _buy(RAISE / 10);
        uint256 holderT = t.balanceOf(address(trader));
        PoolDriver otherLP = new PoolDriver(pm);
        PoolKey memory otherKey = PoolKey(key.currency0, key.currency1, 3000, 60, IHooks(address(0)));
        pm.initialize(otherKey, 1 << 96);
        p.mint(address(otherLP), 1e12);
        vm.prank(address(trader)); t.transfer(address(otherLP), 1e12);
        uint256 before = t.balanceOf(address(pm)); otherLP.modify(otherKey, -60, 60, 1e12);
        uint256 otherInventory = t.balanceOf(address(pm)) - before;
        assertGt(otherInventory, 0);
        vm.warp(box.deadline()); box.fail();
        (, uint256 left) = box.claimState();
        assertEq(left, holderT, "other position backing is still holder T");
        assertEq(hook.closedTResidue(), t.balanceOf(address(pm)) - otherInventory, "only this pool's inventory");
        before = t.balanceOf(address(otherLP)); otherLP.modify(otherKey, -60, 60, -int256(1e12));
        assertGt(t.balanceOf(address(otherLP)), before, "legitimate other position still withdraws");
    }
    function test_C11_managerProtocolFeesRemainRedeemableHolderT() public {
        _open(); _buy(RAISE / 10);
        pm.setProtocolFeeController(address(this)); pm.setProtocolFee(key, 1000 << 12);
        uint256 sold = t.balanceOf(address(trader));
        trader.trade(key, false, -int256(sold), layout.sqrtPriceStartX96);
        uint256 accrued = pm.protocolFeesAccrued(Currency.wrap(address(t)));
        assertGt(accrued, 0); assertEq(t.balanceOf(address(trader)), 0);
        vm.warp(box.deadline()); box.fail();
        (uint256 pot, uint256 left) = box.claimState();
        assertEq(left, accrued, "protocol fees are redeemable, not irrecoverable pool T");
        assertEq(hook.closedTResidue(), t.balanceOf(address(pm)) - accrued);
        address owner = address(0xFEE5);
        assertEq(pm.collectProtocolFees(owner, Currency.wrap(address(t)), 0), accrued);
        vm.startPrank(owner); t.approve(address(box), accrued);
        assertEq(box.claim(accrued, owner), pot); vm.stopPrank();
        assertEq(p.balanceOf(owner), pot); assertEq(_claims(address(box)), 0);
    }
    function test_C11_protocolFeeChangesAndCollectionsDoNotChangePoolAttribution() public {
        _open(); pm.setProtocolFeeController(address(this));
        address owner = address(0xFEE5);
        for (uint24 i; i < 3; ++i) {
            pm.setProtocolFee(key, (i == 0 ? uint24(1000) : i == 1 ? uint24(37) : uint24(0)) << 12);
            _buy(RAISE / 10);
            trader.trade(key, false, -int256(t.balanceOf(address(trader)) / 2), layout.sqrtPriceStartX96);
            if (i == 0) pm.collectProtocolFees(owner, Currency.wrap(address(t)), 0);
        }
        uint256 accrued = pm.protocolFeesAccrued(Currency.wrap(address(t)));
        uint256 outstanding = t.balanceOf(address(trader)) + t.balanceOf(owner) + accrued;
        vm.warp(box.deadline()); box.fail();
        (uint256 pot, uint256 left) = box.claimState(); assertEq(left, outstanding);
        assertEq(hook.closedTResidue(), t.balanceOf(address(pm)) - accrued);
        pm.collectProtocolFees(owner, Currency.wrap(address(t)), 0);
        uint256 collected = t.balanceOf(owner);
        vm.prank(owner); t.transfer(address(trader), collected);
        vm.startPrank(address(trader)); t.approve(address(box), outstanding);
        assertEq(box.claim(outstanding, owner), pot); vm.stopPrank();
    }
    function testFuzz_C11_inventoryMatchesOnlyUnclaimableRemainder(uint64 seed, uint8 rounds) public {
        _open(); rounds = uint8(bound(rounds, 1, 12));
        uint256 input = bound(seed, RAISE / 100000, RAISE / 100);
        for (uint256 i; i < rounds; ++i) {
            _buy(input); uint256 sell = t.balanceOf(address(trader)) / 3;
            trader.trade(key, false, -int256(sell), layout.sqrtPriceStartX96);
        }
        uint256 held = t.balanceOf(address(trader));
        uint256 giftedClaims = held / 7; trader.gift(address(t), address(hook), giftedClaims);
        uint256 redeemable = (held - giftedClaims) / 9; trader.gift(address(t), address(0xCAFE), redeemable);
        vm.warp(box.deadline()); box.fail();
        (, uint256 left) = box.claimState();
        assertEq(left, held - giftedClaims);
        assertEq(hook.closedTResidue(), t.balanceOf(address(pm)) - redeemable);
        assertEq(pm.balanceOf(address(0xCAFE), uint160(address(t))), redeemable);
        assertEq(pm.getLiquidity(hook.poolId()), 0);
    }
    function test_C11_hatchUsesSameExactInventoryAfterFill() public {
        _fill(); uint256 held = t.balanceOf(address(trader));
        vm.warp(hook.closedAt() + 7 days); box.fail();
        (, uint256 left) = box.claimState(); assertEq(left, held);
        assertEq(hook.closedTResidue(), t.balanceOf(address(pm)));
        assertTrue(box.failed()); assertFalse(box.graduated());
    }
    function test_C11_refusedBurnIsSeparateFromPoolResidue() public {
        _open(); _buy(RAISE / 10); uint256 held = t.balanceOf(address(trader));
        vm.mockCallRevert(address(t), abi.encodeWithSignature("burn(uint256)"), "burn refused");
        vm.warp(box.deadline()); box.fail();
        (, uint256 left) = box.claimState(); assertEq(left, held);
        uint256 hookClaims = pm.balanceOf(address(hook), uint160(address(t)));
        assertGt(hookClaims, 0); assertEq(hook.closedTResidue(), t.balanceOf(address(pm)) - hookClaims);
        vm.clearMockedCalls();
    }
}
