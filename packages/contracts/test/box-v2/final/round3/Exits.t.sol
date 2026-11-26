// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../../rc5-a/NoFailureSweep.sol";

import {Round2RemainingExitsTest} from "../round2/money/RemainingExits.t.sol";
import {BoxTokenV2} from "../../../../src/box-v2/BoxTokenV2.sol";
import {BoxTokenV2Ledger} from "../../../../src/box-v2/BoxTokenV2Ledger.sol";
import {ClaimCap} from "../../gas/m3/ClaimCap.sol";
import {GasBudget} from "../../gas/GasBudget.sol";

/// FINAL3: production exits after independent accounting transitions. The inherited five Round 2
/// assertions are retained. FINAL3_OLD_CAPS is an opt-in historical mutation, never a release profile.
contract Round3ExitsTest is Round2RemainingExitsTest {
    address private constant CALLER = address(0xCA11E3);

    function _historicalCap(uint256 current, uint256 previous) private {
        if (vm.envOr("FINAL3_OLD_CAPS", false)) {
            vm.etch(release.implementations[5],
                ClaimCap.replace(release.implementations[5].code, current, previous, 1));
        }
    }

    function _cold(BoxTokenV2 asset) private {
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
        vm.cool(address(asset)); vm.cool(address(pm)); vm.cool(conversionSafe); vm.cool(CALLER);
    }

    function _call(address target, bytes memory data, uint256 envelope) private returns (uint256 result) {
        assertLe(envelope, 16_777_216);
        vm.prank(CALLER);
        uint256 start = gasleft();
        (bool ok, bytes memory ret) = target.call{gas: envelope - GasBudget.intrinsic(data)}(data);
        uint256 used = GasBudget.transaction(start - gasleft(), data);
        emit log_named_uint("round3 supplied transaction gas", envelope);
        emit log_named_uint("round3 gross transaction gas", used);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        assertLt(used, envelope);
        return abi.decode(ret, (uint256));
    }

    function test_R3_singleRawRoyaltyStaysLockedAfterFailureWithoutReopeningClaims() public { _royaltyAfterFailure(1); }
    function test_R3_fullRoyaltyStaysLockedAfterFailureWithoutReopeningClaims() public { _royaltyAfterFailure(1 ether); }

    /// F136 (SH-V21-RC5-INT fix round): a lot still held when the box fails never leaves it. Years later a retry, inside
    /// the same envelope FINAL2-M01 measured for a live forward, moves nothing and touches no claim.
    function _royaltyAfterFailure(uint256 amount) private {
        BoxTokenV2 royalty = _royaltyReady();
        vm.warp(box.deadline()); box.fail();
        bytes32 beforeMoney = _moneyFingerprint();
        uint256 beforeBalance = royalty.balanceOf(address(this));
        vm.expectRevert(); receiver.fundRoyalty(address(royalty), amount);
        assertEq(royalty.balanceOf(address(this)), beforeBalance);
        assertEq(royalty.balanceOf(address(receiver)), 0);
        assertEq(royalty.balanceOf(conversionSafe), 0);
        assertEq(_moneyFingerprint(), beforeMoney);
    }

    function test_R3_pendingBurnAfterHolderMutationConsumesOnlyPurchasedT() public {
        _holdersAndBurn();
        vm.mockCallRevert(address(token), abi.encodeWithSignature("burn(uint256)"), "hold purchase");
        (,, uint256 bought,) = receiver.buyBack(address(0));
        vm.clearMockedCalls();
        assertGt(bought, 0); assertEq(receiver.tBurnPending(), bought);
        BoxTokenV2Ledger history = BoxTokenV2Ledger(address(token));
        vm.prank(address(0xA11CE)); token.transfer(address(0xB0B), 1);
        uint256 checkpoint = history.holderCheckpoint();
        uint256 eligible = history.eligibleSupplyAt(checkpoint);
        uint256 supply = token.totalSupply();
        bytes32 money = _moneyFingerprint();
        _historicalCap(1_000_000, 250_000);
        _cold(token);
        assertEq(_call(address(receiver), abi.encodeCall(receiver.burnPending, ()), 1_500_000), bought,
            "FINAL2-M02: nonzero eligible history must not strand purchased T");
        assertEq(receiver.tBurnPending(), 0); assertEq(token.balanceOf(address(receiver)), 0);
        assertEq(token.totalSupply(), supply - bought);
        assertEq(token.totalSupply() + token.totalBurned(), token.initialSupply());
        assertEq(history.eligibleSupplyAt(checkpoint), eligible);
        assertEq(history.eligibleSupplyAt(history.holderCheckpoint()), eligible);
        assertEq(token.balanceOf(address(0xB0B)), 1);
        assertEq(token.balanceOf(CALLER), 0);
        assertEq(_moneyFingerprint(), money, "retry neither spends P nor tips the caller");
        assertEq(receiver.burnPending(), 0);
    }

    function _moneyFingerprint() private view returns (bytes32) {
        (uint256 pot, uint256 left) = box.claimState();
        return keccak256(abi.encode(pot, left, receiver.fitOwed(), receiver.platformOwed(),
            receiver.buyBackP(), receiver.booked(address(0)), pm.balanceOf(address(receiver), 0),
            address(pm).balance, CALLER.balance));
    }
}
