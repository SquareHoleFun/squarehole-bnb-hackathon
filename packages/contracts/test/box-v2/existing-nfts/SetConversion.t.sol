// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetConversionFixture, ConversionVault, SetStandardERC721, HostileERC721} from "./SetConversionFixture.sol";
import {IBoxVaultV2 as V, IBoxVaultItemsV2 as B} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";
import {SetRefused} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetReason as R} from "../../../src/box-v2/set/SetConstantsV2.sol";

contract SetConversionTest is SetConversionFixture {
    function test_preOperationBatchRoundingAndBurnedFees() public {
        _ready(10, 1003, false);
        assertEq(conversion.quoteWithdraw(3), 301);
        vm.expectEmit(true, false, false, true, address(vault));
        emit V.Withdrawn(ALICE, _list(0, 3), 301, 16, 987, 301, 7);
        (uint256 p, uint256 f) = _pick(0, 3);
        assertEq(p, 301);
        assertEq(f, 16);
        assertEq(conversion.quoteReturn(2), 196); // (987 - 301) * 2 / 7
        vm.expectEmit(true, false, false, true, address(vault));
        emit V.Returned(ALICE, _list(0, 2), 196, 10, 977, 105, 9);
        (p, f) = _return(0, 2);
        assertEq(p, 196);
        assertEq(f, 10);
        assertEq(token.balanceOf(ALICE), 872);
        _invariants(0);
    }

    struct Model {
        uint256 s;
        uint256 e;
        uint256 n;
        bool[33] outside;
    }

    struct Step {
        bool returning;
        uint256 k;
        uint256 p;
        uint256 f;
        uint256 nextE;
        uint256 nextN;
    }

    function testFuzz_operationSequence(uint256 entropy, uint8 rawPreset, uint96 rawSupply) public {
        preset = rawPreset % 3 == 0 ? 100 : rawPreset % 3 == 1 ? 500 : 2500;
        _ready(33, bound(uint256(rawSupply), 10_000, 1e27), false);
        Model memory m;
        m.s = token.totalSupply();
        m.n = 33;
        for (uint256 step; step < 32; ++step) {
            entropy = uint256(keccak256(abi.encode(entropy, step)));
            _step(m, entropy);
        }
    }

    function _step(Model memory m, uint256 entropy) private {
        Step memory t;
        t.returning = m.n < 33 && (entropy % 2 == 0 || m.n == 1);
        t.k = 1 + ((entropy >> 8) % (t.returning ? 33 - m.n : m.n - 1));
        uint256[] memory list = new uint256[](t.k);
        uint256 found;
        for (uint256 i; i < 33 && found < t.k; ++i) {
            if (m.outside[i] == t.returning) list[found++] = ids[i];
        }
        t.p = t.returning ? (m.s - m.e) * t.k / m.n : _ceil((m.s - m.e) * t.k, m.n);
        t.f = _ceil(t.p * (t.returning ? 500 : preset), 10_000);
        t.nextE = t.returning ? m.e - t.p : m.e + t.p;
        t.nextN = t.returning ? m.n + t.k : m.n - t.k;
        uint256 previousNumerator = m.e * m.n - (33 - m.n) * (m.s - m.e);
        uint256 previousN = m.n;
        bytes32 beforeState = _stateHash();
        vm.prank(ALICE);
        (bool ok, bytes memory answer) = address(conversion)
            .call(
                t.returning
                    ? abi.encodeCall(conversion.returnItems, (list, t.p - t.f, block.timestamp))
                    : abi.encodeCall(conversion.withdrawBatch, (list, t.p + t.f, block.timestamp))
            );
        if (m.s - t.f < t.nextE + t.nextN || (!t.returning && t.p + t.f > m.s - m.e)) {
            assertFalse(ok);
            assertEq(_stateHash(), beforeState);
        } else {
            assertTrue(ok);
            (uint256 actualP, uint256 actualF) = abi.decode(answer, (uint256, uint256));
            assertEq(actualP, t.p);
            assertEq(actualF, t.f);
            m.s -= t.f;
            m.e = t.nextE;
            m.n = t.nextN;
            for (uint256 i; i < t.k; ++i) {
                for (uint256 j; j < 33; ++j) {
                    if (ids[j] == list[i]) m.outside[j] = !t.returning;
                }
            }
        }
        uint256 burn = (m.s - m.e - m.n) / 100;
        vm.prank(ALICE);
        token.burn(burn);
        m.s -= burn;
        assertEq(token.totalSupply(), m.s);
        assertEq(vault.escrowPrincipal(), m.e);
        assertEq(vault.inside(), m.n);
        uint256 numerator = m.e * m.n - (33 - m.n) * (m.s - m.e);
        assertGe(numerator * previousN, previousNumerator * m.n);
        for (uint256 j; j < 33; ++j) {
            assertEq(vault.isOutside(ids[j]), m.outside[j]);
            assertEq(SetStandardERC721(collection).ownerOf(ids[j]), m.outside[j] ? ALICE : address(vault));
        }
        _invariants(0);
    }

    function test_currentOwnerGetsCurrentQuoteNotHistoricRefund() public {
        _ready(10, 1003, false);
        (uint256 locked,) = _pick(0, 2);
        vm.startPrank(ALICE);
        token.burn(79);
        SetStandardERC721(collection).transferFrom(ALICE, BOB, ids[0]);
        vm.stopPrank();
        uint256 p = conversion.quoteReturn(1);
        assertLt(p, locked / 2);
        uint256[] memory list = _list(0, 1);
        vm.prank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.OWNER_MISMATCH, 10));
        conversion.returnItems(list, 0, block.timestamp);
        vm.startPrank(BOB);
        SetStandardERC721(collection).approve(address(vault), ids[0]);
        conversion.returnItems(list, p - _ceil(p * 500, 10000), block.timestamp);
        vm.stopPrank();
        assertEq(token.balanceOf(BOB), p - _ceil(p * 500, 10000));
        assertFalse(vault.isOutside(ids[0]));
        _invariants(0);
    }

    function test_limitsDeadlinesDuplicatesAndLastItem() public {
        preset = 100;
        _ready(10, 1003, false);
        uint256[] memory list = _list(0, 1);
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(V.DeadlineExpired.selector, block.timestamp - 1, block.timestamp));
        conversion.withdrawBatch(list, 103, block.timestamp - 1);
        vm.expectRevert(abi.encodeWithSelector(V.MaxTokenExceeded.selector, 103, 102));
        conversion.withdrawBatch(list, 102, block.timestamp);
        conversion.withdrawBatch(list, 103, block.timestamp); // inclusive max and deadline
        uint256 net = conversion.quoteReturn(1) - 5;
        vm.expectRevert(abi.encodeWithSelector(V.MinTokenNotMet.selector, net, net + 1));
        conversion.returnItems(list, net + 1, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(V.DeadlineExpired.selector, block.timestamp - 1, block.timestamp));
        conversion.returnItems(list, 0, block.timestamp - 1);
        conversion.returnItems(list, net, block.timestamp); // inclusive minimum
        vm.expectRevert(V.LastItem.selector);
        conversion.withdrawBatch(_list(0, 10), type(uint256).max, block.timestamp);
        vm.stopPrank();
        _pick(0, 9);
        vm.expectRevert(V.LastItem.selector);
        conversion.quoteWithdraw(1);
        _return(0, 9);
        _invariants(0);
    }

    function test_emptyOversizeDuplicateAndUnknownIds() public {
        _ready(65, 100003, false);
        uint256[] memory list = new uint256[](0);
        vm.startPrank(ALICE);
        vm.expectRevert(V.InvalidIdList.selector);
        conversion.withdrawBatch(list, type(uint256).max, block.timestamp);
        vm.expectRevert(V.InvalidIdList.selector);
        conversion.returnItems(list, 0, block.timestamp);
        list = _list(0, 33);
        vm.expectRevert(abi.encodeWithSelector(B.ItemBatchTooLarge.selector, 33, 32));
        conversion.withdrawBatch(list, type(uint256).max, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(B.ItemBatchTooLarge.selector, 33, 32));
        conversion.returnItems(list, 0, block.timestamp);
        list = _list(0, 2);
        list[1] = list[0];
        vm.expectRevert(V.InvalidIdList.selector);
        conversion.withdrawBatch(list, type(uint256).max, block.timestamp);
        vm.stopPrank();
        _pick(0, 32);
        vm.startPrank(ALICE);
        vm.expectRevert(V.InvalidIdList.selector);
        conversion.returnItems(list, 0, block.timestamp);
        list = _list(32, 1);
        vm.expectRevert(abi.encodeWithSelector(V.NotOwner.selector, list[0]));
        conversion.returnItems(list, 0, block.timestamp);
        list[0] = 12345;
        vm.expectRevert(abi.encodeWithSelector(V.IneligibleId.selector, 12345));
        conversion.withdrawBatch(list, type(uint256).max, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(V.NotOwner.selector, 12345));
        conversion.returnItems(list, 0, block.timestamp);
        vm.stopPrank();
        _return(0, 32);
        _invariants(0);
    }

    function test_pickAndReturnAtSupplyFloorRollBackEverything() public {
        _ready(10, 1003, false);
        _pick(0, 1);
        uint256 burn = token.totalSupply() - vault.supplyFloor();
        vm.prank(ALICE);
        token.burn(burn);
        bytes32 beforeState = _stateHash();
        uint256[] memory list = _list(0, 1);
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.BurnBelowSupplyFloor.selector, 109, 110));
        conversion.returnItems(list, 0, block.timestamp);
        list = _list(1, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.BurnBelowSupplyFloor.selector, 109, 110));
        conversion.withdrawBatch(list, 2, block.timestamp);
        vm.stopPrank();
        assertEq(_stateHash(), beforeState);
        assertTrue(vault.isOutside(ids[0]));
        assertFalse(vault.isOutside(ids[1]));
        assertEq(SetStandardERC721(collection).ownerOf(ids[0]), ALICE);
        _invariants(0);
    }

    function test_exactFloorPickAndZeroNetReturn() public {
        _ready(10, 12, false);
        (uint256 p, uint256 f) = _pick(0, 1);
        assertEq(p, 2);
        assertEq(f, 1);
        assertEq(token.totalSupply(), vault.supplyFloor());
        _invariants(0);
        _ready(10, 13, false);
        _pick(0, 1);
        uint256 balance = token.balanceOf(ALICE);
        (p, f) = _return(0, 1);
        assertEq(p, 1);
        assertEq(f, 1);
        assertEq(token.balanceOf(ALICE), balance);
        assertEq(token.totalSupply(), vault.supplyFloor());
        _invariants(0);
    }

    function test_tokenBalanceAllowanceAndQuoteDefenses() public {
        _ready(10, 1003, false);
        uint256[] memory list = _list(0, 1);
        vm.startPrank(ALICE);
        token.approve(address(vault), 106);
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.InsufficientAllowance.selector, 106, 107));
        conversion.withdrawBatch(list, 107, block.timestamp);
        token.approve(address(vault), type(uint256).max);
        token.transfer(BOB, 897);
        vm.expectRevert(abi.encodeWithSelector(V.InsufficientToken.selector, 106, 107));
        conversion.withdrawBatch(list, 107, block.timestamp);
        vm.stopPrank();
        vm.prank(BOB);
        token.transfer(ALICE, 897);
        _pick(0, 1);
        vm.expectRevert(abi.encodeWithSelector(V.InvalidQuantity.selector, 2, 1));
        conversion.quoteReturn(2);
        vm.expectRevert(V.InvalidIdList.selector);
        conversion.quoteWithdraw(0);
        vm.expectRevert(abi.encodeWithSelector(B.ItemBatchTooLarge.selector, 33, 32));
        conversion.quoteReturn(33);
        // Synthetic impossible token observations exercise the defensive quote refusals directly.
        vm.mockCall(address(token), abi.encodeWithSignature("totalSupply()"), abi.encode(uint256(109)));
        vm.expectRevert(abi.encodeWithSelector(V.ReturnBelowUnit.selector, 0, 1));
        conversion.quoteReturn(1);
        vm.mockCall(address(token), abi.encodeWithSignature("totalSupply()"), abi.encode(uint256(1019)));
        vm.expectRevert(abi.encodeWithSelector(V.EscrowInsolvent.selector, 102, 101));
        conversion.quoteReturn(1);
        vm.clearMockedCalls();
        _invariants(0);
    }

    function test_onlyWithdrawnMembersMayReturnEvenAfterIssuerSeizure() public {
        _ready(10, 1003, true);
        HostileERC721 nft = HostileERC721(collection);
        nft.seize(ids[0], ALICE);
        uint256[] memory list = _list(0, 1);
        vm.startPrank(ALICE);
        vm.expectRevert(abi.encodeWithSelector(V.NotOwner.selector, ids[0]));
        conversion.returnItems(list, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(SetRefused.selector, R.OWNER_MISMATCH, 10));
        conversion.withdrawBatch(list, 1003, block.timestamp);
        vm.stopPrank();
        nft.mint(ALICE, 77);
        list[0] = 77;
        vm.startPrank(ALICE);
        nft.transferFrom(ALICE, address(vault), 77);
        vm.expectRevert(abi.encodeWithSelector(V.NotOwner.selector, 77));
        conversion.returnItems(list, 0, block.timestamp);
        vm.stopPrank();
        assertFalse(vault.eligible(77));
        assertEq(vault.inside(), 10);
        assertEq(vault.escrowPrincipal(), 0);
    }

    function test_closedAndFailedHaveNoConversionQuotesOrActions() public {
        _standard(10);
        _deploy(true);
        conversion = ConversionVault(address(vault));
        uint256[] memory list = _list(0, 1);
        for (uint256 phase; phase < 3; ++phase) {
            vm.expectRevert(V.GateClosed.selector);
            conversion.quoteWithdraw(1);
            vm.expectRevert(V.GateClosed.selector);
            conversion.quoteReturn(1);
            vm.expectRevert(V.GateClosed.selector);
            conversion.withdrawBatch(list, 0, block.timestamp);
            vm.expectRevert(V.GateClosed.selector);
            conversion.returnItems(list, 0, block.timestamp);
            if (phase == 0) {
                _page(0, 10);
                loader.complete();
            }
            if (phase == 1) {
                vm.prank(address(box));
                vault.enterFailure();
            }
        }
        (uint256 k, uint256 r) = vault.escrowSurplus();
        assertEq(k, 0);
        assertEq(r, 0);
    }

    function test_extraTokenBalanceIsNotEscrowOrAQuoteInput() public {
        _ready(10, 1003, false);
        _pick(0, 2);
        uint256 quoted = conversion.quoteReturn(1);
        uint256 e = vault.escrowPrincipal();
        // The real T forbids gifts. Model a pre-existing extra balance without changing supply: only the
        // authenticated vault can pull; this prank is a test seam, not a callable vault operation.
        vm.prank(address(vault));
        token.transferFrom(ALICE, address(vault), 7);
        assertEq(vault.escrowPrincipal(), e);
        assertEq(conversion.quoteReturn(1), quoted);
        _return(0, 2);
        _invariants(7);
    }
}
