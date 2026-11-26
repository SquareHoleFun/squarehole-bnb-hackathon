// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxReceiverV2, IBoxReceiverItemsV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTicketsV2} from "../../../src/box-v2/BoxTicketsV2.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

contract PokeGasSink {
    fallback() external payable { assembly { invalid() } }
}

contract PokeStipendsTest is M363Base {
    function _cold() private {
        address[24] memory parts;
        for (uint256 i; i < 24; ++i) parts[i] = box.roleAddress(i);
        for (uint256 i; i < 24; ++i) {
            if (parts[i] != address(0)) vm.cool(parts[i]);
            address impl = release.implementations[i];
            if (impl != address(0)) {
                address helper = vm.computeCreateAddress(impl, 1);
                if (helper.code.length != 0) vm.cool(helper);
                // SH-V21-00-ROOM: the receiver callback is constructor child 2.
                if (i == 5) vm.cool(vm.computeCreateAddress(impl, 2));
                vm.cool(impl);
            }
        }
        vm.cool(address(pm));
    }

    function test_graduationPokeTwoFreshItemReceipts() public {
        _start(_items(1, 1));
        (, uint256 bought) = _buy(box.raise() / 10);
        buyer.swap(hook.poolKey(), false, bought / 4, layout.sqrtPriceStartX96);
        _fill(); receiver.collect(address(0));
        assertGt(receiver.itemsHeldP(), 0);
        vm.mockCallRevert(address(receiver), abi.encodeCall(receiver.onGraduation, ()), "hold for measurement");
        box.graduate(); vm.clearMockedCalls();
        uint256 held = receiver.itemsHeldP();
        uint256 cap = box.POKE_GAS();
        uint256 snap = vm.snapshotState(); _cold();
        vm.prank(address(box)); uint256 start = gasleft(); receiver.onGraduation();
        uint256 used = start - gasleft();
        emit log_named_uint("two item graduation receipts cold", used);
        assertEq(receiver.itemsHeldP(), 0);
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 2);
        assertEq(pm.balanceOf(box.roleAddress(16), 0), held);
        assertLe(used * 2, cap, "graduation poke strict twice margin");
        assertTrue(vm.revertToState(snap)); _cold(); vm.prank(address(box));
        (bool ok,) = address(receiver).call{gas: cap / 2}(abi.encodeCall(receiver.onGraduation, ()));
        assertTrue(ok, "graduation poke half allowance");
    }

    function test_graduationWordPokeFreshRealSource() public {
        DrandSource source = new DrandSource();
        vm.etch(release.randomness, address(source).code);
        vm.warp(source.GENESIS_TIME() + 100);
        _start(_hiddenSpec()); _fill();
        BoxTicketsV2 tickets = BoxTicketsV2(box.tickets());
        address owner = address(0xA11CE);
        uint256 balance = token.balanceOf(address(buyer));
        vm.prank(address(buyer)); token.transfer(owner, balance);
        vm.startPrank(owner);
        token.approve(address(tickets), balance);
        tickets.take(1, balance, block.timestamp);
        vm.stopPrank();
        vm.mockCallRevert(address(tickets), abi.encodeCall(tickets.requestGraduationWord, ()), "hold request");
        box.graduate(); vm.clearMockedCalls();
        uint256 cap = box.POKE_GAS();
        uint256 snap = vm.snapshotState(); _cold(); vm.cool(release.randomness);
        uint256 start = gasleft(); tickets.requestGraduationWord();
        uint256 used = start - gasleft();
        emit log_named_uint("graduation word poke cold", used);
        assertLe(used * 2, cap);
        assertTrue(vm.revertToState(snap)); _cold(); vm.cool(release.randomness);
        (bool ok,) = address(tickets).call{gas: cap / 2}(abi.encodeCall(tickets.requestGraduationWord, ()));
        assertTrue(ok, "real randomness request fits half poke allowance");
    }

    function test_graduationExhaustsBothPokesAndBurnBelowTransactionCap() public {
        _start(_hiddenSpec()); _fill();
        PokeGasSink sink = new PokeGasSink();
        vm.mockFunction(address(token), address(sink), abi.encodeWithSignature("burn(uint256)"));
        vm.mockFunction(address(receiver), address(sink), abi.encodeCall(receiver.onGraduation, ()));
        vm.mockFunction(box.tickets(), address(sink), abi.encodeWithSignature("requestGraduationWord()"));
        uint256 cap = box.POKE_GAS();
        bytes memory data = abi.encodeCall(box.graduate, ());
        uint256 limit = 12_000_000;
        _cold(); uint256 start = gasleft();
        (bool ok,) = address(box).call{gas: limit - GasBudget.intrinsic(data)}(data);
        uint256 used = GasBudget.transaction(start - gasleft(), data);
        emit log_named_uint("graduation all optional calls exhausted", used);
        assertTrue(ok && box.graduated());
        assertGt(used, (C.BURN_GAS + cap * 2) * 9 / 10);
        assertLt(used, limit); assertLt(limit, 16_777_216);
    }
}
