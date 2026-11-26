// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FactoryLife} from "../kit/FactoryLife.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {GasBudget} from "../gas/GasBudget.sol";

contract ListingLifeTest is FactoryLife {
    function test_updateRaiseKeepsExistingTradingBoxAndRefreshesNextCreation() public {
        BoxSpec memory s = _menu(1, 2);
        _start(s);
        _buy(s.raise / 10);
        bytes32 oldState = _snapshot();
        (bytes32 cs, bytes32 hs) = _salts(s);
        vm.expectRevert();
        vm.prank(CREATOR);
        listings.updateRaise(0, 8 ether);
        listings.updateRaise(0, 8 ether);
        assertEq(_snapshot(), oldState);
        bytes memory refusal = factory.refusal(s, CREATOR);
        assertGt(refusal.length, 0);
        uint256 bootstrap = box.bootstrapQ();
        vm.expectRevert(refusal);
        vm.prank(CREATOR);
        factory.createBox{value: bootstrap}(s, cs, hs);
        s.raise = 8 ether;
        BoxCoordinatorV2 fresh = _create(s);
        assertEq(fresh.raise(), 8 ether);
        assertEq(IBoxHookV2(fresh.hook()).raise(), 8 ether);
        assertEq(fresh.bootstrapQ(), factory.boxQParameters(0, 8 ether).bootstrapQ);
        assertEq(registry.recordOf(0).raise, box.raise());
        assertEq(registry.recordOf(1).raise, 8 ether);
        assertEq(_snapshot(), oldState);
        _fill();
        box.graduate();
        assertTrue(box.graduated(), "old snapshot remains executable after update");
    }

    function test_plainOpenArtCreationStaysUnderTenMillionGas() public {
        BoxSpec memory s = _collectionSpec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 value = factory.boxQParameters(0, s.raise).bootstrapQ;
        bytes memory data = abi.encodeCall(IBoxFactoryV2.createBox, (s, cs, hs));
        _coldRelease();
        vm.prank(CREATOR);
        uint256 start = gasleft();
        (bool ok, bytes memory result) = address(factory).call{value: value}(data);
        uint256 used = GasBudget.transaction(start - gasleft(), data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        emit log_named_uint("open art creation including intrinsic gas", used);
        assertLt(used, 10_000_000);
        assertEq(registry.boxCount(), 1);
    }

    function _snapshot() private view returns (bytes32) {
        (int24 lo, int24 hi, uint128 liquidity) = hook.curve();
        return keccak256(
            abi.encode(
                box.raise(),
                box.bootstrapQ(),
                box.deadline(),
                box.specHash(),
                hook.raise(),
                hook.reserveCap(),
                lo,
                hi,
                liquidity,
                receiver.buyersChoice(),
                receiver.sellersChoice()
            )
        );
    }
}
