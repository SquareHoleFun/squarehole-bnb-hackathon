// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {History2935} from "../../backup/History2935.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {AuditGhostLedger, EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditHeaders} from "../common/AuditHeaders.sol";
import {AuditU5FableBase, AuditU5FableReads, AuditU5FableRevealCache} from "./AuditU5FableBase.sol";

/// @notice The campaign's actions (counters are indexed by them).
enum StreamAction {
    Sell,
    Buy,
    Collect,
    Gift,
    Burn,
    Deepen,
    Advance,
    Draw,
    Rescue,
    Settle,
    OpenDraw,
    OpenPlaceholder,
    Transfer,
    ReturnItem,
    Pick,
    Claim,
    EnterTerminal,
    Cancel,
    TakeByNumber,
    Finish,
    Jump
}

/// @title AuditU5FableStreamModel
/// @notice TEST ONLY (SH-AUDIT-B0-U5-F). The stream campaign's reference model and ghosts, shared by its two action
/// handlers: every rise of X (read by StateLibrary, never from the stream) is allocated to the slots outside at that
/// moment (each outside item to its holder, each open placeholder and each open draw on its own); after every action
/// the stream's X, J, ledgers, conservation, owners and events are checked; `finish` claims everyone and compares the
/// accounts with the reference. It also keeps the ghost ledger, seeded with the world's totals at the hand-over.
contract AuditU5FableStreamModel is CommonBase, AuditGhostLedger {
    using PoolIdLibrary for PoolKey;

    struct DrawRef {
        uint256 ticket;
        address drawer;
        uint256 acc;
    }

    struct Setup {
        IPoolManager pm;
        BoxItemStream stream;
        BoxToken t;
        BoxReceiver receiver;
        BoxCollection collection;
        BoxTickets tickets;
        BoxHook hook;
        PoolKey key;
        int24 p1;
        int24 p0;
        address keeper;
        address[] actors;
        address[] system;
        address[] outside;
        uint256 ethIn;
        uint256 ethOut;
        uint256 tIn;
        uint256 tOut;
        address weth;
        uint256[] items;
        uint256[] placeholders;
        uint256 openDraw;
        address openDrawer;
    }

    uint8 internal constant KIND_PLAIN = 0;
    uint8 internal constant KIND_X = 1;

    IPoolManager internal pm;
    BoxItemStream internal stream;
    BoxToken internal t;
    BoxReceiver internal receiver;
    BoxCollection internal collection;
    BoxTickets internal tickets;
    BoxHook internal hook;
    PoolId internal pid;
    AuditU5FableReads.Positions internal pos;
    address public keeper;
    address[] public actors;
    uint256 public n;

    // ------------------------------------------------------------------ the reference model
    uint256[] public items;
    mapping(uint256 => bool) internal tracked;
    mapping(uint256 => address) public itemOwner;
    uint256[] public shelf;
    DrawRef[] public draws;
    uint256[] public placeholders;
    uint256 public placeholderAcc;
    mapping(address => uint256) public ref;
    mapping(address => uint256) public intervals;
    mapping(address => uint256) public paid;
    uint256 internal xLast;
    uint256 internal jLast;
    uint256 public received;
    uint256 public gifts;
    bool public terminal;
    uint256 internal xBefore;
    uint8 internal kind;

    // ------------------------------------------------------------------ ghosts (must stay zero)
    uint256 public xMismatch;
    uint256 public xFell;
    uint256 public jFell;
    uint256 public xMovedWithoutCause;
    uint256 public uncovered;
    uint256 public ledgerMismatch;
    uint256 public ownerMismatch;
    uint256 public observerFailed;
    uint256 public noticeFailed;
    uint256 public conservationMismatch;
    uint256 public drawCheckFailed;
    uint256 public unexpectedRevert;
    bytes public lastUnexpected;

    // ------------------------------------------------------------------ coverage
    uint256[21] public calls;
    uint256[21] public oks;

    constructor(Setup memory s) {
        pm = s.pm;
        stream = s.stream;
        t = s.t;
        receiver = s.receiver;
        collection = s.collection;
        tickets = s.tickets;
        hook = s.hook;
        pid = s.key.toId();
        pos = AuditU5FableReads.Positions(s.p1, s.p0);
        keeper = s.keeper;
        actors = s.actors;
        n = s.collection.collectionSize();
        for (uint256 i; i < s.system.length; ++i) {
            _ghostAddSystem(s.system[i]);
        }
        for (uint256 i; i < s.outside.length; ++i) {
            _ghostAddOutside(s.outside[i]);
        }
        _ghostToken = address(s.t);
        _ghostWeth = s.weth;
        (_ghostEthInTotal, _ghostEthOutTotal, _ghostTInTotal, _ghostTOutTotal) = (s.ethIn, s.ethOut, s.tIn, s.tOut);
        for (uint256 i; i < s.items.length; ++i) {
            track(s.items[i], s.collection.ownerOf(s.items[i]));
        }
        placeholders = s.placeholders;
        draws.push(DrawRef(s.openDraw, s.openDrawer, 0));
        xLast = xMine();
        jLast = s.stream.index();
        require(xLast == s.stream.streamValue(), "model: X at the start");
    }

    // ================================================================== per action

    function before(StreamAction action, bool movesX) external {
        calls[uint256(action)]++;
        kind = movesX ? KIND_X : KIND_PLAIN;
        uint256 x = xMine();
        if (x > xLast) _allocate(x - xLast);
        else if (x < xLast) ++xFell;
        xLast = x;
        xBefore = x;
        vm.recordLogs();
    }

    function ok(StreamAction action) external {
        oks[uint256(action)]++;
    }

    function unexpected(bytes memory e) external {
        ++unexpectedRevert;
        lastUnexpected = e;
    }

    function after_() external {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IBoxCollection.TransferObserverFailed.selector || t0 == IBoxVault.VaultObserverFailed.selector) {
                ++observerFailed;
            } else if (t0 == IBoxReceiver.StreamNotifyFailed.selector) {
                ++noticeFailed;
            } else if (t0 == IBoxReceiver.StreamFunded.selector && logs[i].emitter == address(receiver)) {
                received += abi.decode(logs[i].data, (uint256));
            }
        }
        uint256 x = xMine();
        if (x != stream.streamValue()) ++xMismatch;
        if (kind == KIND_PLAIN && x != xBefore) ++xMovedWithoutCause;
        if (x < xBefore) ++xFell;
        uint256 j = stream.index();
        if (j < jLast) ++jFell;
        jLast = j;
        if (ledger() != stream.liabilities()) ++ledgerMismatch;
        for (uint256 i; i < items.length; ++i) {
            if (collection.ownerOf(items[i]) != itemOwner[items[i]]) ++ownerMismatch;
        }
        (uint256 claimed, uint256 burned) = stream.totals();
        if (t.balanceOf(address(stream)) + claimed + burned != received + gifts) ++conservationMismatch;
    }

    /// Every rise of X goes to the slots outside at that moment: an item's holder, a placeholder's pot, a draw's own.
    function _allocate(uint256 dx) internal {
        for (uint256 i; i < items.length; ++i) {
            ref[itemOwner[items[i]]] += dx;
        }
        placeholderAcc += dx;
        for (uint256 i; i < draws.length; ++i) {
            draws[i].acc += dx;
        }
    }

    // ================================================================== reads

    /// X = F + 13·⌊(U + R)/15⌋ by StateLibrary and the receiver's claims (graduated and settled from the start).
    function xMine() public view returns (uint256) {
        (uint256 claimed, uint256 burned) = stream.totals();
        uint256 f = t.balanceOf(address(stream)) + claimed + burned;
        (, uint256 u1) = AuditU5FableReads.uncollected(pm, pid, address(hook), pos);
        uint256 r = pm.balanceOf(address(receiver), uint256(uint160(address(t))));
        return f + BoxSpecV1.BOX0_FEE_SHARE_T_BURN * ((u1 + r) / BoxSpecV1.FEE_SHARE_DENOMINATOR);
    }

    /// Σ owed + Σ pending of the outside items + the open tickets' accrual.
    function ledger() public view returns (uint256 total) {
        for (uint256 i; i < actors.length; ++i) {
            total += stream.owedOf(actors[i]);
        }
        total += stream.owedOf(address(this));
        for (uint256 i; i < items.length; ++i) {
            (, uint256 pending) = stream.pendingOf(items[i]);
            total += pending;
        }
        uint256 j = stream.index();
        (uint256 p, uint256 d, uint256 sum) = stream.openTickets();
        total += p * j + (d * j - sum);
    }

    function itemsOf(address who) public view returns (uint256[] memory ids) {
        uint256 c;
        ids = new uint256[](items.length);
        for (uint256 i; i < items.length; ++i) {
            if (itemOwner[items[i]] == who) ids[c++] = items[i];
        }
        assembly ("memory-safe") {
            mstore(ids, c)
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function itemCount() external view returns (uint256) {
        return items.length;
    }

    function shelfCount() external view returns (uint256) {
        return shelf.length;
    }

    function drawCount() external view returns (uint256) {
        return draws.length;
    }

    function placeholderCount() external view returns (uint256) {
        return placeholders.length;
    }

    function ghostBalanced() external view returns (bool ethOk, bool tOk) {
        (ethOk,,,) = _ghostEthBalanced();
        (tOk,,,) = _ghostTBalanced();
    }

    // ================================================================== writes by the handlers

    function noteEth(uint256 before_, uint256 after__, EthIn inClass, EthOut outClass) external {
        _noteEthChange(before_, after__, inClass, outClass);
    }

    function noteT(uint256 before_, uint256 after__, TIn inClass, TOut outClass) external {
        _noteTChange(before_, after__, inClass, outClass);
    }

    function noteGift(uint256 amount) external {
        _noteTIn(TIn.Direct, amount);
        gifts += amount;
    }

    function track(uint256 item, address owner) public {
        if (!tracked[item]) {
            tracked[item] = true;
            items.push(item);
        }
        itemOwner[item] = owner;
    }

    function onTransfer(uint256 item, address from, address to) external {
        ++intervals[from];
        itemOwner[item] = to;
    }

    function onReturn(uint256 i, address owner) external {
        uint256 item = items[i];
        ++intervals[owner];
        tracked[item] = false;
        delete itemOwner[item];
        items[i] = items[items.length - 1];
        items.pop();
        shelf.push(item);
    }

    function onPick(uint256 i, address actor) external {
        uint256 item = shelf[i];
        track(item, actor);
        shelf[i] = shelf[shelf.length - 1];
        shelf.pop();
    }

    function onClaim(address actor, uint256 got, uint256 count) external {
        paid[actor] += got;
        intervals[actor] += count;
    }

    function pushDraw(uint256 ticket, address drawer) external {
        draws.push(DrawRef(ticket, drawer, 0));
    }

    function onDrawOpened(uint256 i, address to, uint256 item) external {
        DrawRef memory d = draws[i];
        (address o, uint256 pending) = stream.pendingOf(item);
        if (o != to || !_within(pending, d.acc / n, 2)) ++drawCheckFailed;
        ref[to] += d.acc;
        ++intervals[to];
        track(item, to);
        _popDraw(i);
    }

    function onDrawCancelled(uint256 i, uint256 booked) external {
        DrawRef memory d = draws[i];
        if (!_within(booked, d.acc / n, 2)) ++drawCheckFailed;
        ref[d.drawer] += d.acc;
        ++intervals[d.drawer];
        _popDraw(i);
    }

    function onPlaceholderOpened(uint256 i, address holder, uint256 item) external {
        ref[holder] += placeholderAcc;
        ++intervals[holder];
        track(item, holder);
        placeholders[i] = placeholders[placeholders.length - 1];
        placeholders.pop();
    }

    function setTerminal() external {
        terminal = true;
    }

    function registerOutside(address who) external {
        _ghostAddOutside(who);
    }

    function _popDraw(uint256 i) internal {
        draws[i] = draws[draws.length - 1];
        draws.pop();
    }

    function _within(uint256 got, uint256 want, uint256 tol) internal pure returns (bool) {
        return got > want ? got - want <= tol : want - got <= tol;
    }

    // ================================================================== the end of a run

    /// After a final collect (the caller's): the final allocation, every account claimed, the reference compared:
    /// |owed + paid − ref/N| ≤ intervals + 3 per account; a burn then leaves at most one raw unit per outside slot
    /// beyond the owners' accrual (owners covered: what a collect brings in is what J counted).
    function finish() external {
        this.before(StreamAction.Finish, false);
        for (uint256 i; i < actors.length; ++i) {
            address actor = actors[i];
            uint256[] memory ids = itemsOf(actor);
            uint256 t0 = t.balanceOf(actor);
            vm.prank(keeper);
            uint256 got = stream.claimFor(actor, ids);
            paid[actor] += got;
            intervals[actor] += ids.length;
            _noteTChange(t0, t.balanceOf(actor), TIn.Other, TOut.StreamClaim);
        }
        for (uint256 i; i < actors.length; ++i) {
            address actor = actors[i];
            uint256 want = ref[actor] / n;
            uint256 got = stream.owedOf(actor) + paid[actor];
            require(
                _within(got, want, intervals[actor] + 3), "finish: an account's total is off the per-swap reference"
            );
        }
        vm.prank(keeper);
        stream.burn();
        uint256 held = t.balanceOf(address(stream));
        uint256 liabilities = stream.liabilities();
        require(held >= liabilities, "finish: owners covered after the burn");
        require(held - liabilities <= stream.outsideCount(), "finish: only the per-slot margin stays");
        this.after_();
        oks[uint256(StreamAction.Finish)]++;
    }
}

/// @title AuditU5FableStreamTradeHandler
/// @notice TEST ONLY (SH-AUDIT-B0-U5-F). The trading, batch, item and claim actions of the stream campaign.
contract AuditU5FableStreamTradeHandler is CommonBase, StdCheats, StdUtils {
    AuditU5FableStreamModel internal m;
    IPoolManager internal pm;
    BoxItemStream internal stream;
    BoxToken internal t;
    BoxReceiver internal receiver;
    BoxVault internal vault;
    BoxCollection internal collection;
    BoxHook internal hook;
    AuditRouterSwapper internal swapper;
    PoolKey internal key;
    address internal keeper;

    constructor(
        AuditU5FableStreamModel m_,
        BoxVault vault_,
        BoxCollection collection_,
        BoxHook hook_,
        AuditRouterSwapper swapper_,
        PoolKey memory key_
    ) {
        m = m_;
        vault = vault_;
        collection = collection_;
        hook = hook_;
        swapper = swapper_;
        key = key_;
        keeper = m_.keeper();
        stream = BoxItemStream(vault_.observer());
        t = BoxToken(vault_.token());
        receiver = BoxReceiver(payable(stream.receiver()));
        pm = IPoolManager(stream.poolManager());
    }

    function _actor(uint256 who) internal view returns (address) {
        return m.actors(who % m.actorCount());
    }

    function sell(uint256 who, uint256 frac) external {
        m.before(StreamAction.Sell, true);
        address actor = _actor(who);
        uint256 held = t.balanceOf(actor);
        uint256 amount = held == 0 ? 0 : held * bound(frac, 1, 60) / 100;
        if (amount != 0) {
            vm.prank(actor);
            t.approve(address(swapper), type(uint256).max);
            uint256 e0 = actor.balance;
            vm.prank(actor);
            try swapper.swapOne(key, SwapParams(false, -int256(amount), TickMath.MAX_SQRT_PRICE - 1), "", actor) {
                m.ok(StreamAction.Sell);
            } catch (bytes memory e) {
                m.unexpected(e);
            }
            m.noteEth(e0, actor.balance, EthIn.SwapIn, EthOut.SwapOut);
            m.noteT(held, t.balanceOf(actor), TIn.Sell, TOut.Buy);
        }
        m.after_();
    }

    function buy(uint256 who, uint256 amount) external {
        m.before(StreamAction.Buy, false);
        address actor = _actor(who);
        amount = bound(amount, 1e15, 2 ether);
        vm.deal(actor, actor.balance + amount);
        uint256 e0 = actor.balance;
        uint256 t0 = t.balanceOf(actor);
        vm.prank(actor);
        try swapper.swapOne{value: amount}(
            key, SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1), "", actor
        ) {
            m.ok(StreamAction.Buy);
        } catch (bytes memory e) {
            m.unexpected(e);
        }
        m.noteEth(e0, actor.balance, EthIn.SwapIn, EthOut.SwapOut);
        m.noteT(t0, t.balanceOf(actor), TIn.Sell, TOut.Buy);
        m.after_();
    }

    function collect() external {
        m.before(StreamAction.Collect, false);
        uint256 k0 = keeper.balance;
        vm.prank(keeper);
        try receiver.collect(keeper) {
            m.ok(StreamAction.Collect);
            if (t.balanceOf(address(stream)) < stream.liabilities()) m.unexpected("uncovered after a collect");
        } catch (bytes memory e) {
            if (bytes4(e) != IBoxReceiver.BatchTooSmall.selector) m.unexpected(e);
        }
        m.noteEth(k0, keeper.balance, EthIn.Other, EthOut.Tip);
        m.after_();
    }

    function gift(uint256 amount) external {
        m.before(StreamAction.Gift, true);
        uint256 held = t.balanceOf(address(this));
        if (held != 0) {
            amount = bound(amount, 1, held / 4 + 1);
            if (amount > held) amount = held;
            require(t.transfer(address(stream), amount), "gift");
            m.noteGift(amount);
            m.ok(StreamAction.Gift);
        }
        m.after_();
    }

    function burn() external {
        m.before(StreamAction.Burn, false);
        vm.prank(_actor(0));
        try stream.burn() {
            m.ok(StreamAction.Burn);
        } catch (bytes memory e) {
            m.unexpected(e);
        }
        m.after_();
    }

    function deepen() external {
        m.before(StreamAction.Deepen, false);
        uint256 k0 = keeper.balance;
        vm.prank(keeper);
        try hook.deepen(keeper) {
            m.ok(StreamAction.Deepen);
        } catch (bytes memory e) {
            m.unexpected(e);
        }
        m.noteEth(k0, keeper.balance, EthIn.Other, EthOut.Tip);
        m.after_();
    }

    function advance(uint256 blocks) external {
        m.before(StreamAction.Advance, false);
        blocks = bound(blocks, 1, 300);
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + 12 * blocks);
        m.ok(StreamAction.Advance);
        m.after_();
    }

    /// A jump of 1 hour to 3 days (a backup window missed now and then: the terminal path).
    function jump(uint256 secs) external {
        m.before(StreamAction.Jump, false);
        secs = bound(secs, 1 hours, 3 days);
        vm.roll(vm.getBlockNumber() + secs / 12);
        vm.warp(vm.getBlockTimestamp() + secs);
        m.ok(StreamAction.Jump);
        m.after_();
    }

    function transfer(uint256 k, uint256 who) external {
        m.before(StreamAction.Transfer, false);
        uint256 count = m.itemCount();
        if (count != 0) {
            uint256 item = m.items(k % count);
            address from = m.itemOwner(item);
            address to = _actor(who);
            if (from != to) {
                vm.prank(from);
                try collection.transferFrom(from, to, item) {
                    m.ok(StreamAction.Transfer);
                    m.onTransfer(item, from, to);
                } catch (bytes memory e) {
                    m.unexpected(e);
                }
            }
        }
        m.after_();
    }

    function returnItem(uint256 k) external {
        m.before(StreamAction.ReturnItem, false);
        uint256 count = m.itemCount();
        if (count != 0) {
            uint256 i = k % count;
            uint256 item = m.items(i);
            address owner = m.itemOwner(item);
            vm.prank(owner);
            collection.setApprovalForAll(address(vault), true);
            uint256 t0 = t.balanceOf(owner);
            vm.prank(owner);
            try vault.returnItem(item, 0, vm.getBlockTimestamp()) {
                m.ok(StreamAction.ReturnItem);
                m.onReturn(i, owner);
            } catch (bytes memory e) {
                bytes4 s = bytes4(e);
                if (s != IBoxVault.NotRevealed.selector && s != IBoxVault.EscrowInsolvent.selector) m.unexpected(e);
            }
            m.noteT(t0, t.balanceOf(owner), TIn.Other, TOut.Return);
        }
        m.after_();
    }

    function pick(uint256 k, uint256 who) external {
        m.before(StreamAction.Pick, false);
        uint256 count = m.shelfCount();
        if (count != 0) {
            uint256 i = k % count;
            uint256 item = m.shelf(i);
            address actor = _actor(who);
            uint256 cost = vault.quoteWithdraw(1);
            cost += cost * vault.pickFeeBps() / vault.FEE_DENOMINATOR();
            if (t.balanceOf(actor) >= cost) {
                vm.prank(actor);
                t.approve(address(vault), type(uint256).max);
                uint256 t0 = t.balanceOf(actor);
                vm.prank(actor);
                try vault.withdraw(item, type(uint256).max, vm.getBlockTimestamp()) {
                    m.ok(StreamAction.Pick);
                    m.onPick(i, actor);
                } catch (bytes memory e) {
                    m.unexpected(e);
                }
                m.noteT(t0, t.balanceOf(actor), TIn.Pick, TOut.Other);
            }
        }
        m.after_();
    }

    /// The actor's items claimed: by itself (`claim`) or by anyone for it (`claimFor`; contracts always this way).
    function claim(uint256 who, bool viaFor) external {
        m.before(StreamAction.Claim, false);
        address actor = _actor(who);
        uint256[] memory ids = m.itemsOf(actor);
        uint256 t0 = t.balanceOf(actor);
        bool ok;
        uint256 got;
        if (viaFor || actor.code.length > 23) {
            vm.prank(keeper);
            try stream.claimFor(actor, ids) returns (uint256 p) {
                (ok, got) = (true, p);
            } catch (bytes memory e) {
                m.unexpected(e);
            }
        } else {
            vm.prank(actor);
            try stream.claim(ids, actor) returns (uint256 p) {
                (ok, got) = (true, p);
            } catch (bytes memory e) {
                m.unexpected(e);
            }
        }
        if (ok) {
            m.ok(StreamAction.Claim);
            m.onClaim(actor, got, ids.length);
            if (t.balanceOf(actor) != t0 + got) m.unexpected("a claim paid another amount than it returned");
        }
        m.noteT(t0, t.balanceOf(actor), TIn.Other, TOut.StreamClaim);
        m.after_();
    }

    receive() external payable {}
}

/// @title AuditU5FableStreamDrawHandler
/// @notice TEST ONLY (SH-AUDIT-B0-U5-F). The draw, word, opening and terminal-mode actions of the stream campaign:
/// draws by EOAs, a contract and an EIP-7702 EOA, words by the RANDAO backup (drand is silent past the committed
/// rounds), settles, openings by the drawer or a third party, placeholder openings, terminal mode, cancels and takes.
contract AuditU5FableStreamDrawHandler is CommonBase, StdCheats, StdUtils {
    AuditU5FableStreamModel internal m;
    BoxItemStream internal stream;
    BoxToken internal t;
    BoxVault internal vault;
    BoxTickets internal tickets;
    BoxBackedSource internal src;
    AuditU5FableRevealCache internal reveals;
    address internal keeper;
    uint256 internal n;
    uint256 internal firstId;
    uint256 internal constant MAX_OPEN_DRAWS = 8;

    constructor(
        AuditU5FableStreamModel m_,
        BoxVault vault_,
        BoxTickets tickets_,
        BoxBackedSource src_,
        AuditU5FableRevealCache reveals_
    ) {
        m = m_;
        vault = vault_;
        tickets = tickets_;
        src = src_;
        reveals = reveals_;
        keeper = m_.keeper();
        stream = BoxItemStream(vault_.observer());
        t = BoxToken(vault_.token());
        n = m_.n();
        firstId = tickets_.firstId();
    }

    function _actor(uint256 who) internal view returns (address) {
        return m.actors(who % m.actorCount());
    }

    function _warpTo(uint256 ts) internal {
        uint256 d = ts - vm.getBlockTimestamp();
        vm.roll(vm.getBlockNumber() + (d + 11) / 12);
        vm.warp(ts);
    }

    function draw(uint256 who) external {
        m.before(StreamAction.Draw, false);
        address actor = _actor(who);
        if (m.drawCount() < MAX_OPEN_DRAWS && !m.terminal()) {
            (uint256 p, uint256 f) = vault.quoteTake(1);
            if (t.balanceOf(actor) >= p + f) {
                vm.prank(actor);
                t.approve(address(tickets), type(uint256).max);
                vm.deal(actor, actor.balance + 0.001 ether);
                uint256 e0 = actor.balance;
                uint256 t0 = t.balanceOf(actor);
                vm.prank(actor);
                try tickets.draw{value: 0.001 ether}(type(uint256).max, vm.getBlockTimestamp()) returns (
                    uint256 ticket
                ) {
                    m.ok(StreamAction.Draw);
                    m.pushDraw(ticket, actor);
                } catch (bytes memory e) {
                    bytes4 s = bytes4(e);
                    if (s != IBoxTickets.QueueDead.selector && s != IBoxTickets.TerminalMode.selector) m.unexpected(e);
                }
                m.noteEth(e0, actor.balance, EthIn.DrawValue, EthOut.Refund);
                m.noteT(t0, t.balanceOf(actor), TIn.Draw, TOut.Other);
            }
        }
        m.after_();
    }

    /// The queue head's word by the RANDAO backup: start it once 5 days have passed since the round's time (warping
    /// there if needed), then 257 blocks on fix it with a header carrying a chosen prevRandao, both by anyone. A head
    /// past its 7 days, or past the latest start, is left to terminal mode.
    function rescue() external {
        m.before(StreamAction.Rescue, false);
        IBoxTickets.TicketState memory s = tickets.status();
        if (!m.terminal() && s.drawsSettled < s.drawsRequested) {
            uint256 head = uint256(s.drawsSettled) + 1;
            (bytes32 word,) = src.wordOf(address(tickets), head);
            (uint64 requestedAt, uint64 round) = src.requestOf(address(tickets), head);
            (, uint64 target,,) = src.backupOf(round);
            uint256 rt = src.roundTime(round);
            bool dead = vm.getBlockTimestamp() > uint256(requestedAt) + tickets.SILENCE();
            if (word == bytes32(0) && !dead) {
                bool started = target != 0;
                if (!started && vm.getBlockTimestamp() <= rt + src.LATEST_START()) {
                    if (vm.getBlockTimestamp() < rt + src.BACKUP_AFTER() + 1) _warpTo(rt + src.BACKUP_AFTER() + 1);
                    bytes memory p = HeaderVectors.MAINNET;
                    vm.setBlockhash(vm.getBlockNumber() - 1, keccak256(p));
                    vm.prank(keeper);
                    try src.startBackup(round, vm.getBlockNumber() - 1, p) returns (uint256 t_) {
                        target = uint64(t_);
                        started = true;
                    } catch (bytes memory e) {
                        m.unexpected(e);
                    }
                }
                if (started) {
                    if (vm.getBlockNumber() <= target) {
                        uint256 more = target + 1 - vm.getBlockNumber();
                        vm.roll(target + 1);
                        vm.warp(vm.getBlockTimestamp() + 12 * more);
                    }
                    if (vm.getBlockTimestamp() <= uint256(requestedAt) + tickets.SILENCE()) {
                        bytes32 mix = keccak256(abi.encode("audit.u5.mix", round));
                        bytes memory h = AuditHeaders.header(target, mix);
                        if (vm.getBlockNumber() - target <= 256) vm.setBlockhash(target, keccak256(h));
                        History2935.put(vm, target, keccak256(h));
                        vm.prank(keeper);
                        try src.fixBackup(round, h) {
                            m.ok(StreamAction.Rescue);
                        } catch (bytes memory e) {
                            m.unexpected(e);
                        }
                    }
                }
            }
        }
        m.after_();
    }

    function settle(uint256 k) external {
        m.before(StreamAction.Settle, false);
        if (!m.terminal()) {
            vm.prank(keeper);
            try tickets.settle(bound(k, 1, 3)) {
                m.ok(StreamAction.Settle);
            } catch (bytes memory e) {
                if (bytes4(e) != IBoxTickets.NothingSettled.selector) m.unexpected(e);
            }
        }
        m.after_();
    }

    /// A settled draw opened: by its drawer to itself (mode 0) or to another actor (1), or by a third party to the
    /// drawer (2; refused before the grace for a drawer with code). The item starts at the draw's own request.
    function openDraw(uint256 k, uint256 who, uint256 mode) external {
        m.before(StreamAction.OpenDraw, false);
        uint256 count = m.drawCount();
        if (count != 0) {
            uint256 i = k % count;
            (uint256 ticket, address drawer,) = m.draws(i);
            if (tickets.drawTicket(ticket).status == DrawStatus.Settled) {
                mode %= 3;
                address other = _actor(who);
                address opener = mode == 2 ? other : drawer;
                address to = mode == 1 ? other : drawer;
                uint256 item = tickets.drawTicket(ticket).itemId;
                ItemReveal memory r = reveals.reveal(item);
                vm.prank(opener);
                try tickets.openDraw(ticket, to, r) returns (uint256 got) {
                    m.ok(StreamAction.OpenDraw);
                    require(got == item, "handler: the draw's item");
                    m.onDrawOpened(i, to, item);
                } catch (bytes memory e) {
                    if (bytes4(e) != IBoxTickets.DrawerOpensFirst.selector) m.unexpected(e);
                }
            }
        }
        m.after_();
    }

    function openPlaceholder(uint256 k) external {
        m.before(StreamAction.OpenPlaceholder, false);
        uint256 count = m.placeholderCount();
        if (count != 0) {
            uint256 i = k % count;
            uint256 tokenId = m.placeholders(i);
            address holder = tickets.ownerOf(tokenId);
            uint256 item = tickets.numberOf(tokenId);
            ItemReveal memory r = reveals.reveal(item);
            vm.prank(holder);
            try tickets.open(tokenId, r) returns (uint256 got) {
                m.ok(StreamAction.OpenPlaceholder);
                require(got == item, "handler: the placeholder's item");
                m.onPlaceholderOpened(i, holder, item);
            } catch (bytes memory e) {
                m.unexpected(e);
            }
        }
        m.after_();
    }

    /// 7 days of silence on the queue head let anyone enter terminal mode: taken once the head is dead (its deadline
    /// passed with no usable word), or warped there when its backup can no longer start, so the backup path stays
    /// reachable in the same runs.
    function enterTerminal() external {
        m.before(StreamAction.EnterTerminal, false);
        IBoxTickets.TicketState memory s = tickets.status();
        if (!m.terminal() && s.drawsSettled < s.drawsRequested) {
            uint256 head = uint256(s.drawsSettled) + 1;
            (uint64 requestedAt, uint64 round) = src.requestOf(address(tickets), head);
            (, uint64 target,,) = src.backupOf(round);
            uint256 deadline = uint256(requestedAt) + tickets.SILENCE();
            bool cannotStart = target == 0 && vm.getBlockTimestamp() > src.roundTime(round) + src.LATEST_START();
            if (vm.getBlockTimestamp() > deadline || cannotStart) {
                if (vm.getBlockTimestamp() <= deadline) _warpTo(deadline + 1);
                vm.prank(_actor(1));
                try tickets.enterTerminal() {
                    m.ok(StreamAction.EnterTerminal);
                    m.setTerminal();
                } catch (bytes memory e) {
                    if (bytes4(e) != IBoxTickets.HeadNotDead.selector) m.unexpected(e);
                }
            }
        }
        m.after_();
    }

    /// In terminal mode a requested draw is cancelled by anyone: its drawer gets its principal and the draw's own
    /// accrual since its request.
    function cancel(uint256 k, uint256 who) external {
        m.before(StreamAction.Cancel, false);
        uint256 count = m.drawCount();
        if (m.terminal() && count != 0) {
            uint256 i = k % count;
            (uint256 ticket, address drawer,) = m.draws(i);
            if (tickets.drawTicket(ticket).status == DrawStatus.Requested) {
                uint256 owedBefore = stream.owedOf(drawer);
                uint256 t0 = t.balanceOf(drawer);
                vm.prank(_actor(who));
                try tickets.cancelDraw(ticket) {
                    m.ok(StreamAction.Cancel);
                    m.onDrawCancelled(i, stream.owedOf(drawer) - owedBefore);
                } catch (bytes memory e) {
                    m.unexpected(e);
                }
                m.noteT(t0, t.balanceOf(drawer), TIn.Other, TOut.Cancel);
            }
        }
        m.after_();
    }

    /// In terminal mode, 3 days on, a hidden item taken by its number (with its reveal): outside from now.
    function takeByNumber(uint256 who, uint256 idx) external {
        m.before(StreamAction.TakeByNumber, false);
        if (m.terminal()) {
            IBoxTickets.TicketState memory s = tickets.status();
            uint256 from = uint256(s.terminalAt) + tickets.TAKE_DELAY();
            if (vm.getBlockTimestamp() < from) _warpTo(from + 1);
            uint256 left = n - s.slots - s.drawsSettled;
            if (left != 0) {
                idx %= left;
                (uint256 u, uint256 v) = BoxShuffle.halves(n);
                uint256 item =
                    firstId + BoxShuffle.permute(tickets.graduationWord(), tickets.poolPositionAt(idx), n, u, v);
                address actor = _actor(who);
                (uint256 p, uint256 f) = vault.quoteTake(1);
                if (vault.isHidden(item) && t.balanceOf(actor) >= p + f) {
                    ItemReveal memory r = reveals.reveal(item);
                    vm.prank(actor);
                    t.approve(address(tickets), type(uint256).max);
                    uint256 t0 = t.balanceOf(actor);
                    vm.prank(actor);
                    try tickets.takeByNumber(item, idx, type(uint256).max, vm.getBlockTimestamp(), r) {
                        m.ok(StreamAction.TakeByNumber);
                        m.track(item, actor);
                    } catch (bytes memory e) {
                        m.unexpected(e);
                    }
                    m.noteT(t0, t.balanceOf(actor), TIn.TakeByNumber, TOut.Other);
                }
            }
        }
        m.after_();
    }
}

/// @title AuditU5FableStreamInvariants
/// @notice SH-AUDIT-B0-U5-F: the stream's invariant campaign on the factory's box 0 (plan § 6 item 5; unit brief P5.3,
/// P5.4, P5.10, P5.13, P5.14): X by StateLibrary equals the stream's and never falls; J never decreases; X moves only
/// at a sell or a gift; the two ledgers agree; conservation to the raw unit; owners covered after every collect; every
/// opened or cancelled draw within two raw units of its own accrual; no observer or notice ever failed; no unexpected
/// revert; the ghost ledger; and at the end of each run every account within intervals + 3 of the per-swap reference.
/// forge-config: default.evm_version = "osaka"
contract AuditU5FableStreamInvariants is AuditU5FableBase {
    AuditU5FableStreamModel internal m;
    AuditU5FableStreamTradeHandler internal ht;
    AuditU5FableStreamDrawHandler internal hd;

    function setUp() public override {
        super.setUp();
        _toDrawing();
        AuditU5FableRevealCache cache = new AuditU5FableRevealCache(editionSize);
        address[] memory actors = new address[](8);
        for (uint256 i; i < 6; ++i) {
            actors[i] = eoa[i];
        }
        actors[6] = address(contractDrawer);
        actors[7] = eoa7702;
        uint256[] memory startItems = new uint256[](2);
        (startItems[0], startItems[1]) = (itemA, itemP1);
        uint256[] memory ph = new uint256[](4);
        (ph[0], ph[1], ph[2], ph[3]) = (2, 3, 4, 5);
        AuditU5FableStreamModel.Setup memory s;
        s.pm = pm;
        s.stream = stream;
        s.t = token;
        s.receiver = receiver;
        s.collection = collection;
        s.tickets = tickets;
        s.hook = hook;
        s.key = poolKey;
        s.p1 = curve.tickLower;
        s.p0 = curve.tickUpper;
        s.keeper = keeper;
        s.actors = actors;
        s.system = ghostSystem();
        s.outside = ghostOutside();
        s.weth = a.weth;
        s.items = startItems;
        s.placeholders = ph;
        s.openDraw = drawB;
        s.openDrawer = address(contractDrawer);
        (s.ethIn, s.ethOut, s.tIn, s.tOut) = ghostTotals();
        m = new AuditU5FableStreamModel(s);
        ht = new AuditU5FableStreamTradeHandler(m, vault, collection, hook, routerSwapper, poolKey);
        hd = new AuditU5FableStreamDrawHandler(m, vault, tickets, src, cache);
        // The trade handler holds T for gifts (a plain transfer between outside holders after its creation; the
        // model's ghost ledger was seeded before it, so the gift is booked on the model's side).
        _ghostAddOutside(address(ht));
        vm.prank(eoa[2]);
        require(token.transfer(address(ht), 5e22), "T for gifts");
        m.registerOutside(address(ht));
        targetContract(address(ht));
        targetContract(address(hd));
    }

    /// A last batch with enough Q to collect, then the model's end-of-run checks.
    function afterInvariant() public {
        _finish();
    }

    function _finish() internal {
        ht.buy(4, 0.6 ether);
        ht.advance(1);
        ht.collect();
        m.finish();
    }

    function invariant_AUDIT_U5_streamXMatchesStateLibraryAndNeverFalls() public view {
        assertEq(m.xMismatch(), 0, "X by extsload == X by StateLibrary");
        assertEq(m.xFell(), 0, "X never falls");
        assertEq(m.xMovedWithoutCause(), 0, "X moves only at a sell or a gift");
    }

    function invariant_AUDIT_U5_streamIndexNeverDecreases() public view {
        assertEq(m.jFell(), 0, "J never decreases");
    }

    function invariant_AUDIT_U5_streamLedgersAgree() public view {
        assertEq(m.ledgerMismatch(), 0, "aggregate (m x dJ) == per-item records + owed + open tickets");
        assertEq(m.ownerMismatch(), 0, "tracked owners are the collection's");
    }

    function invariant_AUDIT_U5_streamConservation() public view {
        assertEq(m.conservationMismatch(), 0, "held + paid + burned == received + gifts");
    }

    function invariant_AUDIT_U5_streamDrawsEarnFromTheirOwnRequest() public view {
        assertEq(m.drawCheckFailed(), 0, "each opened or cancelled draw within 2 raw units of its own accrual");
    }

    function invariant_AUDIT_U5_streamObserversAndNoticesNeverFail() public view {
        assertEq(m.observerFailed(), 0, "no observer failed");
        assertEq(m.noticeFailed(), 0, "no notice failed");
    }

    function invariant_AUDIT_U5_streamNoUnexpectedRevert() public view {
        assertEq(m.unexpectedRevert(), 0, "no call reverted for an unexpected reason, owners covered after collects");
    }

    function invariant_AUDIT_U5_streamGhostLedger() public view {
        (bool ethOk, bool tOk) = m.ghostBalanced();
        assertTrue(ethOk, "system ETH == booked in - booked out");
        assertTrue(tOk, "outside T == booked out - booked in");
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
    }

    /// Coverage (reported, not an invariant): a scripted run of 600 pseudo-random handler calls through every phase
    /// (draws rescued by the backup, terminal mode, cancels, takes); every action must have succeeded at least once.
    function testProperty_AUDIT_U5_streamHandlerCoverage() public {
        string[21] memory names = [
            "sell",
            "buy",
            "collect",
            "gift",
            "burn",
            "deepen",
            "advance",
            "draw",
            "rescue",
            "settle",
            "openDraw",
            "openPlaceholder",
            "transfer",
            "returnItem",
            "pick",
            "claim",
            "enterTerminal",
            "cancel",
            "takeByNumber",
            "finish",
            "jump"
        ];
        for (uint256 i; i < 600; ++i) {
            uint256 r = uint256(keccak256(abi.encode("audit.u5.stream.coverage", i)));
            uint256 op = r % 100;
            uint256 p = r >> 8;
            uint256 q = r >> 72;
            if (op < 16) ht.sell(p, q);
            else if (op < 24) ht.buy(p, q);
            else if (op < 34) ht.collect();
            else if (op < 36) ht.gift(p);
            else if (op < 38) ht.burn();
            else if (op < 40) ht.deepen();
            else if (op < 43) ht.advance(p);
            else if (op < 45) ht.jump(p);
            else if (op < 51) hd.draw(p);
            else if (op < 57) hd.rescue();
            else if (op < 61) hd.settle(p);
            else if (op < 66) hd.openDraw(p, q, r >> 136);
            else if (op < 69) hd.openPlaceholder(p);
            else if (op < 77) ht.transfer(p, q);
            else if (op < 81) ht.returnItem(p);
            else if (op < 85) ht.pick(p, q);
            else if (op < 92) ht.claim(p, (r >> 200) & 1 == 1);
            else if (op < 94) hd.enterTerminal();
            else if (op < 97) hd.cancel(p, q);
            else hd.takeByNumber(p, q);
        }
        _finish();
        emit log_named_bytes("last unexpected revert", m.lastUnexpected());
        invariant_AUDIT_U5_streamNoUnexpectedRevert();
        for (uint256 i; i < 21; ++i) {
            emit log_named_uint(string.concat(names[i], " calls"), m.calls(i));
            emit log_named_uint(string.concat(names[i], " successes"), m.oks(i));
            assertGt(m.oks(i), 0, "every action succeeded at least once");
        }
        invariant_AUDIT_U5_streamXMatchesStateLibraryAndNeverFalls();
        invariant_AUDIT_U5_streamIndexNeverDecreases();
        invariant_AUDIT_U5_streamLedgersAgree();
        invariant_AUDIT_U5_streamConservation();
        invariant_AUDIT_U5_streamDrawsEarnFromTheirOwnRequest();
        invariant_AUDIT_U5_streamObserversAndNoticesNeverFail();
        invariant_AUDIT_U5_streamNoUnexpectedRevert();
        invariant_AUDIT_U5_streamGhostLedger();
        emit log_named_uint("outside items at the end", m.itemCount());
        emit log_named_uint("received by the stream", m.received());
    }
}
