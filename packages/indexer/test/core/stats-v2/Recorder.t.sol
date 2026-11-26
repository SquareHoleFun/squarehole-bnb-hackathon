// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FactoryLife} from "test/box-v2/kit/FactoryLife.sol";
import {BoxSpec} from "src/box-v2/interfaces/SpecTypes.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";

/// Offline real factory/token/hook/PoolManager receipts; no RPC or listener.
contract StatsRecorderTest is FactoryLife {
    using PoolIdLibrary for *;
    function _startClock() internal override { vm.warp(1_799_999_600); vm.roll(100); }

    function snapshot(string memory stage) internal {
        emit log_named_bytes(stage, abi.encode(vm.getRecordedLogs()));
        (uint160 price,,,) = StateLibrary.getSlot0(pm, hook.poolKey().toId());
        uint256 raised = price <= layout.sqrtPriceEndX96 ? box.raise()
            : price >= layout.sqrtPriceStartX96 ? 0
            : SqrtPriceMath.getAmount0Delta(price, layout.sqrtPriceStartX96, layout.liquidity, false);
        emit log_named_bytes(string.concat(stage, "State"), abi.encode(
            block.timestamp, token.totalSupply(), price, token.totalBurned(), raised,
            [token.balanceOf(address(buyer)), token.balanceOf(address(pm)), token.balanceOf(address(box)),
             token.balanceOf(address(hook)), token.balanceOf(address(receiver))]
        ));
    }

    function recordLife(BoxSpec memory spec) internal {
        vm.recordLogs(); _startAt(spec, 0); snapshot("launch");
        emit log_named_bytes("wiring", abi.encode(address(box), address(token), address(hook), address(receiver),
            address(pm), address(buyer), box.q(), box.raise(), hook.poolKey().toId(), address(registry), address(listings)));
        vm.warp(1_800_000_100); vm.roll(block.number + 1);
        vm.recordLogs(); _buy(spec.raise / 5); snapshot("buy");
        vm.warp(1_800_000_200); vm.roll(block.number + 1);
        vm.recordLogs(); buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 10, layout.sqrtPriceStartX96);
        snapshot("sell");
        vm.warp(1_800_003_700); vm.roll(block.number + 1);
        vm.recordLogs(); _fill(); snapshot("filled");
        vm.roll(block.number + 1); vm.recordLogs(); box.graduate(); snapshot("graduated");
        vm.warp(1_800_003_800); vm.roll(block.number + 1);
        vm.recordLogs(); buyer.swap(hook.poolKey(), true, spec.raise / 20, TickMath.MIN_SQRT_PRICE + 1);
        snapshot("poolBuy");
        vm.warp(1_800_007_300); vm.roll(block.number + 1);
        vm.recordLogs(); buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 20, TickMath.MAX_SQRT_PRICE - 1);
        vm.prank(address(buyer)); token.burn(1234567890123456789);
        snapshot("poolSellBurn");
    }

    function test_recordNative() public { recordLife(_spec()); }
    function test_recordSixDecimals() public {
        (BoxSpec memory spec,) = _priceSpec(1, 1, 6);
        recordLife(spec);
    }
}
