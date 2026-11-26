// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ItemAccountingBase} from "./Accounting.t.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {ItemLedgerProbe, ItemPriceDouble} from "./Fixture.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IBoxVaultItemsV2, ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {ItemKit} from "../kit/m3/ItemKit.sol";

contract ItemBoundariesTest is ItemAccountingBase, IUnlockCallback {
    function _args(uint8 b, uint8 s) internal view returns (bytes memory) {
        return abi.encodePacked(
            address(c), address(j), address(j), address(j), address(j), DEPTH, address(0), b, s, uint256(1), uint256(10)
        );
    }

    function _clone(bytes memory args) internal returns (ItemLedgerProbe l) {
        l = ItemLedgerProbe(BoxClones.create(BoxClones.initCode(address(implementation), args)));
        c.configure(address(pm), address(j), DEPTH, address(l));
    }

    function test_wrongCallerLengthRoleAndEveryWiringAddress() public {
        ItemLedgerProbe l = _clone(_args(1, 2));
        vm.expectRevert();
        l.initialize();
        l = _clone(bytes.concat(_args(1, 2), hex"00"));
        vm.expectRevert();
        c.initializeLedger();
        l = _clone(_args(4, 2));
        vm.expectRevert();
        c.initializeLedger();
        l = _clone(_args(0, 0));
        vm.expectRevert();
        c.initializeLedger();
        for (uint256 offset; offset <= 120; offset += 20) {
            bytes memory args = _args(1, 2);
            // Change only one address, preserving the packed adjacent fields.
            for (uint256 i; i < 20; ++i) {
                args[offset + i] = bytes1(uint8(0xBB));
            }
            l = _clone(args);
            vm.expectRevert();
            c.initializeLedger();
        }
        l = _clone(_args(1, 2));
        c.configure(address(pm), address(j), DEPTH, address(ledger));
        vm.prank(address(c));
        vm.expectRevert();
        l.initialize();
    }

    function test_uninitializedNoticeAndViewsRefuse() public {
        ItemLedgerProbe l = _clone(_args(1, 2));
        (uint8 b, uint8 s) = l.insidePolicies();
        assertEq(b, 1);
        assertEq(s, 2);
        vm.expectRevert();
        l.sync(1);
        vm.expectRevert();
        l.flushResidue();
        vm.prank(address(j));
        vm.expectRevert();
        l.onTicketsOpened(1, 4);
        vm.expectRevert();
        l.itemCredit(1);
        vm.expectRevert();
        l.ticketCredit(bytes32(0));
    }

    function test_productionArtifactAndCloneWithoutProbe() public {
        ItemLedgerV2 impl = new ItemLedgerV2(pm, implementation.coordinatorImplementation());
        assertLe(address(impl).code.length, 22_118);
        emit log_named_uint("ItemLedgerV2 runtime bytes", address(impl).code.length);
        IItemLedgerV2 actual = IItemLedgerV2(BoxClones.create(BoxClones.initCode(address(impl), _args(1, 2))));
        c.configure(address(pm), address(j), DEPTH, address(actual));
        j.wire(address(c), address(actual), 1);
        c.initializeLedger();
        j.fund(1, 2, 0, 43);
        j.graduate();
        actual.sync(32);
        m.sync(32);
        ItemKit.compare(m, actual, 1, 4, keys);
        assertEq(actual.flushResidue(), m.flushResidue());
        assertEq(pm.balanceOf(DEPTH, 0), 3);
        assertEq(pm.balanceOf(address(actual), 0), 40);
    }

    function test_foreignUnlockCannotReplayOrFlush() public {
        j.graduate();
        _page(32);
        j.fund(1, 2, 0, 43);
        _page(32);
        pm.unlock(abi.encodeCall(IItemLedgerV2.sync, (32)));
        pm.unlock(abi.encodeCall(IItemLedgerV2.flushResidue, ()));
        _compare();
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (bool ok, bytes memory result) = address(ledger).call(data);
        assertFalse(ok);
        assertEq(result, abi.encodeWithSelector(ItemLedgerV2.ForeignUnlock.selector));
        return "";
    }

    function test_refusedFundingTransferPublishesNothing() public {
        j.graduate();
        _page(32);
        vm.deal(address(j), 0);
        vm.expectRevert();
        j.fund(1, 2, 0, 43);
        assertEq(h.itemFundingCount(), 2);
        assertEq(h.received(), 0);
        _page(32);
    }

    function test_revertingLedgerCannotBlockReceiptAndClaimsTransfer() public {
        j.graduate();
        _page(32);
        bytes memory code = address(ledger).code;
        vm.etch(address(ledger), hex"60006000fd");
        j.fund(1, 2, 0, 43);
        assertEq(h.itemFundingCount(), 3);
        assertEq(pm.balanceOf(address(ledger), 0), 43);
        vm.etch(address(ledger), code);
        _page(32);
    }

    function test_erc20ResidueUsesOnlyFixedPClaimsEvenWhileTokenPaused() public {
        uint8[3] memory decimals = [uint8(6), uint8(8), uint8(18)];
        for (uint256 i; i < decimals.length; ++i) {
            _setup(1, 2, 1);
            ItemPriceDouble token = new ItemPriceDouble(decimals[i]);
            j.setPrice(address(token));
            c.setPrice(address(token));
            bytes memory args = abi.encodePacked(
                address(c),
                address(j),
                address(j),
                address(j),
                address(j),
                DEPTH,
                address(token),
                uint8(1),
                uint8(2),
                uint256(1),
                uint256(10)
            );
            ItemLedgerProbe actual = _clone(args);
            j.wire(address(c), address(actual), 1);
            c.initializeLedger();
            uint256 p = 40 * 10 ** decimals[i] + 3;
            token.mint(address(j), p);
            j.graduate();
            actual.sync(32);
            m.sync(32);
            j.fund(1, 2, 0, p);
            actual.sync(32);
            m.sync(32);
            ItemKit.compare(m, actual, 1, 4, keys);
            token.pause();
            assertEq(actual.flushResidue(), m.flushResidue());
            assertEq(pm.balanceOf(DEPTH, uint160(address(token))), 3);
            assertEq(pm.balanceOf(address(actual), uint160(address(token))), p - 3);
            assertEq(token.balanceOf(address(pm)), p);
            assertEq(pm.balanceOf(DEPTH, 0), 0);
        }
    }

    function test_sameSourceCanEmitMultipleImmutableReceipts() public {
        j.graduate();
        _page(32);
        j.pick(1, ALICE);
        _page(32);
        j.fund(1, 1, 1, 41);
        _page(32);
        j.fund(1, 1, 1, 7);
        _page(32);
        assertEq(h.itemFunding(3).choiceP, 41);
        assertEq(h.itemFunding(4).choiceP, 7);
        (uint256 p,) = ledger.itemCredit(1);
        assertEq(p, 11);
        _page(32);
        assertEq(ledger.fundingCursor(), 4);
    }

    function test_initialZeroItemIdIsValid() public {
        // The real vault's valid range may start at zero; zero also remains the Request/Cancel sentinel.
        // The local history adapter uses a positive offset, so feed the zero-id record directly.
        vm.mockCall(address(j), abi.encodeWithSignature("firstId()"), abi.encode(uint256(0)));
        ItemLedgerProbe l = _clone(_args(1, 2));
        c.initializeLedger();
        (uint256 p, uint256 s) = l.itemCredit(0);
        assertEq(p + s, 0);
        vm.expectRevert();
        l.itemCredit(4);
        j.wire(address(c), address(l), 1);
        j.graduate();
        l.sync(32);
        j.fund(1, 2, 0, 40);
        l.sync(32);
        j.pick(1, ALICE);
        ItemLifecycleV2 memory op = h.itemLifecycle(1);
        op.itemId = 0;
        j.corruptOperation(1, op);
        l.sync(32);
        j.fund(1, 2, 0, 40);
        l.sync(32);
        (p, s) = l.itemCredit(0);
        assertEq(p, 10);
        assertEq(s, 10);
        vm.clearMockedCalls();
    }

    function test_failureReleaseAndTerminalDeliveryHaveNoMoney() public {
        j.request(_key(1));
        _page(32);
        j.fail();
        ItemLifecycleV2 memory op = ItemLifecycleV2(bytes32(0), 1, 0, uint64(block.timestamp), 6);
        vm.mockCall(address(j), abi.encodeCall(IBoxVaultItemsV2.itemLifecycleCount, ()), abi.encode(uint256(2)));
        vm.mockCall(address(j), abi.encodeCall(IBoxVaultItemsV2.itemLifecycle, (2)), abi.encode(op));
        ledger.sync(1);
        assertEq(ledger.lifecycleCursor(), 2);
        (uint256 p, uint256 s) = ledger.itemCredit(1);
        assertEq(p + s, 0);
        op = ItemLifecycleV2(keys[0], 2, 0, uint64(block.timestamp), 2);
        vm.mockCall(address(j), abi.encodeCall(IBoxVaultItemsV2.itemLifecycleCount, ()), abi.encode(uint256(3)));
        vm.mockCall(address(j), abi.encodeCall(IBoxVaultItemsV2.itemLifecycle, (3)), abi.encode(op));
        ledger.sync(1);
        (p, s) = ledger.itemCredit(2);
        assertEq(p + s, 0);
        (,, bool open) = ledger.ticketCredit(keys[0]);
        assertFalse(open);
    }

    function test_syncCostIndependentOfCollectionSizeAndOpenTickets() public {
        j.graduate();
        ledger.sync(32);
        j.fund(1, 2, 0, 400);
        uint256 gasBefore = gasleft();
        ledger.sync(1);
        uint256 small = gasBefore - gasleft();
        _setupCount(1, 2, 1, 10_000);
        j.graduate();
        ledger.sync(32);
        for (uint256 i = 1; i <= 32; ++i) {
            j.request(_key(i));
        }
        ledger.sync(32);
        j.fund(1, 2, 0, 1_000_000);
        gasBefore = gasleft();
        ledger.sync(1);
        uint256 large = gasBefore - gasleft();
        assertLt(large, small + 50_000);
        emit log_named_uint("4 items receipt gas", small);
        emit log_named_uint("10000 items and 32 open tickets receipt gas", large);
    }

    function test_fullPageLimitAndFutureCursorNeverAdvance() public {
        j.graduate();
        _page(32);
        for (uint256 i; i < 40; ++i) {
            j.fund(1, 2, 0, 41);
        }
        _page(32);
        assertEq(ledger.fundingCursor(), 34);
        _page(32);
        assertEq(ledger.fundingCursor(), 42);
        j.request(_key(1));
        ItemLifecycleV2 memory op = h.itemLifecycle(1);
        op.fundingCursor = 99;
        j.corruptOperation(1, op);
        vm.expectRevert();
        ledger.sync(32);
        assertEq(ledger.lifecycleCursor(), 0);
    }
}
