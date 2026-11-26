// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {LinkedPriceFixture} from "../final/money/LinkedPriceFixture.sol";
import {LifeCustody} from "../m3-63-fix-create/Fixture.sol";
import {HookStipendProbe} from "./HookProbe.sol";
import {BoxHookV2} from "../../../src/box-v2/BoxHookV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxLaunchRouterV2} from "../../../src/box-v2/BoxLaunchRouterV2.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {PayoutProbe} from "../payout-gas/Probe.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {StipendSink} from "./Envelopes.t.sol";

contract ProtocolStipendsTest is LinkedPriceFixture {
    function _cold() private {
        address[48] memory parts;
        for (uint256 i; i < 24; ++i) {
            parts[i] = box.roleAddress(i);
            parts[i + 24] = origin.roleAddress(i);
        }
        for (uint256 i; i < 24; ++i) {
            address impl = release.implementations[i];
            if (impl != address(0)) {
                address helper = vm.computeCreateAddress(impl, 1);
                if (helper.code.length != 0) vm.cool(helper);
                // SH-V21-00-ROOM: the receiver callback is constructor child 2.
                if (i == 5) vm.cool(vm.computeCreateAddress(impl, 2));
                vm.cool(impl);
            }
        }
        for (uint256 i; i < 48; ++i) if (parts[i] != address(0)) vm.cool(parts[i]);
        vm.cool(address(pm)); vm.cool(ALICE);
    }

    function _hookProbe(address h) private returns (HookStipendProbe probe) {
        address ext = BoxHookV2(h).extension();
        probe = new HookStipendProbe(pm, release.implementations[0], ext);
        vm.etch(release.implementations[2], address(probe).code);
        return HookStipendProbe(h);
    }

    function test_hookRedemptionBurnWithNonzeroEligibleHistory() public { _burn(false); }
    function test_hookRedemptionBurnWithShareVaultFloor() public { _burn(true); }
    function _burn(bool floor) private {
        if (floor) {
            BoxSpec memory s = _collectionSpec();
            s.sellers.a = Branch(1, 6, "", abi.encode(uint8(1)));
            _start(s); _fill(); box.graduate();
            origin = box; price = token;
            vm.prank(address(buyer)); price.transfer(ALICE, 1 ether);
        } else _linked(false);
        address h = origin.hook();
        buyer.mintClaims(Currency.wrap(address(price)), h, 1 ether);
        HookStipendProbe probe = _hookProbe(h);
        uint256 supply = price.totalSupply();
        uint256 snap = vm.snapshotState(); _cold();
        uint256 used = probe.measureBurn(1 ether, 1 ether, 6_000_000);
        emit log_named_uint("hook redemption burn cold", used);
        assertEq(price.totalSupply(), supply - 1 ether);
        assertEq(pm.balanceOf(h, uint160(address(price))), 0);
        assertLe(used * 2, C.BURN_GAS, "hook burn strict twice margin");
        assertTrue(vm.revertToState(snap)); _cold();
        probe.measureBurn(1 ether, 1 ether, C.BURN_GAS / 2);
        assertEq(price.totalSupply(), supply - 1 ether);
    }

    function test_coordinatorDirectBurnWithNonzeroEligibleHistory() public {
        _linked(false);
        vm.prank(address(buyer)); price.transfer(address(origin), 1 ether);
        uint256 snap = vm.snapshotState(); _cold();
        vm.prank(address(origin)); uint256 start = gasleft();
        price.burn(1 ether);
        uint256 used = start - gasleft();
        emit log_named_uint("coordinator direct burn cold", used);
        assertLe(used * 2, C.BURN_GAS, "coordinator burn strict twice margin");
        assertTrue(vm.revertToState(snap)); _cold(); vm.prank(address(origin));
        (bool ok,) = address(price).call{gas: C.BURN_GAS / 2}(abi.encodeCall(price.burn, (1 ether)));
        assertTrue(ok, "direct burn half allowance");
    }

    function test_linkedRouterSweep() public {
        _linked(false);
        vm.warp(box.deadline()); box.fail();
        address router = box.launchRouter();
        vm.prank(address(buyer)); price.transfer(router, 1 ether);
        uint256 beforeP = pm.balanceOf(address(box), uint160(address(price)));
        uint256 snap = vm.snapshotState(); _cold();
        uint256 start = gasleft(); BoxLaunchRouterV2(router).sweep();
        uint256 used = start - gasleft();
        emit log_named_uint("linked router sweep cold", used);
        assertEq(pm.balanceOf(address(box), uint160(address(price))), beforeP + 1 ether);
        assertEq(price.balanceOf(router), 0);
        assertLe(used * 2, C.SWEEP_GAS, "sweep strict twice margin");
        assertTrue(vm.revertToState(snap)); _cold();
        (bool ok,) = router.call{gas: C.SWEEP_GAS / 2}(abi.encodeWithSignature("sweep()"));
        assertTrue(ok, "sweep half allowance");
    }

    function test_RR_inboxAllowanceCoversAmsterdam() public {
        assertGe(C.INBOX_SWEEP_GAS, 2 * 1_512_077, "release review Amsterdam cold floor");
    }
    function test_RR_linkedInboxSweepFailedMenu() public { _inboxSweep(false, true); }
    function test_RR_linkedInboxSweepLiveMenu() public { _inboxSweep(false, false); }
    function test_RR_linkedInboxSweepFailedItems() public { _inboxSweep(true, true); }
    function test_RR_linkedInboxSweepLiveItems() public { _inboxSweep(true, false); }

    function test_RR_linkedClaimMinimumMenu() public { _linkedClaimMinimum(false, false); }
    function test_RR_linkedClaimMinimumItems() public { _linkedClaimMinimum(true, false); }
    function test_RR_linkedClaimMinimumSinkingMenu() public { _linkedClaimMinimum(false, true); }
    function test_RR_linkedClaimMinimumSinkingItems() public { _linkedClaimMinimum(true, true); }

    function _linkedClaimMinimum(bool items, bool sinking) private {
        _linked(items); vm.warp(box.deadline()); box.fail();
        if (sinking) {
            StipendSink sink = new StipendSink();
            vm.mockFunction(box.royaltyRouter(), address(sink), abi.encodeWithSignature("sweepPriceCoin()"));
            vm.mockFunction(box.launchRouter(), address(sink), abi.encodeWithSignature("sweep()"));
            vm.mockFunction(box.receiver(), address(sink), abi.encodeWithSignature("collect(address)"));
            vm.mockFunction(address(token), address(sink), abi.encodeWithSignature("burn(uint256)"));
        } else {
            address inbox = box.royaltyRouter();
            vm.prank(address(buyer)); price.transfer(inbox, 1 ether);
        }
        uint256 held = token.balanceOf(address(buyer));
        vm.prank(address(buyer)); token.approve(address(box), held);
        _minimumLinkedClaim(held / 2);
        _minimumLinkedClaim(held - held / 2);
        (uint256 pot, uint256 left) = box.claimState(); assertEq(pot, 0); assertEq(left, 0);
    }

    function _minimumLinkedClaim(uint256 amount) private {
        bytes memory data = abi.encodeCall(box.claim, (amount, address(buyer)));
        uint256 intrinsic = GasBudget.intrinsic(data);
        uint256 low = intrinsic;
        uint256 high = 16_777_215;
        uint256 snap = vm.snapshotState();
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            _cold(); vm.prank(address(buyer));
            (bool ok,) = address(box).call{gas: mid - intrinsic}(data);
            if (ok) high = mid; else low = mid;
            assertTrue(vm.revertToState(snap));
        }
        _cold(); vm.prank(address(buyer));
        (bool ok,) = address(box).call{gas: high - intrinsic}(data);
        assertTrue(ok, "linked P claim succeeds below the transaction cap");
        emit log_named_uint("minimum linked claim transaction gas", high);
    }

    function _inboxSweep(bool items, bool failed) private {
        _linked(items);
        if (failed) { vm.warp(box.deadline()); box.fail(); }
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        vm.prank(address(buyer)); price.transfer(address(inbox), 1 ether);
        uint256 beforeP = pm.balanceOf(address(box), uint160(address(price)));
        uint256 beforeHeld = receiver.royaltyHeldP();
        uint256 snap = vm.snapshotState(); _cold();
        uint256 start = gasleft(); uint256 swept = inbox.sweepPriceCoin();
        uint256 used = start - gasleft();
        emit log_named_uint("linked inbox sweep cold", used);
        assertEq(swept, 1 ether);
        assertEq(price.balanceOf(address(inbox)), 0);
        if (failed) assertEq(pm.balanceOf(address(box), uint160(address(price))), beforeP + 1 ether);
        else assertEq(receiver.royaltyHeldP(), beforeHeld + 1 ether);
        assertLe(used * 2, C.INBOX_SWEEP_GAS, "inbox sweep strict twice margin");
        assertTrue(vm.revertToState(snap)); _cold();
        (bool ok, bytes memory ret) = address(inbox).call{gas: C.INBOX_SWEEP_GAS / 2}(
            abi.encodeCall(inbox.sweepPriceCoin, ()));
        assertTrue(ok, "inbox sweep half allowance");
        assertEq(abi.decode(ret, (uint256)), 1 ether);
        assertEq(price.balanceOf(address(inbox)), 0);
        if (failed) assertEq(pm.balanceOf(address(box), uint160(address(price))), beforeP + 1 ether);
        else assertEq(receiver.royaltyHeldP(), beforeHeld + 1 ether);
    }

    function test_routerSweepFourPartsAndTail() public {
        (BoxSpec memory s, HostileToken p) = _priceSpec(3, 3, 18);
        _start(s); origin = box;
        vm.warp(box.deadline()); box.fail();
        address router = box.launchRouter();
        uint256 batch = 4 * uint256(uint128(type(int128).max));
        p.mint(router, batch + 7);
        uint256 beforeP = pm.balanceOf(address(box), uint160(address(p)));
        uint256 snap = vm.snapshotState(); _cold(); vm.cool(address(p));
        uint256 start = gasleft(); uint256 swept = BoxLaunchRouterV2(router).sweep();
        uint256 used = start - gasleft();
        emit log_named_uint("four-part router sweep cold", used);
        assertEq(swept, batch); assertEq(p.balanceOf(router), 7);
        assertEq(pm.balanceOf(address(box), uint160(address(p))), beforeP + batch);
        assertLe(used * 2, C.SWEEP_GAS);
        assertTrue(vm.revertToState(snap)); _cold(); vm.cool(address(p));
        (bool ok,) = router.call{gas: C.SWEEP_GAS / 2}(abi.encodeWithSignature("sweep()"));
        assertTrue(ok); assertEq(p.balanceOf(router), 7);
        assertEq(pm.balanceOf(address(box), uint160(address(p))), beforeP + batch);
    }

    function test_linkedPriceTipFreshWallet() public { _tip(false, false); }
    function test_linkedPriceTipFirstWallet() public { _tip(true, false); }
    function test_linkedPriceTipFirst7702() public { _tip(true, true); }
    function test_receiverTipFreshWallet() public { _receiverTip(false, false); }
    function test_receiverTipFirstWallet() public { _receiverTip(true, false); }
    function test_receiverTipFirst7702() public { _receiverTip(true, true); }

    function _receiverTip(bool first, bool delegated) private {
        if (first) vm.etch(CREATOR, address(new LifeCustody()).code);
        _linked(false);
        if (delegated) vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(new LifeCustody())));
        PayoutProbe probe = new PayoutProbe(pm, release.implementations[0], fitSafe, address(this), conversionSafe);
        bytes memory runtime = address(receiver).code;
        for (uint256 i; i < 20; ++i) runtime[10 + i] = bytes20(address(probe))[i];
        vm.etch(address(receiver), runtime);
        release.implementations[5] = address(probe);
        uint256 beforeP = price.balanceOf(ALICE);
        uint256 owed = receiver.fitOwed();
        uint256 snap = vm.snapshotState(); _cold();
        vm.prank(fitSafe);
        (uint256 paid, uint256 used) = PayoutProbe(address(receiver)).measuredTip(ALICE, 6_000_000);
        emit log_named_uint("linked P receiver tip cold", used);
        assertEq(paid, owed);
        assertEq(price.balanceOf(ALICE), beforeP + owed);
        assertLe(used * 2, C.TIP_GAS, "receiver tip strict twice margin");
        assertTrue(vm.revertToState(snap)); _cold();
        vm.prank(fitSafe);
        (paid,) = PayoutProbe(address(receiver)).measuredTip(ALICE, C.TIP_GAS / 2);
        assertEq(paid, owed);
        assertEq(price.balanceOf(ALICE), beforeP + owed);
    }

    function _tip(bool first, bool delegated) private {
        if (first) vm.etch(CREATOR, address(new LifeCustody()).code);
        _linked(false);
        if (delegated) vm.etch(ALICE, abi.encodePacked(hex"ef0100", address(new LifeCustody())));
        _gift(address(hook), 1 ether);
        HookStipendProbe probe = _hookProbe(address(hook));
        uint256 snap = vm.snapshotState(); _cold();
        uint256 startP = price.balanceOf(ALICE); vm.cool(address(price));
        uint256 used = probe.measureTip(ALICE, 1 ether, 6_000_000);
        emit log_named_uint("linked P hook tip cold", used);
        assertEq(price.balanceOf(ALICE), startP + 1 ether);
        assertLe(used * 2, C.TIP_GAS, "tip strict twice margin");
        assertTrue(vm.revertToState(snap)); _cold();
        probe.measureTip(ALICE, 1 ether, C.TIP_GAS / 2);
        assertEq(price.balanceOf(ALICE), startP + 1 ether);
    }
}
