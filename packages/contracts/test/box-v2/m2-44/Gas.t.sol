// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "./Fixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract M244BurnGasTest is M244Base {
    function test_bothBurnCapsCanBeExhaustedWithoutLosingCustodyOrContinuation() public {
        _createShop(0, 1000 ether, false, false);
        vm.prank(CREATOR); token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        bytes memory original = address(token).code;
        (uint256 pot, uint256 left) = box.claimState();
        vm.etch(address(token), hex"fe"); // every token call exhausts its forwarded gas
        uint256 gasBefore = gasleft();
        // INT-PINS: both raised caps plus EIP-150/reserve use M2-60's measured 5M exhaustion envelope.
        assertEq(shop.burnFailedT{gas: 5000000}(), 0);
        assertGt(gasBefore - gasleft(), 2000000, "both optional envelopes were activated");
        vm.etch(address(token), original);
        assertEq(shop.failedT(), 1100 ether);
        assertEq(token.balanceOf(address(shop)), 1000 ether);
        assertEq(pm.balanceOf(address(shop), uint160(address(token))), 100 ether);
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot); assertEq(afterLeft, left); _assertOutstanding();
        assertEq(shop.burnFailedT{gas: 4000000}(), 1100 ether);
        _assertOutstanding();
    }

    function test_burnGasSweepPreservesCustodyAndOutstandingUntilBothExitsRun() public {
        _createShop(0, 1000 ether, false, false);
        vm.prank(CREATOR); token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        _assertOutstanding();
        uint256 state = vm.snapshotState();
        uint256 supply = token.totalSupply();
        (uint256 pot, uint256 left) = box.claimState();
        bool skipped; bool partlyBurned; bool complete;
        // Cross both pre-check activation regions with cold contract access and fresh history slots.
        for (uint256 gasLimit = 300000; gasLimit <= 4000000; gasLimit += 100000) {
            vm.cool(address(shop)); vm.cool(address(token)); vm.cool(address(pm));
            vm.cool(release.implementations[21]); vm.cool(release.implementations[20]);
            (bool ok, bytes memory result) = address(shop).call{gas: gasLimit}(abi.encodeCall(shop.burnFailedT, ()));
            assertTrue(ok, "optional burns cannot consume their continuation reserve");
            uint256 burned = abi.decode(result, (uint256));
            if (gasLimit == 1000000) assertEq(burned, 0, "old keeper floor cannot activate ledger burns");
            assertEq(shop.failedT() + burned, 1100 ether);
            assertEq(token.totalSupply(), supply - burned);
            (uint256 afterPot, uint256 afterLeft) = box.claimState();
            assertEq(afterPot, pot); assertEq(afterLeft, left); _assertOutstanding();
            skipped = skipped || burned == 0;
            partlyBurned = partlyBurned || (burned != 0 && burned < 1100 ether);
            complete = complete || burned == 1100 ether;
            assertTrue(vm.revertToState(state));
        }
        assertTrue(skipped); assertTrue(partlyBurned); assertTrue(complete);
        uint256 gasBefore = gasleft();
        assertEq(shop.burnFailedT{gas: 4000000}(), 1100 ether);
        emit log_named_uint("real ledger shop liquid plus claims burn gas", gasBefore - gasleft());
    }

    function test_allReleasePartsPreserveTheReservedSizeGate() public view {
        for (uint256 i; i < 24; ++i) {
            if (release.implementations[i] != address(0)) assertLe(release.implementations[i].code.length, 22118);
        }
    }
}
