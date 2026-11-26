// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxData} from "../../../../src/box/libraries/BoxData.sol";
import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU7FableBase} from "./AuditU7FableBase.sol";

/// @notice SH-AUDIT-B0 U7 (Fable). Box 0 as the factory creates it (L8, P7.14), the entry points before graduation
/// (L2, P7.4, P7.5), the ERC-721 / ERC-165 / ERC-2981 surface on implicit ownership (L6, P7.11) and `royaltyInfo`
/// (L1, P7.3), on the factory's box 0 of the audit world (mainnet build, N 1,969, real observer).
/// forge-config: default.evm_version = "osaka"
contract AuditU7FableCreationTest is AuditU7FableBase {
    // ============================================================================================ L8 creation

    /// P7.14 (BC-009, BC-008, `BoxVault.initialize` `:89-115`, `IBoxVault.sol:70`): every id from 1 to N is the
    /// vault's by implicit ownership, the counts word reads (n = N, h = N with the tickets adapter, t = 0, gate
    /// closed), the wiring and the fee rates are box 0's.
    function testProperty_AUDIT_U7_creationCustodyAndWiring() public view {
        uint256 n = editionSize;
        assertEq(n, 1_969, "the mainnet edition (F141)");
        assertEq(collection.totalSupply(), n);
        assertEq(collection.balanceOf(a.vault), n, "every id in the vault");
        assertEq(collection.ownerOf(1), a.vault);
        assertEq(collection.ownerOf(n), a.vault);
        assertEq(collection.ownerOf(n / 2), a.vault);
        assertEq(vault.inside(), n);
        assertEq(vault.hiddenCount(), n, "hidden = N with the tickets adapter");
        assertEq(vault.shelfCount(), 0);
        assertEq(vault.pendingTickets(), 0);
        assertEq(vault.outside(), 0);
        assertFalse(vault.gateOpen());
        assertEq(vault.gateOpenedAt(), 0);
        assertFalse(vault.handBackFeeWaived());
        assertEq(vault.escrowPrincipal(), 0);
        assertEq(vault.unsolicitedToken(), 0);
        assertEq(vault.supplyFloor(), n, "floor = E + n = N");
        assertEq(vault.activeSupply(), token.totalSupply());
        assertEq(vault.ticketAdapter(), a.tickets);
        assertEq(vault.observer(), a.itemStream, "the real stream is the vault's observer");
        assertEq(collection.transferObserver(), a.itemStream, "and the collection's");
        assertEq(vault.collection(), a.collection);
        assertEq(vault.token(), a.token);
        assertEq(vault.coordinator(), a.coordinator);
        assertEq(vault.collectionSize(), n);
        assertEq(vault.firstId(), 1);
        assertEq(vault.drawFeeBps(), BoxSpecV1.DRAW_FEE_BPS);
        assertEq(vault.pickFeeBps(), BoxSpecV1.PICK_FEE_BPS);
        assertEq(vault.returnFeeBps(), BoxSpecV1.RETURN_FEE_BPS);
        assertEq(vault.FEE_DENOMINATOR(), BPS);
        assertEq(vault.observerGas(), OBSERVER_GAS);
        assertEq(collection.observerGas(), OBSERVER_GAS, "one cap for both callers");
        assertEq(vault.coordinatorImplementation(), kit.impls().coordinator);
        assertEq(collection.coordinatorImplementation(), kit.impls().coordinator);
        // Per-id views at creation.
        assertTrue(vault.isHidden(1) && vault.isHidden(n));
        assertTrue(vault.isInside(1) && vault.isInside(n));
        assertFalse(vault.isOnShelf(1) || vault.isOutside(1) || vault.hasLeftVault(1));
        assertFalse(vault.isHidden(0) || vault.isInside(0) || vault.isOnShelf(0), "0 is no id");
        assertFalse(vault.isHidden(n + 1) || vault.isInside(n + 1), "N + 1 is no id");
        assertEq(collection.firstId(), 1);
        assertEq(collection.collectionSize(), n);
        assertEq(collection.treeDepth(), 11, "ceil(log2 1,969)");
        assertEq(collection.revealTriggers(), collection.REVEAL_ON_EXIT(), "box 0 reveals on exit only");
        assertEq(collection.revealUnlocker(), address(0), "nobody unlocks");
        assertEq(collection.revealedCount(), 0);
        assertEq(collection.vault(), a.vault);
        assertEq(collection.token(), a.token);
        assertEq(collection.coordinator(), a.coordinator);
        assertEq(collection.receiver(), a.receiver);
        assertEq(collection.owner(), safe, "marketplace owner: the platform Safe (F26 (4))");
        _assertVlt08("created");
        _assertVaultApprovesNobody();
    }

    /// P7.14 (BC-062, `BoxCollection.initialize` `:112-117`): the table data contract is 0x00 ‖ table, the table's
    /// keccak256 is the clone argument, the bytes the collection serves are the same, and the table passes the
    /// format check again.
    function testProperty_AUDIT_U7_tableStopPrefixAndHash() public {
        bytes memory code = a.table.code;
        assertGt(code.length, 1);
        assertEq(uint8(code[0]), 0, "STOP prefix");
        bytes memory t = BoxData.read(a.table);
        assertEq(t.length, code.length - 1);
        assertEq(keccak256(abi.encodePacked(hex"00", t)), keccak256(code), "code = 0x00 || table");
        assertEq(keccak256(t), collection.metadataTableHash(), "the committed hash");
        assertEq(collection.metadataTableBytes(), t, "the bytes served");
        assertEq(collection.metadataTable(), a.table);
        assertEq(uint8(t[0]), BoxMetadataTable.VERSION, "format v1");
        BoxMetadataTable.validate(t); // reverts on a malformed table
        // The Sepolia fixture's per-item description is empty (F141 sets the mainnet line at launch).
        emit log_named_uint("table bytes", t.length);
        emit log_named_uint("per-item description bytes", BoxMetadataTable.description(t).length);
        assertLe(t.length, BoxSpecV1.MAX_METADATA_TABLE_BYTES);
    }

    /// BC-100 (`BoxCloneBase.sol:14-16`, `IBoxVault.sol:91-93`, `IBoxCollection.sol:95-97`): the implementations the
    /// clones delegate to are never initialised and refuse every write.
    function testProperty_AUDIT_U7_uninitialisedImplementationsRefuse() public {
        CoreImpls memory impls = kit.impls();
        BoxVault vImpl = BoxVault(impls.vault);
        BoxCollection cImpl = BoxCollection(impls.collection);
        assertEq(vImpl.inside(), 0);
        assertEq(vImpl.supplyFloor(), 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, eoa[0]));
        vm.prank(eoa[0]);
        vImpl.initialize();
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, eoa[0]));
        vm.prank(eoa[0]);
        vImpl.openGate();
        vm.expectRevert(IBoxVault.NotInitialised.selector);
        vm.prank(eoa[0]);
        vImpl.withdraw(1, type(uint256).max, block.timestamp);
        vm.expectRevert(IBoxVault.NotInitialised.selector);
        vm.prank(eoa[0]);
        vImpl.returnItem(1, 0, block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotCoordinator.selector, eoa[0]));
        vm.prank(eoa[0]);
        cImpl.initialize();
        vm.expectRevert(IBoxCollection.NotInitialised.selector);
        vm.prank(eoa[0]);
        cImpl.setApprovalForAll(eoa[1], true);
        vm.expectRevert(IBoxCollection.NotInitialised.selector);
        vm.prank(eoa[0]);
        cImpl.reveal(1, 0, 0, 0, 0, 0, new bytes32[](0));
    }

    /// L8: ETH forced onto the vault or the collection changes nothing (neither has ETH logic); it has no exit here,
    /// which is the accepted forced-ETH class (M27 for the source; the same shape).
    function testProperty_AUDIT_U7_forcedEthIsInert() public {
        _forceEth(a.vault, 1 ether);
        _forceEth(a.collection, 1 ether);
        _toBonding();
        assertEq(a.vault.balance, 1 ether);
        assertEq(a.collection.balance, 1 ether);
        _assertVlt08("bonding with forced ETH");
        _assertGhostLedger();
    }

    // ============================================================================================ L2 access

    /// P7.4, P7.5 (`BoxVault.sol:121-139, 145-221, 474, 510`; `BoxCollection.sol:107-111, 298-306`; F30 Q3; BC-097,
    /// BC-100): before graduation nothing leaves; the gate and the waiver answer the coordinator only; the ticket
    /// entry points answer the adapter only (the delivery refuses while the gate is closed even for the adapter);
    /// `initialize` runs once; `unlockReveal` has no caller on box 0; nothing inside is revealable.
    function testProperty_AUDIT_U7_gateAndAdapterAccessBeforeGraduation() public {
        uint256 now_ = block.timestamp;
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, eoa[0]));
        vm.prank(eoa[0]);
        vault.openGate();
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, eoa[0]));
        vm.prank(eoa[0]);
        vault.waiveHandBackFee();
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, a.tickets));
        vm.prank(a.tickets);
        vault.openGate();

        vm.expectRevert(IBoxVault.GateClosed.selector);
        vm.prank(eoa[0]);
        vault.withdraw(1, type(uint256).max, now_);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vm.prank(eoa[0]);
        vault.withdrawBatch(_ids2(1, 2), type(uint256).max, now_);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vm.prank(eoa[0]);
        vault.returnItem(1, 0, now_);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vm.prank(eoa[0]);
        vault.returnItems(_ids2(1, 2), 0, now_);

        address[3] memory strangers = [eoa[0], a.coordinator, a.itemStream];
        for (uint256 i; i < strangers.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, strangers[i]));
            vm.prank(strangers[i]);
            vault.openTickets(1, type(uint256).max);
            vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, strangers[i]));
            vm.prank(strangers[i]);
            vault.releaseTickets(1, eoa[0], 0);
            vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, strangers[i]));
            vm.prank(strangers[i]);
            vault.deliverTicket(1, eoa[0]);
        }
        // The adapter itself (its address pranked: the only way to reach this branch before the gate) cannot deliver.
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vm.prank(a.tickets);
        vault.deliverTicket(1, eoa[0]);

        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, eoa[0]));
        vm.prank(eoa[0]);
        vault.initialize();
        vm.expectRevert(IBoxVault.AlreadyInitialised.selector);
        vm.prank(a.coordinator);
        vault.initialize();
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotCoordinator.selector, eoa[0]));
        vm.prank(eoa[0]);
        collection.initialize();
        vm.expectRevert(IBoxCollection.AlreadyInitialised.selector);
        vm.prank(a.coordinator);
        collection.initialize();

        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotRevealUnlocker.selector, eoa[0]));
        vm.prank(eoa[0]);
        collection.unlockReveal(1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotRevealUnlocker.selector, a.tickets));
        vm.prank(a.tickets);
        collection.unlockReveal(1);
        assertFalse(collection.isRevealable(1));
        (bool left, bool unlocked, bool revealed, bool revealable) = collection.revealState(1);
        assertFalse(left || unlocked || revealed || revealable);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotRevealable.selector, 1));
        collection.reveal(1, 0, 0, 0, 0, 0, new bytes32[](0));
        _assertVlt08("before graduation");
    }

    /// P7.1, P7.4 (BC-097, `BoxVault.sol:145-200`; F23 C3): placeholders on the curve lock ⌈A·k/n⌉ plus the 1% fee
    /// in E and count outside without naming an id (every id stays hidden); a hand-back before graduation pays
    /// ⌊A·k/n⌋ less the 5% return fee (not waived: v1 never waives); VLT-08 holds throughout.
    function testProperty_AUDIT_U7_ticketsOnTheCurveKeepVlt08() public {
        _toBonding();
        uint256 n = editionSize;
        assertEq(vault.pendingTickets(), 5);
        assertEq(vault.inside(), n - 5);
        assertEq(vault.hiddenCount(), n - 5);
        assertEq(vault.shelfCount(), 0);
        assertEq(collection.balanceOf(a.vault), n, "tickets move no item");
        assertGt(vault.escrowPrincipal(), 0);
        uint256 hidden;
        for (uint256 id = 1; id <= n; ++id) {
            if (vault.isHidden(id)) ++hidden;
        }
        assertEq(hidden, vault.hiddenCount() + vault.pendingTickets(), "hidden ids = h + t");
        _assertVlt08("bonding");
        _assertVaultApprovesNobody();

        (uint256 p, uint256 f) = vault.quoteHandBack(1);
        (uint256 rp, uint256 rf) = _returnQuote(1);
        assertEq(p, rp, "hand-back principal = floor(A/n)");
        assertEq(f, rf, "hand-back fee = 5% while the gate is closed");
        assertEq(f, _ceilFee(p, RETURN_BPS));
        uint256 t0 = token.balanceOf(eoa[0]);
        uint256 s0 = token.totalSupply();
        uint256 e0 = vault.escrowPrincipal();
        (uint256 principal, uint256 fee) = _handBack(eoa[0], _ids1(3));
        assertEq(principal, p);
        assertEq(fee, f);
        assertEq(token.balanceOf(eoa[0]), t0 + p - f, "the holder gets principal less the fee");
        assertEq(token.totalSupply(), s0 - f, "the fee is burned");
        assertEq(vault.escrowPrincipal(), e0 - p);
        assertEq(vault.pendingTickets(), 4);
        assertEq(vault.hiddenCount(), n - 4);
        assertEq(vault.inside(), n - 4);
        _assertVlt08("after a hand-back");
        _assertGhostLedger();
    }

    /// P7.4 (F30 Q3; `BoxCoordinator.sol:266`, the one caller of `openGate` in `src/box`; `BoxVault.sol:121-139`):
    /// graduation opens the gate once, at the graduation time; nobody opens or waives afterwards; v1 never waived.
    function testProperty_AUDIT_U7_graduationOpensTheGateOnce() public {
        _toGraduated();
        assertTrue(vault.gateOpen());
        assertEq(vault.gateOpenedAt(), coordinator.graduatedAt(), "opened in graduate()");
        assertEq(vault.gateOpenedAt(), block.timestamp);
        assertFalse(vault.handBackFeeWaived(), "no v1 path waives (no caller in src/box)");
        vm.expectRevert(IBoxVault.GateAlreadyOpen.selector);
        vm.prank(a.coordinator);
        vault.openGate();
        vm.expectRevert(IBoxVault.GateAlreadyOpen.selector);
        vm.prank(a.coordinator);
        vault.waiveHandBackFee();
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, keeper));
        vm.prank(keeper);
        vault.openGate();
        // After graduation a hand-back carries no fee in the vault's quote (the adapter closes hand-backs itself).
        (, uint256 fee) = vault.quoteHandBack(1);
        assertEq(fee, 0, "no hand-back fee once the gate is open");
        _assertVlt08("graduated");
    }

    // ============================================================================================ L6 ERC-721

    /// P7.11 (ERC-721, ERC-6093 names, `BoxCollection.sol:238-294, 641-644, 684-698`): the views on implicit
    /// ownership and every refusal of the standard before any item moved.
    function testProperty_AUDIT_U7_erc721ViewsAndRefusalsBeforeAnyMove() public {
        uint256 n = editionSize;
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidOwner.selector, address(0)));
        collection.balanceOf(address(0));
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, 0));
        collection.ownerOf(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, n + 1));
        collection.ownerOf(n + 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, 0));
        collection.getApproved(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, n + 1));
        collection.tokenURI(n + 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, n + 1));
        collection.isRevealed(n + 1);
        assertEq(collection.getApproved(1), address(0));
        assertFalse(collection.isApprovedForAll(a.vault, eoa[0]));
        assertGt(bytes(collection.name()).length, 0);
        assertGt(bytes(collection.symbol()).length, 0);

        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidApprover.selector, eoa[0]));
        vm.prank(eoa[0]);
        collection.approve(eoa[1], 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidOperator.selector, address(0)));
        vm.prank(eoa[0]);
        collection.setApprovalForAll(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[0], 1));
        vm.prank(eoa[0]);
        collection.transferFrom(a.vault, eoa[0], 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InsufficientApproval.selector, eoa[0], 1));
        vm.prank(eoa[0]);
        collection.safeTransferFrom(a.vault, eoa[0], 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721IncorrectOwner.selector, eoa[0], 1, a.vault));
        vm.prank(eoa[0]);
        collection.transferFrom(eoa[0], eoa[1], 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721InvalidReceiver.selector, address(0)));
        vm.prank(eoa[0]);
        collection.transferFrom(a.vault, address(0), 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, n + 1));
        vm.prank(eoa[0]);
        collection.transferFrom(a.vault, eoa[0], n + 1);
        assertEq(collection.balanceOf(a.vault), n, "nothing moved");
        assertEq(collection.balanceOf(eoa[0]), 0);
    }

    /// P7.11, P7.3 (ERC-165; BC-112, BC-113; `BoxCollection.sol:150-156, 190-219`): the interface ids box 0 reports,
    /// and its royalty wiring: 250 bps to its royalty router at every price, never the payee.
    function testProperty_AUDIT_U7_erc165AndRoyaltyWiring() public view {
        assertTrue(collection.supportsInterface(0x01ffc9a7), "ERC-165");
        assertTrue(collection.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(collection.supportsInterface(0x5b5e139f), "ERC-721 metadata");
        assertTrue(collection.supportsInterface(0x49064906), "ERC-4906");
        assertTrue(collection.supportsInterface(0x2a55205a), "ERC-2981 with the royalties add-on");
        assertFalse(collection.supportsInterface(0xffffffff));
        assertFalse(collection.supportsInterface(0x00000000));
        assertFalse(collection.supportsInterface(0x780e9d63), "no enumerable extension");
        assertEq(collection.royaltyBps(), 250);
        assertEq(uint8(collection.royaltyDestination()), uint8(RoyaltyDestination.FeeHandling));
        assertEq(collection.royaltyRouter(), a.royaltyRouter);
        (address r, uint256 amount) = collection.royaltyInfo(1, 1 ether);
        assertEq(r, a.royaltyRouter);
        assertEq(amount, 0.025 ether);
        (r, amount) = collection.royaltyInfo(editionSize + 5, 10_000);
        assertEq(r, a.royaltyRouter, "the id is not checked");
        assertEq(amount, 250);
        (r, amount) = collection.royaltyInfo(0, type(uint256).max);
        assertEq(amount, FullMath.mulDiv(type(uint256).max, 250, BPS), "no overflow at the largest price");
        (, amount) = collection.royaltyInfo(1, 39);
        assertEq(amount, 0, "floor");
        (, amount) = collection.royaltyInfo(1, 40);
        assertEq(amount, 1);
    }

    /// P7.3 (BC-112, `IBoxCollection.sol:43-44`): `royaltyInfo(id, price)` == (the router, ⌊price × 250 / 10,000⌋)
    /// for any id and any price, never reverting.
    function testFuzz_AUDIT_U7_royaltyInfo(uint256 id, uint256 price) public view {
        (address r, uint256 amount) = collection.royaltyInfo(id, price);
        assertEq(r, a.royaltyRouter);
        assertEq(amount, FullMath.mulDiv(price, 250, BPS));
        assertLe(amount, price);
    }
}

/// @notice The creation transaction's events (L6, P7.11; BC-009; `BoxCollection.sol:123-129`, `BoxVault.sol:112-114`):
/// recorded around the world's setUp, so the ERC-2309 batch, the two `Initialized` events and the absence of N
/// `Transfer` events are pinned on the factory's box 0.
/// forge-config: default.evm_version = "osaka"
contract AuditU7FableCreationEventsTest is AuditU7FableBase {
    uint256 internal consecutiveEvents;
    uint256 internal consecutiveFrom;
    uint256 internal consecutiveTo;
    address internal consecutiveFromAddress;
    address internal consecutiveToAddress;
    uint256 internal transferEvents;
    uint256 internal contractUriEvents;
    uint256 internal collectionInitEvents;
    uint256 internal vaultInitEvents;
    uint256 internal gateEvents;
    bytes internal collectionInitData;
    bytes internal vaultInitData;

    function setUp() public override {
        vm.recordLogs();
        super.setUp();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            VmSafe.Log memory l = logs[i];
            if (l.emitter == a.collection) {
                if (l.topics[0] == IBoxCollection.ConsecutiveTransfer.selector) {
                    ++consecutiveEvents;
                    consecutiveFrom = uint256(l.topics[1]);
                    consecutiveFromAddress = address(uint160(uint256(l.topics[2])));
                    consecutiveToAddress = address(uint160(uint256(l.topics[3])));
                    consecutiveTo = abi.decode(l.data, (uint256));
                } else if (l.topics[0] == IBoxCollection.Transfer.selector) {
                    ++transferEvents;
                } else if (l.topics[0] == IBoxCollection.ContractURIUpdated.selector) {
                    ++contractUriEvents;
                } else if (l.topics[0] == IBoxCollection.CollectionInitialized.selector) {
                    ++collectionInitEvents;
                    collectionInitData = l.data;
                }
            } else if (l.emitter == a.vault) {
                if (l.topics[0] == IBoxVault.VaultInitialized.selector) {
                    ++vaultInitEvents;
                    vaultInitData = l.data;
                } else if (l.topics[0] == IBoxVault.GateOpened.selector) {
                    ++gateEvents;
                }
            }
        }
    }

    function testProperty_AUDIT_U7_creationEvents() public view {
        assertEq(consecutiveEvents, 1, "one ERC-2309 batch for N <= 5,000");
        assertEq(consecutiveFrom, 1);
        assertEq(consecutiveTo, editionSize);
        assertEq(consecutiveFromAddress, address(0));
        assertEq(consecutiveToAddress, a.vault);
        assertEq(transferEvents, 0, "no per-id Transfer at creation (implicit ownership)");
        assertEq(contractUriEvents, 1, "ERC-7572 once");
        assertEq(collectionInitEvents, 1);
        assertEq(vaultInitEvents, 1);
        assertEq(gateEvents, 0, "the gate is not opened at creation");
        (
            address v,
            address t,
            uint256 n,
            uint256 first,
            bytes32 root,
            uint8 triggers,
            address unlocker,
            address observer,
            bytes32 tableHash,
            bytes32 generator,
            bytes32 cover
        ) = abi.decode(
            collectionInitData,
            (address, address, uint256, uint256, bytes32, uint8, address, address, bytes32, bytes32, bytes32)
        );
        assertEq(v, a.vault);
        assertEq(t, a.token);
        assertEq(n, editionSize);
        assertEq(first, 1);
        assertEq(root, collection.revealRoot());
        assertEq(triggers, 1);
        assertEq(unlocker, address(0));
        assertEq(observer, a.itemStream);
        assertEq(tableHash, collection.metadataTableHash());
        assertEq(generator, collection.generatorHash());
        assertEq(cover, collection.collectionCoverSha256());
        (
            address vt,
            address vc,
            uint256 vn,
            uint256 vfirst,
            address vcoord,
            address adapter,
            address vobs,
            uint256 draw,
            uint256 pick,
            uint256 ret
        ) = abi.decode(
            vaultInitData, (address, address, uint256, uint256, address, address, address, uint256, uint256, uint256)
        );
        assertEq(vt, a.token);
        assertEq(vc, a.collection);
        assertEq(vn, editionSize);
        assertEq(vfirst, 1);
        assertEq(vcoord, a.coordinator);
        assertEq(adapter, a.tickets);
        assertEq(vobs, a.itemStream);
        assertEq(draw, BoxSpecV1.DRAW_FEE_BPS);
        assertEq(pick, BoxSpecV1.PICK_FEE_BPS);
        assertEq(ret, BoxSpecV1.RETURN_FEE_BPS);
    }
}
