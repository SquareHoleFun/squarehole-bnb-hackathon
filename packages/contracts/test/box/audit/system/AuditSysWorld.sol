// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {AuditU3ClaudeActor} from "../U3/AuditU3ClaudeBase.sol";
import {AuditU4ClaudeClaimGifter} from "../U4/AuditU4ClaudeHelpers.sol";
import {AuditU6ClaudeBase} from "../U6/AuditU6ClaudeBase.sol";
import {AuditU7ClaudeBase} from "../U7/AuditU7ClaudeBase.sol";

/// @notice The system campaign's actions (one handler selector each; plan § 3.2's handler list).
enum Act {
    WindowBuy,
    SwapBuyIn,
    SwapSellIn,
    SwapBuyOut,
    SwapSellOut,
    SwapMulti,
    CloseCurve,
    Graduate,
    Collect,
    FundFees,
    FundDepth,
    ForceEth,
    Royalty,
    Flush,
    SweepWeth,
    RouterSweep,
    PayFit,
    PayPlatform,
    ClaimReward,
    GiftClaims,
    Deepen,
    Poke,
    Execute,
    FundBudget,
    Take,
    HandBack,
    TransferPlaceholder,
    RequestWord,
    AcceptWord,
    Draw,
    DrawMany,
    Settle,
    OpenPlaceholder,
    OpenDraw,
    PostRound,
    PostAll,
    AddBounty,
    WithdrawBounty,
    StartBackup,
    FixBackup,
    BackupCycle,
    EnterTerminal,
    CancelDraw,
    TakeByNumber,
    Pick,
    PickBatch,
    ReturnItem,
    ReturnItems,
    Reveal,
    TransferItem,
    ItemToBox,
    ApproveItem,
    StreamClaim,
    StreamClaimFor,
    StreamBurn,
    TransferT,
    TToBox,
    BurnT,
    ProbePool,
    Warp
}

/// @notice The accepted findings and no-exit classes the campaign meets as named exceptions (register
/// `box0-audit/findings.md` and map § 6 item 10), never as failures.
enum Exc {
    /// W1-U4-2: a payout in epoch k carries earlier epochs' credits, so the Safe can receive above 32 ETH inside one
    /// epoch (credits per epoch ≤ 32 ETH and receipts by the end of epoch k ≤ (k + 1) × 32 ETH hold).
    W1_U4_2,
    /// W1-U4-3: receiver claims above Σ ledgers by the next batch.
    W1_U4_3,
    /// W2-U2-1: the launch router's `quote` answers a taxed buy after a close inside the window.
    W2_U2_1,
    /// W2-U2-2: T gifted to the coordinator joins the ask and can empty the bid sentinel (two positions).
    W2_U2_2,
    /// W2-U5-1: after a full collect owners can be uncovered by up to N − 1 − m raw units.
    W2_U5_1,
    /// W2-U6-1: settleHours saturated (more than 65,535 hours from request to settlement).
    W2_U6_1,
    /// W3-U7-1: an item sent with `transferFrom` to a box contract has no exit.
    W3_U7_1,
    /// M01: raw FIT (T) sent to the receiver has no exit.
    M01,
    /// M02: FIT royalties (T) at the royalty router have no exit.
    M02,
    /// M25: raw FIT at other system addresses (coordinator after graduation, hook, tickets, collection, table, ...).
    M25,
    /// M27 (and the forced-value shape at every box address, FQ-19/FQ-02): forced ETH with no exit.
    M27,
    /// BC-140: launch tax held for good when box 0 never graduates (the closing driver always graduates).
    BC140
}

/// @title AuditSysWorld
/// @notice TEST ONLY (SH-AUDIT-B0 round 2, box0-audit plan § 3.2; Claude). The state the system campaign's three shards
/// share on top of R0-A's world (`AuditPhases`: the factory's box 0 on the mainnet build, Osaka, real everything) and
/// two unit bases reused by inheritance, read-only: `AuditU6ClaudeBase` (tickets oracles: live placeholders, slot and
/// ticket counts, the independent item replay) and `AuditU7ClaudeBase` (VLT-08 in the vault's numbers, the cached reveal
/// tree, 512-bit quote checks). Here: the actors, the per-action counters (calls, successes, skips, refusals), the
/// write-surface recorder (X17) that also marks which contracts each call wrote, the ghosts the invariants read, the
/// named exceptions of the accepted findings, the ticket oracles ported from U6's campaign, and the reach report.
abstract contract AuditSysWorld is AuditU6ClaudeBase, AuditU7ClaudeBase {
    // ================================================================================================ constants
    uint256 internal constant N_ACT = 60;
    uint256 internal constant N_EXC = 12;
    /// @dev The runbook's graduation gas (`docs/runbooks/sepolia-core-v1.md:595`): X06's floor.
    uint256 internal constant GRADUATE_FLOOR = 15_000_000;
    /// @dev EIP-7825's transaction gas cap (X18's bound for every keeper action).
    uint256 internal constant TX_CAP = 16_777_216;
    /// @dev BoxCoordinator's poke floor (`BoxCoordinator.sol:121`).
    uint256 internal constant POKE_FLOOR = 2_651_269;

    // Write-surface bits (X17), one per recorded account.
    uint256 internal constant W_PM = 1 << 0;
    uint256 internal constant W_COORD = 1 << 1;
    uint256 internal constant W_HOOK = 1 << 2;
    uint256 internal constant W_LROUTER = 1 << 3;
    uint256 internal constant W_RECV = 1 << 4;
    uint256 internal constant W_EXEC = 1 << 5;
    uint256 internal constant W_TICKETS = 1 << 6;
    uint256 internal constant W_VAULT = 1 << 7;
    uint256 internal constant W_COLL = 1 << 8;
    uint256 internal constant W_STREAM = 1 << 9;
    uint256 internal constant W_RROUTER = 1 << 10;
    uint256 internal constant W_TABLE = 1 << 11;
    uint256 internal constant W_TOKEN = 1 << 12;
    uint256 internal constant W_DRAND = 1 << 13;
    uint256 internal constant W_SRC = 1 << 14;
    uint256 internal constant W_FACTORY = 1 << 15;
    uint256 internal constant W_REGISTRY = 1 << 16;
    uint256 internal constant W_WETH = 1 << 17;
    uint256 internal constant N_REC = 18;
    /// @dev What the receiver's graduation settlement may write when any receiver call runs it (`_settleIfDue`).
    uint256 internal constant W_SETTLE = W_RECV | W_PM | W_TOKEN | W_STREAM;

    // ================================================================================================ campaign state
    address internal handler;
    string internal shardName;
    uint256[N_ACT] internal aCalls;
    uint256[N_ACT] internal aOk;
    uint256[N_ACT] internal aSkip;
    uint256[N_ACT] internal aRefused;
    uint256[N_ACT] internal aGasMax;
    uint256[N_ACT] internal allowedWrites;
    uint256[N_EXC] internal excCount;
    uint256[N_EXC] internal excMax;
    address[N_REC] internal recAddr;
    Act internal cur;
    uint8 internal curOutcome;
    uint256 internal runCalls;
    uint256 public violations;
    string internal lastViolation;

    // ================================================================================================ clock
    /// @notice Seconds per block in the campaign's own clock moves (12; the 6-s variant sets 6, plan § 3.2). R0-A's
    /// phase drivers in setUp keep their 12-s blocks.
    uint256 internal blockSeconds = 12;

    /// @dev `blocks` blocks of `blockSeconds` each.
    function _adv(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + blockSeconds * blocks);
    }

    /// @dev Forward to time `t`, one block per started `blockSeconds` (never back).
    function _warpT(uint256 t) internal {
        uint256 now_ = vm.getBlockTimestamp();
        if (t <= now_) return;
        vm.roll(vm.getBlockNumber() + (t - now_ + blockSeconds - 1) / blockSeconds);
        vm.warp(t);
    }

    // ================================================================================================ actors
    address[] internal traders;
    AuditU4ClaudeClaimGifter internal gifter;
    AuditU3ClaudeActor internal lp;

    // ================================================================================================ ghosts
    uint256 internal gSupply;
    uint256 internal gPhase;
    uint256 internal gClosedAtBlock;
    uint256 internal gGraduatedAt;
    uint256 internal gLeastGraduateGas;
    uint256 internal gMostRefusedGraduateGas;
    uint256 internal gGraduatePokeFailures;
    address internal gRewardHolder;
    uint256 internal gReward;
    bool internal gRewardClaimed;
    uint256 internal gSafePaid;
    uint256 internal gSafePaidEpoch;
    uint256 internal gSafePaidInEpoch;
    uint256 internal gExecBlock;
    uint256 internal gExecChunks;
    uint256 internal gStreamIndex;
    uint256 internal gStreamValue;
    uint256 internal gStreamClaimed;
    uint256 internal gStreamBurned;
    uint256 internal gToPlatform;
    uint256 internal gToFit;
    uint256 internal gTaxSwept;
    uint256 internal gReserveMinted;
    /// @dev Position liquidity last seen (X16): curve, ask, bid, sentinel, pair.
    uint128[5] internal gLiq;
    /// @dev Every key (0 = the graduation word, k = draw k) whose word was seen non-zero, and that word (X11).
    mapping(uint256 => bytes32) internal gWord;
    uint256 internal gWordsChecked;
    /// @dev Items the tickets delivered (placeholders, draws, takes by number): each at most once (X19).
    uint256[] internal gDelivered;
    mapping(uint256 => bool) internal gIsDelivered;
    /// @dev Items that ever left the vault (deliveries and picks) and items that came back (returns) (X03).
    uint256[] internal gLeft;
    mapping(uint256 => bool) internal gHasLeft;
    mapping(uint256 => bool) internal gReturned;
    /// @dev Items sent with transferFrom to a box contract (W3-U7-1) and where.
    uint256[] internal gStuck;
    mapping(uint256 => address) internal gStuckAt;
    /// @dev Rounds that ever held a pot (X01's DrandSource holdings).
    uint256[] internal gRounds;
    mapping(uint256 => bool) internal gRoundSeen;
    /// @dev Forced ETH and direct T per system address (M27 / M01 / M02 / M25 classes).
    mapping(address => uint256) internal gForced;
    mapping(address => uint256) internal gForcedTotal;
    mapping(address => uint256) internal gDirectT;
    /// @dev ETH funded into the executor's budget by outsiders (`fundBudget`), not by the receiver (X08).
    uint256 internal gOutsideBudget;
    /// @dev ERC-6909 ETH claims gifted to the coordinator before graduation (forwarded to the receiver there).
    uint256 internal gCoordGiftPre;
    /// @dev T gifted to the coordinator before graduation (W2-U2-2: it joins the ask).
    uint256 internal gGiftToCoordinator;
    /// @dev ERC-6909 ETH claims gifted per system address (the receiver's next batch, the hook's depth, the rest none).
    mapping(address => uint256) internal gClaimGift;
    /// @dev Burned placeholders (hand-backs and opens), for minted − burned == live (X04).
    uint256 internal gBurnedPlaceholders;
    /// @dev Started backup rounds (for fixes).
    uint256[] internal gStarted;
    mapping(uint256 => bool) internal gIsCommitted;
    /// @dev The closing driver's last X21 figures (for the report).
    uint256[16] internal gEnd;
    /// @dev The shard's weighted selector list (built by `_w`, handed to `targetSelector`).
    bytes4[] internal selPool;

    // ================================================================================================ edges
    /// @dev The time and block edges the actions land on exactly (plan § 3.2's warps and windows), counted per edge
    /// and offset (one second before, at, one second after; one block for the history window) for the reach report,
    /// so "the handler reaches the edges" is measured, not read.
    uint256 internal constant N_EDGE = 11;
    /// The queue head's 7-day deadline (SILENCE after its request).
    uint256 internal constant E_HEAD = 0;
    /// The gate's 30 days without a word request (SILENCE_UNREQUESTED).
    uint256 internal constant E_UNREQUESTED = 1;
    /// A 30-day platform epoch boundary after graduation.
    uint256 internal constant E_EPOCH = 2;
    /// A round's time + 5 days (BACKUP_AFTER: the backup may start after it).
    uint256 internal constant E_BACKUP_AFTER = 3;
    /// A round's time + 5 days 18 hours (LATEST_START: the backup may start until it).
    uint256 internal constant E_LATEST_START = 4;
    /// Terminal mode + 3 days (TAKE_DELAY).
    uint256 internal constant E_TAKE_DELAY = 5;
    /// The word's acceptance, or a draw's settlement, + 30 days (REVEAL_GRACE).
    uint256 internal constant E_REVEAL_GRACE = 6;
    /// The window's openAt.
    uint256 internal constant E_OPEN_AT = 7;
    /// A 12-second step of the window.
    uint256 internal constant E_WINDOW_STEP = 8;
    /// r0's request time (the graduation word's committed round).
    uint256 internal constant E_REQUEST_R0 = 9;
    /// 8,191 blocks after a backup's target block (EIP-2935's last served block; counted in blocks).
    uint256 internal constant E_HISTORY = 10;
    uint256[3 * N_EDGE] internal gEdge;
    /// @dev The largest block distance past the target at which a backup fix passed, and the smallest at which one was
    /// refused (the history window's edge, X11).
    uint256 internal gFixOkMaxDistance;
    uint256 internal gFixRefusedMinDistance;

    /// @dev Counts a landing on edge `kind` at `off` (-1, 0 or +1).
    function _edge(uint256 kind, int256 off) internal {
        ++gEdge[3 * kind + uint256(off + 1)];
    }

    /// @dev A warp's offset from its edge as the actions draw it (`(seed >> 8) % 3` maps to -1, 0, +1).
    function _offset(uint256 seed) internal pure returns (int256) {
        return int256((seed >> 8) % 3) - 1;
    }

    // ================================================================================================ setup

    /// @dev Called by each shard's setUp after its start state: actors, recorder, masks, ghosts, the handler.
    function _setUpSys(string memory name, address handler_) internal {
        shardName = name;
        handler = handler_;
        _buildTree();
        traders.push(eoa[0]);
        traders.push(eoa[1]);
        traders.push(eoa[2]);
        traders.push(eoa[3]);
        traders.push(eoa[4]);
        traders.push(eoa[5]);
        traders.push(eoa7702);
        traders.push(address(contractDrawer));
        traders.push(address(ethRefuser));
        traders.push(address(gasBurner));
        gifter = new AuditU4ClaudeClaimGifter(pm);
        lp = new AuditU3ClaudeActor(pm);
        _ghostAddOutside(address(gifter));
        _ghostAddOutside(address(lp));
        recAddr = [
            address(pm),
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.executor,
            a.tickets,
            a.vault,
            a.collection,
            a.itemStream,
            a.royaltyRouter,
            a.table,
            a.token,
            address(drand),
            address(src),
            address(factory),
            address(factory.registry()),
            a.weth
        ];
        for (uint256 i; i < _boxDrandCount(); ++i) {
            gIsCommitted[_boxDrandAt(i).round] = true;
        }
        _initMasks();
        _syncGhosts();
        _initGhosts();
    }

    /// @dev The ghosts a later layer keeps (the pool's positions), read once at the start.
    function _initGhosts() internal virtual {}

    /// @dev After every action, in the handler's call (forge keeps no write an invariant function makes, so every
    /// comparison with the state before a call lives here): the monotone checks and the words' record.
    function _afterAction(uint256 wrote) internal virtual {}

    /// @dev X17's account-level allow-list per action: the contracts each documented flow writes (map § 3 flows).
    function _initMasks() internal {
        uint256 swapW = W_PM | W_HOOK | W_TOKEN;
        allowedWrites[uint256(Act.WindowBuy)] = swapW | W_LROUTER;
        allowedWrites[uint256(Act.SwapBuyIn)] = swapW;
        allowedWrites[uint256(Act.SwapSellIn)] = swapW;
        allowedWrites[uint256(Act.SwapBuyOut)] = swapW;
        allowedWrites[uint256(Act.SwapSellOut)] = swapW;
        allowedWrites[uint256(Act.SwapMulti)] = swapW;
        allowedWrites[uint256(Act.CloseCurve)] = swapW | W_LROUTER;
        allowedWrites[uint256(Act.Graduate)] =
            W_PM | W_COORD | W_HOOK | W_RECV | W_EXEC | W_TICKETS | W_VAULT | W_STREAM | W_TOKEN | W_DRAND | W_SRC;
        allowedWrites[uint256(Act.Collect)] = W_SETTLE | W_HOOK;
        allowedWrites[uint256(Act.FundFees)] = W_SETTLE;
        allowedWrites[uint256(Act.FundDepth)] = W_SETTLE;
        allowedWrites[uint256(Act.ForceEth)] = 0;
        allowedWrites[uint256(Act.Royalty)] = W_WETH;
        allowedWrites[uint256(Act.Flush)] = W_SETTLE | W_WETH;
        allowedWrites[uint256(Act.SweepWeth)] = W_SETTLE | W_WETH;
        allowedWrites[uint256(Act.RouterSweep)] = W_LROUTER | W_PM;
        allowedWrites[uint256(Act.PayFit)] = W_SETTLE | W_EXEC;
        allowedWrites[uint256(Act.PayPlatform)] = W_SETTLE;
        allowedWrites[uint256(Act.ClaimReward)] = W_COORD | W_PM;
        allowedWrites[uint256(Act.GiftClaims)] = W_PM | W_TOKEN;
        allowedWrites[uint256(Act.Deepen)] = swapW | W_EXEC | W_RECV;
        allowedWrites[uint256(Act.Poke)] = W_EXEC;
        allowedWrites[uint256(Act.Execute)] = swapW | W_EXEC | W_RECV;
        allowedWrites[uint256(Act.FundBudget)] = W_EXEC;
        uint256 ticketW = W_TICKETS | W_VAULT | W_TOKEN | W_STREAM;
        // A take may first buy the T it needs on the curve (through the launch router in the window).
        allowedWrites[uint256(Act.Take)] = ticketW | swapW | W_LROUTER;
        allowedWrites[uint256(Act.HandBack)] = ticketW;
        allowedWrites[uint256(Act.TransferPlaceholder)] = W_TICKETS;
        allowedWrites[uint256(Act.RequestWord)] = W_TICKETS | W_SRC | W_DRAND;
        allowedWrites[uint256(Act.AcceptWord)] = W_TICKETS;
        // A draw may first buy the T it needs (a swap) for its drawer.
        allowedWrites[uint256(Act.Draw)] = ticketW | W_SRC | W_DRAND | swapW;
        allowedWrites[uint256(Act.DrawMany)] = ticketW | W_SRC | W_DRAND | swapW;
        allowedWrites[uint256(Act.Settle)] = W_TICKETS;
        allowedWrites[uint256(Act.OpenPlaceholder)] = ticketW | W_COLL;
        allowedWrites[uint256(Act.OpenDraw)] = ticketW | W_COLL;
        allowedWrites[uint256(Act.PostRound)] = W_DRAND;
        allowedWrites[uint256(Act.PostAll)] = W_DRAND;
        allowedWrites[uint256(Act.AddBounty)] = W_DRAND;
        allowedWrites[uint256(Act.WithdrawBounty)] = W_DRAND;
        allowedWrites[uint256(Act.StartBackup)] = W_SRC;
        allowedWrites[uint256(Act.FixBackup)] = W_SRC;
        allowedWrites[uint256(Act.BackupCycle)] = W_SRC;
        allowedWrites[uint256(Act.EnterTerminal)] = W_TICKETS;
        allowedWrites[uint256(Act.CancelDraw)] = ticketW;
        allowedWrites[uint256(Act.TakeByNumber)] = ticketW | W_COLL | swapW;
        uint256 vaultW = W_VAULT | W_TOKEN | W_COLL | W_STREAM;
        allowedWrites[uint256(Act.Pick)] = vaultW | swapW;
        allowedWrites[uint256(Act.PickBatch)] = vaultW | swapW;
        allowedWrites[uint256(Act.ReturnItem)] = vaultW;
        allowedWrites[uint256(Act.ReturnItems)] = vaultW;
        allowedWrites[uint256(Act.Reveal)] = W_COLL;
        allowedWrites[uint256(Act.TransferItem)] = W_COLL | W_STREAM;
        allowedWrites[uint256(Act.ItemToBox)] = W_COLL | W_STREAM;
        allowedWrites[uint256(Act.ApproveItem)] = W_COLL;
        allowedWrites[uint256(Act.StreamClaim)] = W_STREAM | W_TOKEN;
        allowedWrites[uint256(Act.StreamClaimFor)] = W_STREAM | W_TOKEN;
        allowedWrites[uint256(Act.StreamBurn)] = W_STREAM | W_TOKEN;
        allowedWrites[uint256(Act.TransferT)] = W_TOKEN;
        allowedWrites[uint256(Act.TToBox)] = W_TOKEN;
        allowedWrites[uint256(Act.BurnT)] = W_TOKEN;
        allowedWrites[uint256(Act.ProbePool)] = 0;
        allowedWrites[uint256(Act.Warp)] = 0;
    }

    /// @dev `weight` copies of `sel` in the shard's selector list (forge picks uniformly from it).
    function _w(bytes4 sel, uint256 weight) internal {
        for (uint256 i; i < weight; ++i) {
            selPool.push(sel);
        }
    }

    // ================================================================================================ the action frame

    modifier act(Act x) {
        require(msg.sender == handler, "AuditSys: handler only");
        _begin(x);
        _;
        _end(x);
    }

    modifier onlySelf() {
        require(msg.sender == address(this), "AuditSys: self only");
        _;
    }

    function _begin(Act x) internal {
        ++aCalls[uint256(x)];
        ++runCalls;
        cur = x;
        curOutcome = 0;
        vm.record();
    }

    /// @dev X17: a successful action wrote only the accounts its flow names; then the cross-call checks.
    function _end(Act x) internal {
        uint256 i = uint256(x);
        uint256 wrote;
        for (uint256 k; k < N_REC; ++k) {
            (, bytes32[] memory writes) = vm.accesses(recAddr[k]);
            if (writes.length != 0) wrote |= 1 << k;
        }
        vm.stopRecord();
        uint256 extra = wrote & ~allowedWrites[i];
        _afterAction(wrote);
        uint8 o = curOutcome;
        if (o == 1) {
            ++aOk[i];
            if (extra != 0) {
                _violation(
                    string.concat(
                        "X17: ", _actName(i), " wrote outside its documented surface, mask ", vm.toString(extra)
                    )
                );
            }
        } else if (o == 3) {
            ++aRefused[i];
        } else {
            ++aSkip[i];
        }
    }

    function _ok() internal {
        curOutcome = 1;
    }

    function _skipped() internal {
        curOutcome = 2;
    }

    function _refused() internal {
        if (curOutcome != 1) curOutcome = 3;
    }

    function _violation(string memory why) internal {
        ++violations;
        lastViolation = why;
        console.log("AuditSys violation:", why);
    }

    function _exc(Exc e, uint256 size) internal {
        ++excCount[uint256(e)];
        if (size > excMax[uint256(e)]) excMax[uint256(e)] = size;
    }

    /// @dev X18: the gas one keeper call used, against EIP-7825's cap (and the action's maximum, for the report).
    function _gas(Act x, uint256 used) internal {
        if (used > aGasMax[uint256(x)]) aGasMax[uint256(x)] = used;
        if (used + 21_000 > TX_CAP) _violation("X18: a keeper call above EIP-7825's transaction cap");
    }

    /// @dev Cold accounts and slots, as at the start of a transaction (X18 measures each keeper call from cold).
    function _coolAll() internal {
        for (uint256 k; k < N_REC; ++k) {
            vm.cool(recAddr[k]);
        }
    }

    // ================================================================================================ actors

    function _who(uint256 seed) internal view returns (address) {
        return traders[seed % traders.length];
    }

    /// @dev A trader holding at least `need` T, searched from `seed` (address(0) if none does).
    function _holder(uint256 seed, uint256 need) internal view returns (address) {
        uint256 n = traders.length;
        for (uint256 i; i < n; ++i) {
            address x = traders[(seed % n + i) % n];
            if (token.balanceOf(x) >= need && token.balanceOf(x) != 0) return x;
        }
        return address(0);
    }

    /// @dev An actor that accepts ETH (for recipients whose refusal is not the point).
    function _payee(uint256 seed) internal view returns (address) {
        address[7] memory p = [eoa[0], eoa[1], eoa[2], eoa[3], eoa[4], eoa[5], eoa7702];
        return p[seed % 7];
    }

    function _isContract(address x) internal view returns (bool) {
        return x.code.length != 0 && !(x.code.length == 23 && bytes3(x.code) == bytes3(hex"ef0100"));
    }

    function _refuses(address x) internal view returns (bool) {
        return x == address(ethRefuser) || x == address(gasBurner);
    }

    /// @dev A log-uniform amount in [lo, hi] from `seed`.
    function _amount(uint256 seed, uint256 lo, uint256 hi) internal pure returns (uint256 x) {
        uint256 span = hi / lo;
        uint256 bits;
        while (span > 1) {
            span >>= 1;
            ++bits;
        }
        x = lo << (seed % (bits + 1));
        x += (seed >> 8) % x;
        if (x > hi) x = hi;
    }

    // ================================================================================================ ghosts

    /// @dev The ghosts the monotone checks compare with, read again after the checks passed.
    function _syncGhosts() internal {
        gSupply = token.totalSupply();
        gPhase = uint256(hook.phase());
        gClosedAtBlock = hook.closedAtBlock();
        gGraduatedAt = coordinator.graduatedAt();
        gStreamIndex = stream.index();
        gStreamValue = stream.streamValue();
        (gStreamClaimed, gStreamBurned) = stream.totals();
        (gToFit, gToPlatform,,,,,) = receiver.totals();
        gTaxSwept = launchRouter.totalSwept();
        gReserveMinted = hook.reserveMinted();
    }

    function _noteRound(uint256 round) internal {
        if (round == 0 || gRoundSeen[round]) return;
        gRoundSeen[round] = true;
        gRounds.push(round);
    }

    function _noteDelivered(uint256 item) internal {
        if (gIsDelivered[item]) _violation("X19: an item delivered twice by the tickets");
        gIsDelivered[item] = true;
        gDelivered.push(item);
        _noteLeft(item);
    }

    function _noteLeft(uint256 item) internal {
        if (gHasLeft[item]) return;
        gHasLeft[item] = true;
        gLeft.push(item);
    }

    // ================================================================================================ ticket oracles

    struct Head {
        bool exists;
        uint256 key;
        uint256 since;
        uint256 deadline;
        bool requested;
        bool usable;
        bool dead;
    }

    /// @dev The queue head by the documented rule (`IBoxTickets.sol:18-21`; `BoxTickets.sol:42-44`), from views (the
    /// oracle of U6's campaign, `AuditU6ClaudeInvariants._head`).
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

    /// @dev How many draws settle(k) settles now by the rule.
    function _settleable(uint256 k) internal view returns (uint256 count) {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt != 0 || vault.gateOpenedAt() == 0) return 0;
        if (s.slots != 0 && s.wordAcceptedAt == 0) return 0;
        for (uint256 id = uint256(s.drawsSettled) + 1; id <= s.drawsRequested && count < k; ++id) {
            if (!_usable(id, tickets.drawTicket(id).requestedAt)) break;
            ++count;
        }
    }

    /// @dev The word the source must answer for `key` by its round's rule (F143: the backup's once it started).
    function _expectedWord(uint256 key) internal view returns (bytes32) {
        (, uint64 round) = src.requestOf(a.tickets, key);
        (uint64 startedAt,,, bytes32 mix) = src.backupOf(round);
        if (startedAt != 0) return _word(src.BACKUP_TAG(), mix, key);
        (bytes32 randomness,) = drand.beaconOf(round);
        return _word(src.DRAND_TAG(), randomness, key);
    }

    function _pendingRound(uint256 key) internal view returns (uint256) {
        (uint64 requestedAt, uint64 round) = src.requestOf(a.tickets, key);
        if (requestedAt == 0) return 0;
        return round;
    }

    /// @dev A round some pending key waits on (the graduation word or an unsettled draw), 0 if none.
    function _pickPendingRound(uint256 seed) internal view returns (uint256 round) {
        IBoxTickets.TicketState memory s = tickets.status();
        uint256 open_ = s.drawsRequested - s.drawsSettled;
        bool wordPending = s.wordAcceptedAt == 0 && s.wordRequestedAt != 0;
        uint256 options = open_ + (wordPending ? 1 : 0);
        if (options == 0) return 0;
        uint256 pick_ = seed % options;
        if (wordPending) {
            if (pick_ == 0) return _pendingRound(0);
            --pick_;
        }
        return _pendingRound(uint256(s.drawsSettled) + 1 + pick_);
    }

    // ================================================================================================ report

    function _actName(uint256 i) internal pure returns (string memory) {
        string[60] memory n = [
            "windowBuy",
            "swapBuyIn",
            "swapSellIn",
            "swapBuyOut",
            "swapSellOut",
            "swapMulti",
            "closeCurve",
            "graduate",
            "collect",
            "fundFees",
            "fundDepth",
            "forceEth",
            "royalty",
            "flush",
            "sweepWeth",
            "routerSweep",
            "payFit",
            "payPlatform",
            "claimReward",
            "giftClaims",
            "deepen",
            "poke",
            "execute",
            "fundBudget",
            "take",
            "handBack",
            "transferPlaceholder",
            "requestWord",
            "acceptWord",
            "draw",
            "drawMany",
            "settle",
            "openPlaceholder",
            "openDraw",
            "postRound",
            "postAll",
            "addBounty",
            "withdrawBounty",
            "startBackup",
            "fixBackup",
            "backupCycle",
            "enterTerminal",
            "cancelDraw",
            "takeByNumber",
            "pick",
            "pickBatch",
            "returnItem",
            "returnItems",
            "reveal",
            "transferItem",
            "itemToBox",
            "approveItem",
            "streamClaim",
            "streamClaimFor",
            "streamBurn",
            "transferT",
            "tToBox",
            "burnT",
            "probePool",
            "warp"
        ];
        return n[i];
    }

    function _edgeName(uint256 i) internal pure returns (string memory) {
        string[11] memory n = [
            "head deadline 7 d",
            "unrequested word 30 d",
            "epoch boundary 30 d",
            "backup after 5 d",
            "latest start 5 d 18 h",
            "take delay 3 d",
            "reveal grace 30 d",
            "openAt",
            "window step 12 s",
            "r0 request time",
            "history window 8,191 blocks"
        ];
        return n[i];
    }

    function _excName(uint256 i) internal pure returns (string memory) {
        string[12] memory n = [
            "W1-U4-2 receipts above the cap in one epoch (late payout)",
            "W1-U4-3 receiver claims above its ledgers (next batch, sized in Q)",
            "W2-U2-1 quote answered after a close in the window",
            "W2-U2-2 T gift to the coordinator (graduations with an empty sentinel)",
            "W2-U5-1 owners uncovered after a full collect (raw units)",
            "W2-U6-1 settleHours saturated",
            "W3-U7-1 items sent by transferFrom to a box contract",
            "M01 raw T at the receiver",
            "M02 raw T at the royalty router",
            "M25 raw T at other system addresses",
            "M27 forced ETH at box addresses",
            "BC-140 launch tax held without graduation"
        ];
        return n[i];
    }

    /// @dev Adds `add` to the process-wide sum `key` (per shard and EVM; the runs share the environment).
    function _sum(string memory key, uint256 add) internal returns (uint256 total) {
        string memory k = string.concat("AUDITSYS_", shardName, "_", vm.getEvmVersion(), "_", key);
        total = vm.envOr(k, uint256(0)) + add;
        vm.setEnv(k, vm.toString(total));
    }

    function _max(string memory key, uint256 v) internal returns (uint256 m) {
        string memory k = string.concat("AUDITSYS_", shardName, "_", vm.getEvmVersion(), "_", key);
        m = vm.envOr(k, uint256(0));
        if (v > m) {
            m = v;
            vm.setEnv(k, vm.toString(m));
        }
    }

    /// @dev The smallest non-zero `v` seen for `key` over the campaign (0 while none was).
    function _minEnv(string memory key, uint256 v) internal returns (uint256 m) {
        string memory k = string.concat("AUDITSYS_", shardName, "_", vm.getEvmVersion(), "_", key);
        m = vm.envOr(k, uint256(0));
        if (v != 0 && (m == 0 || v < m)) {
            m = v;
            vm.setEnv(k, vm.toString(m));
        }
    }

    /// @dev The reach report: per action the campaign's sums (every run's afterInvariant adds its run, forge's
    /// end-of-campaign replays included), this run's own counts, and the named exceptions' counts and sizes.
    /// @dev The campaign's depth (calls per run): forge's FOUNDRY_INVARIANT_DEPTH if set, else the profile's (deep:
    /// 256, default: 128). Runs of exactly this many calls are the campaign's own; forge 1.8.3 also calls
    /// afterInvariant on extra replays of other lengths, which the "exact" sums leave out.
    function _depth() internal view returns (uint256) {
        uint256 d = vm.envOr("FOUNDRY_INVARIANT_DEPTH", uint256(0));
        if (d != 0) return d;
        return keccak256(bytes(vm.envOr("FOUNDRY_PROFILE", string("default")))) == keccak256("deep") ? 256 : 128;
    }

    function _report() internal {
        bool exact = runCalls == _depth();
        console.log("reach shard", shardName, vm.getEvmVersion());
        console.log("reach runs", _sum("RUNS", 1), "this run calls", runCalls);
        console.log("reach exact runs", _sum("XRUNS", exact ? 1 : 0), "depth", _depth());
        for (uint256 i; i < N_ACT; ++i) {
            string memory nm = _actName(i);
            uint256 c = _sum(string.concat(nm, "_c"), aCalls[i]);
            uint256 o = _sum(string.concat(nm, "_o"), aOk[i]);
            uint256 s = _sum(string.concat(nm, "_s"), aSkip[i]);
            uint256 r = _sum(string.concat(nm, "_r"), aRefused[i]);
            uint256 g = _max(string.concat(nm, "_g"), aGasMax[i]);
            console.log(string.concat("reach ", nm, " calls ", vm.toString(c), " ok ", vm.toString(o)));
            console.log(string.concat("reach ", nm, " skip ", vm.toString(s), " refused ", vm.toString(r)));
            console.log(string.concat("reach ", nm, " gasmax ", vm.toString(g), " run ", vm.toString(aCalls[i])));
            c = _sum(string.concat(nm, "_C"), exact ? aCalls[i] : 0);
            o = _sum(string.concat(nm, "_O"), exact ? aOk[i] : 0);
            s = _sum(string.concat(nm, "_S"), exact ? aSkip[i] : 0);
            r = _sum(string.concat(nm, "_R"), exact ? aRefused[i] : 0);
            console.log(
                string.concat(
                    "xreach ",
                    nm,
                    " calls ",
                    vm.toString(c),
                    " ok ",
                    vm.toString(o),
                    " skip ",
                    vm.toString(s),
                    " refused ",
                    vm.toString(r)
                )
            );
        }
        for (uint256 e; e < N_EXC; ++e) {
            if (e == uint256(Exc.W2_U5_1)) {
                // Observed inside the X10 invariant, whose writes forge does not keep: the environment holds them.
                uint256 obs = _sum("W2U5_obs", 0);
                uint256 mx = _max("W2U5_max", 0);
                console.log(
                    string.concat(
                        "exception ", _excName(e), ": observations ", vm.toString(obs), " max ", vm.toString(mx)
                    )
                );
                continue;
            }
            uint256 c = _sum(string.concat("exc", vm.toString(e), "_c"), excCount[e]);
            uint256 m = _max(string.concat("exc", vm.toString(e), "_m"), excMax[e]);
            console.log(string.concat("exception ", _excName(e), ": count ", vm.toString(c), " max ", vm.toString(m)));
        }
        // The edges landed on exactly, summed over the campaign (replays included), per offset.
        for (uint256 k; k < N_EDGE; ++k) {
            string memory id = vm.toString(k);
            uint256 before_ = _sum(string.concat("edge", id, "_m"), gEdge[3 * k]);
            uint256 at = _sum(string.concat("edge", id, "_0"), gEdge[3 * k + 1]);
            uint256 after_ = _sum(string.concat("edge", id, "_p"), gEdge[3 * k + 2]);
            console.log(
                string.concat(
                    "edge ",
                    _edgeName(k),
                    ": before ",
                    vm.toString(before_),
                    " at ",
                    vm.toString(at),
                    " after ",
                    vm.toString(after_)
                )
            );
        }
        console.log(
            "edge fix distance in blocks: largest that passed",
            _max("FIX_OK_MAX", gFixOkMaxDistance),
            "smallest refused",
            _minEnv("FIX_REFUSED_MIN", gFixRefusedMinDistance)
        );
    }
}
