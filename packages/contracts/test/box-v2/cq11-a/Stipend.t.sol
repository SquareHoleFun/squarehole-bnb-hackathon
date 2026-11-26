// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CQ11ARealFixture} from "./RealFixture.sol";
import {CQAAsset} from "./Fixture.sol";
import {IBoxHookV2, ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// Price token adversary at the external-call boundary; all box parts and PoolManager stay real.
contract CQATipToken is CQAAsset {
    address private recipient;
    uint256 private mode;
    IBoxHookV2 private observed;
    uint128 private oldLiquidity;

    function configure(address to, uint256 how, IBoxHookV2 h) external {
        recipient = to;
        mode = how;
        observed = h;
        oldLiquidity = h.pairedLiquidity();
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (to == recipient) {
            require(observed.lastProtocolBlock() == block.number, "tip before mark");
            require(observed.pairedLiquidity() > oldLiquidity, "tip before add");
            if (mode == 1) revert("tip refused");
            if (mode == 2) assembly { for {} 1 {} {} }
        }
        return super.transfer(to, amount);
    }
}

contract CQABurnGasSink {
    function burn(uint256) external pure {
        assembly { for {} 1 {} {} }
    }
}

contract CQ11AStipendTest is CQ11ARealFixture {
    address private constant TIP = address(0xb0b);
    uint256 private constant GIFT = 1e24;

    function test_C7_capsKeepMeasuredFullPathMargin() public pure {
        // FINAL2-GAS includes mandatory cold eligible-supply history and first-wallet state.
        assertEq(C.TIP_GAS, 2_800_000);
        assertEq(C.BURN_GAS, 2_500_000);
        assertGe(C.TIP_GAS, 2 * 1_257_614, "twice cold linked P tip");
        assertGe(C.BURN_GAS, 2 * 1_029_046, "twice cold redemption and burn");
    }

    function _prepare() private {
        _graduate();
        vm.roll(block.number + 1);
        vm.etch(address(p), address(new CQATipToken()).code);
        // Gift real T bought by the trader as claims, never enlarge the real token's supply.
        trader.gift(address(t), address(hook), GIFT);
    }

    function _tClaims() private view returns (uint256) {
        return pm.balanceOf(address(hook), uint160(address(t)));
    }

    function test_C7_completeFreshTipAndGiftedBurnPaths() public {
        _prepare();
        CQATipToken(address(p)).configure(TIP, 0, hook);
        uint256 budget = hook.depthBudget();
        uint256 supply = t.totalSupply();
        uint256 before = gasleft();
        (ProtocolSkip skip, uint256 used,, uint256 tip) = hook.deepen(TIP);
        emit log_named_uint("complete deepen including tip and burn", before - gasleft());
        assertEq(uint256(skip), uint256(ProtocolSkip.None));
        assertGt(used, 0);
        assertGt(tip, 0, "complete unlock must pay a fresh recipient");
        assertEq(p.balanceOf(TIP), tip);
        assertEq(tip, (budget - hook.depthBudget() - tip) / 20);
        assertEq(_tClaims(), GIFT, "complete burn must leave only the gift");
        assertLt(t.totalSupply(), supply, "new remainder burns");
        assertEq(t.balanceOf(address(hook)), 0, "take and burn are one atomic unlock");
    }

    function test_C7_refusingAndGasConsumingTipRollbackOnlyTip() public {
        _prepare();
        uint256 snapshot = vm.snapshotState();
        CQATipToken(address(p)).configure(TIP, 0, hook);
        (,,, uint256 paid) = hook.deepen(TIP);
        assertGt(paid, 0, "supported transfer succeeds before adversarial variants");
        uint256 budget = hook.depthBudget();
        uint128 liquidity = hook.pairedLiquidity();
        uint256 supply = t.totalSupply();
        for (uint256 mode = 1; mode <= 2; ++mode) {
            vm.revertToState(snapshot);
            CQATipToken(address(p)).configure(TIP, mode, hook);
            uint256 start = gasleft();
            (,,, uint256 tip) = hook.deepen(TIP);
            emit log_named_uint(mode == 1 ? "complete deepen refused tip" : "complete deepen gas sink tip", start - gasleft());
            assertEq(tip, 0);
            assertEq(p.balanceOf(TIP), 0);
            assertEq(hook.depthBudget(), budget + paid);
            assertEq(hook.pairedLiquidity(), liquidity);
            assertEq(t.totalSupply(), supply);
            assertEq(_tClaims(), GIFT);
            assertEq(hook.lastProtocolBlock(), block.number);
        }
    }

    function test_C7_refusingBurnRollsBackRedemptionAndPreservesGift() public {
        _prepare();
        uint256 snapshot = vm.snapshotState();
        uint256 supply = t.totalSupply();
        hook.deepen(address(0));
        uint256 burned = supply - t.totalSupply();
        assertGt(burned, 0, "supported complete burn succeeds first");
        uint128 liquidity = hook.pairedLiquidity();
        uint256 budget = hook.depthBudget();
        vm.revertToState(snapshot);
        vm.mockCallRevert(address(t), abi.encodeWithSignature("burn(uint256)"), "floor");
        uint256 start = gasleft();
        hook.deepen(address(0));
        emit log_named_uint("complete deepen refused burn", start - gasleft());
        assertEq(_tClaims(), GIFT + burned);
        assertEq(t.balanceOf(address(hook)), 0);
        assertEq(t.totalSupply(), supply);
        assertEq(hook.pairedLiquidity(), liquidity);
        assertEq(hook.depthBudget(), budget);
    }

    function test_C7_gasConsumingBurnRollsBackRedemptionOnly() public {
        _prepare();
        uint256 snapshot = vm.snapshotState();
        uint256 supply = t.totalSupply();
        hook.deepen(address(0));
        uint256 burned = supply - t.totalSupply();
        assertGt(burned, 0);
        uint128 liquidity = hook.pairedLiquidity();
        uint256 budget = hook.depthBudget();
        vm.revertToState(snapshot);
        CQABurnGasSink sink = new CQABurnGasSink();
        vm.mockFunction(address(t), address(sink), abi.encodeWithSignature("burn(uint256)", burned));
        uint256 start = gasleft();
        hook.deepen(address(0));
        emit log_named_uint("complete deepen gas sink burn", start - gasleft());
        assertEq(_tClaims(), GIFT + burned);
        assertEq(t.balanceOf(address(hook)), 0);
        assertEq(t.totalSupply(), supply);
        assertEq(hook.pairedLiquidity(), liquidity);
        assertEq(hook.depthBudget(), budget);
    }
}
