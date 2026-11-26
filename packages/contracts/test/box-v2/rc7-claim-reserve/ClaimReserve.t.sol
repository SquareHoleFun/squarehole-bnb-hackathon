// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LinkedPriceFixture} from "../final/money/LinkedPriceFixture.sol";
import {Round2RemainingExitsTest} from "../final/round2/money/RemainingExits.t.sol";
import {StipendSink} from "../stipends/Envelopes.t.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// RR2-LIM-2: only inbox state changes after the empty-inbox gas search.
/// Uses the same real release/PoolManager and cold-account discipline as the stipend suites.
abstract contract ClaimReserveFixture is LinkedPriceFixture, Round2RemainingExitsTest {
    uint256 internal constant TX_CAP = 16_777_216;
    uint256 internal constant EXPECTED_RESERVE = 4_000_000;
    address internal constant PRESSER = address(0xB0B);
    enum Action { Partial, Final, Creator, Fail, FailClosed, EmptyFail, EmptyFailClosed }
    address internal caller;
    bytes internal callData;
    uint256 internal handedIn;
    uint256 internal kind;

    function _prepare(uint256 pKind, bool items, Action action, bool waiting) internal {
        kind = pKind;
        buyer = new PoolDriver(pm);
        bool closed = action == Action.FailClosed || action == Action.EmptyFailClosed;
        bool noBuyer = action == Action.Creator || action == Action.EmptyFail || action == Action.EmptyFailClosed;
        BoxSpec memory s = items ? _items(1, 1) : (closed ? _collectionSpec() : _menu(1, 1));
        if (pKind == 2) {
            _linked(items);
            s.pricing.token = address(price);
            (, s.pricing.listingId) = listings.newestListingOf(address(price));
            s.raise = 100 ether;
            s.tokenName = string.concat(s.tokenName, " reserve");
        } else if (pKind == 1) {
            (BoxSpec memory priced,) = _priceSpec(1, 1, 18);
            s.pricing = priced.pricing;
            s.raise = priced.raise;
        }
        // failClosed has a genuine unloaded collection gate; its buyers are the creation-time buy.
        if (closed && !noBuyer) s.creatorBuy = s.raise / 5;
        if (pKind != 2 || closed || noBuyer) {
            box = _create(s);
            token = BoxTokenV2(box.token());
            hook = IBoxHookV2(box.hook());
            receiver = IBoxReceiverV2(box.receiver());
            layout = BoxLayoutV2.curve(s.raise, false);
            if (!closed) {
                if (s.metadataTable.length != 0) box.loadChunk(ChunkPart.Table, s.metadataTable, 0);
                BoxFactoryV2Parts.Box memory encoding;
                (, bytes memory texts) = planner.parts().partArgs(encoding, s);
                if (texts.length != 0) box.loadChunk(ChunkPart.Texts, texts, 0);
                assertTrue(box.gateOpen());
                vm.warp(box.effectiveOpenAt() + 384);
                vm.roll(block.number + 1);
                if (pKind == 0) vm.deal(address(buyer), s.raise * 10);
                else if (pKind == 1) HostileToken(box.q()).mint(address(buyer), s.raise * 10);
                if (!noBuyer) _buy(s.raise / 5);
            }
        }
        if (closed && pKind == 0) vm.deal(address(buyer), s.raise * 10);
        else if (closed && pKind == 1) HostileToken(box.q()).mint(address(buyer), s.raise * 10);
        // Non-linked fixtures need the settlement actor normally supplied by _start.
        assertTrue(address(buyer) != address(0), "settlement actor");
        vm.warp(closed ? box.openAt() + 14 days : box.deadline());
        if (action <= Action.Creator) box.fail();
        if (waiting) {
            _fund(box.launchRouter(), 1e15);
            _gift(address(receiver), 1e15);
        }
        caller = action == Action.Creator ? CREATOR : action <= Action.Final ? address(buyer) : PRESSER;
        if (action <= Action.Final) {
            uint256 held = token.balanceOf(address(buyer));
            assertGt(held, 0);
            handedIn = action == Action.Partial ? held / 2 : held;
            vm.prank(address(buyer)); token.approve(address(box), held);
        }
        callData = action <= Action.Creator ? abi.encodeCall(box.claim, (handedIn, caller))
            : closed ? abi.encodeCall(box.failClosed, ()) : abi.encodeCall(box.fail, ());
        assertEq(_inboxBalance(), 0);
    }

    function _fund(address to, uint256 amount) internal {
        if (kind == 0) vm.deal(to, to.balance + amount);
        else if (kind == 1) HostileToken(box.q()).mint(to, amount);
        else { vm.prank(address(buyer)); price.transfer(to, amount); }
    }

    function _inboxBalance() internal view returns (uint256) {
        return _balance(box.royaltyRouter());
    }

    function _cold() internal {
        address[48] memory parts;
        address p = box.q();
        for (uint256 i; i < 24; ++i) {
            parts[i] = box.roleAddress(i);
            if (address(origin) != address(0)) parts[i + 24] = origin.roleAddress(i);
        }
        for (uint256 i; i < 24; ++i) {
            address impl = release.implementations[i];
            if (impl != address(0)) {
                address helper = vm.computeCreateAddress(impl, 1);
                if (helper.code.length != 0) vm.cool(helper);
                if (i == 5) vm.cool(vm.computeCreateAddress(impl, 2));
                vm.cool(impl);
            }
        }
        for (uint256 i; i < 48; ++i) if (parts[i] != address(0)) vm.cool(parts[i]);
        vm.cool(address(pm)); vm.cool(caller); vm.cool(CREATOR); vm.cool(conversionSafe);
        if (p != address(0)) vm.cool(p);
    }

    function _send(uint256 submitted) internal returns (bool ok, bytes memory ret, uint256 used) {
        bytes memory data = callData;
        address who = caller;
        address target = address(box);
        uint256 execution = submitted - GasBudget.intrinsic(data);
        _cold(); vm.prank(who);
        uint256 start = gasleft();
        (ok, ret) = target.call{gas: execution}(data);
        used = GasBudget.transaction(start - gasleft(), data);
    }

    function _minimum() internal returns (uint256 high) {
        uint256 snap = vm.snapshotState();
        high = TX_CAP - 1;
        (bool ok,,) = _send(high);
        assertTrue(ok, "cap is a successful upper bound");
        assertTrue(vm.revertToState(snap));
        uint256 low = GasBudget.intrinsic(callData);
        while (low + 1 < high) {
            uint256 mid = (low + high) / 2;
            (ok,,) = _send(mid);
            if (ok) high = mid; else low = mid;
            assertTrue(vm.revertToState(snap));
        }
    }

    function _rethrow(bytes memory ret) internal pure {
        assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
    }

    function _state() internal view returns (bytes32) {
        // Reads only; every actual probe cools these again.
        return keccak256(abi.encode(box.failed(), token.totalSupply(), token.balanceOf(caller),
            token.allowance(caller, address(box)), pm.balanceOf(address(box), uint160(box.q())),
            pm.balanceOf(address(receiver), uint160(box.q())), _balance(caller), _inboxBalance()));
    }

    function _boundary(uint256 minimum) internal {
        bytes32 beforeState = _state();
        (bool ok, bytes memory ret,) = _send(minimum - 1);
        assertFalse(ok);
        assertEq(bytes4(ret), bytes4(keccak256("GasTooLow(uint256,uint256)")));
        uint256 left; uint256 required;
        assembly ("memory-safe") { left := mload(add(ret, 36)) required := mload(add(ret, 68)) }
        assertEq(required, C.INBOX_SWEEP_GAS + C.INBOX_SWEEP_GAS / 63 + C.POKE_OVERHEAD_GAS + EXPECTED_RESERVE,
            "refuse at inbox admission, before spending its allowance");
        assertLt(left, required);
        assertEq(_state(), beforeState, "refusal rolls back the whole entry");
    }

    function _race(uint256 pKind, bool items, Action action, uint256 arrival) internal {
        for (uint256 background; background < 2; ++background) {
            uint256 initial = vm.snapshotState();
            _prepare(pKind, items, action, background != 0);
            emit log_named_uint("router and receiver funded before estimate", background);
            uint256 minimum = _minimum();
            emit log_named_uint("empty inbox minimum submitted gas", minimum);
            uint256 estimated = vm.snapshotState();
            (bool ok, bytes memory ret, uint256 used) = _send(minimum);
            if (!ok) _rethrow(ret);
            emit log_named_uint("empty inbox gross gas", used);
            assertTrue(vm.revertToState(estimated));
            if (arrival == 2) {
                StipendSink sink = new StipendSink();
                vm.mockFunction(box.royaltyRouter(), address(sink), abi.encodeWithSignature("sweepPriceCoin()"));
            } else _fund(box.royaltyRouter(), arrival == 0 ? 1 : 1e15);
            (ok, ret, used) = _send(minimum);
            if (!ok) _rethrow(ret);
            emit log_named_uint("after inbox change gross gas", used);
            assertLt(used, minimum);
            assertTrue(box.failed());
            if (action <= Action.Final) {
                (, uint256 left) = box.claimState();
                assertEq(left, token.balanceOf(address(buyer)));
                if (action == Action.Final) assertEq(left, 0);
            }
            assertEq(_inboxBalance(), 0);
            assertTrue(vm.revertToState(estimated));
            vm.mockFunction(box.royaltyRouter(), box.royaltyRouter(), abi.encodeWithSignature("sweepPriceCoin()"));
            // Kept in a separate test so the pre-rc7 green controls remain visibly green.
            assertTrue(vm.revertToState(initial));
        }
    }

    function _oneBelow(uint256 pKind, bool items, Action action) internal {
        for (uint256 background; background < 2; ++background) {
            uint256 initial = vm.snapshotState();
            _prepare(pKind, items, action, background != 0);
            uint256 minimum = _minimum();
            _boundary(minimum);
            uint256 estimated = vm.snapshotState();
            for (uint256 arrival; arrival < 2; ++arrival) {
                _fund(box.royaltyRouter(), arrival == 0 ? 1 : 1e15);
                _boundary(minimum);
                assertTrue(vm.revertToState(estimated));
            }
            assertTrue(vm.revertToState(initial));
        }
    }
}

contract ClaimReserveTest is ClaimReserveFixture {
    function test_NativeMenuPartialRaw() public { _race(0, false, Action.Partial, 0); }
    function test_NativeMenuPartialLot() public { _race(0, false, Action.Partial, 1); }
    function test_NativeMenuPartialExhausted() public { _race(0, false, Action.Partial, 2); }
    function test_NativeMenuPartialOneBelow() public { _oneBelow(0, false, Action.Partial); }
    function test_NativeMenuFinalRaw() public { _race(0, false, Action.Final, 0); }
    function test_NativeMenuFinalLot() public { _race(0, false, Action.Final, 1); }
    function test_NativeMenuFinalExhausted() public { _race(0, false, Action.Final, 2); }
    function test_NativeMenuFinalOneBelow() public { _oneBelow(0, false, Action.Final); }
    function test_NativeMenuCreatorRaw() public { _race(0, false, Action.Creator, 0); }
    function test_NativeMenuCreatorLot() public { _race(0, false, Action.Creator, 1); }
    function test_NativeMenuCreatorExhausted() public { _race(0, false, Action.Creator, 2); }
    function test_NativeMenuCreatorOneBelow() public { _oneBelow(0, false, Action.Creator); }
    function test_NativeMenuFailRaw() public { _race(0, false, Action.Fail, 0); }
    function test_NativeMenuFailLot() public { _race(0, false, Action.Fail, 1); }
    function test_NativeMenuFailExhausted() public { _race(0, false, Action.Fail, 2); }
    function test_NativeMenuFailOneBelow() public { _oneBelow(0, false, Action.Fail); }
    function test_NativeMenuFailClosedRaw() public { _race(0, false, Action.FailClosed, 0); }
    function test_NativeMenuFailClosedLot() public { _race(0, false, Action.FailClosed, 1); }
    function test_NativeMenuFailClosedExhausted() public { _race(0, false, Action.FailClosed, 2); }
    function test_NativeMenuFailClosedOneBelow() public { _oneBelow(0, false, Action.FailClosed); }
    function test_NativeMenuEmptyFailRaw() public { _race(0, false, Action.EmptyFail, 0); }
    function test_NativeMenuEmptyFailLot() public { _race(0, false, Action.EmptyFail, 1); }
    function test_NativeMenuEmptyFailExhausted() public { _race(0, false, Action.EmptyFail, 2); }
    function test_NativeMenuEmptyFailOneBelow() public { _oneBelow(0, false, Action.EmptyFail); }
    function test_NativeMenuEmptyFailClosedRaw() public { _race(0, false, Action.EmptyFailClosed, 0); }
    function test_NativeMenuEmptyFailClosedLot() public { _race(0, false, Action.EmptyFailClosed, 1); }
    function test_NativeMenuEmptyFailClosedExhausted() public { _race(0, false, Action.EmptyFailClosed, 2); }
    function test_NativeMenuEmptyFailClosedOneBelow() public { _oneBelow(0, false, Action.EmptyFailClosed); }
    function test_NativeItemsPartialRaw() public { _race(0, true, Action.Partial, 0); }
    function test_NativeItemsPartialLot() public { _race(0, true, Action.Partial, 1); }
    function test_NativeItemsPartialExhausted() public { _race(0, true, Action.Partial, 2); }
    function test_NativeItemsPartialOneBelow() public { _oneBelow(0, true, Action.Partial); }
    function test_NativeItemsFinalRaw() public { _race(0, true, Action.Final, 0); }
    function test_NativeItemsFinalLot() public { _race(0, true, Action.Final, 1); }
    function test_NativeItemsFinalExhausted() public { _race(0, true, Action.Final, 2); }
    function test_NativeItemsFinalOneBelow() public { _oneBelow(0, true, Action.Final); }
    function test_NativeItemsCreatorRaw() public { _race(0, true, Action.Creator, 0); }
    function test_NativeItemsCreatorLot() public { _race(0, true, Action.Creator, 1); }
    function test_NativeItemsCreatorExhausted() public { _race(0, true, Action.Creator, 2); }
    function test_NativeItemsCreatorOneBelow() public { _oneBelow(0, true, Action.Creator); }
    function test_NativeItemsFailRaw() public { _race(0, true, Action.Fail, 0); }
    function test_NativeItemsFailLot() public { _race(0, true, Action.Fail, 1); }
    function test_NativeItemsFailExhausted() public { _race(0, true, Action.Fail, 2); }
    function test_NativeItemsFailOneBelow() public { _oneBelow(0, true, Action.Fail); }
    function test_NativeItemsFailClosedRaw() public { _race(0, true, Action.FailClosed, 0); }
    function test_NativeItemsFailClosedLot() public { _race(0, true, Action.FailClosed, 1); }
    function test_NativeItemsFailClosedExhausted() public { _race(0, true, Action.FailClosed, 2); }
    function test_NativeItemsFailClosedOneBelow() public { _oneBelow(0, true, Action.FailClosed); }
    function test_NativeItemsEmptyFailRaw() public { _race(0, true, Action.EmptyFail, 0); }
    function test_NativeItemsEmptyFailLot() public { _race(0, true, Action.EmptyFail, 1); }
    function test_NativeItemsEmptyFailExhausted() public { _race(0, true, Action.EmptyFail, 2); }
    function test_NativeItemsEmptyFailOneBelow() public { _oneBelow(0, true, Action.EmptyFail); }
    function test_NativeItemsEmptyFailClosedRaw() public { _race(0, true, Action.EmptyFailClosed, 0); }
    function test_NativeItemsEmptyFailClosedLot() public { _race(0, true, Action.EmptyFailClosed, 1); }
    function test_NativeItemsEmptyFailClosedExhausted() public { _race(0, true, Action.EmptyFailClosed, 2); }
    function test_NativeItemsEmptyFailClosedOneBelow() public { _oneBelow(0, true, Action.EmptyFailClosed); }
    function test_ERC20MenuPartialRaw() public { _race(1, false, Action.Partial, 0); }
    function test_ERC20MenuPartialLot() public { _race(1, false, Action.Partial, 1); }
    function test_ERC20MenuPartialExhausted() public { _race(1, false, Action.Partial, 2); }
    function test_ERC20MenuPartialOneBelow() public { _oneBelow(1, false, Action.Partial); }
    function test_ERC20MenuFinalRaw() public { _race(1, false, Action.Final, 0); }
    function test_ERC20MenuFinalLot() public { _race(1, false, Action.Final, 1); }
    function test_ERC20MenuFinalExhausted() public { _race(1, false, Action.Final, 2); }
    function test_ERC20MenuFinalOneBelow() public { _oneBelow(1, false, Action.Final); }
    function test_ERC20MenuCreatorRaw() public { _race(1, false, Action.Creator, 0); }
    function test_ERC20MenuCreatorLot() public { _race(1, false, Action.Creator, 1); }
    function test_ERC20MenuCreatorExhausted() public { _race(1, false, Action.Creator, 2); }
    function test_ERC20MenuCreatorOneBelow() public { _oneBelow(1, false, Action.Creator); }
    function test_ERC20MenuFailRaw() public { _race(1, false, Action.Fail, 0); }
    function test_ERC20MenuFailLot() public { _race(1, false, Action.Fail, 1); }
    function test_ERC20MenuFailExhausted() public { _race(1, false, Action.Fail, 2); }
    function test_ERC20MenuFailOneBelow() public { _oneBelow(1, false, Action.Fail); }
    function test_ERC20MenuFailClosedRaw() public { _race(1, false, Action.FailClosed, 0); }
    function test_ERC20MenuFailClosedLot() public { _race(1, false, Action.FailClosed, 1); }
    function test_ERC20MenuFailClosedExhausted() public { _race(1, false, Action.FailClosed, 2); }
    function test_ERC20MenuFailClosedOneBelow() public { _oneBelow(1, false, Action.FailClosed); }
    function test_ERC20MenuEmptyFailRaw() public { _race(1, false, Action.EmptyFail, 0); }
    function test_ERC20MenuEmptyFailLot() public { _race(1, false, Action.EmptyFail, 1); }
    function test_ERC20MenuEmptyFailExhausted() public { _race(1, false, Action.EmptyFail, 2); }
    function test_ERC20MenuEmptyFailOneBelow() public { _oneBelow(1, false, Action.EmptyFail); }
    function test_ERC20MenuEmptyFailClosedRaw() public { _race(1, false, Action.EmptyFailClosed, 0); }
    function test_ERC20MenuEmptyFailClosedLot() public { _race(1, false, Action.EmptyFailClosed, 1); }
    function test_ERC20MenuEmptyFailClosedExhausted() public { _race(1, false, Action.EmptyFailClosed, 2); }
    function test_ERC20MenuEmptyFailClosedOneBelow() public { _oneBelow(1, false, Action.EmptyFailClosed); }
    function test_ERC20ItemsPartialRaw() public { _race(1, true, Action.Partial, 0); }
    function test_ERC20ItemsPartialLot() public { _race(1, true, Action.Partial, 1); }
    function test_ERC20ItemsPartialExhausted() public { _race(1, true, Action.Partial, 2); }
    function test_ERC20ItemsPartialOneBelow() public { _oneBelow(1, true, Action.Partial); }
    function test_ERC20ItemsFinalRaw() public { _race(1, true, Action.Final, 0); }
    function test_ERC20ItemsFinalLot() public { _race(1, true, Action.Final, 1); }
    function test_ERC20ItemsFinalExhausted() public { _race(1, true, Action.Final, 2); }
    function test_ERC20ItemsFinalOneBelow() public { _oneBelow(1, true, Action.Final); }
    function test_ERC20ItemsCreatorRaw() public { _race(1, true, Action.Creator, 0); }
    function test_ERC20ItemsCreatorLot() public { _race(1, true, Action.Creator, 1); }
    function test_ERC20ItemsCreatorExhausted() public { _race(1, true, Action.Creator, 2); }
    function test_ERC20ItemsCreatorOneBelow() public { _oneBelow(1, true, Action.Creator); }
    function test_ERC20ItemsFailRaw() public { _race(1, true, Action.Fail, 0); }
    function test_ERC20ItemsFailLot() public { _race(1, true, Action.Fail, 1); }
    function test_ERC20ItemsFailExhausted() public { _race(1, true, Action.Fail, 2); }
    function test_ERC20ItemsFailOneBelow() public { _oneBelow(1, true, Action.Fail); }
    function test_ERC20ItemsFailClosedRaw() public { _race(1, true, Action.FailClosed, 0); }
    function test_ERC20ItemsFailClosedLot() public { _race(1, true, Action.FailClosed, 1); }
    function test_ERC20ItemsFailClosedExhausted() public { _race(1, true, Action.FailClosed, 2); }
    function test_ERC20ItemsFailClosedOneBelow() public { _oneBelow(1, true, Action.FailClosed); }
    function test_ERC20ItemsEmptyFailRaw() public { _race(1, true, Action.EmptyFail, 0); }
    function test_ERC20ItemsEmptyFailLot() public { _race(1, true, Action.EmptyFail, 1); }
    function test_ERC20ItemsEmptyFailExhausted() public { _race(1, true, Action.EmptyFail, 2); }
    function test_ERC20ItemsEmptyFailOneBelow() public { _oneBelow(1, true, Action.EmptyFail); }
    function test_ERC20ItemsEmptyFailClosedRaw() public { _race(1, true, Action.EmptyFailClosed, 0); }
    function test_ERC20ItemsEmptyFailClosedLot() public { _race(1, true, Action.EmptyFailClosed, 1); }
    function test_ERC20ItemsEmptyFailClosedExhausted() public { _race(1, true, Action.EmptyFailClosed, 2); }
    function test_ERC20ItemsEmptyFailClosedOneBelow() public { _oneBelow(1, true, Action.EmptyFailClosed); }
    function test_LinkedMenuPartialRaw() public { _race(2, false, Action.Partial, 0); }
    function test_LinkedMenuPartialLot() public { _race(2, false, Action.Partial, 1); }
    function test_LinkedMenuPartialExhausted() public { _race(2, false, Action.Partial, 2); }
    function test_LinkedMenuPartialOneBelow() public { _oneBelow(2, false, Action.Partial); }
    function test_LinkedMenuFinalRaw() public { _race(2, false, Action.Final, 0); }
    function test_LinkedMenuFinalLot() public { _race(2, false, Action.Final, 1); }
    function test_LinkedMenuFinalExhausted() public { _race(2, false, Action.Final, 2); }
    function test_LinkedMenuFinalOneBelow() public { _oneBelow(2, false, Action.Final); }
    function test_LinkedMenuCreatorRaw() public { _race(2, false, Action.Creator, 0); }
    function test_LinkedMenuCreatorLot() public { _race(2, false, Action.Creator, 1); }
    function test_LinkedMenuCreatorExhausted() public { _race(2, false, Action.Creator, 2); }
    function test_LinkedMenuCreatorOneBelow() public { _oneBelow(2, false, Action.Creator); }
    function test_LinkedMenuFailRaw() public { _race(2, false, Action.Fail, 0); }
    function test_LinkedMenuFailLot() public { _race(2, false, Action.Fail, 1); }
    function test_LinkedMenuFailExhausted() public { _race(2, false, Action.Fail, 2); }
    function test_LinkedMenuFailOneBelow() public { _oneBelow(2, false, Action.Fail); }
    function test_LinkedMenuFailClosedRaw() public { _race(2, false, Action.FailClosed, 0); }
    function test_LinkedMenuFailClosedLot() public { _race(2, false, Action.FailClosed, 1); }
    function test_LinkedMenuFailClosedExhausted() public { _race(2, false, Action.FailClosed, 2); }
    function test_LinkedMenuFailClosedOneBelow() public { _oneBelow(2, false, Action.FailClosed); }
    function test_LinkedMenuEmptyFailRaw() public { _race(2, false, Action.EmptyFail, 0); }
    function test_LinkedMenuEmptyFailLot() public { _race(2, false, Action.EmptyFail, 1); }
    function test_LinkedMenuEmptyFailExhausted() public { _race(2, false, Action.EmptyFail, 2); }
    function test_LinkedMenuEmptyFailOneBelow() public { _oneBelow(2, false, Action.EmptyFail); }
    function test_LinkedMenuEmptyFailClosedRaw() public { _race(2, false, Action.EmptyFailClosed, 0); }
    function test_LinkedMenuEmptyFailClosedLot() public { _race(2, false, Action.EmptyFailClosed, 1); }
    function test_LinkedMenuEmptyFailClosedExhausted() public { _race(2, false, Action.EmptyFailClosed, 2); }
    function test_LinkedMenuEmptyFailClosedOneBelow() public { _oneBelow(2, false, Action.EmptyFailClosed); }
    function test_LinkedItemsPartialRaw() public { _race(2, true, Action.Partial, 0); }
    function test_LinkedItemsPartialLot() public { _race(2, true, Action.Partial, 1); }
    function test_LinkedItemsPartialExhausted() public { _race(2, true, Action.Partial, 2); }
    function test_LinkedItemsPartialOneBelow() public { _oneBelow(2, true, Action.Partial); }
    function test_LinkedItemsFinalRaw() public { _race(2, true, Action.Final, 0); }
    function test_LinkedItemsFinalLot() public { _race(2, true, Action.Final, 1); }
    function test_LinkedItemsFinalExhausted() public { _race(2, true, Action.Final, 2); }
    function test_LinkedItemsFinalOneBelow() public { _oneBelow(2, true, Action.Final); }
    function test_LinkedItemsCreatorRaw() public { _race(2, true, Action.Creator, 0); }
    function test_LinkedItemsCreatorLot() public { _race(2, true, Action.Creator, 1); }
    function test_LinkedItemsCreatorExhausted() public { _race(2, true, Action.Creator, 2); }
    function test_LinkedItemsCreatorOneBelow() public { _oneBelow(2, true, Action.Creator); }
    function test_LinkedItemsFailRaw() public { _race(2, true, Action.Fail, 0); }
    function test_LinkedItemsFailLot() public { _race(2, true, Action.Fail, 1); }
    function test_LinkedItemsFailExhausted() public { _race(2, true, Action.Fail, 2); }
    function test_LinkedItemsFailOneBelow() public { _oneBelow(2, true, Action.Fail); }
    function test_LinkedItemsFailClosedRaw() public { _race(2, true, Action.FailClosed, 0); }
    function test_LinkedItemsFailClosedLot() public { _race(2, true, Action.FailClosed, 1); }
    function test_LinkedItemsFailClosedExhausted() public { _race(2, true, Action.FailClosed, 2); }
    function test_LinkedItemsFailClosedOneBelow() public { _oneBelow(2, true, Action.FailClosed); }
    function test_LinkedItemsEmptyFailRaw() public { _race(2, true, Action.EmptyFail, 0); }
    function test_LinkedItemsEmptyFailLot() public { _race(2, true, Action.EmptyFail, 1); }
    function test_LinkedItemsEmptyFailExhausted() public { _race(2, true, Action.EmptyFail, 2); }
    function test_LinkedItemsEmptyFailOneBelow() public { _oneBelow(2, true, Action.EmptyFail); }
    function test_LinkedItemsEmptyFailClosedRaw() public { _race(2, true, Action.EmptyFailClosed, 0); }
    function test_LinkedItemsEmptyFailClosedLot() public { _race(2, true, Action.EmptyFailClosed, 1); }
    function test_LinkedItemsEmptyFailClosedExhausted() public { _race(2, true, Action.EmptyFailClosed, 2); }
    function test_LinkedItemsEmptyFailClosedOneBelow() public { _oneBelow(2, true, Action.EmptyFailClosed); }
}
