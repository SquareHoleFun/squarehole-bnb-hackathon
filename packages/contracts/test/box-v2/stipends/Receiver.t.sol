// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M363Base, LifeCustody} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";
import {HolderLedgerV2} from "../../../src/box-v2/HolderLedgerV2.sol";
import {ReceiverStipendProbe} from "./ReceiverProbe.sol";

contract ReceiverStipendsTest is M363Base {
    address private constant WALLET = address(0xBEE123);

    function _ready(uint256 kind) private returns (address to, ReceiverStipendProbe probe) {
        if (kind == 0 || kind == 4) vm.etch(CREATOR, address(new LifeCustody()).code);
        BoxSpec memory s = kind == 6 ? _collectionSpec() : _menu(2, 3);
        s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s); _fill(); box.graduate();
        if (kind != 0 && kind != 4) {
            vm.prank(address(buyer)); token.transfer(address(0xE1191B1E), 1 ether);
            BoxTokenV2Ledger history = BoxTokenV2Ledger(address(token));
            assertGt(history.eligibleSupplyAt(history.holderCheckpoint()), 0);
        }
        to = kind == 1 || kind == 2 || kind == 3 ? address(new LifeCustody()) : WALLET;
        if (kind == 4) vm.etch(to, abi.encodePacked(hex"ef0100", address(new LifeCustody())));
        if (kind == 2 || kind == 3) {
            vm.prank(to); HolderLedgerV2(box.roleAddress(17)).register();
        }
        if (kind == 3) {
            vm.prank(address(buyer)); token.transfer(to, 1 ether);
            vm.pauseGasMetering();
            for (uint256 i; i < 512; ++i) {
                vm.prank(to); token.transfer(WALLET, 1);
                vm.prank(WALLET); token.transfer(to, 1);
            }
            vm.resumeGasMetering();
        }
        vm.prank(address(buyer)); token.transfer(address(receiver), 1 ether);
        probe = new ReceiverStipendProbe(pm, release.implementations[0], fitSafe, address(this), conversionSafe);
        // Keep custody/storage at the real box address, but delegate to the measurement implementation.
        // Its constructor-created callback authenticates that exact implementation's direct clones.
        bytes memory runtime = address(receiver).code;
        for (uint256 i; i < 20; ++i) runtime[10 + i] = bytes20(address(probe))[i];
        vm.etch(address(receiver), runtime);
        release.implementations[5] = address(probe);
        probe = ReceiverStipendProbe(payable(address(receiver)));
    }

    function _cold(address to) private {
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
        vm.cool(address(pm)); vm.cool(to);
    }

    function test_receiverBurnNonzeroEligibleSupply() public { _burn(5); }
    function test_receiverBurnLongHistory() public { _burn(3); }
    function test_receiverBurnWithShareVaultFloor() public { _burn(6); }
    function _burn(uint256 kind) private {
        (address to, ReceiverStipendProbe probe) = _ready(kind);
        (, uint256 cap) = probe.caps();
        uint256 supply = token.totalSupply();
        uint256 snap = vm.snapshotState(); _cold(to);
        uint256 used = probe.measure(true, address(token), address(0), 1 ether, 6_000_000);
        emit log_named_uint("receiver burn complete cold unlock", used);
        assertEq(token.totalSupply(), supply - 1 ether);
        assertEq(token.balanceOf(address(receiver)), 0);
        assertLe(used * 2, cap, "receiver burn strict twice margin");
        assertTrue(vm.revertToState(snap)); _cold(to);
        probe.measure(true, address(token), address(0), 1 ether, cap / 2);
        assertEq(token.totalSupply(), supply - 1 ether);
    }
}
