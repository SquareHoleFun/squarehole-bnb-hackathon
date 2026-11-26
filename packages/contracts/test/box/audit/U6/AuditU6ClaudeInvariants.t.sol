// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {DrawStatus, ItemReveal, TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {AuditU6ClaudeBase} from "./AuditU6ClaudeBase.sol";

/// @notice TEST ONLY. The invariant campaign's only target: it forwards each fuzzed call to the test contract (which is
/// the world), so every action runs with the world's booked helpers and every outcome is checked against an oracle.
contract AuditU6ClaudeHandler {
    AuditU6ClaudeInvariants internal immutable t;

    constructor(AuditU6ClaudeInvariants t_) {
        t = t_;
    }

    function take(uint256 a, uint256 b) external {
        t.h_take(a, b);
    }

    function handBack(uint256 a, uint256 b) external {
        t.h_handBack(a, b);
    }

    function graduate() external {
        t.h_graduate();
    }

    function post(uint256 a) external {
        t.h_post(a);
    }

    function accept() external {
        t.h_accept();
    }

    function draw(uint256 a, uint256 b) external {
        t.h_draw(a, b);
    }

    function settle(uint256 a) external {
        t.h_settle(a);
    }

    function openDraw(uint256 a, uint256 b) external {
        t.h_openDraw(a, b);
    }

    function openPlaceholder(uint256 a, uint256 b) external {
        t.h_openPlaceholder(a, b);
    }

    function transferPlaceholder(uint256 a, uint256 b) external {
        t.h_transferPlaceholder(a, b);
    }

    function warp(uint256 a) external {
        t.h_warp(a);
    }

    function startBackup(uint256 a) external {
        t.h_startBackup(a);
    }

    function fixBackup(uint256 a, uint256 b) external {
        t.h_fixBackup(a, b);
    }

    function enterTerminal() external {
        t.h_enterTerminal();
    }

    function cancel(uint256 a) external {
        t.h_cancel(a);
    }

    function takeByNumber(uint256 a, uint256 b) external {
        t.h_takeByNumber(a, b);
    }

    function returnItem(uint256 a) external {
        t.h_returnItem(a);
    }

    function pick(uint256 a) external {
        t.h_pick(a);
    }

    function addBounty(uint256 a) external {
        t.h_addBounty(a);
    }

    function backupCycle(uint256 a, uint256 b) external {
        t.h_backupCycle(a, b);
    }

    function postAll() external {
        t.h_postAll();
    }

    function drawMany(uint256 a, uint256 b) external {
        t.h_drawMany(a, b);
    }
}

/// @title AuditU6ClaudeInvariants
/// @notice U6's invariant campaign (plan § 1.1; the map's gap 4: the tickets' campaign ran on MockDrandSource only) on
/// the factory's box 0 with the real BoxBackedSource and DrandSource: from the bonding phase (five placeholders), random
/// takes, hand-backs and transfers on the curve, graduation (on r0 if the clock allows, else on whatever round the
/// clock gives: drand silent for it), committed quicknet rounds posted (also after a backup started: ignored), the
/// graduation word, draws by EOAs, a contract, the EIP-7702 account and an ETH refuser with every bounty case, settles,
/// opens of draws and placeholders by drawers, holders and strangers, backup starts (the real mainnet header as the
/// parent's) and fixes (a synthetic post-London header served by BLOCKHASH or EIP-2935's history code), warps across
/// the 5-day, 5-day-18-hour, 7-day, 30-day and 3-day edges, terminal mode, cancels, takes by number, returns to the
/// shelf and named picks of it, and bounties. Every action's outcome is compared with an oracle of the documented rule
/// (`_violation` counts any mismatch); after every call the invariants check P6.1 (nothing held), P6.15 / X04 (slots,
/// pending tickets, minted − burned, distinct reserved numbers, each item delivered once), P6.9 / X13 (strict order,
/// items equal an independent replay), P6.14 / X11 (words from their round's rule, never changed), P6.12 / X12 (a dead
/// head opens terminal mode, a counting head settles), the vault's n + t and X01 / X02 at the boundary.
/// forge-config: default.evm_version = "osaka"
contract AuditU6ClaudeInvariants is AuditU6ClaudeBase {
    AuditU6ClaudeHandler internal handler;

    // ------------------------------------------------------------------------------------------------ ghosts
    uint256 public violations;
    string internal lastViolation;
    mapping(uint256 => bool) internal isCommitted;
    mapping(uint256 => bytes32) internal wordAtSettle;
    uint256 internal recordedUpTo;
    uint256[] internal delivered;
    uint256[] internal startedRounds;
    bool internal graduatedOnR0;
    /// @dev Placeholders burned by the handler's hand-backs and opens (the only burns), for minted − burned == live.
    uint256 internal burnedPlaceholders;
    /// @dev Handler calls in this run, and whether `afterInvariant` already summed this run (it may be called again
    /// on the same state; only a run with calls is counted, once).
    uint256 internal calls;
    bool internal reported;

    // coverage
    uint256 internal cTake;
    uint256 internal cHandBack;
    uint256 internal cGraduate;
    uint256 internal cSilentGraduation;
    uint256 internal cPost;
    uint256 internal cPostAfterStart;
    uint256 internal cAccept;
    uint256 internal cDraw;
    uint256 internal cDrawRefused;
    uint256 internal cSettled;
    uint256 internal cOpenDraw;
    uint256 internal cOpenDrawStranger;
    uint256 internal cOpenPlaceholder;
    uint256 internal cTransfer;
    uint256 internal cStart;
    uint256 internal cFix;
    uint256 internal cTerminal;
    uint256 internal cCancel;
    uint256 internal cByNumber;
    uint256 internal cReturn;
    uint256 internal cPick;
    uint256 internal cEdgeWarp;

    function setUp() public override {
        super.setUp();
        _toBonding();
        for (uint256 i; i < _boxDrandCount(); ++i) {
            isCommitted[_boxDrandAt(i).round] = true;
        }
        _giveT(eoa[1], address(ethRefuser), token.balanceOf(eoa[1]) / 3);
        handler = new AuditU6ClaudeHandler(this);
        bytes4[] memory s = new bytes4[](31);
        s[0] = AuditU6ClaudeHandler.take.selector;
        s[1] = AuditU6ClaudeHandler.handBack.selector;
        s[2] = AuditU6ClaudeHandler.graduate.selector;
        s[3] = AuditU6ClaudeHandler.post.selector;
        s[4] = AuditU6ClaudeHandler.post.selector;
        s[5] = AuditU6ClaudeHandler.accept.selector;
        s[6] = AuditU6ClaudeHandler.draw.selector;
        s[7] = AuditU6ClaudeHandler.draw.selector;
        s[8] = AuditU6ClaudeHandler.draw.selector;
        s[9] = AuditU6ClaudeHandler.settle.selector;
        s[10] = AuditU6ClaudeHandler.settle.selector;
        s[11] = AuditU6ClaudeHandler.openDraw.selector;
        s[12] = AuditU6ClaudeHandler.openDraw.selector;
        s[13] = AuditU6ClaudeHandler.openPlaceholder.selector;
        s[14] = AuditU6ClaudeHandler.transferPlaceholder.selector;
        s[15] = AuditU6ClaudeHandler.warp.selector;
        s[16] = AuditU6ClaudeHandler.warp.selector;
        s[17] = AuditU6ClaudeHandler.warp.selector;
        s[18] = AuditU6ClaudeHandler.startBackup.selector;
        s[19] = AuditU6ClaudeHandler.fixBackup.selector;
        s[20] = AuditU6ClaudeHandler.enterTerminal.selector;
        s[21] = AuditU6ClaudeHandler.cancel.selector;
        s[22] = AuditU6ClaudeHandler.takeByNumber.selector;
        s[23] = AuditU6ClaudeHandler.returnItem.selector;
        s[24] = AuditU6ClaudeHandler.pick.selector;
        s[25] = AuditU6ClaudeHandler.addBounty.selector;
        s[26] = AuditU6ClaudeHandler.graduate.selector;
        s[27] = AuditU6ClaudeHandler.backupCycle.selector;
        s[28] = AuditU6ClaudeHandler.postAll.selector;
        s[29] = AuditU6ClaudeHandler.drawMany.selector;
        s[30] = AuditU6ClaudeHandler.backupCycle.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
        targetContract(address(handler));
    }

    modifier onlyHandler() {
        require(msg.sender == address(handler), "handler only");
        ++calls;
        _;
    }

    modifier onlySelf() {
        require(msg.sender == address(this), "self only");
        _;
    }

    function _violation(string memory why) internal {
        ++violations;
        lastViolation = why;
        console.log("U6 violation:", why);
    }

    // ================================================================================================ oracles

    struct Head {
        bool exists;
        uint256 key;
        uint256 since;
        uint256 deadline;
        bool requested;
        bool usable;
        bool dead;
    }

    /// @dev The queue head by the documented rule (IBoxTickets.sol:18-21; BoxTickets.sol:42-44), from public views.
    function _head() internal view returns (Head memory h) {
        IBoxTickets.TicketState memory s = tickets.status();
        uint256 gate = vault.gateOpenedAt();
        if (gate == 0 || s.terminalAt != 0) return h;
        h.requested = true;
        if (s.slots != 0 && s.wordAcceptedAt == 0) {
            h.exists = true;
            h.requested = s.wordRequestedAt != 0;
            h.since = s.wordRequestedAt;
            h.deadline = h.requested ? h.since + 7 days : gate + 30 days;
        } else {
            if (s.drawsSettled == s.drawsRequested) return h;
            h.exists = true;
            h.key = uint256(s.drawsSettled) + 1;
            h.since = tickets.drawTicket(h.key).requestedAt;
            h.deadline = h.since + 7 days;
        }
        if (h.requested) h.usable = _usable(h.key, h.since);
        h.dead = vm.getBlockTimestamp() > h.deadline && !h.usable;
    }

    function _usable(uint256 key, uint256 since) internal view returns (bool) {
        (bytes32 w, uint64 readyAt) = src.wordOf(a.tickets, key);
        return w != bytes32(0) && readyAt >= since && readyAt <= vm.getBlockTimestamp() && readyAt <= since + 7 days;
    }

    /// @dev How many draws settle(k) settles now by the rule: from the head, in order, while their words count.
    function _settleable(uint256 k) internal view returns (uint256 count) {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt != 0 || vault.gateOpenedAt() == 0) return 0;
        if (s.slots != 0 && s.wordAcceptedAt == 0) return 0;
        for (uint256 id = uint256(s.drawsSettled) + 1; id <= s.drawsRequested && count < k; ++id) {
            if (!_usable(id, tickets.drawTicket(id).requestedAt)) break;
            ++count;
        }
    }

    function _recordWords() internal {
        uint256 settled = tickets.status().drawsSettled;
        for (uint256 k = recordedUpTo + 1; k <= settled; ++k) {
            (bytes32 w,) = src.wordOf(a.tickets, k);
            wordAtSettle[k] = w;
        }
        recordedUpTo = settled;
    }

    function _drawers(uint256 seed) internal view returns (address) {
        address[6] memory d = [eoa[3], eoa[4], eoa[5], eoa7702, address(contractDrawer), address(ethRefuser)];
        return d[seed % 6];
    }

    function _holders(uint256 seed) internal view returns (address) {
        address[4] memory h = [eoa[0], eoa[1], eoa[3], eoa[4]];
        return h[seed % 4];
    }

    function _isContract(address x) internal view returns (bool) {
        return x.code.length != 0 && !(x.code.length == 23 && bytes3(x.code) == bytes3(hex"ef0100"));
    }

    // ================================================================================================ actions

    function h_take(uint256 whoSeed, uint256 kSeed) external onlyHandler {
        if (vault.gateOpenedAt() != 0 || hook.closed()) return;
        address who = _holders(whoSeed);
        uint256 k = 1 + kSeed % 3;
        try vault.quoteTake(k) returns (uint256 p, uint256 f) {
            if (token.balanceOf(who) < p + f) return;
        } catch {
            return;
        }
        try this.x_take(who, k) {
            ++cTake;
        } catch {
            _violation("take refused on the curve");
        }
    }

    function x_take(address who, uint256 k) external onlySelf {
        _take(who, k);
    }

    function h_handBack(uint256, uint256 idSeed) external onlyHandler {
        (uint256[] memory ids,) = _livePlaceholders();
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        address owner = tickets.ownerOf(id);
        IBoxTickets.TicketState memory s = tickets.status();
        bool curve = vault.gateOpenedAt() == 0;
        bool allowed = curve || (s.terminalAt != 0 && s.wordAcceptedAt == 0);
        uint256[] memory one = new uint256[](1);
        one[0] = id;
        try this.x_handBack(owner, one) {
            ++cHandBack;
            ++burnedPlaceholders;
            if (!allowed) _violation("a hand-back passed outside the curve and number-less terminal mode");
        } catch (bytes memory err) {
            if (allowed) {
                _violation("a hand-back was refused where the rules allow it");
            } else if (keccak256(err) != keccak256(abi.encodeWithSelector(IBoxTickets.HandBackClosed.selector))) {
                _violation("a hand-back refused with the wrong error");
            }
        }
    }

    function x_handBack(address who, uint256[] memory ids) external onlySelf {
        _handBack(who, ids);
    }

    function h_graduate() external onlyHandler {
        if (vault.gateOpenedAt() != 0) return;
        try this.x_graduateOnR0() {
            ++cGraduate;
            graduatedOnR0 = true;
        } catch {
            try this.x_graduateNow() {
                ++cGraduate;
                ++cSilentGraduation;
            } catch {
                _violation("graduation failed after the close");
            }
        }
    }

    function x_graduateOnR0() external onlySelf {
        _toGraduated();
    }

    function x_graduateNow() external onlySelf {
        _toClosed();
        (graduationReward, graduationPokeFailures) = _graduate(keeper);
        reached = AuditPhase.Graduated;
    }

    /// @dev The round of key `key` if it is requested and unanswered (0 otherwise).
    function _pendingRound(uint256 key) internal view returns (uint256) {
        (uint64 requestedAt, uint64 round) = src.requestOf(a.tickets, key);
        if (requestedAt == 0) return 0;
        return round;
    }

    function _pickPendingRound(uint256 seed) internal view returns (uint256 round) {
        IBoxTickets.TicketState memory s = tickets.status();
        uint256 open = s.drawsRequested - s.drawsSettled;
        uint256 options = open + (s.wordAcceptedAt == 0 ? 1 : 0);
        if (options == 0) return 0;
        uint256 pick_ = seed % options;
        if (s.wordAcceptedAt == 0) {
            if (pick_ == 0) return _pendingRound(0);
            --pick_;
        }
        return _pendingRound(uint256(s.drawsSettled) + 1 + pick_);
    }

    function h_post(uint256 seed) external onlyHandler {
        uint256 round = _pickPendingRound(seed);
        if (round == 0 || !isCommitted[round]) return;
        (, uint64 postedAt) = drand.beaconOf(round);
        if (postedAt != 0 || vm.getBlockTimestamp() < src.roundTime(round)) return;
        (uint64 startedAt,,,) = src.backupOf(round);
        try this.x_post(round) {
            ++cPost;
            if (startedAt != 0) ++cPostAfterStart;
        } catch {
            _violation("a valid post was refused");
        }
    }

    function x_post(uint256 round) external onlySelf {
        _post(round);
    }

    function h_accept() external onlyHandler {
        IBoxTickets.TicketState memory s = tickets.status();
        bool want = vault.gateOpenedAt() != 0 && s.wordAcceptedAt == 0 && s.terminalAt == 0 && s.wordRequestedAt != 0
            && _usable(0, s.wordRequestedAt);
        try tickets.acceptGraduationWord() {
            ++cAccept;
            if (!want) _violation("the word was accepted against the rule");
        } catch {
            if (want) _violation("a usable word was refused");
        }
    }

    struct DrawCase {
        address who;
        uint256 round;
        uint256 pot0;
        uint256 shortfall;
        uint256 value;
        uint256 e0;
        uint256 nextId;
        bool want;
    }

    function h_draw(uint256 whoSeed, uint256 valueSeed) external onlyHandler {
        _drawCase(whoSeed, valueSeed);
    }

    function _drawCase(uint256 whoSeed, uint256 valueSeed) internal {
        DrawCase memory c;
        c.who = _drawers(whoSeed);
        IBoxTickets.TicketState memory s = tickets.status();
        c.round = _roundNow();
        c.pot0 = drand.bountyOf(c.round);
        uint256 target = _target();
        c.shortfall = c.pot0 < target ? target - c.pot0 : 0;
        uint256 mode = valueSeed % 4;
        if (mode == 0) c.value = c.shortfall;
        else if (mode == 1) c.value = target;
        else if (mode == 2) c.value = 2 * target + 1;
        else c.value = c.shortfall == 0 ? 0 : c.shortfall - 1;
        try vault.quoteTake(1) returns (uint256 p, uint256 f) {
            if (token.balanceOf(c.who) < p + f) return;
        } catch {
            return; // no hidden item or the last one: the vault's rule (U7), not exercised here
        }
        bool sendWord = s.slots != 0 && s.wordRequestedAt == 0;
        Head memory h = _head();
        c.want = vault.gateOpenedAt() != 0 && s.terminalAt == 0 && (sendWord || !(h.exists && h.dead))
            && c.pot0 + c.value >= target;
        c.e0 = c.who.balance;
        c.nextId = uint256(s.drawsRequested) + 1;
        try this.x_draw(c.who, c.value) returns (uint256 id) {
            _checkDraw(c, id);
        } catch (bytes memory err) {
            ++cDrawRefused;
            if (c.want) {
                _violation("a draw the rules allow was refused");
                console.logBytes(err);
            }
        }
    }

    function _checkDraw(DrawCase memory c, uint256 id) internal {
        ++cDraw;
        if (!c.want) _violation("a draw passed against the rule");
        uint256 rest = c.value - c.shortfall;
        uint256 paid = rest != 0 && c.who == address(ethRefuser) ? c.value : c.shortfall;
        if (drand.bountyOf(c.round) != c.pot0 + paid) _violation("the pot is not max(pot, target) (+ a refused rest)");
        if (c.who.balance != c.e0 + c.value - paid) _violation("the drawer did not get exactly its rest back");
        if (id != c.nextId) _violation("ticket ids are not consecutive");
    }

    function x_draw(address who, uint256 value) external onlySelf returns (uint256) {
        return _draw(who, value);
    }

    function h_settle(uint256 kSeed) external onlyHandler {
        uint256 k = 1 + kSeed % 4;
        uint256 want = _settleable(k);
        try this.x_settle(k) returns (uint256 n) {
            cSettled += n;
            if (n != want) _violation("settle settled another count than the rule");
            _recordWords();
        } catch {
            if (want != 0) _violation("settle refused while the head's word counts");
        }
    }

    function x_settle(uint256 k) external onlySelf returns (uint256) {
        return _settle(eoa[7], k);
    }

    function h_openDraw(uint256 ticketSeed, uint256 modeSeed) external onlyHandler {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.drawsRequested == 0) return;
        uint256 ticket = 1 + ticketSeed % s.drawsRequested;
        IBoxTickets.DrawView memory d = tickets.drawTicket(ticket);
        uint256 mode = modeSeed % 4;
        bool willSettle = d.status == DrawStatus.Requested && ticket > s.drawsSettled
            && _settleable(type(uint256).max) >= ticket - s.drawsSettled;
        bool settledAlready = d.status == DrawStatus.Settled;
        uint256 item;
        uint256 graceAt;
        if (settledAlready) {
            (item, graceAt) = (d.itemId, d.revealFallbackAt);
        } else if (willSettle) {
            item = _replayItems(ticket)[ticket];
            uint256 hoursTaken = (vm.getBlockTimestamp() - d.requestedAt + 1 hours - 1) / 1 hours;
            if (hoursTaken > type(uint16).max) hoursTaken = type(uint16).max;
            graceAt = d.requestedAt + hoursTaken * 1 hours + 30 days;
        }
        address caller = mode == 2 ? eoa[6] : d.drawer;
        address to = mode == 1 ? eoa[2] : caller;
        bool withReveal = mode != 3;
        bool want = (settledAlready || willSettle)
            && (mode != 2 || !_isContract(d.drawer) || vm.getBlockTimestamp() >= graceAt)
            && (withReveal || vm.getBlockTimestamp() >= graceAt);
        address recipient = mode == 2 ? d.drawer : to;
        ItemReveal memory r;
        if (withReveal && item != 0) r = _reveal(item);
        try this.x_openDraw(caller, ticket, to, r) {
            ++cOpenDraw;
            if (mode == 2) ++cOpenDrawStranger;
            if (!want) _violation("a draw opened against the rule");
            if (collection.ownerOf(item) != recipient) {
                _violation("the item went to an address the rule does not name");
            }
            if (tickets.ticketInFlight() != 0) _violation("a ticket stayed in flight");
            delivered.push(item);
            _recordWords();
        } catch {
            if (want) _violation("an open the rules allow was refused");
        }
    }

    function x_openDraw(address caller, uint256 ticket, address to, ItemReveal memory r) external onlySelf {
        vm.prank(caller);
        tickets.openDraw(ticket, to, r);
    }

    function h_openPlaceholder(uint256 idSeed, uint256 modeSeed) external onlyHandler {
        (uint256[] memory ids,) = _livePlaceholders();
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        address owner = tickets.ownerOf(id);
        IBoxTickets.TicketState memory s = tickets.status();
        bool withReveal = modeSeed % 3 != 0;
        bool want = s.wordAcceptedAt != 0
            && (withReveal || vm.getBlockTimestamp() >= uint256(s.wordAcceptedAt) + tickets.REVEAL_GRACE());
        uint256 item = s.wordAcceptedAt != 0 ? tickets.numberOf(id) : 0;
        ItemReveal memory r;
        if (withReveal && item != 0) r = _reveal(item);
        try this.x_open(owner, id, r) {
            ++cOpenPlaceholder;
            ++burnedPlaceholders;
            if (!want) _violation("a placeholder opened against the rule");
            if (collection.ownerOf(item) != owner) _violation("a placeholder's item missed its holder");
            delivered.push(item);
        } catch {
            if (want) _violation("a placeholder open the rules allow was refused");
        }
    }

    function x_open(address who, uint256 id, ItemReveal memory r) external onlySelf {
        vm.prank(who);
        tickets.open(id, r);
    }

    function h_transferPlaceholder(uint256 idSeed, uint256 toSeed) external onlyHandler {
        (uint256[] memory ids,) = _livePlaceholders();
        if (ids.length == 0) return;
        uint256 id = ids[idSeed % ids.length];
        address from = tickets.ownerOf(id);
        address to = _holders(toSeed);
        IBoxTickets.TicketState memory s = tickets.status();
        bool frozen = vault.gateOpenedAt() != 0 && s.terminalAt == 0 && s.wordAcceptedAt == 0;
        vm.prank(from);
        try tickets.transferFrom(from, to, id) {
            ++cTransfer;
            if (frozen) _violation("a placeholder moved while frozen");
        } catch (bytes memory err) {
            if (!frozen) {
                _violation("a placeholder transfer was refused outside the freeze");
            } else if (keccak256(err) != keccak256(abi.encodeWithSelector(IBoxTickets.Frozen.selector))) {
                _violation("a frozen transfer refused with the wrong error");
            }
        }
    }

    function h_warp(uint256 seed) external onlyHandler {
        uint256 mode = seed % 16;
        uint256 now_ = vm.getBlockTimestamp();
        // Before graduation a jump of hours or days is kept one time in four (so most runs graduate on r0, some late).
        if (vault.gateOpenedAt() == 0 && mode >= 9 && (seed >> 40) % 4 != 0) mode = 0;
        uint256 off = (seed >> 8) % 3; // -1, 0, +1 around an edge
        if (mode <= 6) {
            _advance(1);
        } else if (mode == 7) {
            _advance(3);
        } else if (mode == 8) {
            _advance(src.TARGET_BLOCKS() + 1);
        } else if (mode == 9) {
            _warpTo(now_ + 1 hours);
        } else if (mode == 10) {
            _warpTo(now_ + 1 days);
        } else if (mode == 11) {
            _warpTo(now_ + 3 days);
        } else {
            uint256 edge;
            Head memory h = _head();
            uint256 round = _pickPendingRound(seed >> 16);
            if (mode == 12 && h.exists) {
                edge = h.deadline;
            } else if (mode == 13 && round != 0) {
                edge = src.roundTime(round) + src.BACKUP_AFTER();
            } else if (mode == 14 && round != 0) {
                edge = src.roundTime(round) + src.LATEST_START();
            } else if (mode == 15) {
                IBoxTickets.TicketState memory s = tickets.status();
                if (s.terminalAt != 0) edge = uint256(s.terminalAt) + tickets.TAKE_DELAY();
                else if (s.wordAcceptedAt != 0) edge = uint256(s.wordAcceptedAt) + tickets.REVEAL_GRACE();
                else if (vault.gateOpenedAt() != 0) edge = vault.gateOpenedAt() + tickets.SILENCE_UNREQUESTED();
            }
            if (edge == 0) {
                _advance(1);
                return;
            }
            edge = edge + off;
            if (edge >= 1) edge -= 1;
            if (edge > now_) {
                _warpTo(edge);
                ++cEdgeWarp;
            } else {
                _advance(1);
            }
        }
    }

    function h_startBackup(uint256 seed) external onlyHandler {
        uint256 round = _pickPendingRound(seed);
        if (round == 0) return;
        uint256 rt = src.roundTime(round);
        uint256 now_ = vm.getBlockTimestamp();
        (uint64 startedAt,,,) = src.backupOf(round);
        (, uint64 postedAt) = drand.beaconOf(round);
        bool want = now_ > rt + src.BACKUP_AFTER() && now_ <= rt + src.LATEST_START() && startedAt == 0 && postedAt == 0;
        try this.x_startBackup(round) {
            ++cStart;
            startedRounds.push(round);
            if (!want) _violation("a backup started against the rule");
        } catch {
            if (want) _violation("a backup start the rule allows was refused");
        }
    }

    function x_startBackup(uint256 round) external onlySelf {
        _startBackup(round, eoa[6]);
    }

    function h_fixBackup(uint256 seed, uint256 mixSeed) external onlyHandler {
        if (startedRounds.length == 0) return;
        uint256 round = startedRounds[seed % startedRounds.length];
        (, uint64 target, uint64 fixedAt,) = src.backupOf(round);
        uint256 bn = vm.getBlockNumber();
        bool want = fixedAt == 0 && target < bn && bn - target <= 8_191;
        try this.x_fixBackup(round, keccak256(abi.encode("u6.mix", mixSeed))) {
            ++cFix;
            if (!want) _violation("a backup fixed against the rule");
        } catch {
            if (want) _violation("a backup fix the rule allows was refused");
        }
    }

    function x_fixBackup(uint256 round, bytes32 mix) external onlySelf {
        _fixBackup(round, mix, poster);
    }

    function h_enterTerminal() external onlyHandler {
        Head memory h = _head();
        bool want = h.exists && h.dead;
        vm.prank(eoa[5]);
        try tickets.enterTerminal() {
            ++cTerminal;
            if (!want) _violation("terminal mode entered against the rule");
        } catch {
            if (want) _violation("a dead head did not let anyone enter terminal mode");
        }
    }

    function h_cancel(uint256 seed) external onlyHandler {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.drawsRequested == 0) return;
        uint256 ticket = 1 + seed % s.drawsRequested;
        IBoxTickets.DrawView memory d = tickets.drawTicket(ticket);
        bool want = s.terminalAt != 0 && d.status == DrawStatus.Requested;
        uint256 quote;
        if (want) quote = vault.quoteReturn(1);
        uint256 t0 = token.balanceOf(d.drawer);
        try this.x_cancel(ticket) returns (uint256 principal) {
            ++cCancel;
            if (!want) _violation("a draw cancelled against the rule");
            if (principal != quote || token.balanceOf(d.drawer) != t0 + quote) {
                _violation("a cancel did not pay the drawer exactly the current principal");
            }
        } catch {
            if (want) _violation("a cancel the rule allows was refused");
        }
    }

    function x_cancel(uint256 ticket) external onlySelf returns (uint256) {
        return _cancelDraw(eoa[2], ticket);
    }

    function h_takeByNumber(uint256 seed, uint256 revealSeed) external onlyHandler {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt == 0 || vm.getBlockTimestamp() < uint256(s.terminalAt) + tickets.TAKE_DELAY()) return;
        bool numbered = s.slots == 0 || s.wordAcceptedAt != 0;
        uint256 n = editionSize;
        uint256 item;
        uint256 index;
        if (numbered) {
            uint256 left = n - s.slots - s.drawsSettled;
            if (left == 0) return;
            index = seed % left;
            uint256 position = tickets.poolPositionAt(index);
            (uint256 u, uint256 v) = BoxShuffle.halves(n);
            item = tickets.firstId()
                + (s.slots == 0 ? position : BoxShuffle.permute(tickets.graduationWord(), position, n, u, v));
        } else {
            item = 1 + seed % n;
        }
        if (!vault.isHidden(item)) return;
        try vault.quoteTake(1) returns (uint256 p, uint256 f) {
            if (token.balanceOf(eoa[4]) < p + f) return;
        } catch {
            return;
        }
        try this.x_takeByNumber(item, index, revealSeed % 2 == 0) {
            ++cByNumber;
            delivered.push(item);
            if (collection.ownerOf(item) != eoa[4]) _violation("a take by number missed its taker");
        } catch {
            _violation("a take by number of a free pool item was refused");
        }
    }

    function x_takeByNumber(uint256 item, uint256 index, bool withReveal) external onlySelf {
        _takeByNumber(eoa[4], item, index, withReveal);
    }

    function h_returnItem(uint256 seed) external onlyHandler {
        if (delivered.length == 0) return;
        uint256 item = delivered[seed % delivered.length];
        address owner = collection.ownerOf(item);
        if (owner == a.vault) return;
        bool returnable = collection.isRevealed(item)
            || (tickets.returnableFrom(item) != 0 && vm.getBlockTimestamp() >= tickets.returnableFrom(item));
        if (!returnable) return;
        try this.x_return(owner, item) {
            ++cReturn;
        } catch {
            _violation("a return of an outside revealed item was refused");
        }
    }

    function x_return(address who, uint256 item) external onlySelf {
        _returnItem(who, item);
    }

    function h_pick(uint256 seed) external onlyHandler {
        if (delivered.length == 0) return;
        uint256 item = delivered[seed % delivered.length];
        if (!vault.isOnShelf(item) || !collection.isRevealed(item)) return;
        if (vault.inside() <= 1) return;
        try vault.quoteWithdraw(1) returns (uint256 p) {
            if (token.balanceOf(eoa[2]) < p + p / 4 + 1) return;
        } catch {
            return;
        }
        try this.x_pick(item) {
            ++cPick;
        } catch {
            _violation("a named pick of a revealed shelf item was refused");
        }
    }

    function x_pick(uint256 item) external onlySelf {
        _pick(eoa[2], item);
    }

    function h_addBounty(uint256 seed) external onlyHandler {
        uint256 round = _roundNow();
        (, uint64 postedAt) = drand.beaconOf(round);
        if (postedAt != 0) return;
        try this.x_addBounty(round, (seed % 1_000) * 1 gwei) {}
        catch {
            _violation("a bounty was refused");
        }
    }

    function x_addBounty(uint256 round, uint256 value) external onlySelf {
        _addBounty(eoa[2], round, value, round % 2 == 0);
    }

    /// @dev A pending round's whole backup in one action: to its first start second if earlier, start, 257 blocks,
    /// fix (each step checked by its own oracle in h_startBackup / h_fixBackup's terms).
    function h_backupCycle(uint256 seed, uint256 mixSeed) external onlyHandler {
        uint256 round = _pickPendingRound(seed);
        if (round == 0) return;
        (uint64 startedAt,,,) = src.backupOf(round);
        (, uint64 postedAt) = drand.beaconOf(round);
        if (startedAt != 0 || postedAt != 0) return;
        uint256 rt = src.roundTime(round);
        uint256 first = rt + src.BACKUP_AFTER() + 1;
        if (vm.getBlockTimestamp() < first) {
            _warpTo(first + (seed >> 64) % 18 hours);
            ++cEdgeWarp;
        }
        if (vm.getBlockTimestamp() > rt + src.LATEST_START()) return;
        try this.x_startBackup(round) {
            ++cStart;
            startedRounds.push(round);
        } catch {
            _violation("a backup start inside its window was refused");
            return;
        }
        _advance(src.TARGET_BLOCKS() + 1 + (seed >> 128) % 300);
        try this.x_fixBackup(round, keccak256(abi.encode("u6.mix", mixSeed))) {
            ++cFix;
        } catch {
            _violation("a backup fix inside its window was refused");
        }
    }

    /// @dev Every committed, due, unposted round a pending key waits on, posted.
    function h_postAll() external onlyHandler {
        IBoxTickets.TicketState memory s = tickets.status();
        for (uint256 key = (s.wordAcceptedAt == 0 ? 0 : uint256(s.drawsSettled) + 1); key <= s.drawsRequested; ++key) {
            if (key == 0 && s.wordRequestedAt == 0) continue;
            uint256 round = _pendingRound(key);
            if (round == 0 || !isCommitted[round] || vm.getBlockTimestamp() < src.roundTime(round)) continue;
            (, uint64 postedAt) = drand.beaconOf(round);
            if (postedAt != 0) continue;
            (uint64 startedAt,,,) = src.backupOf(round);
            try this.x_post(round) {
                ++cPost;
                if (startedAt != 0) ++cPostAfterStart;
            } catch {
                _violation("a valid post was refused");
            }
            if (key == 0 && s.drawsRequested == 0) break;
        }
    }

    /// @dev Two to four draws in this block (one round), by different drawers.
    function h_drawMany(uint256 seed, uint256 valueSeed) external onlyHandler {
        uint256 k = 2 + seed % 3;
        for (uint256 i; i < k; ++i) {
            this.h_drawSelf(uint256(keccak256(abi.encode(seed, i))), valueSeed >> (8 * i));
        }
    }

    function h_drawSelf(uint256 whoSeed, uint256 valueSeed) external {
        require(msg.sender == address(this) || msg.sender == address(handler), "self only");
        _drawCase(whoSeed, valueSeed);
    }

    // ================================================================================================ invariants

    /// P6.1: nothing stays in the tickets contract after any call (`BoxTickets.sol:47-52`).
    function invariant_AUDIT_U6_ticketsHoldNothing() public view {
        _assertTicketsHoldNothing();
    }

    /// P6.15: distinct slots below q on the curve, q == live there; pending tickets == live placeholders + open draws.
    function invariant_AUDIT_U6_slotsAndPending() public view {
        _assertSlotsAndTickets();
    }

    /// P6.15: a number goes to at most one placeholder or draw: the live placeholders' numbers (word stored) and the
    /// settled, unopened draws' items are all distinct, all hidden in the vault, the placeholders' outside the pool.
    function invariant_AUDIT_U6_numbersDistinctAndHidden() public view {
        IBoxTickets.TicketState memory s = tickets.status();
        (uint256[] memory ids,) = _livePlaceholders();
        uint256 settled = s.drawsSettled;
        uint256[] memory items = new uint256[](ids.length + settled);
        uint256 m;
        if (s.wordAcceptedAt != 0) {
            for (uint256 i; i < ids.length; ++i) {
                items[m++] = tickets.numberOf(ids[i]);
            }
        }
        for (uint256 k = 1; k <= settled; ++k) {
            IBoxTickets.DrawView memory d = tickets.drawTicket(k);
            if (d.status == DrawStatus.Settled) items[m++] = d.itemId;
        }
        for (uint256 i; i < m; ++i) {
            assertTrue(vault.isHidden(items[i]), "a reserved item waits hidden in the vault");
            for (uint256 j; j < i; ++j) {
                assertTrue(items[i] != items[j], "one number, one ticket");
            }
        }
    }

    /// P6.9: strict request order: every ticket up to drawsSettled is settled, opened (or cancelled never), every later
    /// one requested or (terminal mode only) cancelled.
    function invariant_AUDIT_U6_strictOrder() public view {
        IBoxTickets.TicketState memory s = tickets.status();
        for (uint256 k = 1; k <= s.drawsRequested; ++k) {
            DrawStatus st = tickets.drawTicket(k).status;
            if (k <= s.drawsSettled) {
                assertTrue(st == DrawStatus.Settled || st == DrawStatus.Opened, "settled in order");
            } else {
                assertTrue(st == DrawStatus.Requested || st == DrawStatus.Cancelled, "nothing settled out of order");
                if (st == DrawStatus.Cancelled) assertGt(s.terminalAt, 0, "cancels only in terminal mode");
            }
        }
    }

    /// P6.9 / P6.14: every settled draw's item is the oracle's from its word, its position and pi_w; the word each was
    /// settled with is still the source's (a drand post after a backup start changed nothing).
    function invariant_AUDIT_U6_itemsAreTheOraclesAndWordsStay() public view {
        if (tickets.status().drawsSettled == 0) return;
        _assertItemsMatchOracle();
        for (uint256 k = 1; k <= recordedUpTo; ++k) {
            (bytes32 w,) = src.wordOf(a.tickets, k);
            assertEq(w, wordAtSettle[k], "a settled draw's word never changes");
        }
    }

    /// P6.14 / F143 in random sequences: every stored word is the backup's when its round's backup started (a drand
    /// post after the start is ignored for good), else drand's, domain-separated per (tickets, key); the graduation
    /// word too.
    function invariant_AUDIT_U6_wordsFromTheirRulesSource() public view {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.wordAcceptedAt != 0) assertEq(tickets.graduationWord(), _expectedWord(0), "the graduation word");
        for (uint256 k = 1; k <= s.drawsSettled; ++k) {
            (bytes32 w,) = src.wordOf(a.tickets, k);
            assertEq(w, _expectedWord(k), "a settled draw's word comes from its round's rule");
        }
    }

    function _expectedWord(uint256 key) internal view returns (bytes32) {
        (, uint64 round) = src.requestOf(a.tickets, key);
        (uint64 startedAt,,, bytes32 mix) = src.backupOf(round);
        if (startedAt != 0) return _word(src.BACKUP_TAG(), mix, key);
        (bytes32 randomness,) = drand.beaconOf(round);
        return _word(src.DRAND_TAG(), randomness, key);
    }

    /// P6.15 / X04: minted − burned == live placeholders, and the holders' balances sum to the live count.
    function invariant_AUDIT_U6_mintedMinusBurnedIsLive() public view {
        (uint256[] memory ids,) = _livePlaceholders();
        assertEq(uint256(tickets.status().minted) - burnedPlaceholders, ids.length, "minted - burned == live");
        uint256 balances;
        for (uint256 i; i < 4; ++i) {
            balances += tickets.balanceOf(_holders(i));
        }
        assertEq(balances, ids.length, "the holders' balances sum to the live placeholders");
    }

    /// X03 / X19 on the tickets' side: an item is delivered by the tickets at most once (opens, draw opens, takes by
    /// number), and every delivered item has left the vault for good (never hidden again).
    function invariant_AUDIT_U6_eachItemDeliveredOnce() public view {
        for (uint256 i; i < delivered.length; ++i) {
            assertTrue(vault.hasLeftVault(delivered[i]), "a delivered item has left the vault");
            assertFalse(vault.isHidden(delivered[i]), "and is never hidden again");
            for (uint256 j; j < i; ++j) {
                assertTrue(delivered[i] != delivered[j], "delivered once");
            }
        }
    }

    /// X01/X02 at the boundary: every wei and T unit booked by the world's helpers.
    function invariant_AUDIT_U6_ghostLedger() public view {
        _assertGhostLedger();
    }

    /// The vault holds n + t items (VLT-08's count; the tickets' side of it).
    function invariant_AUDIT_U6_vaultHoldsInsidePlusTickets() public view {
        assertEq(collection.balanceOf(a.vault), vault.inside() + vault.pendingTickets(), "n + t in the vault");
        assertEq(vault.inside(), vault.hiddenCount() + vault.shelfCount());
    }

    /// P6.12: never stuck: a dead head always lets anyone enter terminal mode, and a counting word at the head of a live
    /// queue always lets anyone settle (each checked by a call that is then rolled back).
    function invariant_AUDIT_U6_neverStuck() public {
        Head memory h = _head();
        if (h.exists && h.dead) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = a.tickets.call(abi.encodeCall(tickets.enterTerminal, ()));
            vm.revertToState(snap);
            assertTrue(ok, "a dead head: terminal mode is open to anyone");
        }
        if (_settleable(1) == 1) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = a.tickets.call(abi.encodeCall(tickets.settle, (1)));
            vm.revertToState(snap);
            assertTrue(ok, "a counting word at the head: anyone settles");
        }
    }

    /// Every action matched its oracle.
    function invariant_AUDIT_U6_everyOutcomeAsTheRules() public view {
        assertEq(violations, 0, lastViolation);
    }

    /// @dev Coverage summed over the campaign's runs (each run starts from setUp's state, so the counters are per run;
    /// the sums ride in the process environment, which survives the runs). The last line of the log is the total.
    function _sum(string memory key, uint256 add) internal returns (uint256 total) {
        string memory k = string.concat(key, "_", vm.getEvmVersion()); // one sum per EVM (the variants run together)
        total = vm.envOr(k, uint256(0)) + add;
        vm.setEnv(k, vm.toString(total));
    }

    function afterInvariant() external {
        if (reported || calls == 0) return;
        reported = true;
        // forge 1.8.3 calls afterInvariant after every run and again for a few replays at the campaign's end, so the
        // sums below are a reach indicator (slightly above the runs' own totals), not exact per-run counts.
        console.log("afterInvariant calls with handler calls", _sum("U6C_RUNS", 1));
        console.log("graduations on r0", _sum("U6C_GRAD_R0", graduatedOnR0 ? 1 : 0));
        console.log("silent graduations", _sum("U6C_GRAD_SILENT", cSilentGraduation));
        console.log("takes", _sum("U6C_TAKE", cTake), "hand-backs", _sum("U6C_HANDBACK", cHandBack));
        console.log("posts", _sum("U6C_POST", cPost), "after a start", _sum("U6C_POST_AFTER", cPostAfterStart));
        console.log("accepts", _sum("U6C_ACCEPT", cAccept), "draws", _sum("U6C_DRAW", cDraw));
        console.log("draws refused", _sum("U6C_DRAW_REFUSED", cDrawRefused), "settled", _sum("U6C_SETTLED", cSettled));
        console.log(
            "draw opens", _sum("U6C_OPEN_DRAW", cOpenDraw), "by strangers", _sum("U6C_OPEN_STR", cOpenDrawStranger)
        );
        console.log(
            "placeholder opens", _sum("U6C_OPEN_PH", cOpenPlaceholder), "transfers", _sum("U6C_TRANSFER", cTransfer)
        );
        console.log("backup starts", _sum("U6C_START", cStart), "fixes", _sum("U6C_FIX", cFix));
        console.log("terminal", _sum("U6C_TERMINAL", cTerminal), "cancels", _sum("U6C_CANCEL", cCancel));
        console.log("takes by number", _sum("U6C_BYNUMBER", cByNumber), "returns", _sum("U6C_RETURN", cReturn));
        console.log("picks", _sum("U6C_PICK", cPick), "edge warps", _sum("U6C_EDGE", cEdgeWarp));
    }
}

/// The same campaign under Amsterdam (Glamsterdam's repricing: the 50,000-gas word read, the observers' caps, the
/// backup's headers and EIP-2935 reads are fork-sensitive).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU6ClaudeAmsterdamInvariants is AuditU6ClaudeInvariants {}
