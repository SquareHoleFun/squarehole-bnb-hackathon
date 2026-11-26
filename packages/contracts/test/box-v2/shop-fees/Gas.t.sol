// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ShopFeesTest, ShopFees, ShopReceiver} from "./ShopFees.t.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ShopConfigV2} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";

contract ShopFeesGasTest is ShopFeesTest {
    function _amsterdam() private returns (bool) {
        bytes memory init = hex"6104006000f3";
        uint256 before_ = gasleft();
        assembly ("memory-safe") { pop(create(0, add(init, 32), mload(init))) }
        return before_ - gasleft() > 500_000;
    }
    function _coldShop() private {
        _coldRelease();
        vm.cool(address(receiver)); vm.cool(address(shop)); vm.cool(address(hook));
        vm.cool(address(box)); vm.cool(address(token)); vm.cool(address(pm));
        vm.cool(receiver.holderLedger());
    }
    function test_G1_D2_firstPurchaseAndRefundTransactionGas() public {
        BoxSpec memory s = _shopSpec(2);
        ShopConfigV2 memory cfg = abi.decode(s.contentsParams, (ShopConfigV2)); cfg.seedT = 400_000 ether;
        s.contentsParams = abi.encode(cfg);
        _startShop(s); _fill(); box.graduate(); receiver.collect(address(0));
        for (uint256 i; i < 6; ++i) _sellCollect(); vm.roll(block.number + 1);
        uint256 beforeHeld = pm.balanceOf(receiver.holderLedger(), 0);
        bytes memory data = abi.encodeCall(ShopReceiver.executeModule, (true));
        bool amsterdam = _amsterdam();
        _coldShop(); uint256 before_ = gasleft();
        (bool ok, bytes memory ret) = address(receiver).call(data);
        uint256 used = GasBudget.transaction(before_ - gasleft(), data);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        emit log_named_uint("first purchase plus refund transaction gas", used);
        emit log_named_uint("first purchased T", ShopFees(address(shop)).feesT());
        emit log_named_uint("same-call holder refund P", pm.balanceOf(receiver.holderLedger(), 0) - beforeHeld);
        assertGt(ShopFees(address(shop)).feesT(), 0);
        assertGt(pm.balanceOf(receiver.holderLedger(), 0), beforeHeld, "purchase and refund in one call");
        // RC7: additive receiver selector shifts executeModule dispatch by -42 gas on both EVMs.
        assertEq(used, amsterdam ? 2_756_224 : 905_624, "G1-D2 measured execution pin");
        assertLe(used * 120 / 100, 3_500_000, "keeper floor includes measured 20% headroom");
    }
    function test_G1_D2_shopCollectionTransactionGas() public {
        _startShop(2); _fill(); box.graduate(); receiver.collect(address(0));
        buyer.swap(hook.poolKey(), true, box.raise() / 10, TickMath.MIN_SQRT_PRICE + 1);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 20, layout.sqrtPriceStartX96);
        _sellFeeP();
        bytes memory data = abi.encodeWithSignature("collect(address)", address(0));
        bool amsterdam = _amsterdam();
        _coldShop(); uint256 before_ = gasleft();
        (bool ok, bytes memory ret) = address(receiver).call(data);
        uint256 used = GasBudget.transaction(before_ - gasleft(), data);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        emit log_named_uint("ShopT collect transaction gas", used);
        assertGt(ShopReceiver(address(receiver)).modulePendingP(true), 0);
        // RC7: bounded sub-unit passes and cursor-view dispatch, cold measured on both EVMs.
        assertEq(used, amsterdam ? 1_693_310 : 676_790, "G1-D2 measured collect pin");
        assertLe(used * 120 / 100, 5_000_000, "existing collect floor");
    }
}
