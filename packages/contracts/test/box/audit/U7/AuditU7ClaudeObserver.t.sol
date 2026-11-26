// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {ItemReveal, VaultAction} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {AuditU7ClaudeBase} from "./AuditU7ClaudeBase.sol";

/// @title AuditU7ClaudeObserverProbe
/// @notice TEST ONLY. A stand-in observer (its code is etched over the stream's, so the vault and the collection call it
/// with their real cap): it reads the vault's, T's and the collection's state during the call and logs it, so a test
/// sees what the observer could see (P7.6 "called first": before n, E, S or the owner change).
contract AuditU7ClaudeObserverProbe {
    event SawVault(uint8 action, address account, uint256 count, uint256 insideBefore, uint256 inside, uint256 e);
    event SawTransfer(address from, address to, uint256 id, address owner, uint256 fromBalance, uint256 toBalance);

    address public immutable vault;
    address public immutable collection;

    constructor(address vault_, address collection_) {
        vault = vault_;
        collection = collection_;
    }

    function onVaultAction(VaultAction action, address account, uint256 count, uint256 insideBefore) external {
        emit SawVault(
            uint8(action), account, count, insideBefore, IBoxVault(vault).inside(), IBoxVault(vault).escrowPrincipal()
        );
    }

    function onItemTransfer(address from, address to, uint256 id) external {
        IBoxCollection c = IBoxCollection(collection);
        emit SawTransfer(from, to, id, c.ownerOf(id), c.balanceOf(from), c.balanceOf(to));
    }
}

/// @notice SH-AUDIT-B0-U7 (Claude), L3 and L5: the observer (box 0's per-item stream) is called with its whole
/// 460,000-gas cap at every vault and collection entry point, first (before the counts, E and the owner change), and
/// fail-safe (BoxVault.sol:36-37, :621-634; BoxCollection.sol:48-51, :699-720; IBoxItemStream.sol:10-14, :23-24).
/// With the stream's code a gas logger, each entry point's least gas is found to the unit; at it every capped call
/// gets exactly 460,000, and one gas less reverts `ObserverGasTooLow(…, 477,301)` (the floor, cap + cap / 63 +
/// 10,000). A stream that reverts, burns all its gas or returns 64 KiB changes no ownership, count or escrow outcome.
/// The stand-ins (gas logger, probe, misbehaving codes) are etched at the stream's address: the property is how the
/// unit treats its observer's behaviour (plan § 1, World). Already recorded and pinned here: stream-gas R2 and R4
/// (floors, the 10,000 margin), M16 (an exhausted observer's misattribution, accepted): these tests show only the
/// unit's side (outcomes unchanged, caps whole).
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeObserverTest is AuditU7ClaudeBase {
    /// GAS; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; LOG0; STOP: logs the gas left after GAS (what it was given, less 2).
    bytes internal constant GAS_LOGGER = hex"5a60005260206000a000";
    bytes internal constant REVERTS = hex"60006000fd";
    bytes internal constant BURNS_ALL = hex"5b600056";
    bytes internal constant RETURNS_64K = hex"620100006000f3";

    /// One probed call: who sends it, where, with what.
    struct Call {
        address from;
        address to;
        bytes data;
    }

    uint256[] internal shelf;
    uint256 internal p2Item;

    function setUp() public virtual override {
        super.setUp();
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        _buildTree();
        // Three revealed items on the shelf (taken by number, then returned) and item A with its drawer.
        for (uint256 i; i < 3; ++i) {
            uint256 item = _takeItem(eoa[2], 1_000 + i * 97, true);
            _returnItem(eoa[2], item);
            shelf.push(item);
        }
        p2Item = tickets.numberOf(2);
        _approveT(eoa[1], a.vault);
        _approveT(eoa[1], a.tickets);
        vm.prank(eoa[3]);
        collection.setApprovalForAll(a.vault, true);
    }

    // ------------------------------------------------------------------------------------------------ the calls

    function _pickOne() internal view returns (Call memory) {
        return Call(
            eoa[1], a.vault, abi.encodeCall(IBoxVault.withdraw, (shelf[0], type(uint256).max, vm.getBlockTimestamp()))
        );
    }

    function _pickThree() internal view returns (Call memory) {
        return Call(
            eoa[1],
            a.vault,
            abi.encodeCall(
                IBoxVault.withdrawBatch,
                (_ids3(shelf[0], shelf[1], shelf[2]), type(uint256).max, vm.getBlockTimestamp())
            )
        );
    }

    function _returnOne() internal view returns (Call memory) {
        return Call(eoa[3], a.vault, abi.encodeCall(IBoxVault.returnItem, (itemA, 0, vm.getBlockTimestamp())));
    }

    function _takeOne() internal view returns (Call memory) {
        (uint256 item, uint256 index) = _hiddenPoolItem(4_242);
        ItemReveal memory r = tree.itemReveal(item);
        return Call(
            eoa[1],
            a.tickets,
            abi.encodeCall(IBoxTickets.takeByNumber, (item, index, type(uint256).max, vm.getBlockTimestamp(), r))
        );
    }

    function _cancelC() internal view returns (Call memory) {
        return Call(eoa[5], a.tickets, abi.encodeCall(IBoxTickets.cancelDraw, (drawC)));
    }

    function _openPlaceholder() internal view returns (Call memory) {
        ItemReveal memory r = tree.itemReveal(p2Item);
        return Call(eoa[0], a.tickets, abi.encodeCall(IBoxTickets.open, (2, r)));
    }

    function _openDrawB() internal view returns (Call memory) {
        ItemReveal memory r = tree.itemReveal(itemB);
        return Call(
            address(contractDrawer),
            a.tickets,
            abi.encodeCall(IBoxTickets.openDraw, (drawB, address(contractDrawer), r))
        );
    }

    function _transferA() internal view returns (Call memory) {
        return Call(
            eoa[3],
            a.collection,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", eoa[3], eoa[4], itemA)
        );
    }

    function _safeTransferA() internal view returns (Call memory) {
        return Call(
            eoa[3],
            a.collection,
            abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", eoa[3], address(contractDrawer), itemA)
        );
    }

    // ------------------------------------------------------------------------------------------------ the cap

    /// @notice P7.6: at each entry point's least gas every capped observer call receives exactly 460,000 (logged + 2),
    /// as many calls as the action has (vault notices and transfers), and one gas less fails: ObserverGasTooLow naming
    /// the floor 477,301 where the floor binds, or an out-of-gas after the observers where a later step binds (measured:
    /// takeByNumber's reveal under Amsterdam).
    function testProperty_AUDIT_U7_everyEntryPointGivesTheWholeCap() public {
        _checkCap(_pickOne(), 2, "withdraw");
        _checkCap(_pickThree(), 4, "withdrawBatch(3)");
        _checkCap(_returnOne(), 2, "returnItem");
        _checkCap(_takeOne(), 2, "takeByNumber");
        _checkCap(_cancelC(), 1, "cancelDraw");
        _checkCap(_openPlaceholder(), 1, "open");
        _checkCap(_openDrawB(), 1, "openDraw");
        _checkCap(_transferA(), 1, "transferFrom");
        _checkCap(_safeTransferA(), 1, "safeTransferFrom");
    }

    /// @notice P7.6 / L8: returnItems of three items by one holder: 1 + 3 capped calls, each whole at the least gas.
    function testProperty_AUDIT_U7_returnBatchGivesTheWholeCap() public {
        for (uint256 i; i < 3; ++i) {
            _pick(eoa[4], shelf[i]);
        }
        vm.prank(eoa[4]);
        collection.setApprovalForAll(a.vault, true);
        Call memory c = Call(
            eoa[4],
            a.vault,
            abi.encodeCall(IBoxVault.returnItems, (_ids3(shelf[0], shelf[1], shelf[2]), 0, vm.getBlockTimestamp()))
        );
        _checkCap(c, 4, "returnItems(3)");
    }

    function _checkCap(Call memory c, uint256 calls, string memory label) internal {
        uint256 snap = vm.snapshotState();
        vm.etch(a.itemStream, GAS_LOGGER);
        uint256 least = _leastGas(c);
        (bool ok, bytes memory ret, uint256[] memory given) = _try(c, least);
        assertTrue(ok, string.concat(label, ": succeeds at its least gas"));
        assertEq(given.length, calls, string.concat(label, ": capped calls"));
        for (uint256 i; i < given.length; ++i) {
            assertEq(given[i], OBSERVER_CAP, string.concat(label, ": each capped call gets 460,000"));
        }
        (ok, ret,) = _try(c, least - 1);
        assertFalse(ok, string.concat(label, ": one gas less fails"));
        if (ret.length == 0) {
            // The least gas is set after the observers (an out-of-gas further on, e.g. the reveal's new slots under
            // Amsterdam): the caps were whole at the least gas, which is what the property needs.
            emit log_named_uint(string.concat("U7 least gas set past the observer, ", label), least);
        } else {
            assertEq(bytes4(ret), IBoxVault.ObserverGasTooLow.selector, string.concat(label, ": ObserverGasTooLow"));
            (, uint256 required) = abi.decode(_args(ret), (uint256, uint256));
            assertEq(required, OBSERVER_FLOOR, string.concat(label, ": the floor 477,301"));
        }
        emit log_named_uint(string.concat("U7 least gas, ", label), least);
        vm.revertToState(snap);
    }

    /// @dev Binary search for the least call gas at which `c` succeeds (the outcome is monotone in the gas).
    function _leastGas(Call memory c) internal returns (uint256 lo) {
        uint256 hi = 30_000_000;
        lo = 50_000;
        (bool okHi,,) = _try(c, hi);
        require(okHi, "U7: the call succeeds with plenty of gas");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,,) = _try(c, mid);
            if (ok) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    /// @dev One attempt in its own snapshot: success, revert data, and the gas each capped call was given.
    function _try(Call memory c, uint256 gas_) internal returns (bool ok, bytes memory ret, uint256[] memory given) {
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vm.prank(c.from);
        (ok, ret) = c.to.call{gas: gas_}(c.data);
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.itemStream && logs[i].topics.length == 0) ++count;
        }
        given = new uint256[](count);
        count = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.itemStream && logs[i].topics.length == 0) {
                given[count++] = abi.decode(logs[i].data, (uint256)) + 2;
            }
        }
        vm.revertToState(snap);
    }

    function _args(bytes memory ret) internal pure returns (bytes memory out) {
        out = new bytes(ret.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = ret[i + 4];
        }
    }

    // ------------------------------------------------------------------------------------------------ fail-safe

    /// @notice P7.6: a stream that reverts, burns all its gas or returns 64 KiB changes no outcome: the same owners,
    /// counts, escrow and supply as with the real stream, for a pick of three, a return, a take by number, a cancel,
    /// an opening and a transfer; each revert or exhaustion is reported (VaultObserverFailed / TransferObserverFailed),
    /// a 64 KiB answer is a success (no return data is copied).
    function testProperty_AUDIT_U7_failingObserverChangesNoOutcome() public {
        Call[6] memory cs = [_pickThree(), _returnOne(), _takeOne(), _cancelC(), _openPlaceholder(), _transferA()];
        bytes[3] memory bad = [REVERTS, BURNS_ALL, RETURNS_64K];
        // A 64 KiB answer is not a failure: the caps copy no return data (out size 0), so the call succeeds.
        bool[3] memory fails = [true, true, false];
        for (uint256 i; i < cs.length; ++i) {
            bytes32 healthy = _outcome(cs[i], "", false);
            for (uint256 j; j < bad.length; ++j) {
                assertEq(_outcome(cs[i], bad[j], fails[j]), healthy, "the same outcome with a misbehaving observer");
            }
        }
    }

    /// @dev Runs `c` (with `code` at the stream's address when non-empty) in a snapshot and hashes what U7 owns: the
    /// vault's counts, E, S, the T and item balances of the parties, every owner of the involved ids; checks that a
    /// failing observer was reported.
    function _outcome(Call memory c, bytes memory code, bool expectFailure) internal returns (bytes32 h) {
        uint256 snap = vm.snapshotState();
        if (code.length != 0) vm.etch(a.itemStream, code);
        vm.recordLogs();
        vm.prank(c.from);
        (bool ok, bytes memory ret) = c.to.call{gas: 15_000_000}(c.data);
        require(ok, string(ret));
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 failures;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics.length == 0 ? bytes32(0) : logs[i].topics[0];
            if (
                (logs[i].emitter == a.vault && t0 == IBoxVault.VaultObserverFailed.selector)
                    || (logs[i].emitter == a.collection && t0 == IBoxCollection.TransferObserverFailed.selector)
            ) ++failures;
        }
        if (expectFailure) assertGt(failures, 0, "the failure is reported");
        else assertEq(failures, 0, "the real stream never fails here");
        VaultState memory v = _vaultState();
        h = keccak256(abi.encode(v, _owners(), token.balanceOf(c.from), collection.balanceOf(c.from)));
        vm.revertToState(snap);
    }

    function _owners() internal view returns (address[] memory o) {
        uint256[] memory ids = new uint256[](8);
        ids[0] = shelf[0];
        ids[1] = shelf[1];
        ids[2] = shelf[2];
        ids[3] = itemA;
        ids[4] = itemB;
        ids[5] = itemP1;
        ids[6] = p2Item;
        (ids[7],) = _hiddenPoolItem(4_242);
        o = new address[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            o[i] = collection.ownerOf(ids[i]);
        }
    }

    // ------------------------------------------------------------------------------------------------ first

    /// @notice P7.6 "called first": during the vault's notice n and E are still the pre-action values (insideBefore
    /// == inside()), and during a transfer's notice the item is still the sender's, with its old balances.
    function testProperty_AUDIT_U7_observerSeesThePreActionState() public {
        AuditU7ClaudeObserverProbe probe = new AuditU7ClaudeObserverProbe(a.vault, a.collection);
        vm.etch(a.itemStream, address(probe).code);
        probeE0 = vault.escrowPrincipal();
        probeN0 = vault.inside();
        vm.recordLogs();
        Call memory c = _pickThree();
        vm.prank(c.from);
        (bool ok,) = c.to.call(c.data);
        assertTrue(ok, "pick");
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.itemStream) continue;
            if (logs[i].topics[0] == AuditU7ClaudeObserverProbe.SawVault.selector) _sawVault(logs[i].data);
            else if (logs[i].topics[0] == AuditU7ClaudeObserverProbe.SawTransfer.selector) _sawTransfer(logs[i].data);
        }
        assertEq(probeVaultNotices, 1, "one vault notice");
        assertEq(probeTransferNotices, 3, "three transfer notices");
    }

    uint256 internal probeE0;
    uint256 internal probeN0;
    uint256 internal probeVaultNotices;
    uint256 internal probeTransferNotices;

    function _sawVault(bytes memory data) internal {
        (uint8 action,, uint256 count, uint256 insideBefore, uint256 inside_, uint256 e) =
            abi.decode(data, (uint8, address, uint256, uint256, uint256, uint256));
        assertEq(action, uint8(VaultAction.Withdrawn), "a named pick");
        assertEq(count, 3, "three items");
        assertEq(insideBefore, probeN0, "insideBefore");
        assertEq(inside_, probeN0, "n unchanged while the observer runs");
        assertEq(e, probeE0, "E unchanged while the observer runs");
        ++probeVaultNotices;
    }

    function _sawTransfer(bytes memory data) internal {
        (address from, address to,, address owner_, uint256 fromBal, uint256 toBal) =
            abi.decode(data, (address, address, uint256, address, uint256, uint256));
        assertEq(from, a.vault, "from the vault");
        assertEq(to, eoa[1], "to the picker");
        assertEq(owner_, a.vault, "still the vault's while the observer runs");
        assertEq(fromBal, probeN0 + vault.pendingTickets() - probeTransferNotices, "the vault's old balance");
        assertEq(toBal, probeTransferNotices, "the picker's old balance");
        ++probeTransferNotices;
    }
}

/// @notice The same under Amsterdam (Glamsterdam's repricing, EIP-8037 state gas in gasleft): the caps arrive whole and
/// the floor is the same 477,301.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU7ClaudeObserverAmsterdamTest is AuditU7ClaudeObserverTest {}
