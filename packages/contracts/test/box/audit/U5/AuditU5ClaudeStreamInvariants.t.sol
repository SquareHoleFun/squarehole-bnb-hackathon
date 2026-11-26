// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {DrawStatus} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

interface IAuditU5ClaudeStreamWorld {
    function sSell(uint256 amount) external;
    function sBuy(uint256 amount) external;
    function sCollect() external;
    function sBurn(uint256 who) external;
    function sGift(uint256 amount) external;
    function sTransfer(uint256 from, uint256 to, uint256 k) external;
    function sClaim(uint256 who, bool forOther) external;
    function sReturn(uint256 who, uint256 k) external;
    function sPick(uint256 who, uint256 k) external;
    function sOpenPlaceholder(uint256 k) external;
    function sMovePlaceholder(uint256 k, uint256 to) external;
    function sDraw(uint256 who) external;
    function sSettle(uint256 mix) external;
    function sOpenDraw(uint256 k, uint256 to) external;
    function sTerminal() external;
    function sCancel(uint256 k) external;
    function sTake(uint256 who, uint256 poolIndex) external;
    function sWarp(uint256 secondsAhead) external;
    function sDeepen() external;
    function sNoteFailure(bytes4 action, bytes calldata reason) external;
}

/// @notice TEST ONLY. The stream campaign's handler: one world call per action, fail-safe here; the actions that must
/// never fail (claims, claimFor, burns, transfers between holders) report a failure to the world.
contract AuditU5ClaudeStreamHandler {
    IAuditU5ClaudeStreamWorld internal immutable w;

    constructor(IAuditU5ClaudeStreamWorld w_) {
        w = w_;
    }

    function sell(uint256 amount) external {
        try w.sSell(amount) {} catch {}
    }

    function buy(uint256 amount) external {
        try w.sBuy(amount) {} catch {}
    }

    function collect() external {
        try w.sCollect() {} catch {}
    }

    function burn(uint256 who) external {
        try w.sBurn(who) {}
        catch (bytes memory e) {
            w.sNoteFailure(this.burn.selector, e);
        }
    }

    function gift(uint256 amount) external {
        try w.sGift(amount) {} catch {}
    }

    function transfer(uint256 from, uint256 to, uint256 k) external {
        try w.sTransfer(from, to, k) {}
        catch (bytes memory e) {
            w.sNoteFailure(this.transfer.selector, e);
        }
    }

    function claim(uint256 who, bool forOther) external {
        try w.sClaim(who, forOther) {}
        catch (bytes memory e) {
            w.sNoteFailure(this.claim.selector, e);
        }
    }

    function returnItem(uint256 who, uint256 k) external {
        try w.sReturn(who, k) {} catch {}
    }

    function pick(uint256 who, uint256 k) external {
        try w.sPick(who, k) {} catch {}
    }

    function openPlaceholder(uint256 k) external {
        try w.sOpenPlaceholder(k) {} catch {}
    }

    function movePlaceholder(uint256 k, uint256 to) external {
        try w.sMovePlaceholder(k, to) {} catch {}
    }

    function draw(uint256 who) external {
        try w.sDraw(who) {} catch {}
    }

    function settle(uint256 mix) external {
        try w.sSettle(mix) {} catch {}
    }

    function openDraw(uint256 k, uint256 to) external {
        try w.sOpenDraw(k, to) {} catch {}
    }

    function terminal() external {
        try w.sTerminal() {} catch {}
    }

    function cancel(uint256 k) external {
        try w.sCancel(k) {} catch {}
    }

    function take(uint256 who, uint256 poolIndex) external {
        try w.sTake(who, poolIndex) {} catch {}
    }

    function warp(uint256 secondsAhead) external {
        try w.sWarp(secondsAhead) {} catch {}
    }

    function deepen() external {
        try w.sDeepen() {} catch {}
    }
}

/// @title AuditU5ClaudeStreamInvariants
/// @notice SH-AUDIT-B0 U5 (Claude): the stream campaign the map's gap list asks for (map § 6 item 5; U5 brief P5.3,
/// P5.4, P5.10, P5.14) on the factory's box 0 from its Drawing phase, with a reference model of what each account is
/// owed. Actions: sells (T fees) and buys, fee batches, burns, T gifts to the stream, Misfit transfers among seven
/// holders (four EOAs, the contract drawer, the EIP-7702 EOA), claims and claimFor, returns and named picks,
/// placeholder openings and placeholder transfers, draws, settles (drand's committed rounds, then the RANDAO backup
/// five days on), draw openings to the drawer or another holder, terminal mode with cancels and takes by number,
/// time, `deepen()`.
/// The reference (scaled by N): every change of X is shared out exactly, ΔX/N to each slot outside at that moment
/// (an outside Misfit's owner, an open placeholder, an open draw); a placeholder's share passes to its opener, a
/// draw's to its recipient (or its drawer at a cancel). Invariants: X equals its StateLibrary rebuild, never falls
/// and moves only by a sell's fee or a gift; J = ⌊(X − X₀)/N⌋ never falls; F = held + claimed + burned and moves only
/// by arrivals; every slot's accrual is booked to an owner or waits on an open ticket, exactly; each holder's paid +
/// booked + pending equals its reference to within one raw unit per booked interval; each draw starts at its own
/// request; a burn never leaves less than the owners' accrual; no observer or notice ever fails (a revert inside a
/// fail-safe hook point would be swallowed); and owners are covered to within N − 1 raw units (AUDIT-U5-01's bound).
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeStreamInvariants is StdInvariant, AuditU5ClaudeBase, IAuditU5ClaudeStreamWorld {
    uint256 internal constant HOLDERS = 7;

    AuditU5ClaudeStreamHandler internal handler;
    address[HOLDERS] internal holders;
    mapping(address => uint256) internal holderIndexPlusOne;

    // ------------------------------------------------------------------ the model
    uint256[] internal items; // every Misfit that has been outside
    mapping(uint256 => bool) internal knownItem;
    uint256[] internal shelf; // returned Misfits (named picks take them)
    uint256[] internal openPh; // open placeholder token ids
    mapping(uint256 => uint256) internal phAcc; // a placeholder's reference accrual (scaled by N)
    uint256[] internal openDraws; // requested or settled, not opened or cancelled
    mapping(uint256 => uint256) internal drawAcc;
    mapping(uint256 => uint256) internal drawJ;
    mapping(address => uint256) public refScaled;
    mapping(address => uint256) public intervals;
    mapping(address => uint256) public paid;
    uint256 public paidTotal;
    uint256 internal lastX;
    uint256 internal lastJ;
    uint256 internal lastF;

    // ------------------------------------------------------------------ ghosts (must stay zero)
    uint256 public xMismatch;
    uint256 public xFell;
    uint256 public xMovedWithoutFee;
    uint256 public jFell;
    uint256 public fFell;
    uint256 public fMovedWithoutArrival;
    uint256 public burnBelowLiabilities;
    uint256 public drawStartMismatch;
    uint256 public hookPointFailures;
    uint256 public mustNotFail;
    bytes public lastFailure;
    uint256 public maxShortfall;

    // ------------------------------------------------------------------ coverage
    uint256 public sells;
    uint256 public batches;
    uint256 public claims;
    uint256 public transfers;
    uint256 public returns_;
    uint256 public picks;
    uint256 public placeholderOpens;
    uint256 public drawsRequested;
    uint256 public drawsOpened;
    uint256 public cancels;
    uint256 public takes;
    uint256 public settles;

    modifier onlyHandler() {
        require(msg.sender == address(handler), "handler only");
        _;
    }

    function setUp() public override {
        super.setUp();
        _toDrawing();
        holders = [eoa[0], eoa[1], eoa[3], eoa[4], eoa[5], address(contractDrawer), eoa7702];
        for (uint256 i; i < HOLDERS; ++i) {
            holderIndexPlusOne[holders[i]] = i + 1;
            // T for draws and named picks: from eoa[2]'s closing buy (a move between outside holders).
            _transferT(eoa[2], holders[i], 8_000_000 ether);
        }
        _addItem(itemA);
        _addItem(itemP1);
        for (uint256 t = 2; t <= 5; ++t) {
            openPh.push(t);
        }
        openDraws.push(drawB);
        drawJ[drawB] = 0;
        (lastX, lastJ, lastF) = (stream.streamValue(), stream.index(), _streamF());
        assertEq(stream.outsideCount(), 7, "two Misfits, four placeholders, draw B");

        handler = new AuditU5ClaudeStreamHandler(this);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](24);
        sel[0] = AuditU5ClaudeStreamHandler.sell.selector;
        sel[1] = AuditU5ClaudeStreamHandler.sell.selector;
        sel[2] = AuditU5ClaudeStreamHandler.buy.selector;
        sel[3] = AuditU5ClaudeStreamHandler.collect.selector;
        sel[4] = AuditU5ClaudeStreamHandler.collect.selector;
        sel[5] = AuditU5ClaudeStreamHandler.burn.selector;
        sel[6] = AuditU5ClaudeStreamHandler.gift.selector;
        sel[7] = AuditU5ClaudeStreamHandler.transfer.selector;
        sel[8] = AuditU5ClaudeStreamHandler.transfer.selector;
        sel[9] = AuditU5ClaudeStreamHandler.claim.selector;
        sel[10] = AuditU5ClaudeStreamHandler.claim.selector;
        sel[11] = AuditU5ClaudeStreamHandler.returnItem.selector;
        sel[12] = AuditU5ClaudeStreamHandler.pick.selector;
        sel[13] = AuditU5ClaudeStreamHandler.openPlaceholder.selector;
        sel[14] = AuditU5ClaudeStreamHandler.movePlaceholder.selector;
        sel[15] = AuditU5ClaudeStreamHandler.draw.selector;
        sel[16] = AuditU5ClaudeStreamHandler.draw.selector;
        sel[17] = AuditU5ClaudeStreamHandler.settle.selector;
        sel[18] = AuditU5ClaudeStreamHandler.openDraw.selector;
        sel[19] = AuditU5ClaudeStreamHandler.terminal.selector;
        sel[20] = AuditU5ClaudeStreamHandler.cancel.selector;
        sel[21] = AuditU5ClaudeStreamHandler.take.selector;
        sel[22] = AuditU5ClaudeStreamHandler.warp.selector;
        sel[23] = AuditU5ClaudeStreamHandler.deepen.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    // ================================================================================================ the model

    function _addItem(uint256 id) internal {
        if (knownItem[id]) return;
        knownItem[id] = true;
        items.push(id);
    }

    function _holder(uint256 i) internal view returns (address) {
        return holders[i % HOLDERS];
    }

    /// The model's step after each action: X, J and F checked against their rules, the change of X shared out to the
    /// slots outside now (an X-moving action does not change the slots), every hook-point failure counted.
    function _settleModel(bool xMayMove, bool fMayRise) internal {
        _countHookPointFailures();
        uint256 x = stream.streamValue();
        if (x != _refX()) ++xMismatch;
        if (x < lastX) {
            ++xFell;
        } else if (x > lastX) {
            if (!xMayMove) ++xMovedWithoutFee;
            _share(x - lastX);
        }
        uint256 j = stream.index();
        if (j < lastJ) ++jFell;
        uint256 f = _streamF();
        if (f < lastF) ++fFell;
        else if (f > lastF && !fMayRise) ++fMovedWithoutArrival;
        uint256 owed = stream.liabilities();
        uint256 covered = token.balanceOf(a.itemStream) + _streamPending();
        if (owed > covered && owed - covered > maxShortfall) maxShortfall = owed - covered;
        (lastX, lastJ, lastF) = (x, j, f);
    }

    function _share(uint256 dx) internal {
        for (uint256 i; i < items.length; ++i) {
            address o = collection.ownerOf(items[i]);
            if (o != a.vault) refScaled[o] += dx;
        }
        for (uint256 i; i < openPh.length; ++i) {
            phAcc[openPh[i]] += dx;
        }
        for (uint256 i; i < openDraws.length; ++i) {
            drawAcc[openDraws[i]] += dx;
        }
    }

    /// A fail-safe hook point that failed (the collection's or the vault's observer, the receiver's notice) would be
    /// swallowed by its caller: the action's logs are scanned for the three failure events.
    function _countHookPointFailures() internal {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        bytes32 t = IBoxCollection.TransferObserverFailed.selector;
        bytes32 v = IBoxVault.VaultObserverFailed.selector;
        bytes32 n = IBoxReceiver.StreamNotifyFailed.selector;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 sig = logs[i].topics.length != 0 ? logs[i].topics[0] : bytes32(0);
            if (sig == t || sig == v || sig == n) ++hookPointFailures;
        }
    }

    function _begin() internal {
        vm.recordLogs();
    }

    // ================================================================================================ actions

    function sSell(uint256 amount) external onlyHandler {
        _begin();
        uint256 held = token.balanceOf(eoa[2]);
        amount = bound(amount, 1, held / 20 + 1);
        if (amount > held) return;
        _sell(eoa[2], amount);
        ++sells;
        _settleModel(true, false);
    }

    function sBuy(uint256 amount) external onlyHandler {
        _begin();
        amount = bound(amount, 1e9, 1 ether);
        _buy(eoa[2], amount);
        _settleModel(false, false);
    }

    function sCollect() external onlyHandler {
        _begin();
        _buy(eoa[2], 0.6 ether);
        _collect(keeper, keeper);
        ++batches;
        _settleModel(false, true);
    }

    function sBurn(uint256 who) external onlyHandler {
        _begin();
        vm.prank(_holder(who));
        uint256 b = stream.burn();
        if (b != 0 && token.balanceOf(a.itemStream) < stream.liabilities()) ++burnBelowLiabilities;
        _settleModel(false, false);
    }

    function sGift(uint256 amount) external onlyHandler {
        _begin();
        amount = bound(amount, 1, 1_000 ether);
        _transferT(eoa[2], a.itemStream, amount);
        _settleModel(true, true);
    }

    function sTransfer(uint256 from, uint256 to, uint256 k) external onlyHandler {
        _begin();
        if (items.length == 0) return;
        uint256 id = items[addmod(k, from, items.length)];
        address f = collection.ownerOf(id);
        address t = _holder(to);
        if (f == t || f == a.vault) return;
        vm.prank(f);
        collection.transferFrom(f, t, id);
        ++intervals[f];
        ++transfers;
        _settleModel(false, false);
    }

    function _idsOf(address who) internal view returns (uint256[] memory ids) {
        uint256 c;
        for (uint256 i; i < items.length; ++i) {
            if (collection.ownerOf(items[i]) == who) ++c;
        }
        ids = new uint256[](c);
        c = 0;
        for (uint256 i; i < items.length; ++i) {
            if (collection.ownerOf(items[i]) == who) ids[c++] = items[i];
        }
    }

    function sClaim(uint256 who, bool forOther) external onlyHandler {
        _begin();
        address h = _holder(who);
        uint256[] memory ids = _idsOf(h);
        uint256 got = forOther || h == address(contractDrawer) ? _claimStreamFor(keeper, h, ids) : _claimStream(h, ids);
        intervals[h] += ids.length;
        paid[h] += got;
        paidTotal += got;
        ++claims;
        _settleModel(false, false);
    }

    function sReturn(uint256 who, uint256 k) external onlyHandler {
        _begin();
        address h = _holder(who);
        uint256[] memory ids = _idsOf(h);
        if (ids.length == 0) return;
        uint256 id = ids[k % ids.length];
        if (h == address(contractDrawer)) {
            vm.prank(address(contractDrawer));
            contractDrawer.exec(a.collection, 0, abi.encodeCall(IBoxCollection.setApprovalForAll, (a.vault, true)));
            uint256 t0 = token.balanceOf(h);
            vm.prank(address(contractDrawer));
            contractDrawer.exec(a.vault, 0, abi.encodeCall(IBoxVault.returnItem, (id, 0, vm.getBlockTimestamp())));
            _noteTChange(t0, token.balanceOf(h), TInOther, TOutReturn);
        } else {
            _returnItem(h, id);
        }
        ++intervals[h];
        shelf.push(id);
        ++returns_;
        _settleModel(false, false);
    }

    function sPick(uint256 who, uint256 k) external onlyHandler {
        _begin();
        if (shelf.length == 0) return;
        address h = _holder(who);
        if (h == address(contractDrawer)) h = eoa[4];
        uint256 i = k % shelf.length;
        uint256 id = shelf[i];
        _pick(h, id);
        shelf[i] = shelf[shelf.length - 1];
        shelf.pop();
        ++picks;
        _settleModel(false, false);
    }

    function sOpenPlaceholder(uint256 k) external onlyHandler {
        _begin();
        if (openPh.length == 0) return;
        uint256 i = k % openPh.length;
        uint256 token_ = openPh[i];
        address o = tickets.ownerOf(token_);
        uint256 item = tickets.numberOf(token_);
        if (o == address(contractDrawer)) {
            vm.prank(address(contractDrawer));
            contractDrawer.exec(a.tickets, 0, abi.encodeCall(BoxTickets.open, (token_, _reveal(item))));
        } else {
            _open(o, token_, true);
        }
        (address rec, uint256 pend) = stream.pendingOf(item);
        if (rec != o || pend != stream.index()) ++drawStartMismatch; // a placeholder's Misfit starts at J 0
        refScaled[o] += phAcc[token_];
        ++intervals[o];
        openPh[i] = openPh[openPh.length - 1];
        openPh.pop();
        _addItem(item);
        ++placeholderOpens;
        _settleModel(false, false);
    }

    function sMovePlaceholder(uint256 k, uint256 to) external onlyHandler {
        _begin();
        if (openPh.length == 0) return;
        uint256 token_ = openPh[k % openPh.length];
        address o = tickets.ownerOf(token_);
        address t = _holder(to);
        if (o == t || o == address(contractDrawer)) return;
        vm.prank(o);
        tickets.transferFrom(o, t, token_);
        _settleModel(false, false);
    }

    function sDraw(uint256 who) external onlyHandler {
        _begin();
        address h = _holder(who);
        uint256 j = stream.index();
        uint256 ticket;
        if (h == address(contractDrawer)) {
            vm.prank(address(contractDrawer));
            contractDrawer.exec(
                a.token, 0, abi.encodeWithSignature("approve(address,uint256)", a.tickets, type(uint256).max)
            );
            vm.deal(address(contractDrawer), address(contractDrawer).balance + AUDIT_DRAW_VALUE);
            uint256 t0 = token.balanceOf(h);
            uint256 e0 = h.balance;
            vm.prank(address(contractDrawer));
            bytes memory ret = contractDrawer.exec(
                a.tickets,
                AUDIT_DRAW_VALUE,
                abi.encodeCall(BoxTickets.draw, (type(uint256).max, vm.getBlockTimestamp()))
            );
            ticket = abi.decode(ret, (uint256));
            _noteEthChange(e0, h.balance, EthInDraw, EthOutRefund);
            _noteTChange(t0, token.balanceOf(h), TInDraw, TOutOther);
        } else {
            ticket = _draw(h, AUDIT_DRAW_VALUE);
        }
        openDraws.push(ticket);
        drawJ[ticket] = j;
        ++drawsRequested;
        _settleModel(false, false);
    }

    function sSettle(uint256 mix) external onlyHandler {
        _begin();
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt != 0 || s.drawsSettled >= s.drawsRequested) return;
        uint256 head = uint256(s.drawsSettled) + 1;
        (, uint64 round) = src.requestOf(a.tickets, head);
        (, uint64 ready) = src.wordOf(a.tickets, head);
        if (ready == 0) {
            (, uint64 postedAt) = drand.beaconOf(round);
            if (_committed(round) && postedAt == 0) {
                if (vm.getBlockTimestamp() < src.roundTime(round)) _warpTo(src.roundTime(round));
                _post(round);
            } else {
                (uint64 startedAt,,,) = src.backupOf(round);
                if (startedAt == 0) {
                    uint256 at = src.roundTime(round) + src.BACKUP_AFTER() + 1;
                    if (vm.getBlockTimestamp() < at) _warpTo(at);
                    _advance(1);
                    _backup(round, keccak256(abi.encode("u5.mix", mix, round)), keeper);
                } else {
                    _advance(src.TARGET_BLOCKS() + 1);
                    _fixBackup(round, keccak256(abi.encode("u5.mix", mix, round)), keeper);
                }
            }
        }
        _settle(keeper, type(uint256).max);
        ++settles;
        _settleModel(false, false);
    }

    function sOpenDraw(uint256 k, uint256 to) external onlyHandler {
        _begin();
        if (openDraws.length == 0) return;
        uint256 i = k % openDraws.length;
        uint256 ticket = openDraws[i];
        IBoxTickets.DrawView memory d = tickets.drawTicket(ticket);
        if (d.status != DrawStatus.Settled) return;
        address recipient = d.drawer;
        address t = _holder(to);
        if (d.drawer == address(contractDrawer)) {
            vm.prank(address(contractDrawer));
            contractDrawer.exec(
                a.tickets, 0, abi.encodeCall(BoxTickets.openDraw, (ticket, address(contractDrawer), _reveal(d.itemId)))
            );
        } else {
            if (t != address(contractDrawer)) recipient = t;
            _openDraw(d.drawer, ticket, recipient, true);
        }
        (address rec, uint256 pend) = stream.pendingOf(d.itemId);
        if (rec != recipient || pend != stream.index() - drawJ[ticket]) ++drawStartMismatch;
        refScaled[recipient] += drawAcc[ticket];
        ++intervals[recipient];
        openDraws[i] = openDraws[openDraws.length - 1];
        openDraws.pop();
        _addItem(d.itemId);
        ++drawsOpened;
        _settleModel(false, false);
    }

    function sTerminal() external onlyHandler {
        _begin();
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt != 0 || s.drawsSettled >= s.drawsRequested) return;
        uint256 head = uint256(s.drawsSettled) + 1;
        uint256 dead = uint256(tickets.drawTicket(head).requestedAt) + tickets.SILENCE() + 1;
        if (vm.getBlockTimestamp() < dead) _warpTo(dead);
        vm.prank(eoa[5]);
        tickets.enterTerminal();
        _settleModel(false, false);
    }

    function sCancel(uint256 k) external onlyHandler {
        _begin();
        if (openDraws.length == 0 || tickets.status().terminalAt == 0) return;
        uint256 i = k % openDraws.length;
        uint256 ticket = openDraws[i];
        IBoxTickets.DrawView memory d = tickets.drawTicket(ticket);
        if (d.status != DrawStatus.Requested) return;
        uint256 before = stream.owedOf(d.drawer);
        _cancelDraw(eoa[6], ticket);
        if (stream.owedOf(d.drawer) - before != stream.index() - drawJ[ticket]) ++drawStartMismatch;
        refScaled[d.drawer] += drawAcc[ticket];
        ++intervals[d.drawer];
        openDraws[i] = openDraws[openDraws.length - 1];
        openDraws.pop();
        ++cancels;
        _settleModel(false, false);
    }

    function sTake(uint256 who, uint256 poolIndex) external onlyHandler {
        _begin();
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt == 0) return;
        uint256 from = uint256(s.terminalAt) + tickets.TAKE_DELAY();
        if (vm.getBlockTimestamp() < from) _warpTo(from);
        address h = _holder(who);
        if (h == address(contractDrawer)) h = eoa[4];
        (uint256 item, bool hidden) = _poolItem(poolIndex % 64);
        if (!hidden) return;
        _takeByNumber(h, item, poolIndex % 64, true);
        (address rec, uint256 pend) = stream.pendingOf(item);
        if (rec != h || pend != 0) ++drawStartMismatch; // a take starts at J now
        _addItem(item);
        ++takes;
        _settleModel(false, false);
    }

    function sWarp(uint256 secondsAhead) external onlyHandler {
        _begin();
        _warpTo(vm.getBlockTimestamp() + bound(secondsAhead, 12, 3 days));
        _settleModel(false, false);
    }

    function sDeepen() external onlyHandler {
        _begin();
        _deepen(keeper, keeper);
        _settleModel(false, false);
    }

    function sNoteFailure(bytes4, bytes calldata reason) external onlyHandler {
        ++mustNotFail;
        lastFailure = reason;
    }

    // The ghost ledger's classes used above (kept as constants so the actions read short).
    TIn internal constant TInOther = TIn.Other;
    TIn internal constant TInDraw = TIn.Draw;
    TOut internal constant TOutReturn = TOut.Return;
    TOut internal constant TOutOther = TOut.Other;
    EthIn internal constant EthInDraw = EthIn.DrawValue;
    EthOut internal constant EthOutRefund = EthOut.Refund;

    // ================================================================================================ invariants

    /// P5.3: X equals its StateLibrary rebuild, never falls, and moves only by a sell's T fee or a gift.
    function invariant_AUDIT_U5_streamValueNeverFallsAndMovesOnlyByFeesOrGifts() public view {
        assertEq(xMismatch, 0, "X == its StateLibrary rebuild");
        assertEq(xFell, 0, "X never falls");
        assertEq(xMovedWithoutFee, 0, "X moves only by a fee or a gift");
        assertEq(stream.streamValue(), _refX());
    }

    /// P5.3: J never falls and is ⌊(X − X₀)/N⌋.
    function invariant_AUDIT_U5_indexNeverFallsAndFollowsX() public view {
        assertEq(jFell, 0, "J never falls");
        assertEq(stream.index(), (stream.streamValue() - stream.startValue()) / editionSize);
    }

    /// P5.3: F = held + claimed + burned, moved only by arrivals; claimed == Σ paid.
    function invariant_AUDIT_U5_conservation() public view {
        (uint256 claimed, uint256 burned) = stream.totals();
        assertEq(_streamF(), token.balanceOf(a.itemStream) + claimed + burned);
        assertEq(claimed, paidTotal, "claimed == paid");
        assertEq(fFell, 0, "F never falls");
        assertEq(fMovedWithoutArrival, 0, "F moves only by a batch or a gift");
    }

    /// P5.3, P5.14: every slot's accrual is booked to an owner or waits on an open ticket, exactly in J units:
    /// liabilities = Σ owed + Σ pending of the outside Misfits + p·J + (d·J − Σ J at the draws' requests); the stream's
    /// counts are the vault's and the model's.
    function invariant_AUDIT_U5_everySlotIsBookedOrWaitsExactly() public view {
        uint256 j = stream.index();
        uint256 sum;
        for (uint256 i; i < HOLDERS; ++i) {
            sum += stream.owedOf(holders[i]);
        }
        sum += stream.owedOf(keeper);
        for (uint256 i; i < items.length; ++i) {
            (address o, uint256 p) = stream.pendingOf(items[i]);
            if (o != address(0)) sum += p;
        }
        (uint256 ph, uint256 dr, uint256 dsum) = stream.openTickets();
        assertEq(ph, openPh.length, "open placeholders");
        assertEq(dr, openDraws.length, "open draws");
        uint256 jsum;
        for (uint256 i; i < openDraws.length; ++i) {
            jsum += drawJ[openDraws[i]];
        }
        assertEq(dsum, jsum, "the draws' J at request");
        assertEq(stream.liabilities(), sum + ph * j + (dr * j - dsum), "every slot's accrual booked or waiting");
        assertEq(stream.outsideCount(), editionSize - vault.inside(), "m = N - n");
    }

    /// P5.3 (BC-065): each holder's paid + booked + pending is its per-swap share (ΔX/N for every slot it held, its
    /// placeholders' and draws' shares at their openings) to within one raw unit per booked interval.
    function invariant_AUDIT_U5_eachHolderGetsItsShare() public view {
        for (uint256 i; i < HOLDERS; ++i) {
            address h = holders[i];
            uint256 got = paid[h] + stream.owedOf(h);
            uint256 open;
            for (uint256 k; k < items.length; ++k) {
                (address o, uint256 p) = stream.pendingOf(items[k]);
                if (o == h) {
                    got += p;
                    ++open;
                }
            }
            uint256 want = refScaled[h] / editionSize;
            assertApproxEqAbs(got, want, intervals[h] + open + 1, string.concat("holder ", vm.toString(i)));
        }
    }

    /// R1, P5.10: every draw starts at its own request (an opening's Misfit carries J − J at its request, a cancel
    /// books exactly that), a placeholder's Misfit at J 0, a take by number at J now.
    function invariant_AUDIT_U5_eachTicketStartsWhereItShould() public view {
        assertEq(drawStartMismatch, 0);
    }

    /// P5.3: a burn never leaves less than the owners' accrual; claims, claimFor, burns and transfers never fail; no
    /// fail-safe hook point (the collection's or the vault's observer, the receiver's notice) ever failed.
    function invariant_AUDIT_U5_burnsClaimsAndHookPointsNeverMisbehave() public view {
        assertEq(burnBelowLiabilities, 0, "a burn takes only surplus");
        assertEq(mustNotFail, 0, string(lastFailure));
        assertEq(hookPointFailures, 0, "no observer or notice failed");
    }

    /// AUDIT-U5-01's bound: the owners are covered by the T held and on its way to within N − 1 raw units.
    function invariant_AUDIT_U5_ownersCoveredWithinTheBound() public view {
        assertLe(maxShortfall, editionSize - 1);
    }

    function invariant_AUDIT_U5_ghostLedger() public view {
        _assertGhostLedger();
    }

    /// The handler does what it says (its actions are fail-safe): a seeded replay of 240 handler calls in the
    /// campaign's mix, then terminal mode (a draw left silent seven days), cancels and takes by number, reaches every
    /// kind of step (sells, batches, claims, transfers, returns, named picks, placeholder openings, draws, settles by
    /// drand and by the backup, draw openings, cancels, takes), and every invariant above holds after it.
    function testProperty_AUDIT_U5_streamCampaignReachesItsStates() public {
        for (uint256 i; i < 240; ++i) {
            _replayStep(uint256(keccak256(abi.encode("u5.stream.replay", i))));
        }
        handler.draw(3);
        handler.terminal();
        for (uint256 i; i < 40; ++i) {
            uint256 r = uint256(keccak256(abi.encode("u5.stream.terminal", i)));
            if (r % 3 == 0) handler.cancel(r >> 8);
            else if (r % 3 == 1) handler.take(r >> 8, r >> 64);
            else _replayStep(r >> 2);
        }
        emit log_named_uint("sells", sells);
        emit log_named_uint("batches", batches);
        emit log_named_uint("claims", claims);
        emit log_named_uint("transfers", transfers);
        emit log_named_uint("returns", returns_);
        emit log_named_uint("named picks", picks);
        emit log_named_uint("placeholder openings", placeholderOpens);
        emit log_named_uint("draws requested", drawsRequested);
        emit log_named_uint("settles", settles);
        emit log_named_uint("draws opened", drawsOpened);
        emit log_named_uint("cancels", cancels);
        emit log_named_uint("takes", takes);
        emit log_named_uint("largest shortfall (raw)", maxShortfall);
        assertGt(sells, 0);
        assertGt(batches, 0);
        assertGt(claims, 0);
        assertGt(transfers, 0);
        assertGt(returns_, 0);
        assertGt(picks, 0);
        assertGt(placeholderOpens, 0);
        assertGt(drawsRequested, 0);
        assertGt(settles, 0);
        assertGt(drawsOpened, 0);
        assertGt(cancels, 0);
        assertGt(takes, 0);
        assertTrue(tickets.status().terminalAt != 0, "terminal mode reached");
        invariant_AUDIT_U5_streamValueNeverFallsAndMovesOnlyByFeesOrGifts();
        invariant_AUDIT_U5_indexNeverFallsAndFollowsX();
        invariant_AUDIT_U5_conservation();
        invariant_AUDIT_U5_everySlotIsBookedOrWaitsExactly();
        invariant_AUDIT_U5_eachHolderGetsItsShare();
        invariant_AUDIT_U5_eachTicketStartsWhereItShould();
        invariant_AUDIT_U5_burnsClaimsAndHookPointsNeverMisbehave();
        invariant_AUDIT_U5_ownersCoveredWithinTheBound();
        invariant_AUDIT_U5_ghostLedger();
    }

    function _replayStep(uint256 r) internal {
        uint256 op = r % 20;
        uint256 x = r >> 8;
        uint256 y = r >> 64;
        uint256 z = r >> 128;
        if (op <= 1) handler.sell(x);
        else if (op == 2) handler.buy(x);
        else if (op <= 4) handler.collect();
        else if (op == 5) handler.burn(x);
        else if (op == 6) handler.gift(x);
        else if (op <= 8) handler.transfer(x, y, z);
        else if (op <= 10) handler.claim(x, y & 1 == 1);
        else if (op == 11) handler.returnItem(x, y);
        else if (op == 12) handler.pick(x, y);
        else if (op == 13) handler.openPlaceholder(x);
        else if (op == 14) handler.movePlaceholder(x, y);
        else if (op == 15) handler.draw(x);
        else if (op == 16) handler.settle(x);
        else if (op == 17) handler.openDraw(x, y);
        else if (op == 18) handler.warp(x);
        else handler.deepen();
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeStreamAmsterdamInvariants is AuditU5ClaudeStreamInvariants {}
