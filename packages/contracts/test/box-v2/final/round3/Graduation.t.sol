// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PokeStipendsTest, PokeGasSink} from "../../stipends/Pokes.t.sol";
import {GasBudget} from "../../gas/GasBudget.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../../src/box-v2/interfaces/RecipeTypes.sol";
import {IHolderTokenHistoryV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {KeeperReleaseGas} from "./PublishedGas.sol";
import {IBoxCoordinator} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

/// Check the second burn omitted by the earlier graduation exhaustion fixture: anyone can gift
/// liquid T to the hook. Sink substitutions measure the advertised fail-safe envelope, not honest T cost.
contract Round3GraduationTest is PokeStipendsTest {
    enum Variant { Plain, SellerHolders, BuyerHolders, BothHolders, ItemsAndHolders }

    function test_R3_graduationEnvelopeCarriesBothBurnsAndBothPokes() public { _graduate(KeeperReleaseGas.GRADUATE); }
    function test_R3_twelvePointFiveMillionControlFitsTransactionCap() public { _graduate(12_500_000); }
    function test_R3_largerGraduationControlStillFitsTransactionCap() public { _graduate(14_000_000); }
    function test_R3_thirteenMillionPlainControl() public { _graduate(13_000_000); }
    function test_R3_thirteenPointFiveMillionPlainControl() public { _graduate(13_500_000); }
    function test_R3_ledgerPublishedEnvelopeCarriesBothBurnsAndBothPokes() public {
        _graduate(KeeperReleaseGas.GRADUATE, true);
    }
    function test_R3_oldTwelveMillionPlainCounterexample() public {
        _graduate(12_000_000, Variant.Plain, true);
    }
    function test_R3_oldTwelveMillionLedgerCounterexample() public {
        _graduate(12_000_000, Variant.SellerHolders, true);
    }
    function test_R3_ledgerTwelvePointFiveMillionCounterexample() public {
        _graduate(12_500_000, Variant.SellerHolders, true);
    }
    function test_R3_ledgerThirteenMillionCounterexample() public {
        _graduate(13_000_000, Variant.SellerHolders, true);
    }
    function test_R3_ledgerThirteenPointFiveMillionControl() public { _graduate(13_500_000, true); }
    function test_R3_ledgerFourteenMillionControl() public { _graduate(14_000_000, true); }
    function test_R3_buyerHoldersThirteenPointFiveMillionControl() public {
        _graduate(13_500_000, Variant.BuyerHolders);
    }
    function test_R3_bothHoldersThirteenPointFiveMillionControl() public {
        _graduate(13_500_000, Variant.BothHolders);
    }
    function test_R3_itemsAndHoldersThirteenPointFiveMillionControl() public {
        _graduate(13_500_000, Variant.ItemsAndHolders);
    }

    function _graduate(uint256 envelope) private {
        _graduate(envelope, false);
    }

    function _graduate(uint256 envelope, bool ledger) private {
        _graduate(envelope, ledger ? Variant.SellerHolders : Variant.Plain);
    }

    function _graduate(uint256 envelope, Variant variant) private {
        _graduate(envelope, variant, false);
    }

    function _graduate(uint256 envelope, Variant variant, bool oldEnvelope) private {
        BoxSpec memory spec = _hiddenSpec();
        if (variant == Variant.SellerHolders || variant == Variant.BothHolders || variant == Variant.ItemsAndHolders) {
            spec.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        }
        if (variant == Variant.BuyerHolders || variant == Variant.BothHolders) {
            spec.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        }
        if (variant == Variant.ItemsAndHolders) spec.buyers.a = Branch(1, 8, "", abi.encode(uint8(1)));
        _start(spec); _fill();
        if (variant != Variant.Plain) {
            address holder = address(0xA11CE);
            vm.prank(address(buyer)); token.transfer(holder, 1 ether);
            IHolderTokenHistoryV2 history = IHolderTokenHistoryV2(address(token));
            assertEq(history.eligibleBalanceAt(holder, history.holderCheckpoint()), 1 ether);
        }
        vm.prank(address(buyer)); token.transfer(address(hook), 1 ether);
        uint256 supplied = token.totalSupply();
        uint256 hookHeld = token.balanceOf(address(hook));
        PokeGasSink sink = new PokeGasSink();
        vm.mockFunction(address(token), address(sink), abi.encodeWithSignature("burn(uint256)"));
        vm.mockFunction(address(receiver), address(sink), abi.encodeCall(receiver.onGraduation, ()));
        vm.mockFunction(box.tickets(), address(sink), abi.encodeWithSignature("requestGraduationWord()"));
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
        bytes memory data = abi.encodeCall(box.graduate, ());
        uint256 start = gasleft();
        (bool ok, bytes memory ret) = address(box).call{gas: envelope - GasBudget.intrinsic(data)}(data);
        uint256 used = GasBudget.transaction(start - gasleft(), data);
        emit log_named_uint("graduation variant", uint256(variant));
        emit log_named_uint("four-call graduation supplied", envelope);
        emit log_named_uint("four-call graduation gross", used);
        if (!ok) emit log_bytes(ret);
        // The lower controls succeeded on Cancun but cannot admit the final poke on Amsterdam.
        // Release assertions above always require success, using the generated published floor.
        if (oldEnvelope && keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam")) {
            assertFalse(ok, "obsolete envelope must expose the Amsterdam admission shortfall");
            _assertPokeAdmissionRefused(ret);
            assertFalse(box.graduated(), "underfunded graduation is atomic");
            assertEq(token.totalSupply(), supplied);
            assertEq(token.balanceOf(address(hook)), hookHeld);
            return;
        }
        assertTrue(ok, "published graduation envelope must carry two burns and two pokes");
        assertTrue(box.graduated());
        assertGt(used, (2 * C.BURN_GAS + 2 * box.POKE_GAS()) * 9 / 10);
        assertLt(used, envelope); assertLt(envelope, 16_777_216);
        assertEq(token.totalSupply(), supplied, "refused burns cannot report a supply reduction");
        assertEq(token.balanceOf(address(hook)), hookHeld, "refused gifted T stays at its owner");
        vm.clearMockedCalls();
        receiver.collect(address(0));
        assertTrue(receiver.graduationSettled(), "failed receiver poke remains independently recoverable");
    }

    function _assertPokeAdmissionRefused(bytes memory ret) private view {
        assertEq(ret.length, 68);
        assertEq(bytes4(ret), IBoxCoordinator.GasTooLow.selector);
        uint256 available;
        uint256 required;
        assembly {
            available := mload(add(ret, 36))
            required := mload(add(ret, 68))
        }
        assertEq(required, box.POKE_GAS() + box.POKE_GAS() / 63 + C.POKE_OVERHEAD_GAS);
        assertLt(available, required);
    }
}
