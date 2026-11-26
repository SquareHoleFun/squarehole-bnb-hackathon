// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxData} from "../../../../src/box/libraries/BoxData.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU7ClaudeBase} from "./AuditU7ClaudeBase.sol";

/// @notice SH-AUDIT-B0-U7 (Claude), lens L8 (deployment) and L2 (access) on the factory's box 0 as created, and L6's
/// ERC-2309 part: every id is the vault's by implicit ownership from creation (BoxCollection.sol:17-18, :92-93;
/// BC-009), the table's data contract carries the STOP prefix and the committed hash (BoxCollection.sol:29-30, :114-117),
/// hidden = N with the tickets adapter (BoxVault.sol:27-28, :111), nothing leaves before graduation (F30 Q3; BC-097's
/// rule on box 0), and only the documented callers reach the coordinator-only and adapter-only entry points
/// (BoxVault.sol:121-221; IBoxVault.sol:122-138). The world records the creation's logs (createBox runs in setUp).
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeCreationTest is AuditU7ClaudeBase {
    /// @dev What the collection emitted while box 0 was created.
    uint256 internal consecutiveEvents;
    uint256 internal consecutiveFrom;
    uint256 internal consecutiveTo;
    address internal consecutiveFromAddress;
    address internal consecutiveToAddress;
    uint256 internal collectionTransfers;
    uint256 internal collectionInitializedEvents;
    uint256 internal vaultInitializedEvents;

    function setUp() public virtual override {
        vm.recordLogs();
        super.setUp();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        bytes32 consecutive = IBoxCollection.ConsecutiveTransfer.selector;
        bytes32 transfer = IBoxCollection.Transfer.selector;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.collection) {
                bytes32 t0 = logs[i].topics[0];
                if (t0 == consecutive) {
                    ++consecutiveEvents;
                    consecutiveFrom = uint256(logs[i].topics[1]);
                    consecutiveTo = abi.decode(logs[i].data, (uint256));
                    consecutiveFromAddress = address(uint160(uint256(logs[i].topics[2])));
                    consecutiveToAddress = address(uint160(uint256(logs[i].topics[3])));
                } else if (t0 == transfer) {
                    ++collectionTransfers;
                } else if (t0 == IBoxCollection.CollectionInitialized.selector) {
                    ++collectionInitializedEvents;
                }
            }
            if (logs[i].emitter == a.vault && logs[i].topics[0] == IBoxVault.VaultInitialized.selector) {
                ++vaultInitializedEvents;
            }
        }
    }

    /// @notice P7.14 / BC-009 / L6 (ERC-2309, EIP-721's creation exception): one ConsecutiveTransfer(1, N, 0, vault)
    /// for N = 1,969 (≤ 5,000 ids per event), no per-id Transfer at creation, one CollectionInitialized and one
    /// VaultInitialized; balanceOf(vault) == N == totalSupply.
    function testProperty_AUDIT_U7_creationEmitsOneConsecutiveTransfer() public view {
        assertEq(consecutiveEvents, 1, "one ERC-2309 event for N <= 5,000");
        assertEq(consecutiveFrom, collection.firstId(), "fromTokenId = firstId");
        assertEq(consecutiveTo, collection.firstId() + editionSize - 1, "toTokenId = firstId + N - 1 (inclusive)");
        assertEq(consecutiveFromAddress, address(0), "fromAddress = 0 (creation)");
        assertEq(consecutiveToAddress, a.vault, "toAddress = the vault");
        assertEq(collectionTransfers, 0, "no per-id Transfer at creation");
        assertEq(collectionInitializedEvents, 1, "CollectionInitialized once");
        assertEq(vaultInitializedEvents, 1, "VaultInitialized once");
        assertEq(collection.balanceOf(a.vault), editionSize, "balanceOf(vault) == N");
        assertEq(collection.totalSupply(), editionSize, "totalSupply == N");
    }

    /// @notice P7.14: every id 1..N is the vault's by implicit ownership: ownerOf == vault while `_owners[id]` (slot 1)
    /// holds zero, never left, hidden (the tickets adapter is set), not revealable (REVEAL_ON_EXIT, BoxFactoryV1Planner
    /// :336), no approval; ids 0 and N + 1 do not exist. The vault's counts: n = h = N, t = 0, E = 0, gate closed.
    function testProperty_AUDIT_U7_everyIdIsTheVaultsImplicitly() public {
        uint256 first = collection.firstId();
        assertEq(first, 1, "box 0's firstId");
        for (uint256 id = first; id < first + editionSize; ++id) {
            assertEq(collection.ownerOf(id), a.vault, "owner: the vault");
            assertEq(vm.load(a.collection, keccak256(abi.encode(id, uint256(1)))), bytes32(0), "_owners[id] unset");
            assertEq(collection.getApproved(id), address(0), "no approval");
            (bool left, bool unlocked, bool revealed, bool revealable) = collection.revealState(id);
            assertFalse(left || unlocked || revealed || revealable, "never left, not revealable");
            assertTrue(vault.isHidden(id) && vault.isInside(id), "hidden and inside");
            assertFalse(vault.isOutside(id) || vault.hasLeftVault(id) || vault.isOnShelf(id), "never left");
        }
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, 0));
        collection.ownerOf(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.ERC721NonexistentToken.selector, editionSize + 1));
        collection.ownerOf(editionSize + 1);
        assertEq(vault.inside(), editionSize, "n == N");
        assertEq(vault.hiddenCount(), editionSize, "h == N with the tickets adapter");
        assertEq(vault.ticketAdapter(), a.tickets, "the tickets adapter");
        assertEq(vault.pendingTickets(), 0, "t == 0");
        assertEq(vault.escrowPrincipal(), 0, "E == 0");
        assertFalse(vault.gateOpen(), "gate closed");
        assertFalse(vault.handBackFeeWaived(), "no waiver");
        assertEq(collection.revealedCount(), 0, "nothing revealed");
        _assertVlt08("created");
    }

    /// @notice P7.14: the metadata table's data contract holds 0x00 ‖ table (the STOP prefix), its keccak256 is the
    /// committed `metadataTableHash`, equal to the spec's table's hash, and `metadataTableBytes()` reads it back.
    function testProperty_AUDIT_U7_tableHasStopPrefixAndCommittedHash() public view {
        address table = collection.metadataTable();
        assertEq(table, a.table, "the world's table address");
        bytes memory code = table.code;
        assertGt(code.length, 1, "table code");
        assertEq(uint8(code[0]), 0, "STOP prefix");
        bytes memory body = BoxData.read(table);
        assertEq(body.length + 1, code.length, "body = code after the prefix");
        BoxSpecV1.BoxSpec memory s = kit.spec();
        assertEq(keccak256(body), keccak256(s.metadataTable), "the spec's table");
        assertEq(collection.metadataTableHash(), keccak256(s.metadataTable), "committed hash");
        assertEq(keccak256(collection.metadataTableBytes()), keccak256(s.metadataTable), "read back");
        assertEq(collection.revealRoot(), s.revealRoot, "committed root");
        assertEq(collection.treeDepth(), 11, "depth ceil(log2 1,969) = 11");
    }

    /// @notice P7.4 (F30 Q3): before graduation nothing leaves and nothing returns: named picks and returns revert
    /// GateClosed, and a delivery reverts GateClosed even for the adapter itself (pranked: the vault's own guard).
    function testProperty_AUDIT_U7_nothingLeavesBeforeTheGate() public {
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.withdraw(5, type(uint256).max, deadline);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.withdrawBatch(_ids2(5, 6), type(uint256).max, deadline);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.returnItem(5, 0, deadline);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.returnItems(_ids2(5, 6), 0, deadline);
        vm.prank(a.tickets);
        vm.expectRevert(IBoxVault.GateClosed.selector);
        vault.deliverTicket(5, eoa[0]);
        assertEq(collection.balanceOf(a.vault), editionSize, "every item inside");
    }

    /// @notice P7.4: openGate and waiveHandBackFee only by the coordinator; any other caller reverts NotCoordinator.
    function testFuzz_AUDIT_U7_onlyTheCoordinatorOpensTheGate(address caller) public {
        vm.assume(caller != a.coordinator);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, caller));
        vault.openGate();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, caller));
        vault.waiveHandBackFee();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotCoordinator.selector, caller));
        vault.initialize();
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxCollection.NotCoordinator.selector, caller));
        collection.initialize();
        assertFalse(vault.gateOpen(), "gate still closed");
    }

    /// @notice P7.4: openTickets, releaseTickets and deliverTicket only by the tickets adapter (NotAdapter otherwise).
    function testFuzz_AUDIT_U7_onlyTheAdapterMovesTickets(address caller, uint256 count, uint256 id) public {
        vm.assume(caller != a.tickets);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, caller));
        vault.openTickets(count, type(uint256).max);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, caller));
        vault.releaseTickets(count, caller, 0);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxVault.NotAdapter.selector, caller));
        vault.deliverTicket(id, caller);
    }

    /// @notice P7.4: a second initialize by the coordinator itself reverts AlreadyInitialised (both clones).
    function testProperty_AUDIT_U7_initializeOnlyOnce() public {
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxVault.AlreadyInitialised.selector);
        vault.initialize();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxCollection.AlreadyInitialised.selector);
        collection.initialize();
    }

    /// @notice P7.4 "waiveHandBackFee never called by v1's coordinator (assert no path)": the selector's four bytes
    /// appear in the runtime code of no box 0 contract, clone or implementation, but the vault implementation itself
    /// (its dispatcher, the control). The coordinator's only raw call is `_poke` with four fixed selectors
    /// (BoxCoordinator.sol:532-539); every other call it makes is a fixed high-level call (graduate's `openGate()` at
    /// :266). After creation the flag reads false.
    function testProperty_AUDIT_U7_noPathCallsWaiveHandBackFee() public view {
        bytes4 sel = IBoxVault.waiveHandBackFee.selector;
        CoreImpls memory im = kit.impls();
        address[22] memory scanned = [
            im.coordinator,
            im.hook,
            im.hookExtension,
            im.launchRouter,
            im.receiver,
            im.receiverExtension,
            im.collection,
            im.tickets,
            im.royaltyRouter,
            im.itemStream,
            im.planner,
            im.factory,
            im.registry,
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.executor,
            a.tickets,
            a.collection,
            a.itemStream,
            a.token
        ];
        for (uint256 i; i < scanned.length; ++i) {
            assertFalse(_containsSelector(scanned[i].code, sel), "selector absent");
        }
        assertTrue(_containsSelector(im.vault.code, sel), "control: the vault's own dispatcher");
        assertFalse(_containsSelector(a.vault.code, sel), "the vault clone carries arguments, not code");
        assertFalse(vault.handBackFeeWaived(), "never waived");
    }

    /// @notice P7.1 "the vault approves nobody": the vault implementation's code holds no ERC-20 `approve` and no
    /// ERC-721 `approve` / `setApprovalForAll` selector (it calls none of them; the T allowance it relies on is the
    /// tickets adapter's own, BoxTickets.sol:124), and at creation T reads no allowance of the vault to any box address.
    function testProperty_AUDIT_U7_vaultCodeApprovesNobody() public view {
        CoreImpls memory im = kit.impls();
        bytes memory code = im.vault.code;
        assertFalse(
            _containsSelector(code, IBoxCollection.approve.selector), "no approve (ERC-20 and ERC-721 share it)"
        );
        assertFalse(_containsSelector(code, IBoxCollection.setApprovalForAll.selector), "no setApprovalForAll");
        address[7] memory spenders =
            [a.tickets, a.itemStream, a.coordinator, a.receiver, a.hook, a.launchRouter, address(this)];
        for (uint256 i; i < spenders.length; ++i) {
            assertEq(token.allowance(a.vault, spenders[i]), 0, "no T allowance");
            assertFalse(collection.isApprovedForAll(a.vault, spenders[i]), "no operator");
        }
    }

    /// @notice L6 (ETH sends of this unit): the vault and the collection take no ETH (no payable function, no receive or
    /// fallback: a plain send and a value-bearing call of a view revert, under any gas) and send none (every call they
    /// make carries value 0: BoxVault.sol:580, :631, BoxCollection.sol:718, :724 and high-level calls to non-payable
    /// functions), so the stipend question of EIP-7702 accounts does not arise inside U7.
    function testProperty_AUDIT_U7_vaultAndCollectionMoveNoEth() public {
        _fund(address(this), 2 ether);
        address[2] memory targets = [a.vault, a.collection];
        for (uint256 i; i < 2; ++i) {
            (bool ok,) = targets[i].call{value: 1 ether}("");
            assertFalse(ok, "a plain send reverts");
            (ok,) = targets[i].call{value: 1, gas: 2_300}("");
            assertFalse(ok, "a stipend send reverts");
            (ok,) = targets[i].call{value: 1}(abi.encodeWithSignature("collectionSize()"));
            assertFalse(ok, "a value-bearing call of a view reverts");
            assertEq(targets[i].balance, 0, "holds no ETH");
        }
    }

    function _containsSelector(bytes memory code, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i + 4 <= code.length; ++i) {
            if (code[i] == sel[0] && code[i + 1] == sel[1] && code[i + 2] == sel[2] && code[i + 3] == sel[3]) {
                return true;
            }
        }
        return false;
    }
}
