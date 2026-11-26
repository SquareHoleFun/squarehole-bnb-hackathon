// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverDeploy} from "test/box-v2/fee-modules/ReceiverDeploy.sol";
import {EatGasTest} from "test/box-v2/eat/Gas.t.sol";
import {EatTest, EatReceiver} from "test/box-v2/eat/Eat.t.sol";
import {IBoxReceiverEatV21} from "src/box-v2/interfaces/IBoxReceiverEatV21.sol";

// Independent acceptance ceiling, also pinned by test/eat-v21.test.ts against transactionGas().
// Run from contracts with FOUNDRY_TEST=../keeper/test/contracts. Production sources are unchanged.
contract KeeperEatLinkedEnvelopeTest is EatGasTest {
    uint256 private constant CALL_GAS = 3_500_000 - 21_064;

    function test_WIRING_coldCheckedBurnAtKeeperFloor() public { _keeperFloor(true, true); }
    function test_WIRING_coldFirstDeadWalletAtKeeperFloor() public { _keeperFloor(false, true); }
    function test_WIRING_coldLongHistoryLockAtKeeperFloor() public { _keeperFloor(false, false); }

    function _keeperFloor(bool burn, bool first) private {
        _linkedEat(burn, first); _fill(); box.graduate(); receiver.collect(address(0));
        if (!first) {
            vm.pauseGasMetering();
            for (uint256 i; i < 512; ++i) {
                vm.prank(address(buyer)); price.transfer(address(0xdEaD), 1);
                vm.prank(address(0xdEaD)); price.transfer(address(buyer), 1);
            }
            vm.resumeGasMetering();
        }
        uint256 pending = eat.eatPendingP();
        uint256 supply = price.totalSupply();
        uint256 dead = price.balanceOf(address(0xdEaD));
        _cold(release.implementations[5]);
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory result) = address(eat).call{gas: CALL_GAS}(abi.encodeCall(IBoxReceiverEatV21.eatPriceCoin, ()));
        emit log_named_uint("keeper cold complete call gas", beforeGas - gasleft());
        assertTrue(ok, "keeper admission must fund the entire optional call");
        assertEq(abi.decode(result, (uint256)), pending, "must make progress at the signed floor");
        assertEq(eat.eatPendingP(), 0); assertEq(eat.eatenP(), pending);
        assertEq(price.totalSupply(), burn ? supply - pending : supply);
        assertEq(price.balanceOf(address(0xdEaD)), burn ? dead : dead + pending);
        _booked();
    }
}

contract KeeperEatHostileEnvelopeTest is EatTest {
    function test_WIRING_exhaustedOptionalCapRestoresClaimsAtKeeperFloor() public {
        _burnable(); _fees(1500, 1500); r.collect(address(0)); coord.graduation(r); price.mode(3);
        uint256 balance = _balance(address(r)); uint256 supply = price.totalSupply();
        vm.cool(address(r)); vm.cool(address(implementation)); vm.cool(address(coord));
        vm.cool(coordinatorCode); vm.cool(address(price)); vm.cool(address(pm));
        ReceiverDeploy.cool(address(implementation));
        (bool ok, bytes memory result) = address(e).call{gas: 3_500_000 - 21_064}(abi.encodeCall(EatReceiver.eatPriceCoin, ()));
        assertTrue(ok, "outer reserve must survive full optional gas exhaustion");
        assertEq(abi.decode(result, (uint256)), 0);
        assertEq(e.eatPendingP(), 2000); assertEq(e.eatenP(), 0);
        assertEq(_balance(address(r)), balance); assertEq(r.booked(address(price)), balance);
        assertEq(price.totalSupply(), supply); assertEq(price.balanceOf(DEAD), 0);
        price.mode(0); assertEq(e.eatPriceCoin(), 2000);
    }
}
