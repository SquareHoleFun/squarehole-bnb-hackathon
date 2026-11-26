// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {M363Base, LifeCustody} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxReceiverPileV21} from "../../../src/box-v2/interfaces/IBoxReceiverPileV21.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {BoxReceiverV2Args as A} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxTokenV2Ledger} from "../../../src/box-v2/BoxTokenV2Ledger.sol";

contract PileGasProbe is BoxReceiverV2 {
    constructor(IPoolManager pm, address c, address f, address p, address x) BoxReceiverV2(pm, c, f, p, ReceiverDeploy.code(pm)) {}
    function caps() external pure returns (uint256, uint256) { return (PILE_MOVE_GAS, PILE_MOVE_RESERVE_GAS); }
    // Test-only instrumentation; production callback and its full exactness checks remain inherited.
    function measured(uint256 cap) external locked returns (uint256 used) {
        _prepare();
        uint256 amount = _pilePendingP;
        _pilePendingP = 0;
        uint256 before_ = gasleft();
        require(_tryUnlock(MOVE_PILE, _priceCoin(), A.addressAt(267), amount, cap), "pile probe refused");
        used = before_ - gasleft();
    }
}
contract PileGasTest is M363Base {
    BoxTokenV2 internal price;
    BoxCoordinatorV2 internal origin;
    IBoxReceiverPileV21 internal pileFees;
    function _linkedPile(bool firstHolder) internal {
        if (firstHolder) vm.etch(CREATOR, address(new LifeCustody()).code);
        BoxSpec memory first = _spec();
        first.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
        first.sellers.a = first.buyers.a;
        _start(first); _fill(); box.graduate(); origin = box; price = token;
        vm.startPrank(address(buyer));
        price.transfer(address(this), 10_000); price.transfer(CREATOR, 1000 ether);
        vm.stopPrank(); price.approve(address(listings), 10_000);
        uint32 id = listings.add(address(price), ListingClass.OTHER, 100 ether);
        BoxSpec memory second = _pile(address(price), 0);
        second.contentsParams = abi.encode(address(price), uint256(0), uint16(500));
        second.buyers.a = Branch(1, 7, "", ""); second.sellers.a = second.buyers.a;
        second.pricing.token = address(price); second.pricing.listingId = id; second.raise = 100 ether;
        vm.prank(CREATOR); price.approve(address(factory), 1000 ether);
        box = _create(second);
        token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook()); receiver = IBoxReceiverV2(box.receiver());
        pileFees = IBoxReceiverPileV21(address(receiver)); layout = BoxLayoutV2.curve(second.raise, false);
        vm.warp(box.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        _buy(20 ether); receiver.collect(address(0));
        assertGt(pileFees.pilePendingP(), 0);
    }
    function _cold(address probe) internal {
        address[48] memory parts;
        for (uint256 i; i < 24; ++i) {
            parts[i] = box.roleAddress(i); parts[i + 24] = origin.roleAddress(i);
        }
        for (uint256 i; i < 24; ++i) {
            address impl = release.implementations[i];
            if (impl == address(0)) continue;
            address child = vm.computeCreateAddress(impl, 1);
            if (child.code.length != 0) vm.cool(child);
            if (i == 5) ReceiverDeploy.cool(impl);
            vm.cool(impl);
        }
        for (uint256 i; i < 48; ++i) if (parts[i] != address(0)) vm.cool(parts[i]);
        ReceiverDeploy.cool(probe);
        vm.cool(probe); vm.cool(box.vault()); vm.cool(address(pm));
    }
    function test_PF11_coldFirstLedgerRecipient() public { _measure(true); }
    function test_PF11_coldLongLedgerHistory() public { _measure(false); }
    function _measure(bool first) internal {
        _linkedPile(first); _fill(); box.graduate(); receiver.collect(address(0));
        if (first) assertEq(BoxTokenV2Ledger(address(price)).holderCount(), 0);
        address pile = box.vault();
        if (!first) {
            vm.pauseGasMetering();
            for (uint256 i; i < 512; ++i) {
                vm.prank(address(buyer)); price.transfer(pile, 1);
                // Test setup builds real history; the production pile has no arbitrary-transfer method.
                vm.prank(pile); price.transfer(address(buyer), 1);
            }
            vm.resumeGasMetering();
        }
        PileGasProbe code = new PileGasProbe(pm, release.implementations[0], fitSafe, address(this), conversionSafe);
        bytes memory runtime = address(receiver).code;
        for (uint256 i; i < 20; ++i) runtime[10 + i] = bytes20(address(code))[i];
        vm.etch(address(receiver), runtime);
        PileGasProbe probe = PileGasProbe(address(receiver));
        (uint256 cap,) = probe.caps();
        uint256 amount = pileFees.pilePendingP(); uint256 supply = price.totalSupply();
        uint256 snapshot = vm.snapshotState(); _cold(address(code));
        uint256 used = probe.measured(6_000_000);
        emit log_named_uint("cold pile move unlock", used);
        assertLe(used * 2, cap, "twice strict complete unlock bound");
        assertEq(price.totalSupply(), supply); assertEq(price.balanceOf(box.vault()), amount);
        assertTrue(vm.revertToState(snapshot)); _cold(address(code));
        probe.measured(cap / 2);
        assertEq(price.totalSupply(), supply); assertEq(price.balanceOf(box.vault()), amount);
    }
}
