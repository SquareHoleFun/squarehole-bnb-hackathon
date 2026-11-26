// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PayInTLifecycleTest, RewardItemOwner} from "./Lifecycle.t.sol";
import {LifeCustody} from "../m3-63-fix-create/Fixture.sol";
import {ClaimCap} from "../gas/m3/ClaimCap.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {HolderLedgerV2} from "../../../src/box-v2/HolderLedgerV2.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";
import {BoxVaultV2} from "../../../src/box-v2/BoxVaultV2.sol";

contract PayInTGasTest is PayInTLifecycleTest {
    address constant OWNER = address(0xB021);
    function _cold(address ledger) private {
        for (uint256 i; i < 24; ++i) {
            address part = box.roleAddress(i); if (part != address(0)) vm.cool(part);
            address impl = release.implementations[i]; if (impl != address(0)) vm.cool(impl);
        }
        vm.cool(ledger); vm.cool(address(pm)); vm.cool(OWNER); vm.cool(address(buyer));
    }
    function _itemCredit(bool history) private returns (ItemLedgerV2 ledger, uint256 owed) {
        vm.etch(CREATOR, address(new LifeCustody()).code);
        BoxSpec memory s = _rewardSpec(true, false);
        s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        _start(s); _fill(); box.graduate(); receiver.collect(address(0));
        vm.roll(block.number + 1); receiver.buyBack(address(0));
        ledger = ItemLedgerV2(box.roleAddress(16)); ledger.sync(32); _reveal(1);
        vm.etch(address(buyer), address(new RewardItemOwner()).code);
        vm.startPrank(address(buyer)); token.approve(box.vault(), type(uint256).max);
        BoxVaultV2(box.vault()).withdraw(1, type(uint256).max, block.timestamp); vm.stopPrank();
        ledger.sync(32); (uint256 a, uint256 b) = ledger.itemCreditT(1); owed = a + b; assertGt(owed, 0);
        if (history) {
            for (uint256 i; i < 512; ++i) {
                vm.prank(address(buyer)); token.transfer(OWNER, 1);
                vm.prank(OWNER); token.transfer(address(buyer), 1);
            }
        } else assertEq(BoxTokenV2Ledger(address(token)).holderCount(), 0);
    }
    function _claimItem(ItemLedgerV2 ledger) private returns (bool ok) {
        uint256[] memory ids = new uint256[](1); ids[0] = 1;
        bytes memory data = abi.encodeCall(ItemLedgerV2.claimT, (ids, OWNER));
        _cold(address(ledger)); vm.prank(address(buyer)); (ok,) = address(ledger).call{gas: 6_000_000}(data);
    }
    function test_T11_itemColdFirstEligible7702StrictStipendTwiceMargin() public { _itemGas(false); }
    function test_T12_itemCold1024HistoryStrictStipendTwiceMargin() public { _itemGas(true); }
    function _itemGas(bool history) private {
        (ItemLedgerV2 ledger, uint256 owed) = _itemCredit(history);
        if (!history) vm.etch(OWNER, abi.encodePacked(hex"ef0100", address(new LifeCustody())));
        uint256 cap = ledger.CLAIM_GAS(); bytes memory runtime = release.implementations[16].code;
        uint256 snap = vm.snapshotState(); uint256 low; uint256 high = cap;
        while (low + 1 < high) {
            assertTrue(vm.revertToState(snap));
            uint256 mid = (low + high) / 2;
            vm.etch(release.implementations[16], ClaimCap.replace(bytes.concat(runtime), cap, mid, 2));
            if (_claimItem(ledger)) high = mid; else low = mid;
        }
        emit log_named_uint("strict cold T item payout stipend", high); assertLe(high * 2, cap);
        assertTrue(vm.revertToState(snap));
        vm.etch(release.implementations[16], ClaimCap.replace(bytes.concat(runtime), cap, cap / 2, 2));
        assertTrue(_claimItem(ledger)); assertEq(token.balanceOf(OWNER), owed);
        assertTrue(vm.revertToState(snap));
        vm.etch(release.implementations[16], ClaimCap.replace(bytes.concat(runtime), cap, high - 1, 2));
        assertFalse(_claimItem(ledger)); (uint256 a, uint256 b) = ledger.itemCreditT(1); assertEq(a + b, owed);
        assertEq(token.balanceOf(OWNER), 0);
    }
    function test_T13_holderCold1024HistoryClaimAndResidueExit() public { _holderGas(true); }
    function test_T14_holderColdFirstEligible7702ClaimAndResidueExit() public { _holderGas(false); }
    function _holderGas(bool history) private {
        vm.etch(CREATOR, address(new LifeCustody()).code);
        _start(_rewardSpec(false, false)); HolderLedgerV2 ledger = HolderLedgerV2(box.roleAddress(17));
        vm.prank(address(buyer)); ledger.register(); _buy(box.raise() / 10); receiver.collect(address(0));
        _fill(); box.graduate(); receiver.collect(address(0));
        for (uint256 i; i < 20 && PayInTReceiverLike(address(receiver)).rewardsPendingP() != 0; ++i) { vm.roll(block.number + 1); receiver.buyBack(address(0)); }
        if (history) {
            for (uint256 i; i < 512; ++i) { vm.prank(address(buyer)); token.transfer(OWNER, 1); vm.prank(OWNER); token.transfer(address(buyer), 1); }
        } else {
            uint256 balance = token.balanceOf(address(buyer));
            vm.prank(address(buyer)); token.transfer(address(receiver), balance);
            vm.etch(OWNER, abi.encodePacked(hex"ef0100", address(new LifeCustody())));
            assertEq(BoxTokenV2Ledger(address(token)).eligibleSupplyAt(BoxTokenV2Ledger(address(token)).holderCheckpoint()), 0);
        }
        uint256 paid;
        for (uint256 id = 1; id < hook.currentTradeBatch(true); id += 2) {
            while (!ledger.settleBatch(id, 64)) {}
            uint256 credit = ledger.claimable(id, address(buyer));
            if (credit == 0) { ledger.flushResidue(id); continue; }
            uint256 snap = vm.snapshotState();
            bytes memory code = release.implementations[17].code;
            uint256 cap = ledger.CLAIM_T_GAS(); uint256 low; uint256 high = cap;
            while (low + 1 < high) {
                assertTrue(vm.revertToState(snap)); uint256 mid = (low + high) / 2;
                vm.etch(release.implementations[17], ClaimCap.replace(bytes.concat(code), cap, mid, 2));
                _cold(address(ledger)); vm.prank(address(buyer));
                (bool ok,) = address(ledger).call{gas: 6_000_000}(abi.encodeCall(HolderLedgerV2.claim, (id, OWNER)));
                if (ok) high = mid; else low = mid;
            }
            emit log_named_uint("strict cold T holder payout stipend", high); assertLe(high * 2, cap);
            assertTrue(vm.revertToState(snap)); _cold(address(ledger));
            vm.prank(address(buyer)); paid += ledger.claim(id, OWNER); ledger.flushResidue(id);
        }
        assertGt(paid, 0); assertEq(token.balanceOf(OWNER), paid);
        assertEq(pm.balanceOf(address(ledger), uint160(address(token))), 0, "all bought T exits, including partial batches");
    }
}
interface PayInTReceiverLike { function rewardsPendingP() external view returns (uint256); }
