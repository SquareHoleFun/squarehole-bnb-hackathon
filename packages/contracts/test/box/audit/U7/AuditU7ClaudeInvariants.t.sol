// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {SepoliaBox0TestSet} from "../../../../script/lib/SepoliaBox0TestSet.sol";
import {TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";
import {AuditU7ClaudeBase, AuditU7ClaudeMath} from "./AuditU7ClaudeBase.sol";
import {
    AuditU7ClaudeCurveHandler,
    AuditU7ClaudeHandler,
    AuditU7ClaudeWiring,
    AuditU7ClaudeBooks,
    AuditU7ClaudeCurveHooks
} from "./AuditU7ClaudeHandler.sol";
import {AuditU7ClaudeReceiver} from "./AuditU7ClaudeReentrancy.t.sol";

/// @notice SH-AUDIT-B0-U7 (Claude): the invariant campaign the brief asks for, on the factory's box 0 with its real
/// per-item stream as both observers, in terminal mode (TAKE_DELAY passed; draws refused there, so takes by number,
/// placeholder openings, draw B's opening and draw C's cancel are the ticket paths; see the evidence's limitations).
/// After every random call (`AuditU7ClaudeHandler`):
/// - VLT-08 (BoxVault.sol:42, IBoxVault.sol:28; BC-005, BC-006, BC-007): T balance == E; no unsolicited T; E·n ≥ m·A
///   in 512 bits; n ≥ 1; h ≤ n; E + n ≤ S; the vault holds n + t items; n + t + (ids outside) == N, the vault's bits
///   agreeing with the collection's owners; the floor reads E + n;
/// - quotes from the pre-action state (⌈A·k/n⌉ pay, ⌊A·k/n⌋ receive) and flat fees burned (S falls by exactly the fee:
///   draw 1%, pick 25%, return 5%, none on a terminal cancel), A/n never rising (so the box never pays out more for an
///   item than it took, P7.12); the vault approves nobody; the hand-back waiver is never set;
/// - the observer never fails and never misses a call (no VaultObserverFailed, TransferObserverFailed or
///   CheckpointRepaired), its outside count is N − n; every vault delivery's receiver hook saw the final state and its
///   re-entries were refused;
/// - the collection (BoxCollection.sol:52; IBoxCollection.sol:43; BC-008, BC-009): Σ balances == N with one owner per id
///   (every never-moved id is the vault's), revealed at most once and only with the committed data, approvals cleared
///   on every transfer; sends to the vault, the collection and T always refused;
/// - the world's ghost ledger (ETH and T across box 0's boundary) and no unexpected revert.
abstract contract AuditU7ClaudeCampaignBase is StdInvariant, AuditU7ClaudeBase, AuditU7ClaudeBooks {
    AuditU7ClaudeHandler internal handler;
    AuditU7ClaudeReceiver[2] internal receivers;
    address internal onwardHolder;

    function setUp() public virtual override {
        super.setUp();
        _toTerminal();
        _warpTo(uint256(tickets.status().terminalAt) + tickets.TAKE_DELAY());
        _buildTree();
        onwardHolder = makeAddr("u7.inv.onward");
        _ghostAddOutside(onwardHolder);
        for (uint256 i; i < 2; ++i) {
            receivers[i] = new AuditU7ClaudeReceiver(vault, collection, token, tickets, tree, onwardHolder);
            receivers[i].configure(AuditU7ClaudeReceiver.Mode(i == 0 ? 0 : 1), true, 0, 0, 0);
            _ghostAddOutside(address(receivers[i]));
            _transferT(eoa[0], address(receivers[i]), 30 * vault.quoteWithdraw(1));
        }
        // Material: six items out (three revealed, three not), two of the revealed ones back on the shelf.
        for (uint256 i; i < 6; ++i) {
            uint256 item = _takeItem(eoa[1 + (i % 4)], 10_000 + i * 577, i % 2 == 0);
            if (i == 0 || i == 2) _returnItem(eoa[1 + (i % 4)], item);
        }
        address[] memory hs = new address[](11);
        for (uint256 i; i < 7; ++i) {
            hs[i] = eoa[i];
        }
        hs[7] = eoa7702;
        hs[8] = address(contractDrawer);
        hs[9] = address(receivers[0]);
        hs[10] = address(receivers[1]);
        address[] memory rxs = new address[](2);
        rxs[0] = address(receivers[0]);
        rxs[1] = address(receivers[1]);
        AuditU7ClaudeWiring memory w = AuditU7ClaudeWiring({
            vault: vault,
            collection: collection,
            token: token,
            tickets: tickets,
            stream: stream,
            tree: tree,
            coordinator: a.coordinator,
            onward: onwardHolder,
            drawB: drawB,
            drawC: drawC,
            drawerB: address(contractDrawer),
            receivers: rxs
        });
        handler = new AuditU7ClaudeHandler(this, w, hs);
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: _selectors()}));
    }

    function _selectors() internal pure virtual returns (bytes4[] memory);

    /// @notice The handler's ghost-ledger hook: T it moved across box 0's boundary.
    function u7NoteT(uint256 before, uint256 after_, TIn inClass, TOut outClass) external {
        require(msg.sender == address(handler), "U7: the handler only");
        _noteTChange(before, after_, inClass, outClass);
    }

    // ------------------------------------------------------------------------------------------------ invariants

    /// @notice VLT-08 after every call, with the ids that ever left walked (every other id never moved).
    function _check_vlt08() internal view {
        _assertVlt08Light("inv");
        VaultState memory v = _vaultState();
        uint256 outsideIds;
        uint256[] memory ids = handler.trackedIds();
        for (uint256 i; i < ids.length; ++i) {
            uint256 id = ids[i];
            bool out = vault.isOutside(id);
            address owner = collection.ownerOf(id);
            if (out) ++outsideIds;
            assertEq(out, owner != a.vault, "an id is outside exactly when the vault does not own it");
            assertTrue(vault.hasLeftVault(id), "a tracked id has left");
        }
        assertEq(v.n + v.t + outsideIds, editionSize, "n + t + outside == N");
        assertEq(stream.outsideCount(), v.m, "the stream's outside count == N - n");
        assertFalse(vault.handBackFeeWaived(), "never waived");
        assertTrue(vault.gateOpen(), "the gate stays open");
    }

    /// @notice Quotes from the pre-action state, flat fees burned, A/n never rising, E moving only by principals.
    function _check_quotesFeesAndPrice() internal view {
        assertEq(handler.quoteMismatch(), 0, "principal == ceil/floor(A*k/n) of the pre-action state");
        assertEq(handler.feeMismatch(), 0, "fee == ceil(p * bps / 10,000)");
        assertEq(handler.burnMismatch(), 0, "S falls by exactly the fee");
        assertEq(handler.escrowMismatch(), 0, "E moves by exactly the principal");
        assertEq(handler.priceRose(), 0, "A/n never rises");
    }

    /// @notice Refusals and access: sends to the vault, the collection and T, strangers on the restricted entry points,
    /// repeated ids; the vault approves nobody (T allowances, operators, per-id approvals of its items).
    function _check_refusalsAndApprovals() internal view {
        assertEq(handler.refusalBroken(), 0, "a refused send went through");
        assertEq(handler.accessBroken(), 0, "a stranger reached a restricted entry point");
        assertEq(handler.duplicateAccepted(), 0, "a batch with a repeated id was accepted");
        address[] memory hs = handler.allHolders();
        for (uint256 i; i < hs.length; ++i) {
            assertEq(token.allowance(a.vault, hs[i]), 0, "the vault approves no T");
            assertFalse(collection.isApprovedForAll(a.vault, hs[i]), "the vault sets no operator");
        }
        assertEq(token.allowance(a.vault, a.tickets), 0, "not even the tickets");
        assertEq(token.allowance(a.vault, a.itemStream), 0, "nor the stream");
        uint256[] memory ids = handler.trackedIds();
        for (uint256 i; i < ids.length; ++i) {
            if (collection.ownerOf(ids[i]) == a.vault) {
                assertEq(collection.getApproved(ids[i]), address(0), "no approval");
            }
        }
        assertEq(handler.approvalSurvived(), 0, "an approval survived a transfer");
    }

    /// @notice The observer: never failed, never missed; receivers of vault deliveries saw final state and could not
    /// re-enter.
    function _check_observerAndHooks() internal view {
        assertEq(handler.observerFailures(), 0, "the real stream never failed its cap");
        assertEq(handler.checkpointRepairs(), 0, "no observer call was missed");
        assertEq(handler.hookStateNotFinal(), 0, "a receiver hook saw a half-updated vault");
        assertEq(handler.reentryNotBlocked(), 0, "a receiver re-entered the vault during its delivery");
    }

    /// @notice The collection: Σ balances == N, one owner per id, revealed at most once and only with the committed
    /// data.
    function _check_collectionConserved() internal view {
        uint256[] memory ids = handler.trackedIds();
        address[] memory hs = handler.allHolders();
        uint256[] memory owned = new uint256[](hs.length);
        uint256 vaultTracked;
        uint256 revealed;
        for (uint256 i; i < ids.length; ++i) {
            address owner = collection.ownerOf(ids[i]);
            if (owner == a.vault) {
                ++vaultTracked;
            } else {
                bool known;
                for (uint256 j; j < hs.length; ++j) {
                    if (hs[j] == owner) {
                        ++owned[j];
                        known = true;
                        break;
                    }
                }
                assertTrue(known, "every owner is a holder the handler knows");
            }
            if (collection.isRevealed(ids[i])) {
                ++revealed;
                (, uint128 traits, bytes32 image, bytes32 model) = collection.traitsOf(ids[i]);
                SepoliaBox0TestSet.Entry memory e = AuditRevealSet.entry(ids[i]);
                assertEq(traits, e.traitsPacked, "revealed with the committed traits");
                assertEq(image, e.imageHash, "and image");
                assertEq(model, e.modelHash, "and model");
            }
        }
        uint256 sum = collection.balanceOf(a.vault);
        assertEq(
            sum, editionSize - ids.length + vaultTracked, "the vault holds every never-moved id and its returned ones"
        );
        for (uint256 j; j < hs.length; ++j) {
            uint256 b = collection.balanceOf(hs[j]);
            assertEq(b, owned[j], "balance == ids owned");
            sum += b;
        }
        assertEq(sum, editionSize, "sum of balances == N");
        assertEq(collection.revealedCount(), revealed, "revealedCount == revealed ids (only ids that left)");
        assertEq(handler.doubleReveal(), 0, "an id revealed twice");
        assertEq(handler.forgedReveal(), 0, "a forged reveal verified");
        assertEq(handler.revealDataWrong(), 0, "a reveal stored other data");
        assertEq(handler.ownershipWrong(), 0, "an item ended with the wrong owner");
    }

    /// @notice The world's ghost ledger (ETH and T across box 0's boundary), and no call reverted unexpectedly.
    function _check_ledgerAndNoSurprise() internal {
        _assertGhostLedger();
        if (handler.unexpected() != 0) {
            emit log_named_string("U7 unexpected at", handler.lastUnexpectedWhere());
            emit log_named_bytes("U7 unexpected data", handler.lastUnexpected());
        }
        assertEq(handler.unexpected(), 0, "an action that must succeed reverted");
    }
}

/// @notice The invariants, each after every call of a campaign.
abstract contract AuditU7ClaudeInvariantBase is AuditU7ClaudeCampaignBase {
    function invariant_AUDIT_U7_vlt08() public view {
        _check_vlt08();
    }

    function invariant_AUDIT_U7_quotesFeesAndPrice() public view {
        _check_quotesFeesAndPrice();
    }

    function invariant_AUDIT_U7_refusalsAndApprovals() public view {
        _check_refusalsAndApprovals();
    }

    function invariant_AUDIT_U7_observerAndHooks() public view {
        _check_observerAndHooks();
    }

    function invariant_AUDIT_U7_collectionConserved() public view {
        _check_collectionConserved();
    }

    function invariant_AUDIT_U7_ledgerAndNoSurprise() public {
        _check_ledgerAndNoSurprise();
    }
}

/// @notice The vault-weighted campaign: takes by number (with and without reveals), picks, returns, repeated ids,
/// openings, the cancel, T moves and burns, stream claims, strangers, time jumps, plus enough transfers and reveals that
/// items change hands and unrevealed ones come back.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeVaultInvariants is AuditU7ClaudeInvariantBase {
    function _selectors() internal pure override returns (bytes4[] memory) {
        return AuditU7ClaudeSelectors.vault();
    }
}

/// @notice The vault-weighted campaign under Amsterdam (EIP-8037 state gas in gasleft): the real stream never fails its
/// 460,000 cap on any random path (P7.6), and every invariant above holds on the repriced schedule.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU7ClaudeVaultAmsterdamInvariants is AuditU7ClaudeVaultInvariants {}

library AuditU7ClaudeSelectors {
    function vault() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](16);
        s[0] = AuditU7ClaudeHandler.takeByNumber.selector;
        s[1] = AuditU7ClaudeHandler.takeByNumber.selector;
        s[2] = AuditU7ClaudeHandler.pick.selector;
        s[3] = AuditU7ClaudeHandler.pick.selector;
        s[4] = AuditU7ClaudeHandler.returnSome.selector;
        s[5] = AuditU7ClaudeHandler.returnSome.selector;
        s[6] = AuditU7ClaudeHandler.openPlaceholder.selector;
        s[7] = AuditU7ClaudeHandler.openDrawB.selector;
        s[8] = AuditU7ClaudeHandler.cancelDrawC.selector;
        s[9] = AuditU7ClaudeHandler.transferItem.selector;
        s[10] = AuditU7ClaudeHandler.reveal.selector;
        s[11] = AuditU7ClaudeHandler.sendToSystem.selector;
        s[12] = AuditU7ClaudeHandler.burnT.selector;
        s[13] = AuditU7ClaudeHandler.claimStream.selector;
        s[14] = AuditU7ClaudeHandler.strangerCalls.selector;
        s[15] = AuditU7ClaudeHandler.warp.selector;
    }

    function collection() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](14);
        s[0] = AuditU7ClaudeHandler.transferItem.selector;
        s[1] = AuditU7ClaudeHandler.transferItem.selector;
        s[2] = AuditU7ClaudeHandler.transferItem.selector;
        s[3] = AuditU7ClaudeHandler.approveSome.selector;
        s[4] = AuditU7ClaudeHandler.strangerTransfer.selector;
        s[5] = AuditU7ClaudeHandler.sendToSystem.selector;
        s[6] = AuditU7ClaudeHandler.reveal.selector;
        s[7] = AuditU7ClaudeHandler.reveal.selector;
        s[8] = AuditU7ClaudeHandler.takeByNumber.selector;
        s[9] = AuditU7ClaudeHandler.pick.selector;
        s[10] = AuditU7ClaudeHandler.returnSome.selector;
        s[11] = AuditU7ClaudeHandler.openPlaceholder.selector;
        s[12] = AuditU7ClaudeHandler.warp.selector;
        s[13] = AuditU7ClaudeHandler.claimStream.selector;
    }
}

/// @notice The collection-weighted campaign: transfers (owner, approved, operator; plain and safe; to EOAs, the
/// delegated EOA, a contract and two re-entrant receivers), approvals and operator changes, strangers, sends to system
/// addresses, reveals (committed, forged, repeated), with takes, picks and returns so items keep leaving and coming back.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeCollectionInvariants is AuditU7ClaudeInvariantBase {
    function _selectors() internal pure override returns (bytes4[] memory) {
        return AuditU7ClaudeSelectors.collection();
    }
}

/// @notice The handler's reach (not an invariant campaign): a fixed pseudo-random walk of 700 handler calls on the same
/// world, then every coverage counter is non-zero (every path the campaigns rely on is reachable from this state) and
/// every invariant check holds at the end.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeHandlerCoverageTest is AuditU7ClaudeCampaignBase {
    function _selectors() internal pure override returns (bytes4[] memory) {
        return AuditU7ClaudeSelectors.vault();
    }

    function testProperty_AUDIT_U7_handlerReachesEveryPath() public {
        for (uint256 i; i < 700; ++i) {
            uint256 r = uint256(keccak256(abi.encode("u7.coverage", i)));
            uint256 x = r >> 16;
            uint256 which = r % 19;
            if (which == 0 || which == 1) handler.takeByNumber(x, x >> 8, which == 1);
            else if (which == 2 || which == 3) handler.pick(x, 1 + (x % 3), x >> 8, (x >> 4) % 5 == 0);
            else if (which == 4 || which == 5) handler.returnSome(x, 1 + (x % 3), x >> 8, (x >> 4) % 5 == 0);
            else if (which == 6) handler.openPlaceholder(x, (x >> 4) % 2 == 0);
            else if (which == 7) handler.openDrawB(x);
            else if (which == 8) handler.cancelDrawC(address(uint160(x)));
            else if (which == 9 || which == 10) handler.transferItem(x, x >> 8, uint8(x >> 64));
            else if (which == 11) handler.approveSome(x, x >> 8, (x >> 4) % 2 == 0, (x >> 5) % 2 == 0);
            else if (which == 12) handler.strangerTransfer(x, address(uint160(x >> 8)));
            else if (which == 13) handler.sendToSystem(x, uint8(x >> 8), uint8(x >> 16), x >> 24);
            else if (which == 14) handler.reveal(x, uint8(x >> 8), bytes32(x >> 16));
            else if (which == 15) handler.burnT(x, x >> 8);
            else if (which == 16) handler.claimStream(x);
            else if (which == 17) handler.strangerCalls(address(uint160(x)), x >> 160, x >> 200);
            else handler.warp(x % 8 == 0 ? 4 days : x % (2 days));
        }
        emit log_named_uint("takes", handler.takes());
        emit log_named_uint("takes unrevealed", handler.takesUnrevealed());
        emit log_named_uint("picks", handler.picks());
        emit log_named_uint("pick batches", handler.pickBatches());
        emit log_named_uint("returns", handler.returnsDone());
        emit log_named_uint("return batches", handler.returnBatches());
        emit log_named_uint("unrevealed returns", handler.unrevealedReturns());
        emit log_named_uint("transfers", handler.transfersDone());
        emit log_named_uint("safe transfers", handler.safeTransfers());
        emit log_named_uint("receipts by re-entrant receivers", handler.reentrantReceipts());
        emit log_named_uint("returns inside a receiver hook", handler.reentrantReturns());
        emit log_named_uint("vault deliveries to re-entrant receivers", handler.vaultDeliveriesToReceivers());
        emit log_named_uint("reveals", handler.revealsDone());
        emit log_named_uint("refusals checked", handler.refusalsChecked());
        emit log_named_uint("duplicates refused", handler.duplicatesRefused());
        emit log_named_uint("openings", handler.opens());
        emit log_named_uint("cancels", handler.cancels());
        emit log_named_uint("claims", handler.claims());
        emit log_named_uint("burns", handler.burns());
        emit log_named_uint("warps", handler.warps());
        emit log_named_uint("ids tracked", handler.trackedCount());
        assertGt(handler.takes(), 0, "takes");
        assertGt(handler.takesUnrevealed(), 0, "unrevealed takes");
        assertGt(handler.picks(), 0, "picks");
        assertGt(handler.pickBatches(), 0, "pick batches");
        assertGt(handler.returnsDone(), 0, "returns");
        assertGt(handler.returnBatches(), 0, "return batches");
        assertGt(handler.unrevealedReturns(), 0, "unrevealed returns after the grace");
        assertGt(handler.transfersDone(), 0, "transfers");
        assertGt(handler.safeTransfers(), 0, "safe transfers");
        assertGt(handler.reentrantReceipts(), 0, "re-entrant receivers");
        assertGt(handler.vaultDeliveriesToReceivers(), 0, "vault deliveries into re-entrant receivers");
        assertGt(handler.revealsDone(), 0, "reveals");
        assertGt(handler.refusalsChecked(), 0, "refusals");
        assertGt(handler.duplicatesRefused(), 0, "duplicates refused");
        assertGt(handler.opens(), 0, "openings");
        assertGt(handler.cancels(), 0, "the cancel");
        assertGt(handler.claims(), 0, "claims");
        assertGt(handler.burns(), 0, "burns");
        _check_vlt08();
        _check_quotesFeesAndPrice();
        _check_refusalsAndApprovals();
        _check_observerAndHooks();
        _check_collectionConserved();
        _check_ledgerAndNoSurprise();
    }
}

/// @notice SH-AUDIT-B0-U7 (Claude): the curve campaign (box 0 in its bonding phase, the real stream as the vault's
/// observer; `AuditU7ClaudeCurveHandler`): takes and hand-backs with the gate closed, then graduation once, mid-run.
/// After every call: VLT-08 (as above), quotes and fees from the pre-action state (1% draw fee, 5% hand-back fee before
/// graduation, F23 C3; BoxVault.sol:145-200, :566-569), A/n never rising, T to the vault refused, no stranger on the
/// coordinator-only or adapter-only entry points, the gate opened only by graduate() (gateOpenedAt == graduatedAt),
/// takes and hand-backs refused after it, the stream's outside count == N − n, no observer failure, the ghost ledger.
/// Graduation waits for the run's 64th call, so a run (depth 128 or 256) has a curve part and a graduated part.
/// forge-config: default.evm_version = "osaka"
abstract contract AuditU7ClaudeCurveCampaignBase is StdInvariant, AuditU7ClaudeBase, AuditU7ClaudeCurveHooks {
    AuditU7ClaudeCurveHandler internal curveHandler;

    function setUp() public virtual override {
        super.setUp();
        _toBonding();
        address[] memory actors = new address[](7);
        actors[0] = eoa[0];
        actors[1] = eoa[1];
        actors[2] = eoa[3];
        actors[3] = eoa[4];
        actors[4] = eoa[5];
        actors[5] = eoa7702;
        actors[6] = address(contractDrawer);
        // Steps stay a day before r0's request time, where graduation must happen (AuditPhases).
        curveHandler = new AuditU7ClaudeCurveHandler(
            this, vault, tickets, token, a.coordinator, actors, _requestTimeFor(r0) - 1 hours
        );
        targetContract(address(curveHandler));
        bytes4[] memory s = new bytes4[](10);
        s[0] = AuditU7ClaudeCurveHandler.take.selector;
        s[1] = AuditU7ClaudeCurveHandler.take.selector;
        s[2] = AuditU7ClaudeCurveHandler.handBack.selector;
        s[3] = AuditU7ClaudeCurveHandler.handBack.selector;
        s[4] = AuditU7ClaudeCurveHandler.sendTToVault.selector;
        s[5] = AuditU7ClaudeCurveHandler.burnT.selector;
        s[6] = AuditU7ClaudeCurveHandler.transferT.selector;
        s[7] = AuditU7ClaudeCurveHandler.strangerCalls.selector;
        s[8] = AuditU7ClaudeCurveHandler.step.selector;
        s[9] = AuditU7ClaudeCurveHandler.graduate.selector;
        targetSelector(FuzzSelector({addr: address(curveHandler), selectors: s}));
    }

    function u7NoteT(uint256 before, uint256 after_, TIn inClass, TOut outClass) external {
        require(msg.sender == address(curveHandler), "U7: the handler only");
        _noteTChange(before, after_, inClass, outClass);
    }

    function u7Graduate() external {
        require(msg.sender == address(curveHandler), "U7: the handler only");
        _toGraduated();
    }

    function _checkCurveVlt08() internal view {
        _assertVlt08Light("curve");
        assertEq(stream.outsideCount(), vault.outside(), "the stream's outside count == N - n");
        if (vault.gateOpen()) assertEq(vault.gateOpenedAt(), coordinator.graduatedAt(), "opened by graduate()");
        else assertFalse(coordinator.graduated(), "closed until graduation");
        assertFalse(vault.handBackFeeWaived(), "never waived");
    }

    function _checkCurveQuotesFeesAndRefusals() internal view {
        assertEq(curveHandler.quoteMismatch(), 0, "principal == quote of the pre-action state");
        assertEq(curveHandler.feeMismatch(), 0, "flat fee, burned");
        assertEq(curveHandler.burnMismatch(), 0, "the payer paid exactly p + fee / got p - fee");
        assertEq(curveHandler.escrowMismatch(), 0, "n, h, t moved by k");
        assertEq(curveHandler.priceRose(), 0, "A/n never rises");
        assertEq(curveHandler.refusalBroken(), 0, "T reached the vault");
        assertEq(curveHandler.accessBroken(), 0, "a stranger reached a restricted entry point");
        assertEq(curveHandler.afterGraduationAccepted(), 0, "a take or hand-back after graduation");
        assertEq(curveHandler.observerFailures(), 0, "the real stream never failed its cap");
    }

    function _checkCurveLedgerAndNoSurprise() internal {
        _assertGhostLedger();
        if (curveHandler.unexpected() != 0) {
            emit log_named_string("U7 unexpected at", curveHandler.lastUnexpectedWhere());
            emit log_named_bytes("U7 unexpected data", curveHandler.lastUnexpected());
        }
        assertEq(curveHandler.unexpected(), 0, "an action that must succeed reverted");
    }
}

/// @notice The curve campaign's invariants (see the campaign base above).
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeCurveInvariants is AuditU7ClaudeCurveCampaignBase {
    function invariant_AUDIT_U7_curveVlt08() public view {
        _checkCurveVlt08();
    }

    function invariant_AUDIT_U7_curveQuotesFeesAndRefusals() public view {
        _checkCurveQuotesFeesAndRefusals();
    }

    function invariant_AUDIT_U7_curveLedgerAndNoSurprise() public {
        _checkCurveLedgerAndNoSurprise();
    }
}

/// @notice The curve handler's reach (not a campaign): 200 fixed pseudo-random calls; takes and hand-backs on the curve,
/// one graduation after the 64th call, takes and hand-backs refused after it; every check holds at the end.
/// forge-config: default.evm_version = "osaka"
contract AuditU7ClaudeCurveCoverageTest is AuditU7ClaudeCurveCampaignBase {
    function testProperty_AUDIT_U7_curveHandlerReachesEveryPath() public {
        for (uint256 i; i < 200; ++i) {
            uint256 r = uint256(keccak256(abi.encode("u7.curve.coverage", i)));
            uint256 x = r >> 16;
            uint256 which = r % 9;
            if (which <= 1) curveHandler.take(x, x >> 8);
            else if (which <= 3) curveHandler.handBack(x, x >> 8, x >> 16);
            else if (which == 4) curveHandler.sendTToVault(x, x >> 8);
            else if (which == 5) curveHandler.burnT(x, x >> 8);
            else if (which == 6) curveHandler.strangerCalls(address(uint160(x)), x >> 160, x >> 200);
            else if (which == 7) curveHandler.step(x);
            else curveHandler.graduate();
            _checkCurveVlt08();
            _checkCurveQuotesFeesAndRefusals();
        }
        emit log_named_uint("curve takes", curveHandler.takes());
        emit log_named_uint("curve hand-backs", curveHandler.handBacks());
        emit log_named_uint("graduations", curveHandler.graduations());
        emit log_named_uint("refused after graduation", curveHandler.refusedAfterGraduation());
        assertGt(curveHandler.takes(), 0, "takes");
        assertGt(curveHandler.handBacks(), 0, "hand-backs");
        assertEq(curveHandler.graduations(), 1, "one graduation");
        assertGt(curveHandler.refusedAfterGraduation(), 0, "refused after graduation");
        assertTrue(vault.gateOpen(), "the gate open after graduation");
        _checkCurveLedgerAndNoSurprise();
    }
}
