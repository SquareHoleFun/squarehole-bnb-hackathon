// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU6FableBase} from "./AuditU6FableBase.sol";

/// @notice SH-AUDIT-B0 U6 (Fable): the invariant campaign of box 0's tickets, placeholders and draws on the factory's
/// box 0 with the real BoxBackedSource and DrandSource (map gap 4: the tree's campaign runs on a mock). The test
/// contract is its own handler (`targetSelector` on its `act_` functions): every action is fail-safe (a refused call
/// is recorded, never a revert; `fail_on_revert` stays on) and books the ghost ledger exactly as the world's helpers
/// do. Actions: takes, hand-backs, transfers and approvals (operator moves checked against the era rule), the close
/// and graduation (with and without the word's poke failing), the word's request and acceptance, draws (every actor,
/// the ETH refuser, the gas burner and the EIP-7702 EOA included, with values from 0 to the pot), settles, opens and
/// draw opens (drawer and strangers), terminal entry, cancels, takes by number, committed-round posts (early and
/// late), backup starts and fixes, bounties and withdrawals, T buys, and warps of 12 s, 1 h, 1 d, to the next
/// committed round, to the backup's start window (5 d + 1 s) and its latest second (5 d 18 h), to the first fixable
/// block, to the head's deadline (−0 s and +1 s), to 30 d + 1 s after graduation, to TAKE_DELAY and 8,192 blocks.
/// Invariants (after every call): X04 and IBoxTickets' invariants (pending == live + open draws, slots distinct
/// below q, minted − burned == live, nothing stays), the draw order and item rules (settled strictly in order, an
/// item fixed once and never twice delivered, never a placeholder's number, hidden until opened), the ghost ledger
/// (X01/X02 at the boundary), the vault's solvency (VLT-08), and the rule ghosts: terminal entry only when the
/// reference head rule says dead, `QueueDead` exactly when it says dead, operator moves exactly per the era rule, a
/// settled draw's word never changing and equal to the backup's once a backup was fixed for its round.
abstract contract AuditU6FableCampaign is StdInvariant, AuditU6FableBase {
    uint256 internal constant ACTORS = 10;

    // ------------------------------------------------------------------ ghosts (what must never happen: stay 0)
    uint256 public badTerminal;
    uint256 public badDrawGate;
    uint256 public badOperatorMove;
    uint256 public doubleDelivery;
    uint256 public itemChanged;
    uint256 public wordChanged;
    uint256 public settledOutOfOrder;
    uint256 public cancelledOutsideTerminal;
    bytes public lastUnexpected;

    // ------------------------------------------------------------------ ghosts (state the invariants compare)
    uint256 public burned;
    uint256 public drawsOpened;
    uint256 public drawsCancelled;
    uint256 public lastSettled;
    mapping(uint256 => uint256) public itemOfDraw;
    mapping(uint256 => bytes32) public wordOfDraw;
    mapping(uint256 => bool) public delivered;
    uint256[] internal rounds;
    mapping(uint256 => bool) internal roundSeen;
    /// @dev owner → operator → the era the approval was given in (my own reading of the era), 0 none.
    mapping(address => mapping(address => uint8)) internal eraOfOperator;
    mapping(uint256 => address) internal approvedTo;
    mapping(uint256 => uint8) internal eraOfApproval;

    // ------------------------------------------------------------------ coverage
    uint256 public calls;
    uint256 public okTakes;
    uint256 public okHandBacks;
    uint256 public okTransfers;
    uint256 public okOperatorMoves;
    uint256 public okClose;
    uint256 public okGraduate;
    uint256 public okRequestWord;
    uint256 public okAcceptWord;
    uint256 public okDraws;
    uint256 public refusedDraws;
    uint256 public refusedQueueDead;
    uint256 public refusedTerminal;
    uint256 public refusedBounty;
    uint256 public refusedOther;
    bytes4 public lastDrawError;
    uint256 public okSettles;
    uint256 public settledDraws;
    uint256 public okOpens;
    uint256 public okOpenDraws;
    uint256 public okTerminal;
    uint256 public okCancels;
    uint256 public okTakesByNumber;
    uint256 public okPosts;
    uint256 public okStarts;
    uint256 public okFixes;
    uint256 public okBounties;
    uint256 public okWithdrawals;
    uint256 public okBuys;
    uint256 public warps;

    address[ACTORS] internal actors;

    function _startPhase() internal virtual;

    function setUp() public override {
        super.setUp();
        _buildRevealCache();
        actors = [
            eoa[0],
            eoa[1],
            eoa[2],
            eoa[3],
            eoa[4],
            eoa[5],
            address(contractDrawer),
            eoa7702,
            address(ethRefuser),
            address(gasBurner)
        ];
        _startPhase();
        _trackRound(_roundOf(0));
        bytes4[] memory s = new bytes4[](32);
        s[0] = this.act_take.selector;
        s[1] = this.act_handBack.selector;
        s[2] = this.act_transfer.selector;
        s[3] = this.act_approve.selector;
        s[4] = this.act_operatorMove.selector;
        s[5] = this.act_close.selector;
        s[6] = this.act_graduate.selector;
        s[7] = this.act_requestWord.selector;
        s[8] = this.act_acceptWord.selector;
        s[9] = this.act_draw.selector;
        s[10] = this.act_settle.selector;
        s[11] = this.act_open.selector;
        s[12] = this.act_openDraw.selector;
        s[13] = this.act_enterTerminal.selector;
        s[14] = this.act_cancel.selector;
        s[15] = this.act_takeByNumber.selector;
        s[16] = this.act_post.selector;
        s[17] = this.act_startBackup.selector;
        s[18] = this.act_fixBackup.selector;
        s[19] = this.act_addBounty.selector;
        s[20] = this.act_withdrawBounty.selector;
        s[21] = this.act_buyT.selector;
        s[22] = this.act_warp.selector;
        // Weighted: draws, settles, posts, backups and warps drive the unit's life.
        s[23] = this.act_draw.selector;
        s[24] = this.act_settle.selector;
        s[25] = this.act_warp.selector;
        s[26] = this.act_post.selector;
        s[27] = this.act_startBackup.selector;
        s[28] = this.act_fixBackup.selector;
        s[29] = this.act_warp.selector;
        s[30] = this.act_openDraw.selector;
        s[31] = this.act_acceptWord.selector;
        targetContract(address(this));
        targetSelector(FuzzSelector({addr: address(this), selectors: s}));
    }

    // ================================================================================================ helpers

    function _actor(uint256 i) internal view returns (address) {
        return actors[i % ACTORS];
    }

    function _trackRound(uint256 round) internal {
        if (round == 0 || roundSeen[round]) return;
        roundSeen[round] = true;
        rounds.push(round);
    }

    /// @dev My reading of the placeholder era: 3 once the word is stored or terminal mode began, 1 on the curve, 2
    /// between graduation and the word.
    function _eraNow() internal view returns (uint8) {
        IBoxTickets.TicketState memory s = _st();
        if (s.terminalAt != 0 || s.wordAcceptedAt != 0) return 3;
        return vault.gateOpenedAt() == 0 ? 1 : 2;
    }

    function _quoteOne() internal view returns (bool ok, uint256 total) {
        (bool good, bytes memory ret) = a.vault.staticcall(abi.encodeWithSignature("quoteTake(uint256)", 1));
        if (!good || ret.length < 64) return (false, 0);
        (uint256 p, uint256 f) = abi.decode(ret, (uint256, uint256));
        return (true, p + f);
    }

    /// @dev Tops `who` up from the richest EOA when a draw's quote exceeds its balance (nothing crosses the boundary).
    function _topUp(address who) internal {
        (bool ok, uint256 total) = _quoteOne();
        if (!ok) return;
        uint256 have = token.balanceOf(who);
        if (have >= total) return;
        address richest = eoa[2];
        for (uint256 i; i < 6; ++i) {
            if (eoa[i] != who && token.balanceOf(eoa[i]) > token.balanceOf(richest)) richest = eoa[i];
        }
        if (richest == who || token.balanceOf(richest) < 2 * (total - have)) return;
        _ghostAddOutside(who);
        _transferT(richest, who, total - have);
    }

    function _liveTokenOf(address who, uint256 seed) internal view returns (uint256) {
        (uint256[] memory ids, uint256 live) = _livePlaceholders();
        if (live == 0) return 0;
        uint256 start = seed % live;
        for (uint256 k; k < live; ++k) {
            uint256 id = ids[(start + k) % live];
            if (_ownerOrZero(id) == who) return id;
        }
        return 0;
    }

    /// @dev A live token whose owner gave `o` an operator or per-token approval (in any era), or 0.
    function _approvedTokenFor(address o, uint256 seed) internal view returns (uint256) {
        (uint256[] memory ids, uint256 live) = _livePlaceholders();
        for (uint256 k; k < live; ++k) {
            uint256 id = ids[(seed % live + k) % live];
            address owner = _ownerOrZero(id);
            if (owner != o && (eraOfOperator[owner][o] != 0 || approvedTo[id] == o)) return id;
        }
        return 0;
    }

    function _anyLiveToken(uint256 seed) internal view returns (uint256) {
        (uint256[] memory ids, uint256 live) = _livePlaceholders();
        return live == 0 ? 0 : ids[seed % live];
    }

    function _noteDelivery(uint256 item) internal {
        if (item == 0) return;
        if (delivered[item]) ++doubleDelivery;
        delivered[item] = true;
    }

    function _after(bool ok, bytes memory err) internal {
        ++calls;
        if (!ok && err.length != 0) lastUnexpected = err;
    }

    // ================================================================================================ the curve

    function act_take(uint256 who, uint256 count) external {
        address w = _actor(who);
        count = 1 + count % 3;
        _topUp(w);
        (bool ok,, bytes memory err) = _tryTake(w, count);
        if (ok) ++okTakes;
        _after(ok, err);
    }

    function act_handBack(uint256 who, uint256 seed) external {
        address w = _actor(who);
        uint256 id = _liveTokenOf(w, seed);
        if (id == 0) return;
        (bool ok,,, bytes memory err) = _tryHandBack(w, _one(id));
        if (ok) {
            ++burned;
            ++okHandBacks;
        }
        _after(ok, err);
    }

    function act_transfer(uint256 who, uint256 to, uint256 seed, bool safe) external {
        address w = _actor(who);
        address t = _actor(to);
        uint256 id = _liveTokenOf(w, seed);
        if (id == 0 || t == w) return;
        vm.prank(w);
        bool ok;
        if (safe) {
            try tickets.safeTransferFrom(w, t, id) {
                ok = true;
            } catch {}
        } else {
            try tickets.transferFrom(w, t, id) {
                ok = true;
            } catch {}
        }
        if (ok) {
            ++okTransfers;
            delete approvedTo[id];
        }
        _after(ok, "");
    }

    function act_approve(uint256 who, uint256 op, uint256 seed, bool all) external {
        address w = _actor(who);
        address o = _actor(op);
        if (o == w) return;
        if (all) {
            vm.prank(w);
            try tickets.setApprovalForAll(o, true) {
                eraOfOperator[w][o] = _eraNow();
            } catch {}
        } else {
            uint256 id = _liveTokenOf(w, seed);
            if (id == 0) return;
            vm.prank(w);
            try tickets.approve(o, id) {
                approvedTo[id] = o;
                eraOfApproval[id] = _eraNow();
            } catch {}
        }
        ++calls;
    }

    /// @dev An operator or approved address moves a placeholder; the outcome must follow the era rule exactly: the
    /// approval counts only in the era it was given and never in era 2, and era 2 freezes every transfer.
    function act_operatorMove(uint256 op, uint256 seed, uint256 to) external {
        address o = _actor(op);
        uint256 id = _approvedTokenFor(o, seed);
        if (id == 0) id = _anyLiveToken(seed);
        if (id == 0) return;
        address owner = _ownerOrZero(id);
        address t = _actor(to);
        if (owner == o || t == owner || t == o) return;
        uint8 era = _eraNow();
        bool operatorCounts = eraOfOperator[owner][o] == era && era != 2;
        bool approvalCounts = approvedTo[id] == o && eraOfApproval[id] == era && era != 2;
        bool expected = (operatorCounts || approvalCounts) && era != 2;
        vm.prank(o);
        bool ok;
        try tickets.transferFrom(owner, t, id) {
            ok = true;
        } catch {}
        if (ok != expected) ++badOperatorMove;
        if (ok) {
            ++okOperatorMoves;
            delete approvedTo[id];
        }
        _after(ok, "");
    }

    // ================================================================================================ phases

    function act_close() external {
        if (hook.closed()) return;
        _fund(eoa[2], 3 * raise);
        uint256 e0 = eoa[2].balance;
        uint256 t0 = token.balanceOf(eoa[2]);
        vm.prank(eoa[2]);
        try routerSwapper.swapOne{value: 3 * raise}(
            poolKey,
            SwapParams({
                zeroForOne: true, amountSpecified: _amount(3 * raise, true), sqrtPriceLimitX96: curve.sqrtPriceLowerX96
            }),
            "",
            eoa[2]
        ) {
            ++okClose;
        } catch {}
        _noteEthChange(e0, eoa[2].balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, token.balanceOf(eoa[2]), TIn.Sell, TOut.Buy);
        ++calls;
    }

    function act_graduate(bool failPoke) external {
        if (!hook.closed() || coordinator.graduated()) return;
        if (failPoke) {
            vm.mockCallRevert(address(src), abi.encodeWithSelector(IDrandSource.request.selector, 0), "poke fails");
        }
        vm.prank(keeper);
        bool ok;
        try coordinator.graduate() {
            ok = true;
        } catch {}
        vm.clearMockedCalls();
        if (ok) {
            ++okGraduate;
            _trackRound(_roundOf(0));
        }
        _after(ok, "");
    }

    function act_requestWord(uint256 who, uint256 value) external {
        address w = _actor(who);
        value = value % 3 == 0 ? 0 : (value % 3 == 1 ? 0.0001 ether : AUDIT_DRAW_VALUE);
        (bool ok, bytes memory err) = _tryRequestWord(w, value);
        if (ok) {
            ++okRequestWord;
            _trackRound(_roundOf(0));
        }
        _after(ok, err);
    }

    function act_acceptWord(uint256 who) external {
        (bool ok, bytes memory err) = _tryAcceptWord(_actor(who));
        if (ok) ++okAcceptWord;
        _after(ok, err);
    }

    // ================================================================================================ draws

    function act_draw(uint256 who, uint256 valueSeed) external {
        address w = _actor(who);
        uint256 target = _target();
        uint256 pick = valueSeed % 8;
        uint256 value =
            pick == 0 ? 0 : (pick == 1 ? (target == 0 ? 0 : target - 1) : (pick < 4 ? target : AUDIT_DRAW_VALUE));
        _topUp(w);
        // The gate rule, read before the call: a draw that would wait behind a dead head is refused QueueDead; the
        // first draw that sends the word itself is not gated.
        IBoxTickets.TicketState memory s = _st();
        bool sendWord = s.slots != 0 && s.wordRequestedAt == 0;
        (bool exists, bool dead,,) = _refHead();
        bool gated = !sendWord && exists && dead && vault.gateOpenedAt() != 0 && s.terminalAt == 0;
        (bool ok, uint256 id, bytes memory err) = _tryDraw(w, value);
        if (ok) {
            ++okDraws;
            _trackRound(_roundOf(id));
            if (sendWord) _trackRound(_roundOf(0));
            if (gated) ++badDrawGate;
        } else {
            ++refusedDraws;
            bytes4 sel = _sel(err);
            lastDrawError = sel;
            // Gated and refused for another reason first (the quote, the gate) is no gate error; an ungated QueueDead is.
            if (sel == IBoxTickets.QueueDead.selector) {
                ++refusedQueueDead;
                if (!gated) ++badDrawGate;
            } else if (sel == IBoxTickets.TerminalMode.selector) {
                ++refusedTerminal;
            } else if (sel == IBoxTickets.BountyTooLow.selector) {
                ++refusedBounty;
            } else {
                ++refusedOther;
            }
        }
        _after(ok, err);
    }

    function act_settle(uint256 who, uint256 k) external {
        k = 1 + k % 4;
        uint256 before = _st().drawsSettled;
        (bool ok, uint256 n, bytes memory err) = _trySettle(_actor(who), k);
        if (ok) {
            ++okSettles;
            settledDraws += n;
            uint256 after_ = _st().drawsSettled;
            if (after_ != before + n || n > k) ++settledOutOfOrder;
            for (uint256 id = before + 1; id <= after_; ++id) {
                IBoxTickets.DrawView memory d = _dv(id);
                if (d.status != DrawStatus.Settled) ++settledOutOfOrder;
                itemOfDraw[id] = d.itemId;
                (bytes32 word,) = src.wordOf(a.tickets, id);
                wordOfDraw[id] = word;
            }
        }
        _after(ok, err);
    }

    function act_open(uint256 who, uint256 seed, bool withReveal) external {
        uint256 id = _anyLiveToken(seed);
        if (id == 0) return;
        // The holder opens three times in four (else a random actor, refused unless it is a current-era operator).
        address w = seed % 4 == 0 ? _actor(who) : _ownerOrZero(id);
        (bool ok, uint256 item, bytes memory err) = _tryOpen(w, id, withReveal || seed % 4 != 1);
        if (ok) {
            ++burned;
            ++okOpens;
            _noteDelivery(item);
        }
        _after(ok, err);
    }

    function act_openDraw(uint256 who, uint256 seed, uint256 toSeed, bool withReveal) external {
        uint256 requested = _st().drawsRequested;
        if (requested == 0) return;
        uint256 id = 1 + seed % requested;
        IBoxTickets.DrawView memory d = _dv(id);
        address w = seed % 3 == 0 ? _actor(who) : d.drawer;
        address to = toSeed % 2 == 0 ? address(0) : _actor(toSeed);
        uint256 before = _st().drawsSettled;
        (bool ok, uint256 item, bytes memory err) = _tryOpenDraw(w, id, to, withReveal);
        if (ok) {
            ++okOpenDraws;
            ++drawsOpened;
            _noteDelivery(item);
            // openDraw may settle the queue up to this ticket: record what it fixed.
            uint256 after_ = _st().drawsSettled;
            for (uint256 k = before + 1; k <= after_; ++k) {
                IBoxTickets.DrawView memory dk = _dv(k);
                if (dk.status != DrawStatus.Settled && dk.status != DrawStatus.Opened) ++settledOutOfOrder;
                itemOfDraw[k] = dk.itemId;
                (bytes32 word,) = src.wordOf(a.tickets, k);
                wordOfDraw[k] = word;
            }
            settledDraws += after_ - before;
        }
        _after(ok, err);
    }

    // ================================================================================================ terminal

    function act_enterTerminal(uint256 who) external {
        (bool exists, bool dead,,) = _refHead();
        bool expected = exists && dead && _st().terminalAt == 0;
        (bool ok, bytes memory err) = _tryEnterTerminal(_actor(who));
        if (ok != expected) ++badTerminal;
        if (ok) ++okTerminal;
        _after(ok, err);
    }

    function act_cancel(uint256 who, uint256 seed) external {
        uint256 requested = _st().drawsRequested;
        if (requested == 0) return;
        uint256 id = 1 + seed % requested;
        bool terminal = _st().terminalAt != 0;
        (bool ok,, bytes memory err) = _tryCancel(_actor(who), id);
        if (ok) {
            ++okCancels;
            ++drawsCancelled;
            if (!terminal) ++cancelledOutsideTerminal;
        }
        _after(ok, err);
    }

    function act_takeByNumber(uint256 who, uint256 seed, bool withReveal) external {
        if (_st().terminalAt == 0) return;
        address w = _actor(who);
        IBoxTickets.TicketState memory s = _st();
        uint256 takeFrom = uint256(s.terminalAt) + TAKE_DELAY;
        if (vm.getBlockTimestamp() < takeFrom && seed % 3 != 0) {
            _warpTo(takeFrom);
            ++warps;
        }
        uint256 item;
        uint256 index;
        if (s.slots != 0 && s.wordAcceptedAt == 0) {
            // No numbers: any hidden item.
            for (uint256 k; k < 8; ++k) {
                uint256 id = 1 + uint256(keccak256(abi.encode(seed, k))) % editionSize;
                if (vault.isHidden(id)) {
                    item = id;
                    break;
                }
            }
        } else {
            uint256 left = _left();
            if (left == 0) return;
            index = seed % left;
            item = _itemAtPosition(tickets.poolPositionAt(index));
        }
        if (item == 0) return;
        _topUp(w);
        (bool ok,,, bytes memory err) = _tryTakeByNumber(w, item, index, withReveal);
        if (ok) {
            ++okTakesByNumber;
            _noteDelivery(item);
        }
        _after(ok, err);
    }

    // ================================================================================================ the source

    /// @dev Posts a committed round whose time has come: by preference one a pending request waits on (the word's
    /// or a draw's), else r0 + idx; a round posted late (after its request's 7 days) is a late post on purpose.
    function act_post(uint256 idx) external {
        bool ok;
        if (idx % 4 != 0 && rounds.length != 0) {
            uint256 start = idx % rounds.length;
            for (uint256 i; i < rounds.length && !ok; ++i) {
                ok = _tryPost(rounds[(start + i) % rounds.length]);
            }
        }
        if (!ok) ok = _tryPost(r0 + idx % 16);
        if (ok) ++okPosts;
        ++calls;
    }

    /// @dev Starts the backup of a tracked round that drand has not answered and nobody started; when its start
    /// window has not opened yet, the action first waits for it (the keeper's job, 5 days + 1 s after the round);
    /// past the latest start nothing is tried.
    function act_startBackup(uint256 sel, uint256 who) external {
        if (rounds.length == 0) return;
        uint256 round;
        uint256 start = sel % rounds.length;
        for (uint256 i; i < rounds.length; ++i) {
            uint256 r = rounds[(start + i) % rounds.length];
            (uint64 startedAt,,,) = src.backupOf(r);
            (, uint64 postedAt) = drand.beaconOf(r);
            if (startedAt != 0 || postedAt != 0) continue;
            if (vm.getBlockTimestamp() > src.roundTime(r) + src.LATEST_START()) continue;
            round = r;
            break;
        }
        if (round == 0) return;
        uint256 from = src.roundTime(round) + src.BACKUP_AFTER() + 1;
        if (vm.getBlockTimestamp() < from && sel % 3 != 0) {
            _warpTo(from);
            ++warps;
        }
        (bool ok,, bytes memory err) = _tryStartBackup(round, _actor(who));
        if (ok) ++okStarts;
        _after(ok, err);
    }

    /// @dev Fixes a started, unfixed backup; when its target block is not mined yet the action first advances to
    /// the block after it (257 blocks of 12 s: the fixer's wait), unless `sel` says to try at once.
    function act_fixBackup(uint256 sel, uint256 mixSeed, uint256 who) external {
        if (rounds.length == 0) return;
        uint256 round;
        uint64 target;
        uint256 start = sel % rounds.length;
        for (uint256 i; i < rounds.length; ++i) {
            uint256 r = rounds[(start + i) % rounds.length];
            (uint64 startedAt, uint64 t, uint64 fixedAt,) = src.backupOf(r);
            if (startedAt == 0 || fixedAt != 0) continue;
            round = r;
            target = t;
            break;
        }
        if (round == 0) return;
        if (vm.getBlockNumber() <= target && sel % 3 != 0) {
            _advance(target + 1 - vm.getBlockNumber());
            ++warps;
        }
        (bool ok, bytes memory err) = _tryFixBackup(round, keccak256(abi.encode("mix", mixSeed)), _actor(who));
        if (ok) ++okFixes;
        _after(ok, err);
    }

    /// @dev A pot on a tracked round, or on a committed round r0 + i (its post then credits the poster).
    function act_addBounty(uint256 who, uint256 sel, uint256 value, bool viaBacked) external {
        uint256 round = sel % 2 == 0 && rounds.length != 0 ? rounds[sel % rounds.length] : r0 + sel % 16;
        (, uint64 postedAt) = drand.beaconOf(round);
        if (postedAt != 0) return;
        value = value % 2 == 0 ? 0.0001 ether : AUDIT_DRAW_VALUE;
        _addBounty(_actor(who), round, value, viaBacked);
        ++okBounties;
        ++calls;
    }

    function act_withdrawBounty(uint256 who, uint256 to) external {
        address w = drand.owedTo(poster) != 0 ? poster : _actor(who);
        address t = _actor(to);
        if (drand.owedTo(w) == 0) return;
        (bool ok,) = _tryWithdrawBounty(w, payable(t));
        if (ok) ++okWithdrawals;
        ++calls;
    }

    // ================================================================================================ T and time

    function act_buyT(uint256 who, uint256 eth) external {
        address w = _actor(who % 8); // the EOAs, the contract drawer and the 7702 EOA (a refund must be acceptable)
        eth = 0.01 ether + eth % 0.2 ether;
        _fund(w, eth);
        uint256 e0 = w.balance;
        uint256 t0 = token.balanceOf(w);
        vm.prank(w);
        bool ok;
        try routerSwapper.swapOne{value: eth}(
            poolKey,
            SwapParams({
                zeroForOne: true, amountSpecified: _amount(eth, true), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            "",
            w
        ) {
            ok = true;
        } catch {}
        _noteEthChange(e0, w.balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, token.balanceOf(w), TIn.Sell, TOut.Buy);
        if (ok) ++okBuys;
        ++calls;
    }

    function act_warp(uint256 kind) external {
        kind %= 14;
        uint256 now_ = vm.getBlockTimestamp();
        uint256 to;
        if (kind == 0) {
            to = now_ + SLOT;
        } else if (kind == 1) {
            to = now_ + 1 hours;
        } else if (kind == 2) {
            to = now_ + 1 days;
        } else if (kind == 3) {
            to = _nextCommittedRoundTime(now_);
        } else if (kind == 4) {
            to = _earliestBackupStart(now_);
        } else if (kind == 5) {
            to = _latestBackupStart(now_);
        } else if (kind == 6) {
            _advance(src.TARGET_BLOCKS() + 1);
            ++warps;
            ++calls;
            return;
        } else if (kind == 7) {
            to = _headDeadline(now_);
        } else if (kind == 8) {
            to = _headDeadline(now_) + 1;
        } else if (kind == 9) {
            uint256 gateAt = vault.gateOpenedAt();
            to = gateAt == 0 ? now_ : gateAt + SILENCE_UNREQUESTED + 1;
        } else if (kind == 10) {
            uint256 terminalAt = _st().terminalAt;
            to = terminalAt == 0 ? now_ : terminalAt + TAKE_DELAY;
        } else if (kind == 11) {
            _advance(8_192);
            ++warps;
            ++calls;
            return;
        } else if (kind == 12) {
            to = now_ + 7 days - 1;
        } else {
            to = now_ + 1;
        }
        if (to > now_) _warpTo(to);
        ++warps;
        ++calls;
    }

    function _nextCommittedRoundTime(uint256 now_) internal view returns (uint256) {
        for (uint256 i; i < 16; ++i) {
            uint256 t = src.roundTime(r0 + i);
            if (t > now_) return t;
        }
        return now_;
    }

    function _earliestBackupStart(uint256 now_) internal view returns (uint256 to) {
        to = now_;
        for (uint256 i; i < rounds.length; ++i) {
            (uint64 startedAt,,,) = src.backupOf(rounds[i]);
            if (startedAt != 0) continue;
            uint256 t = src.roundTime(rounds[i]) + src.BACKUP_AFTER() + 1;
            if (t > now_ && (to == now_ || t < to)) to = t;
        }
    }

    function _latestBackupStart(uint256 now_) internal view returns (uint256 to) {
        to = now_;
        for (uint256 i; i < rounds.length; ++i) {
            (uint64 startedAt,,,) = src.backupOf(rounds[i]);
            if (startedAt != 0) continue;
            uint256 t = src.roundTime(rounds[i]) + src.LATEST_START();
            if (t > now_ && (to == now_ || t < to)) to = t;
        }
    }

    function _headDeadline(uint256 now_) internal view returns (uint256) {
        (bool exists,,, uint256 deadline) = _refHead();
        return exists && deadline > now_ ? deadline : now_;
    }
}
