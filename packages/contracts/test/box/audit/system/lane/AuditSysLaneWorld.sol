// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {AuditBox0World} from "../../common/AuditBox0World.sol";
import {EthIn, EthOut, TIn, TOut} from "../../common/AuditGhostLedger.sol";
import {AuditSysLaneHandler, LaneWorld} from "./AuditSysLaneHandler.sol";
import {
    BoxPhase,
    DrawStatus,
    TicketPhase,
    FeeBatch,
    DepthKind,
    DeepenSkip,
    ItemReveal
} from "../../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxReceiver} from "../../../../../src/box/interfaces/IBoxReceiver.sol";
import {BoxSpecV1} from "../../../../../src/box/BoxSpecV1.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

/// @notice Property: nonpayable destinations cannot consume a failed reward claim.
contract NonPayableReceiver {}

/// @notice Independent, state-aware scheduler and accounting model. Only the shared R0-A fixture is inherited.
/// Checks run after each action, including refused collects; temporal checks live in the action transaction.
abstract contract AuditSysLaneWorld is AuditBox0World, LaneWorld {
    enum Act {
        Clock,
        Window,
        Buy,
        Sell,
        Take,
        HandBack,
        Close,
        Graduate,
        Collect,
        Fees,
        FundDepth,
        PayFit,
        PayPlatform,
        Royalty,
        Sweep,
        Deepen,
        Execute,
        Draw,
        Post,
        StartBackup,
        FixBackup,
        Accept,
        Settle,
        Open,
        Return,
        Pick,
        Stream,
        Terminal,
        Cancel,
        Number,
        GiftT,
        ForceEth,
        TransferItem,
        Bounty,
        Reward,
        Poke,
        Burn,
        WithdrawBounty,
        GiftClaims
    }
    uint256 internal constant ACTIONS = 39;

    struct Count {
        uint256 calls;
        uint256 passed;
        uint256 gasMax;
    }
    Count[ACTIONS] internal counts;
    mapping(string => uint256) internal exceptions;
    string[] internal exceptionNames;
    AuditSysLaneHandler internal driver;
    NonPayableReceiver internal nonPayable;
    bool internal silent;
    string internal campaign;
    uint256 internal checked;
    uint256 internal delivered;
    uint256 internal minted;
    uint256 internal burnedTickets;
    uint256 internal pendingDraws;
    uint256 internal settledDraws;
    uint256 internal rewardCredit;
    uint256 internal platformCredits;
    uint256 internal platformPaid;
    uint256 internal fitPaid;
    uint256 internal nextQ;
    uint256 internal nextT;
    mapping(uint256 => uint256) internal creditInEpoch;
    mapping(uint256 => uint256) internal paidInEpoch;
    mapping(address => uint256) internal directT;
    mapping(address => uint256) internal forced;
    mapping(uint256 => address) internal placeholderOwner;
    uint256[] internal placeholders;
    uint256[] internal draws;
    uint256[] internal touchedItems;
    mapping(uint256 => bool) internal touched;
    mapping(uint256 => address) internal itemOwner;
    mapping(uint256 => bool) internal everDelivered;
    uint256[] internal pool;
    bool internal poolBuilt;
    uint256[] internal rounds;
    mapping(uint256 => bool) internal roundKnown;
    mapping(uint256 => bool) internal requestedRound;
    mapping(uint256 => bytes32) internal fixedWord;
    mapping(uint256 => uint64) internal fixedAt;
    uint256 internal oldSupply;
    uint256 internal oldPhase;
    uint256 internal oldClosed;
    uint256 internal oldGraduated;
    uint256 internal oldReserve;
    uint256 internal oldIndex;
    uint256 internal oldValue;
    uint256 internal oldClaimed;
    uint256 internal oldBurned;
    uint256 internal oldPair;
    uint256 internal oldAsk;
    uint256 internal oldBid;
    uint256 internal oldSentinel;
    uint256 internal depthChanges;
    uint256 internal executeChanges;
    bytes32 internal progressProof;
    /// @dev Reach (review): successful actions landing exactly on a rule's edge, campaign calls only (`_edgeName`).
    uint256 internal constant EDGES = 7;
    uint256[EDGES] internal edgeHits;
    /// @dev X01 (review): the published launch tax table (BoxSpecV1.LAUNCH_TAX_TABLE_HASH), copied once at setup.
    uint24[32] internal laneTaxTable;
    /// @dev X11 (review): what the lane itself put into each source: the prevRandao it mined into a fixed backup's
    /// target header, the committed randomness of a posted round (BoxDrandVectors), and when each became ready.
    mapping(uint256 => bytes32) internal mixOf;
    mapping(uint256 => uint256) internal fixedTimeOf;
    mapping(uint256 => bytes32) internal randomnessOf;
    mapping(uint256 => uint256) internal postedTimeOf;
    /// @dev X11 (review): the round a successful post, start or fix wrote, for the write-once probe after it.
    uint256 internal probeRound;
    /// @dev X01 (review): the platform share held before graduation, read before each action.
    uint256 internal oldHeld;

    /// @notice Property: each campaign starts from the same deployed box-zero fixture with every system role present.
    function _laneSetup(uint256 mode) internal {
        super.setUp();
        campaign = mode == 0 ? "creation" : mode == 1 ? "graduated" : "silent";
        silent = mode == 2;
        nonPayable = new NonPayableReceiver();
        _ghostAddOutside(address(nonPayable));
        // X01 (review): the window's 32 rates are the published table (its hash is the spec's), copied once.
        uint24[32] memory table = launchRouter.taxTable();
        assertEq(keccak256(abi.encode(table)), BoxSpecV1.LAUNCH_TAX_TABLE_HASH, "X01 the published tax table");
        laneTaxTable = table;
        exceptionNames =
            ["W1-U4-2", "W1-U4-3", "W2-U2-1", "W2-U2-2", "W2-U5-1", "W2-U6-1", "W3-U7-1", "M01", "M02", "M25", "M27"];
        for (uint256 i; i < 16; ++i) {
            _rememberRound(r0 + i);
        }
        _save();
        if (mode != 0) {
            _warpTo(hook.openAt());
            _run(Act.Window, 2 ether);
            _run(Act.Take, 2);
            _warpTo(_requestTimeFor(r0));
            _run(Act.Close, 0);
            _run(Act.Graduate, 0);
            if (silent) {
                _warpTo(src.roundTime(r0) + 5 days + 1);
            } else {
                _warpTo(src.roundTime(r0));
                _run(Act.Post, 0);
                _run(Act.Accept, 0);
                while (_placeholder() != 0) _run(Act.Open, 0);
            }
        }
        // Setup calls are checked, but campaign action counts start at zero.
        for (uint256 i; i < ACTIONS; ++i) {
            counts[i] = Count(0, 0, 0);
        }
        for (uint256 i; i < EDGES; ++i) {
            edgeHits[i] = 0;
        }
        checked = 0;
        _save();
        for (uint256 i; i < _ghostSystem.length; ++i) {
            assertGt(_ghostSystem[i].code.length, 0, "lane: deployed system account");
        }
        assertEq(royaltyRouter.coordinator(), a.coordinator, "lane: royalty wiring");
        driver = new AuditSysLaneHandler(this);
        targetContract(address(driver));
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = driver.step.selector;
        targetSelector(FuzzSelector(address(driver), selectors));
    }

    /// @notice Property X01-X21: each weighted, currently enabled transition preserves all applicable rules.
    function laneStep(uint256 choice, uint256 seed) external {
        require(msg.sender == address(driver), "lane: driver only");
        uint256 total;
        uint256[ACTIONS] memory weights;
        for (uint256 i; i < ACTIONS; ++i) {
            if (_enabled(Act(i))) weights[i] = _weight(Act(i));
            total += weights[i];
        }
        uint256 at = choice % total;
        for (uint256 i; i < ACTIONS; ++i) {
            if (at < weights[i]) {
                _run(Act(i), seed);
                return;
            }
            at -= weights[i];
        }
        revert("lane: empty menu");
    }

    function _weight(Act x) internal pure returns (uint256) {
        if (x == Act.Clock || x == Act.Buy || x == Act.Sell || x == Act.Open) return 4;
        if (x == Act.Window) return 6;
        if (x == Act.Draw || x == Act.Settle) return 5;
        if (
            x == Act.Take || x == Act.Collect || x == Act.StartBackup || x == Act.FixBackup || x == Act.Accept
                || x == Act.Return || x == Act.Pick || x == Act.Stream || x == Act.Terminal || x == Act.Cancel
                || x == Act.Number
        ) return 3;
        if (
            x == Act.Close || x == Act.FundDepth || x == Act.Deepen || x == Act.Sweep || x == Act.GiftT
                || x == Act.ForceEth || x == Act.Bounty || x == Act.Reward || x == Act.Burn || x == Act.WithdrawBounty
                || x == Act.GiftClaims
        ) return 1;
        return 2;
    }

    function _enabled(Act x) internal view returns (bool) {
        bool g = coordinator.graduated();
        IBoxTickets.TicketState memory s = tickets.status();
        if (x == Act.Window) {
            return
                !hook.closed() && vm.getBlockTimestamp() >= hook.openAt()
                    && vm.getBlockTimestamp() < hook.windowEndsAt();
        }
        if (x == Act.Buy || x == Act.Sell) {
            return (g || !hook.closed()) && vm.getBlockTimestamp() >= hook.windowEndsAt()
                && (x == Act.Buy || token.balanceOf(_richest()) > 1e18);
        }
        if (x == Act.Take) return !g && vm.getBlockTimestamp() >= hook.openAt() && vault.inside() > 2 && _canLock(1);
        if (x == Act.HandBack) return _placeholder() != 0 && (!g || (s.terminalAt != 0 && s.wordAcceptedAt == 0));
        if (x == Act.Close) return !hook.closed() && vm.getBlockTimestamp() >= hook.windowEndsAt();
        if (x == Act.Graduate) return hook.closed() && !g;
        if (x == Act.PayFit) return g && receiver.fitOwed() > 0;
        if (x == Act.PayPlatform) return g && receiver.platformOwed() > 0;
        if (x == Act.Sweep) return g && a.launchRouter.balance != 0;
        if (x == Act.Deepen) {
            if (!g) return false;
            uint256 last = hook.lastDeepenBlock();
            if (last == 0) last = hook.migratedAtBlock();
            (uint256 qBudget,) = hook.depthBudget();
            (bool ready,,) = executor.twap();
            return ready && qBudget >= hook.minAdd() && vm.getBlockNumber() >= last + hook.DEEPEN_COOLDOWN_BLOCKS();
        }
        if (x == Act.Execute) return g && a.executor.balance != 0;
        if (x == Act.Draw) return g && s.terminalAt == 0 && !_deadHead() && draws.length < 40 && _canLock(1);
        if (x == Act.Bounty) return _bountyRound(0) != 0;
        if (x == Act.Post) return !silent && _postable() != 0;
        if (x == Act.StartBackup) return _backupRound(false) != 0;
        if (x == Act.FixBackup) return _backupRound(true) != 0;
        if (x == Act.Accept) {
            return s.wordRequestedAt != 0 && s.wordAcceptedAt == 0 && s.terminalAt == 0 && _usable(0, s.wordRequestedAt);
        }
        if (x == Act.Settle) {
            return g && s.terminalAt == 0 && s.drawsSettled < s.drawsRequested
                && (s.slots == 0 || s.wordAcceptedAt != 0)
                && _usable(uint256(s.drawsSettled) + 1, tickets.drawTicket(uint256(s.drawsSettled) + 1).requestedAt);
        }
        if (x == Act.Open) return (s.wordAcceptedAt != 0 && _placeholder() != 0) || _drawWith(DrawStatus.Settled) != 0;
        if (x == Act.Return || x == Act.TransferItem) return _outsideItem() != 0;
        if (x == Act.Pick) return _shelfItem() != 0 && _canLock(25);
        if (x == Act.Stream) return g;
        if (x == Act.Terminal) return g && s.terminalAt == 0 && _deadHead();
        if (x == Act.Cancel) return s.terminalAt != 0 && _drawWith(DrawStatus.Requested) != 0;
        if (x == Act.Number) {
            return s.terminalAt != 0 && vm.getBlockTimestamp() >= uint256(s.terminalAt) + 3 days && _hiddenItem() != 0
                && _canLock(1);
        }
        if (x == Act.GiftT || x == Act.Burn) return token.balanceOf(_richest()) > 1e18;
        if (x == Act.Reward) return rewardCredit != 0;
        if (x == Act.WithdrawBounty) return drand.owedTo(poster) != 0;
        return true;
    }

    /// @notice Property X01-X21: each transition is measured, checked for allowed writes, and audited before returning.
    function _run(Act x, uint256 seed) internal {
        ++counts[uint256(x)].calls;
        _save();
        uint256 edgeAt = _edgeContext(x);
        for (uint256 i; i < _ghostSystem.length; ++i) {
            // Cooling newly created accounts in setUp loses untouched code in Forge 1.8.3 snapshots.
            // Only campaign calls cool accounts; every campaign begins after the setup transaction.
            require(_ghostSystem[i].code.length != 0, string.concat("lane: missing system code ", vm.toString(i)));
            if (address(driver) != address(0)) vm.cool(_ghostSystem[i]);
        }
        vm.record();
        vm.recordLogs();
        uint256 start = gasleft();
        bool success = _act(x, seed);
        uint256 used = start - gasleft() + 21_000;
        if (success) ++counts[uint256(x)].passed;
        if (used > counts[uint256(x)].gasMax) counts[uint256(x)].gasMax = used;
        // X18 is conservative: includes the fixture's bookkeeping, approvals and local model work.
        if (x != Act.Post && x != Act.Clock) assertLt(used, 16_777_216, "X18 keeper gas");
        _writes(x);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        // Valid no-ops can still sample prices. Only refused collection logs belong to a reverted call.
        if (success || x != Act.Collect) _events(logs);
        if (success) {
            _countEdge(x, edgeAt);
            _probeWriteOnce(x);
        }
        _temporal(x);
        if (hook.closed() && vm.getBlockTimestamp() < hook.windowEndsAt()) {
            (uint256 tax, uint256 net) = launchRouter.quote(1 ether);
            assertEq(tax + net, 1 ether, "W2-U2-1 quote partitions input after close");
            ++exceptions["W2-U2-1"];
        }
        _check();
        ++checked;
    }

    /// @notice Property X01/X07/X08/X09/X20: action-local payments, fee shares, credits and execution limits match their rules.
    function _act(Act x, uint256 seed) internal returns (bool) {
        address who = _richest();
        if (x == Act.Clock) {
            _clock(seed);
        } else if (x == Act.Window) {
            _windowBuyChecked(eoa[seed % 4], 0.01 ether + seed % (3 ether));
        } else if (x == Act.Buy) {
            _buy(eoa[seed % 4], 0.01 ether + seed % (0.8 ether));
        } else if (x == Act.Sell) {
            _sell(who, 1e18 + seed % (token.balanceOf(who) / 10));
        } else if (x == Act.Take) {
            _lockAction(x, who, seed);
        } else if (x == Act.HandBack) {
            _releaseAction(x, placeholderOwner[_placeholder()], _placeholder());
        } else if (x == Act.Close) {
            _buyTo(eoa[0], raise * 3, TickMath.getSqrtPriceAtTick(curve.tickLower));
        } else if (x == Act.Graduate) {
            vm.prank(keeper);
            rewardCredit = coordinator.graduate{gas: 15_000_000}();
            assertEq(rewardCredit, hook.reserveMinted(), "X20 minted reserve credited");
            if (directT[a.coordinator] != 0) {
                directT[a.coordinator] = 0;
                ++exceptions["W2-U2-2"];
            }
        } else if (x == Act.Collect) {
            try this.laneCollect() returns (FeeBatch memory batch) {
                assertLe(batch.tip, receiver.tipMax(), "X01 collect tip cap");
                _streamCoverage();
            } catch (bytes memory reason) {
                assertEq(
                    bytes4(reason), IBoxReceiver.BatchTooSmall.selector, "X09 collect refusal must be batch minimum"
                );
                return false;
            }
        } else if (x == Act.Fees) {
            uint256 amount = 1 + seed % (400 ether);
            (uint256 carry,) = receiver.carried();
            uint256 beforeFit = receiver.fitOwed();
            _fundFees(eoa[4], amount);
            assertEq(receiver.fitOwed() - beforeFit, ((amount + carry) / 15) * 11, "X01 exact 11/15 FIT");
        } else if (x == Act.FundDepth) {
            _fundDepth(eoa[4], 1 + seed % (2 ether));
            forced[a.receiver] = 0;
        } else if (x == Act.PayFit) {
            uint256 owed = receiver.fitOwed();
            uint256 paid = _payFit(keeper);
            assertEq(paid, owed, "X09 FIT ledger paid exactly");
            fitPaid += paid;
        } else if (x == Act.PayPlatform) {
            uint256 owed = receiver.platformOwed();
            uint256 paid = _payPlatform(keeper);
            assertEq(paid, owed, "X07 Safe ledger paid exactly");
            platformPaid += paid;
            (uint256 epoch,,) = receiver.platformEpoch();
            paidInEpoch[epoch] += paid;
            if (paidInEpoch[epoch] > 32 ether) ++exceptions["W1-U4-2"];
        } else if (x == Act.Royalty) {
            uint256 amount = 1 + seed % (0.3 ether);
            if (seed % 2 == 0) _payRoyalty(eoa[4], amount);
            else _payRoyaltyWeth(eoa[4], amount);
            if (coordinator.graduated()) royaltyRouter.flush();
        } else if (x == Act.Sweep) {
            launchRouter.sweep();
        } else if (x == Act.Deepen) {
            (DepthKind kind,,,,) = _deepen(keeper, eoa[5]);
            if (kind != DepthKind.None) ++depthChanges;
            return kind != DepthKind.None;
        } else if (x == Act.Execute) {
            (uint256 chunks, uint256 spent,) = executor.execute(1 + seed % 4);
            assertLe(chunks, 1, "X08 one executor chunk per block");
            if (!coordinator.graduated()) assertEq(spent, 0, "X08 no pregraduation spend");
            if (spent != 0) ++executeChanges;
            return spent != 0;
        } else if (x == Act.Draw) {
            _lockAction(x, who, seed);
        } else if (x == Act.Post) {
            uint256 round = _postable();
            _post(round);
            // X11 (review): drand keeps the committed round's randomness, read from the vectors, not from the source.
            bytes32 committed = _boxDrand(round).randomness;
            (bytes32 stored,) = drand.beaconOf(round);
            assertEq(stored, committed, "X11 drand stores the committed randomness");
            (randomnessOf[round], postedTimeOf[round], probeRound) = (committed, vm.getBlockTimestamp(), round);
        } else if (x == Act.StartBackup) {
            uint256 round = _backupRound(false);
            _startBackup(round, keeper);
            probeRound = round;
        } else if (x == Act.FixBackup) {
            uint256 round = _backupRound(true);
            bytes32 mix = keccak256(abi.encode(seed, checked));
            // X11 (review): the backup fixes the prevRandao the lane mined into its target header, and stores it.
            assertEq(_fixBackup(round, mix, poster), mix, "X11 backup fixes the target header's prevRandao");
            (,,, bytes32 stored) = src.backupOf(round);
            assertEq(stored, mix, "X11 backup stores the target header's prevRandao");
            (mixOf[round], fixedTimeOf[round], probeRound) = (mix, vm.getBlockTimestamp(), round);
        } else if (x == Act.Accept) {
            tickets.acceptGraduationWord();
        } else if (x == Act.Settle) {
            _settleReplay(1 + seed % 8);
        } else if (x == Act.Open) {
            _deliverOne();
        } else if (x == Act.Return) {
            _releaseAction(x, itemOwner[_outsideItem()], _outsideItem());
        } else if (x == Act.Pick) {
            _lockAction(x, who, _shelfItem());
        } else if (x == Act.Stream) {
            uint256 choice = seed % (touchedItems.length + 4);
            uint256 id = choice < touchedItems.length ? touchedItems[choice] : 0;
            address owner = id != 0 ? itemOwner[id] : eoa[choice % 4];
            if (owner == a.vault) {
                id = 0;
                owner = eoa[choice % 4];
            }
            _claimOwner(owner, id != 0 ? _one(id) : new uint256[](0));
            stream.burn();
        } else if (x == Act.Terminal) {
            tickets.enterTerminal();
        } else if (x == Act.Cancel) {
            _releaseAction(
                x, tickets.drawTicket(_drawWith(DrawStatus.Requested)).drawer, _drawWith(DrawStatus.Requested)
            );
        } else if (x == Act.Number) {
            _lockAction(x, who, _hiddenItem());
        } else if (x == Act.GiftT) {
            address[5] memory to = [a.receiver, a.royaltyRouter, a.tickets, a.coordinator, a.hook];
            address dest = to[seed % to.length];
            uint256 amount = 1 + seed % (token.balanceOf(who) / 1000);
            _transferT(who, dest, amount);
            directT[dest] += amount;
            ++exceptions[dest == a.receiver ? "M01" : dest == a.royaltyRouter ? "M02" : "M25"];
        } else if (x == Act.ForceEth) {
            address[5] memory to = [a.collection, a.tickets, a.token, a.launchRouter, a.receiver];
            address dest = to[seed % to.length];
            uint256 amount = 1 + seed % (0.1 ether);
            _forceEth(dest, amount);
            forced[dest] += amount;
            if (dest != a.receiver && dest != a.launchRouter) ++exceptions["M27"];
        } else if (x == Act.TransferItem) {
            uint256 id = _outsideItem();
            address dest = seed % 5 == 0 ? a.receiver : eoa[seed % 4];
            vm.prank(itemOwner[id]);
            collection.transferFrom(itemOwner[id], dest, id);
            itemOwner[id] = dest;
            if (dest == a.receiver) ++exceptions["W3-U7-1"];
        } else if (x == Act.Bounty) {
            uint256 round = _bountyRound(seed);
            _addBounty(eoa[4], round, 1 + seed % (0.001 ether), seed % 2 == 0);
        } else if (x == Act.Reward) {
            uint256 amount = _claimReward(keeper, eoa[5]);
            assertEq(amount, rewardCredit, "X20 exact reward payment");
            rewardCredit = 0;
        } else if (x == Act.Poke) {
            executor.poke();
        } else if (x == Act.Burn) {
            uint256 room = token.totalSupply() - vault.escrowPrincipal() - vault.inside();
            uint256 amount = token.balanceOf(who) / 1000;
            if (amount > room) amount = room;
            _burnT(who, amount);
        } else if (x == Act.WithdrawBounty) {
            _withdrawBounty(poster, payable(eoa[5]));
        } else if (x == Act.GiftClaims) {
            // W1-U4-3 (review): a stranger's ERC-6909 ETH claims sent to the receiver are in no ledger: they wait as
            // its next batch (the event model books the arrival) until a collect or the settlement splits them.
            uint256 amount = 1 + seed % (0.01 ether);
            _fund(address(this), amount);
            pm.unlock(abi.encode(a.receiver, amount));
            _noteEthIn(EthIn.Other, amount);
        }
        return true;
    }

    /// @notice The claims gift's unlock (W1-U4-3): pays `amount` of ETH into the PoolManager and mints the claims to `to`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "lane: PoolManager only");
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.mint(to, 0, amount);
        return "";
    }

    /// @notice Property X11 (review): a source write happens once per round. Right after a successful post, backup start
    /// or backup fix, the same write again (the same signature, the same parent header, the same target header) is
    /// refused, so no later call can move a word or its ready time.
    function _probeWriteOnce(Act x) internal {
        if (x != Act.Post && x != Act.StartBackup && x != Act.FixBackup) return;
        uint256 round = probeRound;
        bytes memory call;
        address to = address(src);
        address who = keeper;
        if (x == Act.Post) {
            (to, who) = (address(drand), poster);
            call = abi.encodeCall(drand.postRound, (round, _boxDrand(round).xy));
        } else if (x == Act.StartBackup) {
            call = abi.encodeCall(src.startBackup, (round, vm.getBlockNumber() - 1, _parentHeader()));
        } else {
            (, uint64 target,,) = src.backupOf(round);
            (call, who) = (abi.encodeCall(src.fixBackup, (round, _mineHeader(target, mixOf[round]))), poster);
        }
        vm.prank(who);
        (bool ok,) = to.call(call);
        assertFalse(ok, "X11 a round's post, backup start or backup fix happens once");
    }

    /// @notice Property: a refused subminimum collection changes neither the system nor its ghost ledger.
    function laneCollect() external returns (FeeBatch memory) {
        require(msg.sender == address(this), "lane: self only");
        return _collect(keeper, eoa[5]);
    }

    /// @notice Property X01 (BC-022, BC-024; review): a window buy keeps exactly its step's published tax, rounded up,
    /// and at a closing fill only the tax on the input that entered the curve, at the same rate of the gross.
    function _windowBuyChecked(address who, uint256 qIn) internal {
        uint256 pips = laneTaxTable[(vm.getBlockTimestamp() - hook.openAt()) / 12];
        uint256 routerBefore = a.launchRouter.balance;
        uint256 countedBefore = launchRouter.totalTaxCollected();
        uint256 ethBefore = who.balance;
        _windowBuy(who, qIn);
        uint256 tax = a.launchRouter.balance - routerBefore;
        // The helper funds qIn, the buy takes qIn and returns the refund: the buyer's net change is the refund.
        uint256 refund = who.balance - ethBefore;
        uint256 expected = (qIn * pips + 1e6 - 1) / 1e6;
        if (refund != 0) {
            uint256 filled = qIn - tax - refund;
            uint256 onFilled = (filled * pips + (1e6 - pips) - 1) / (1e6 - pips);
            if (onFilled < expected) expected = onFilled;
        }
        assertEq(tax, expected, "X01 window buy keeps the step's published tax");
        assertEq(launchRouter.totalTaxCollected() - countedBefore, tax, "X01 router counts the tax it kept");
    }

    /// @notice Property X14: locks use pre-action active supply, ceiling division and a flat burned fee.
    function _lockAction(Act x, address who, uint256 seed) internal {
        uint256 count = x == Act.Take ? 1 + seed % 3 : 1;
        uint256 p = (vault.activeSupply() * count + vault.inside() - 1) / vault.inside();
        uint256 f = (p * (x == Act.Pick ? 2500 : 100) + 9999) / 10000;
        if (token.balanceOf(who) < p + f || count >= vault.inside()) count = 1;
        p = (vault.activeSupply() * count + vault.inside() - 1) / vault.inside();
        f = (p * (x == Act.Pick ? 2500 : 100) + 9999) / 10000;
        uint256 balance = token.balanceOf(who);
        uint256 escrow = vault.escrowPrincipal();
        uint256 supply = token.totalSupply();
        if (x == Act.Take) {
            uint256 first = _take(who, count);
            for (uint256 i; i < count; ++i) {
                placeholders.push(first + i);
                placeholderOwner[first + i] = who;
            }
            minted += count;
        } else if (x == Act.Draw) {
            uint256 id = _draw(who, AUDIT_DRAW_VALUE);
            assertEq(id, draws.length + 1, "X13 sequential request ids");
            draws.push(id);
            ++pendingDraws;
        } else if (x == Act.Pick) {
            _pick(who, seed);
        } else {
            uint256 index;
            if (poolBuilt) while (index < pool.length && _permute(pool[index]) != seed) ++index;
            _approveT(who, a.tickets);
            ItemReveal memory reveal = _prepareReveal(seed);
            uint256 beforeT = token.balanceOf(who);
            vm.prank(who);
            tickets.takeByNumber(seed, index, type(uint256).max, vm.getBlockTimestamp(), reveal);
            _noteTChange(beforeT, token.balanceOf(who), TIn.TakeByNumber, TOut.Other);
            _trackItem(seed, who);
            assertFalse(everDelivered[seed], "X19 hidden item delivered once");
            everDelivered[seed] = true;
            ++delivered;
        }
        assertEq(balance - token.balanceOf(who), p + f, "X14 lock payment");
        assertEq(vault.escrowPrincipal(), escrow + p, "X14 lock escrow");
        assertEq(token.totalSupply(), supply - f, "X14 lock fee burned");
        if (x == Act.Pick) itemOwner[seed] = who;
    }

    /// @notice Property X14: releases use a floor quote and burn only the configured return fee (zero in terminal).
    function _releaseAction(Act x, address who, uint256 id) internal {
        uint256 p = vault.activeSupply() / vault.inside();
        bool free = x == Act.Cancel || (x == Act.HandBack && tickets.status().terminalAt != 0);
        uint256 f = free ? 0 : (p * 500 + 9999) / 10000;
        uint256 balance = token.balanceOf(who);
        uint256 escrow = vault.escrowPrincipal();
        uint256 supply = token.totalSupply();
        if (x == Act.HandBack) {
            _handBack(who, _one(id));
            placeholderOwner[id] = address(0);
            ++burnedTickets;
        } else if (x == Act.Cancel) {
            _cancelDraw(keeper, id);
            --pendingDraws;
        } else {
            _returnItem(who, id);
            itemOwner[id] = a.vault;
        }
        assertEq(token.balanceOf(who) - balance, p - f, "X14 release payment");
        assertEq(vault.escrowPrincipal(), escrow - p, "X14 release escrow");
        assertEq(token.totalSupply(), supply - f, "X14 release fee burned");
    }

    /// @notice Property X10/X21: a stream payout belongs to its entitled owner, including M01/M25 box-contract owners,
    /// and a claim pays the owner's whole due but one raw unit, up to the T the stream holds.
    function _claimOwner(address owner, uint256[] memory ids) internal {
        uint256 beforeT = token.balanceOf(owner);
        // X10 (review): the due is what the stream booked to the owner plus each named item's accrual since its record.
        uint256 due = stream.owedOf(owner);
        for (uint256 i; i < ids.length; ++i) {
            (address recorded, uint256 pending) = stream.pendingOf(ids[i]);
            if (recorded == owner) due += pending;
        }
        uint256 paid;
        if (_ghostIsSystem[owner]) {
            vm.prank(keeper);
            paid = stream.claimFor(owner, ids);
            directT[owner] += paid;
            if (paid != 0) ++exceptions[owner == a.receiver ? "M01" : owner == a.royaltyRouter ? "M02" : "M25"];
        } else {
            paid = _claimStreamFor(keeper, owner, ids);
        }
        assertEq(token.balanceOf(owner), beforeT + paid, "X10 stream pays the owner exactly");
        uint256 left = stream.owedOf(owner);
        assertEq(paid + left, due, "X10 a claim books the owner's whole due as paid or still owed");
        assertTrue(
            left <= 1 || token.balanceOf(a.itemStream) == 0, "X10 a claim pays all but one raw unit while T is held"
        );
    }

    function _prepareReveal(uint256 item) internal returns (ItemReveal memory reveal) {
        // Fixture Merkle-tree construction is not part of the keeper transaction.
        vm.pauseGasMetering();
        reveal = _reveal(item);
        vm.resumeGasMetering();
    }

    /// @notice Property X19: a live ticket delivers exactly one previously undelivered item to its entitled owner.
    function _deliverOne() internal {
        uint256 id = _placeholder();
        uint256 item;
        address who;
        if (id != 0 && tickets.status().wordAcceptedAt != 0) {
            who = placeholderOwner[id];
            ItemReveal memory reveal = _prepareReveal(tickets.numberOf(id));
            vm.prank(who);
            item = tickets.open(id, reveal);
            placeholderOwner[id] = address(0);
            ++burnedTickets;
        } else {
            id = _drawWith(DrawStatus.Settled);
            who = tickets.drawTicket(id).drawer;
            ItemReveal memory reveal = _prepareReveal(tickets.drawTicket(id).itemId);
            vm.prank(keeper);
            item = tickets.openDraw(id, who, reveal);
            --pendingDraws;
        }
        assertFalse(everDelivered[item], "X19 ticket delivery cannot repeat");
        everDelivered[item] = true;
        ++delivered;
        _trackItem(item, who);
    }

    /// @notice Property X13: a full array with swap-and-pop independently replays the contract's sparse draw pool.
    function _settleReplay(uint256 max) internal {
        uint256 first = uint256(tickets.status().drawsSettled) + 1;
        uint256 n = _settle(keeper, max);
        assertGt(n, 0, "X12 usable head settles");
        for (uint256 id = first; id < first + n; ++id) {
            (bytes32 word,) = src.wordOf(a.tickets, id);
            uint256 index = uint256(keccak256(abi.encode(word, id))) % pool.length;
            uint256 expected = _permute(pool[index]);
            assertEq(tickets.drawTicket(id).itemId, expected, "X13 independent draw replay");
            pool[index] = pool[pool.length - 1];
            pool.pop();
            ++settledDraws;
            uint256 hoursTaken = (vm.getBlockTimestamp() - tickets.drawTicket(id).requestedAt + 3599) / 3600;
            if (hoursTaken > type(uint16).max) ++exceptions["W2-U6-1"];
        }
    }

    /// @notice Property: numbered items use the specified eight-round Feistel, implemented with a loop and cycle walk.
    function _permute(uint256 position) internal view returns (uint256) {
        if (tickets.status().slots == 0) return tickets.firstId() + position;
        uint256 bits = 2;
        while (2 ** bits < editionSize) ++bits;
        uint256 high = bits / 2;
        uint256 low = bits - high;
        uint256 value = position;
        bytes32 word = tickets.graduationWord();
        do {
            uint256 left = value >> low;
            uint256 right = value & (2 ** low - 1);
            for (uint256 i; i < 8; ++i) {
                uint256 width = i % 2 == 0 ? high : low;
                uint256 next = (left ^ uint256(keccak256(abi.encode(word, (i << 128) | right)))) & (2 ** width - 1);
                left = right;
                right = next;
            }
            value = (left << low) | right;
        } while (value >= editionSize);
        return tickets.firstId() + value;
    }

    function _clock(uint256 seed) internal {
        uint256 now_ = vm.getBlockTimestamp();
        uint256[17] memory edges;
        edges[0] = hook.openAt();
        edges[1] = hook.windowEndsAt();
        edges[2] = now_ + 12;
        edges[3] = now_ + 1 hours;
        edges[4] = now_ + 30 days;
        edges[5] = now_ + 8191 * 12;
        edges[6] = now_ + 8192 * 12;
        uint256 round = _headRound();
        if (round == 0) round = r0;
        uint256 at = src.roundTime(round);
        edges[7] = at + 5 days;
        edges[8] = at + 5 days + 18 hours;
        (uint256 key, uint256 since) = _head();
        key;
        edges[9] = since + 7 days;
        // Review: the next 30-day platform epoch boundary, not only the first one.
        uint256 g = coordinator.graduatedAt();
        edges[10] = g == 0 ? now_ + 12 : g + 30 days * ((now_ > g ? (now_ - g) / 30 days : 0) + 1);
        edges[11] = uint256(tickets.status().terminalAt) + 3 days;
        (, uint64 target, uint64 fixed_,) = src.backupOf(round);
        uint256 block_ = vm.getBlockNumber();
        edges[12] = target > block_ ? now_ + (target - block_ + 1) * 12 : now_ + 1;
        edges[13] = at + 12;
        edges[14] = now_ + 301 * 12;
        edges[15] = _requestTimeFor(r0);
        // Review: the history window's last block for an unfixed backup (offsets land on 8,191 or 8,192 blocks);
        // while one waits, one clock move in eight goes there, so the window's edge is reached, not only its inside.
        bool fixDue = target != 0 && fixed_ == 0 && target + 8191 > block_;
        edges[16] = fixDue ? now_ + (target + 8191 - block_) * 12 : now_ + 12;
        uint256 t = fixDue && (seed >> 128) % 8 == 0 ? edges[16] : edges[seed % edges.length];
        uint256 offset = (seed / edges.length) % 3;
        if (offset == 0 && t > 0) --t;
        if (offset == 2) ++t;
        if (t <= now_) t = now_ + 12;
        _warpTo(t);
    }

    /// @dev Reach (review): the reference time or block an action's edge is measured from, read before the action.
    function _edgeContext(Act x) internal view returns (uint256 at) {
        if (x == Act.StartBackup) {
            uint256 round = _backupRound(false);
            if (round != 0) at = src.roundTime(round);
        } else if (x == Act.FixBackup) {
            uint256 round = _backupRound(true);
            if (round != 0) (, at,,) = src.backupOf(round);
        } else if (x == Act.Settle || x == Act.Accept || x == Act.Terminal) {
            (, at) = _head();
        } else if (x == Act.Number) {
            at = tickets.status().terminalAt;
        }
    }

    /// @dev Reach (review): counts a successful action exactly on its edge (the first or last second or block a rule
    /// allows). The epoch edge is counted from the cap's own event (`_events`).
    function _countEdge(Act x, uint256 at) internal {
        if (at == 0) return;
        uint256 now_ = vm.getBlockTimestamp();
        if (x == Act.StartBackup) {
            if (now_ == at + 5 days + 1) ++edgeHits[0];
            if (now_ == at + 5 days + 18 hours) ++edgeHits[1];
        } else if (x == Act.Settle || x == Act.Accept) {
            // The live side of the 7-day rule: a word ready in time is consumed at or after the deadline.
            if (now_ >= at + 7 days) ++edgeHits[2];
        } else if (x == Act.Terminal) {
            if (now_ == at + 7 days + 1) ++edgeHits[3];
        } else if (x == Act.FixBackup) {
            if (vm.getBlockNumber() == at + 8191) ++edgeHits[5];
        } else if (x == Act.Number) {
            if (now_ == at + 3 days) ++edgeHits[6];
        }
    }

    function _edgeName(uint256 i) internal pure returns (string memory) {
        if (i == 0) return "backup start at round time + 5 d + 1 s";
        if (i == 1) return "backup start at round time + 5 d 18 h";
        if (i == 2) return "head settled or accepted at or after request + 7 d";
        if (i == 3) return "terminal at request + 7 d + 1 s";
        if (i == 4) return "platform credit at an epoch's last or first second (30 d)";
        if (i == 5) return "backup fixed at target + 8191 blocks";
        return "take by number at terminal + 3 d";
    }

    function _head() internal view returns (uint256 key, uint256 since) {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.slots != 0 && s.wordAcceptedAt == 0) return (0, s.wordRequestedAt);
        if (s.drawsSettled < s.drawsRequested) {
            key = uint256(s.drawsSettled) + 1;
            since = tickets.drawTicket(key).requestedAt;
        }
    }

    function _headRound() internal view returns (uint256 round) {
        (uint256 key, uint256 since) = _head();
        if (since != 0) (, round) = src.requestOf(a.tickets, key);
    }

    function _deadHead() internal view returns (bool) {
        (uint256 key, uint256 since) = _head();
        return since != 0 && vm.getBlockTimestamp() > since + 7 days && !_usable(key, since);
    }

    function _usable(uint256 key, uint256 since) internal view returns (bool) {
        (bytes32 word, uint64 ready) = src.wordOf(a.tickets, key);
        return word != 0 && ready >= since && ready <= vm.getBlockTimestamp() && ready <= since + 7 days;
    }

    function _backupRound(bool fixing) internal view returns (uint256) {
        for (uint256 i; i < rounds.length; ++i) {
            uint256 r = rounds[i];
            if (!requestedRound[r]) continue;
            (uint64 started, uint64 target, uint64 fixed_,) = src.backupOf(r);
            if (fixing) {
                if (started != 0 && fixed_ == 0 && vm.getBlockNumber() > target && vm.getBlockNumber() - target <= 8191)
                {
                    return r;
                }
            } else {
                (, uint64 posted) = drand.beaconOf(r);
                uint256 t = src.roundTime(r);
                if (
                    posted == 0 && started == 0 && vm.getBlockTimestamp() > t + 5 days
                        && vm.getBlockTimestamp() <= t + 5 days + 18 hours
                ) return r;
            }
        }
        return 0;
    }

    function _bountyRound(uint256 seed) internal view returns (uint256) {
        for (uint256 i; i < rounds.length; ++i) {
            uint256 round = rounds[(seed % rounds.length + i) % rounds.length];
            (, uint64 posted) = drand.beaconOf(round);
            if (posted == 0) return round;
        }
        return 0;
    }

    function _postable() internal view returns (uint256) {
        for (uint256 i; i < 16; ++i) {
            (, uint64 posted) = drand.beaconOf(r0 + i);
            if (posted == 0 && vm.getBlockTimestamp() >= src.roundTime(r0 + i)) return r0 + i;
        }
        return 0;
    }

    function _richest() internal view returns (address who) {
        who = eoa[0];
        for (uint256 i = 1; i < 4; ++i) {
            if (token.balanceOf(eoa[i]) > token.balanceOf(who)) who = eoa[i];
        }
    }

    function _canLock(uint256 percent) internal view returns (bool) {
        if (vault.inside() <= 1) return false;
        uint256 p = (vault.activeSupply() + vault.inside() - 1) / vault.inside();
        return token.balanceOf(_richest()) >= p + (p * percent + 99) / 100;
    }

    function _placeholder() internal view returns (uint256) {
        for (uint256 i; i < placeholders.length; ++i) {
            if (placeholderOwner[placeholders[i]] != address(0)) return placeholders[i];
        }
        return 0;
    }

    function _drawWith(DrawStatus status) internal view returns (uint256) {
        for (uint256 i; i < draws.length; ++i) {
            if (tickets.drawTicket(draws[i]).status == status) return draws[i];
        }
        return 0;
    }

    function _outsideItem() internal view returns (uint256) {
        for (uint256 i; i < touchedItems.length; ++i) {
            address owner = itemOwner[touchedItems[i]];
            if (_ghostIsOutside[owner]) return touchedItems[i];
        }
        return 0;
    }

    function _shelfItem() internal view returns (uint256) {
        for (uint256 i; i < touchedItems.length; ++i) {
            if (itemOwner[touchedItems[i]] == a.vault) return touchedItems[i];
        }
        return 0;
    }

    function _hiddenItem() internal view returns (uint256) {
        if (poolBuilt) {
            for (uint256 i; i < pool.length; ++i) {
                uint256 id = _permute(pool[i]);
                if (vault.isHidden(id)) return id;
            }
        } else {
            for (uint256 id = tickets.firstId(); id < tickets.firstId() + 100; ++id) {
                if (vault.isHidden(id)) return id;
            }
        }
        return 0;
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _trackItem(uint256 id, address owner) internal {
        if (!touched[id]) {
            touched[id] = true;
            touchedItems.push(id);
        }
        itemOwner[id] = owner;
    }

    function _rememberRound(uint256 round) internal {
        if (round != 0 && !roundKnown[round]) {
            roundKnown[round] = true;
            rounds.push(round);
        }
    }

    function _save() internal {
        oldSupply = token.totalSupply();
        oldPhase = uint256(coordinator.phase());
        oldClosed = hook.closedAtBlock();
        oldGraduated = coordinator.graduatedAt();
        oldReserve = hook.reserveMinted();
        oldIndex = stream.index();
        oldValue = stream.streamValue();
        (oldClaimed, oldBurned) = stream.totals();
        oldPair = hook.pairedLiquidity();
        (oldAsk, oldBid, oldSentinel) = hook.graduatedLayout();
        oldHeld = receiver.platformHeld();
    }

    /// @notice Property X02/X05/X06/X10/X11/X16: irreversible values never go backwards within a handler call.
    function _temporal(Act action) internal {
        assertLe(token.totalSupply(), oldSupply, "X02 supply cannot increase");
        assertGe(uint256(coordinator.phase()), oldPhase, "X05 phase order");
        if (oldClosed != 0) assertEq(hook.closedAtBlock(), oldClosed, "X05 close is fixed");
        if (oldGraduated != 0) assertEq(coordinator.graduatedAt(), oldGraduated, "X06 graduation is fixed");
        assertGe(hook.reserveMinted(), oldReserve, "X09 reserve never falls");
        assertGe(stream.index(), oldIndex, "X10 index monotone");
        assertGe(stream.streamValue(), oldValue, "X10 value monotone");
        (uint256 claimed, uint256 burned) = stream.totals();
        assertGe(claimed, oldClaimed, "X10 claims monotone");
        assertGe(burned, oldBurned, "X10 burns monotone");
        (uint256 ask, uint256 bid, uint256 sentinel) = hook.graduatedLayout();
        assertGe(ask, oldAsk, "X16 ask cannot shrink");
        assertGe(bid, oldBid, "X16 bid cannot shrink");
        assertGe(sentinel, oldSentinel, "X16 sentinel cannot shrink");
        assertGe(hook.pairedLiquidity(), oldPair, "X16 pair cannot shrink");
        IBoxTickets.TicketState memory s = tickets.status();
        // X17 proves other actions cannot write either source. Recheck all keys on every source-writing action.
        bool sourceWrite = action == Act.Post || action == Act.StartBackup || action == Act.FixBackup
            || action == Act.Graduate || action == Act.Draw || action == Act.Bounty || action == Act.WithdrawBounty;
        for (uint256 key; sourceWrite && key <= draws.length; ++key) {
            (, uint64 round) = src.requestOf(a.tickets, key);
            _rememberRound(round);
            if (round != 0) requestedRound[round] = true;
            (bytes32 word, uint64 ready) = src.wordOf(a.tickets, key);
            if (fixedWord[key] != 0) {
                assertEq(word, fixedWord[key], "X11 fixed word cannot change");
                assertEq(ready, fixedAt[key], "X11 ready time cannot change");
            }
            if (word != 0) {
                // Review: the expected word and time come from what the lane put in (the mined prevRandao, the
                // committed randomness, the post's or fix's time), never from the source's own storage.
                (uint64 start,,,) = src.backupOf(round);
                bytes32 expected = start != 0
                    ? _word(src.BACKUP_TAG(), mixOf[round], key)
                    : _word(src.DRAND_TAG(), randomnessOf[round], key);
                assertEq(word, expected, "X11 source provenance");
                assertEq(ready, start != 0 ? fixedTimeOf[round] : postedTimeOf[round], "X11 source ready time");
                fixedWord[key] = word;
                fixedAt[key] = ready;
            }
        }
        if (!poolBuilt && coordinator.graduated() && (s.slots == 0 || s.wordAcceptedAt != 0)) {
            for (uint256 i = s.slots; i < editionSize; ++i) {
                pool.push(i);
            }
            poolBuilt = true;
        }
    }

    /// @notice Property X07/X09: credits consume their epoch cap once and named claim arrivals book or remain in the next batch.
    function _events(Vm.Log[] memory logs) internal {
        bytes32 credited = keccak256("PlatformCredited(uint256,uint256,uint256,uint256)");
        // X01 (review): a graduated split passes its platform share through the cap just before its BatchSplit (the
        // settlement's held share before GraduationSettled), so the cap's keep and overflow pair with the next split.
        bool capSeen;
        uint256 capKept;
        uint256 capOverflow;
        uint256 heldAdded;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            // X09: unallocated claims are modelled from arrivals and their named booking events,
            // never defined as the difference between production claims and production ledgers.
            if (
                l.emitter == address(pm)
                    && l.topics[0] == keccak256("Transfer(address,address,address,uint256,uint256)")
                    && address(uint160(uint256(l.topics[2]))) == a.receiver
            ) {
                (, uint256 amount) = abi.decode(l.data, (address, uint256));
                if (uint256(l.topics[3]) == 0) nextQ += amount;
                else if (uint256(l.topics[3]) == uint256(uint160(a.token))) nextT += amount;
            }
            if (l.emitter == a.receiver) {
                bytes32 topic = l.topics[0];
                if (topic == keccak256("FeesFunded(address,uint256)")) nextQ -= abi.decode(l.data, (uint256));
                if (topic == keccak256("DepthGifted(address,uint256)") && !coordinator.graduated()) {
                    nextQ -= abi.decode(l.data, (uint256));
                }
                if (
                    topic == keccak256("Collected(address,address,uint256,uint256,uint256,uint256)")
                        || topic == keccak256("GraduationSettled(uint256,uint256,uint256,uint256,uint256)")
                ) {
                    nextQ = 0;
                    nextT = 0;
                }
                if (topic == keccak256("GraduationSettled(uint256,uint256,uint256,uint256,uint256)")) capSeen = false;
            }
            if (
                l.emitter == a.receiver
                    && l.topics[0]
                        == keccak256("BatchSplit(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)")
            ) {
                heldAdded += _splitEvent(l.data, capSeen, capKept, capOverflow);
                capSeen = false;
            }
            if (l.emitter == a.receiver && l.topics[0] == credited) {
                uint256 epoch = uint256(l.topics[1]);
                (uint256 kept, uint256 overflow, uint256 total) = abi.decode(l.data, (uint256, uint256, uint256));
                uint256 room = 32 ether - creditInEpoch[epoch];
                uint256 expected = kept + overflow < room ? kept + overflow : room;
                assertEq(kept, expected, "X07 keep min(share, remaining cap)");
                creditInEpoch[epoch] += kept;
                platformCredits += kept;
                assertEq(total, creditInEpoch[epoch], "X07 cap counts credits");
                assertLe(total, 32 ether, "X07 epoch credit cap");
                (capSeen, capKept, capOverflow) = (true, kept, overflow);
                uint256 g = coordinator.graduatedAt();
                if (g != 0 && vm.getBlockTimestamp() > g) {
                    uint256 r = (vm.getBlockTimestamp() - g) % 30 days;
                    if (r == 0 || r == 30 days - 1) ++edgeHits[4];
                }
            }
        }
        // X01 (review): before graduation each split's platform 2/15 waits in `platformHeld` (BC-106, epoch 0).
        if (!coordinator.graduated()) {
            assertEq(receiver.platformHeld(), oldHeld + heldAdded, "X01 platform two fifteenths held until graduation");
        }
    }

    /// @notice Property X01: every batch uses exact fifteenths, with the platform overflow assigned only to depth.
    /// Review: the platform share and the depth share are each two fifteenths (not only their sum): after graduation
    /// the platform's 2/15 enters the cap (its keep is the batch's platform credit, its overflow joins depth); before,
    /// it is held. Returns the Q the split adds to `platformHeld`.
    function _splitEvent(bytes memory data, bool capSeen, uint256 capKept, uint256 capOverflow)
        internal
        view
        returns (uint256 held)
    {
        uint256[8] memory b = abi.decode(data, (uint256[8]));
        assertEq(b[0] + b[4] + b[5], 0, "X01 no creator or T-FIT share for box zero");
        assertEq(b[1] % 11, 0, "X01 FIT share in elevenths");
        uint256 unit = b[1] / 11;
        assertEq(b[2] + b[3], unit * (coordinator.graduated() ? 4 : 2), "X01 depth plus capped platform");
        if (coordinator.graduated()) {
            assertEq(capSeen ? capKept + capOverflow : 0, unit * 2, "X01 platform share is two fifteenths");
            assertEq(b[3], capSeen ? capKept : 0, "X01 platform credit is the cap's keep");
            assertEq(b[2], unit * 2 + (capSeen ? capOverflow : 0), "X01 depth is two fifteenths plus the overflow");
        } else {
            assertEq(b[2], unit * 2, "X01 depth is two fifteenths");
            held = unit * 2;
        }
        assertEq(b[6] % 2, 0, "X01 T depth share in halves");
        assertEq(b[7], coordinator.graduated() ? 0 : (b[6] / 2) * 13, "X01 curve T burn share");
    }

    /// @notice Property X17: a call writes only its documented subsystem, never the factory, registry or table.
    function _writes(Act x) internal {
        for (uint256 i; i < _ghostSystem.length; ++i) {
            address account = _ghostSystem[i];
            (, bytes32[] memory written) = vm.accesses(account);
            if (written.length == 0) continue;
            bool allowed;
            if (x == Act.Graduate) {
                allowed = account != a.collection && account != a.launchRouter && account != a.royaltyRouter;
            } else if (x == Act.Clock || x == Act.ForceEth) {
                allowed = false;
            } else if (x == Act.Post || x == Act.Bounty || x == Act.WithdrawBounty) {
                allowed = account == address(drand);
            } else if (x == Act.StartBackup || x == Act.FixBackup) {
                allowed = account == address(src);
            } else if (x == Act.Reward) {
                allowed = account == a.coordinator || account == address(pm);
            } else if (x == Act.GiftClaims) {
                allowed = account == address(pm);
            } else if (x == Act.GiftT || x == Act.Burn) {
                allowed = account == a.token;
            } else if (x == Act.Poke) {
                allowed = account == a.executor;
            } else if (
                x == Act.Take || x == Act.HandBack || x == Act.Draw || x == Act.Accept || x == Act.Settle
                    || x == Act.Open || x == Act.Return || x == Act.Pick || x == Act.Stream || x == Act.Terminal
                    || x == Act.Cancel || x == Act.Number || x == Act.TransferItem
            ) {
                allowed = account == a.tickets || account == a.vault || account == a.collection || account == a.token
                    || account == a.itemStream || (account == address(drand) && x == Act.Draw);
            } else {
                allowed = account == address(pm) || account == a.hook || account == a.token || account == a.receiver
                    || account == a.executor || account == a.itemStream
                    || (x == Act.Window && account == a.launchRouter) || (x == Act.Sweep && account == a.launchRouter)
                    || (x == Act.Royalty && account == a.royaltyRouter);
            }
            assertTrue(
                allowed && account != address(factory) && account != address(factory.registry()) && account != a.table,
                string.concat("X17 write outside action mask: ", vm.toString(uint256(x)), " / ", vm.toString(i))
            );
        }
    }

    /// @notice Property X01/X02: outside-side bookings conserve ETH and T; every raw token has a named owner.
    function _conservation() internal view {
        _assertGhostLedger();
        assertEq(token.balanceOf(a.vault), vault.escrowPrincipal(), "X02 vault T equals E");
        assertEq(
            token.balanceOf(a.receiver),
            receiver.tBurnPending() + directT[a.receiver],
            "X02 receiver pending burn + M01"
        );
        for (uint256 i; i < _ghostSystem.length; ++i) {
            address place = _ghostSystem[i];
            if (
                place != address(pm) && place != address(drand) && place != a.executor && place != a.launchRouter
                    && place != a.royaltyRouter
            ) assertEq(place.balance, forced[place], "X01 raw ETH has a named forced destination");
            if (
                place == address(pm) || place == a.vault || place == a.receiver || place == a.itemStream
                    || place == a.coordinator
            ) continue;
            assertEq(token.balanceOf(place), directT[place], "X02 system T has only a named direct owner");
        }
        if (coordinator.graduated()) {
            assertEq(token.balanceOf(a.coordinator), directT[a.coordinator], "X02 coordinator direct T after migration");
        }
        assertEq(
            a.launchRouter.balance + launchRouter.totalSwept(),
            launchRouter.totalTaxCollected() + forced[a.launchRouter],
            "X01 router tax and forced ETH"
        );
        assertEq(a.executor.balance + executor.totalEthSpent(), fitPaid, "X01 executor funding and spend");
        assertEq(safe.balance, platformPaid, "X01 Safe receipts");
        uint256 pots;
        for (uint256 i; i < rounds.length; ++i) {
            pots += drand.bountyOf(rounds[i]);
        }
        assertEq(address(drand).balance, pots + drand.owedTo(poster), "X01 drand pots and poster credits");
    }

    /// @notice Property X03/X04/X15/X19: item custody and ticket histories satisfy VLT-08 and single delivery.
    function _custody() internal view {
        uint256 n = vault.inside();
        uint256 t = vault.pendingTickets();
        uint256 e = vault.escrowPrincipal();
        uint256 supply = token.totalSupply();
        assertGe(n, 1, "X15 last item remains");
        assertLe(vault.hiddenCount(), n, "X15 hidden <= inside");
        assertGe(supply, e + n, "X02 supply floor");
        assertGe(e * n, (editionSize - n) * (supply - e), "X15 escrow backs outside slots");
        assertEq(collection.balanceOf(a.vault), n + t, "X03 physical vault = n + tickets");
        assertEq(collection.totalSupply(), editionSize, "X03 fixed N");
        uint256 outside;
        for (uint256 i; i < _ghostOutside.length; ++i) {
            outside += collection.balanceOf(_ghostOutside[i]);
        }
        for (uint256 i; i < _ghostSystem.length; ++i) {
            if (_ghostSystem[i] != a.vault) outside += collection.balanceOf(_ghostSystem[i]);
        }
        assertEq(outside + n + t, editionSize, "X03 known holders sum to N");
        uint256 liveBalances;
        for (uint256 i; i < 4; ++i) {
            liveBalances += tickets.balanceOf(eoa[i]);
        }
        assertEq(liveBalances, minted - burnedTickets, "X04 actual live balances = minted minus burned");
        assertEq(minted - burnedTickets + pendingDraws, t, "X04 live placeholders + pending draws");
        assertEq(tickets.status().minted, minted, "X04 issued placeholders");
        assertEq(tickets.status().drawsRequested, draws.length, "X13 draw requests");
        assertEq(tickets.status().drawsSettled, settledDraws, "X13 settled prefix");
        IBoxTickets.TicketState memory state = tickets.status();
        if (state.wordAcceptedAt != 0) {
            (bytes32 word, uint64 ready) = src.wordOf(a.tickets, 0);
            assertEq(tickets.graduationWord(), word, "X11 accepted word equals source");
            assertTrue(word != 0, "X11 accepted word is nonzero");
            assertGe(ready, state.wordRequestedAt, "X11 word ready after request");
            assertLe(ready, uint256(state.wordRequestedAt) + 7 days, "X11 word ready within deadline");
            assertLe(ready, state.wordAcceptedAt, "X11 word ready before acceptance");
        }
        for (uint256 i; i < placeholders.length; ++i) {
            uint256 id = placeholders[i];
            if (placeholderOwner[id] == address(0)) continue;
            assertEq(tickets.ownerOf(id), placeholderOwner[id], "X04 placeholder owner");
            uint256 slot = tickets.slotOf(id);
            assertLt(slot, tickets.status().slots, "X04 slot bound");
            for (uint256 j; j < i; ++j) {
                if (placeholderOwner[placeholders[j]] != address(0)) {
                    assertTrue(slot != tickets.slotOf(placeholders[j]), "X04 distinct live slots");
                }
            }
            if (tickets.status().wordAcceptedAt != 0) {
                uint256 item = _permute(slot);
                assertEq(tickets.numberOf(id), item, "X04 independent placeholder number");
                assertTrue(vault.isHidden(item), "X04 reserved item hidden");
            }
        }
        for (uint256 i; i < touchedItems.length; ++i) {
            uint256 id = touchedItems[i];
            assertEq(collection.ownerOf(id), itemOwner[id], "X03 ownership model");
            assertFalse(vault.isHidden(id), "X19 delivered never hidden again");
            assertEq(vault.isOutside(id), itemOwner[id] != a.vault, "X15 outside classification");
        }
        assertEq(delivered, touchedItems.length, "X19 one ticket delivery per touched item");
    }

    /// @notice Property X05-X10/X16/X20: phase gates, credits, ledgers, stream bounds and locked liquidity agree.
    function _accounting() internal view {
        bool g = coordinator.graduated();
        assertEq(uint256(coordinator.phase()), uint256(hook.phase()), "X05 phase agreement");
        assertEq(hook.openAt(), tickets.openAt(), "X05 ticket open time");
        assertEq(hook.openAt(), launchRouter.openAt(), "X05 router open time");
        assertEq(hook.closed(), hook.closedAtBlock() != 0, "X05 close flag");
        assertEq(g, hook.migratedAtBlock() != 0, "X06 migrated iff graduated");
        assertEq(g, vault.gateOpen(), "X06 vault gate iff graduated");
        if (g) {
            assertTrue(hook.closed(), "X06 close precedes graduation");
        } else {
            assertEq(executor.totalEthSpent(), 0, "X08 no early executor spend");
            assertEq(fitPaid, 0, "X08 no early FIT payout");
            assertEq(platformPaid, 0, "X07 no early platform payout");
            assertEq(receiver.platformOwed(), 0, "X07 held before graduation");
            assertFalse(stream.started(), "X08 stream starts at graduation");
            assertEq(stream.index(), 0, "X08 no early stream accrual");
        }
        _ledgers(g);
        _layout(g);
    }

    /// @notice Property X07/X09/X20: credits and held claims match the named ledgers.
    function _ledgers(bool g) internal view {
        (uint256 epoch, uint256 kept, uint256 left) = receiver.platformEpoch();
        assertEq(kept + left, 32 ether, "X07 remaining credit cap");
        if (g) assertEq(kept, creditInEpoch[epoch], "X07 current epoch credits");
        assertEq(receiver.platformOwed() + platformPaid, platformCredits, "X07 owed plus paid equals credited");
        (uint256 qCarry, uint256 tCarry) = receiver.carried();
        (uint256 qDepth, uint256 tDepth) = receiver.depthHeld();
        uint256 qBook = receiver.fitOwed() + receiver.platformOwed() + receiver.platformHeld() + qDepth + qCarry;
        uint256 tBook = tDepth + tCarry;
        (uint256 qReported, uint256 tReported) = receiver.booked();
        assertEq(qBook, qReported, "X09 independent Q ledger sum");
        assertEq(tBook, tReported, "X09 independent T ledger sum");
        assertEq(pm.balanceOf(a.receiver, 0), qBook + nextQ, "X09 Q claims = ledgers + next batch W1-U4-3");
        assertEq(
            pm.balanceOf(a.receiver, uint256(uint160(a.token))), tBook + nextT, "X09 T claims = ledgers + next batch"
        );
        assertLt(qCarry, 15, "X09 Q carry");
        assertLt(tCarry, 15, "X09 T carry");
        (uint256 dq, uint256 dt) = hook.depthBudget();
        assertEq(pm.balanceOf(a.hook, 0), dq, "X09 hook Q claims = depth");
        assertEq(pm.balanceOf(a.hook, uint256(uint160(a.token))), dt, "X09 hook T claims = depth");
        assertLe(hook.reserveMinted(), coordinator.rewardCap(), "X09 reserve cap");
        assertEq(
            pm.balanceOf(a.coordinator, 0), g ? rewardCredit : hook.reserveMinted(), "X09 reserve then reward claim"
        );
        assertEq(coordinator.rewardOf(keeper), rewardCredit, "X20 exact outstanding reward");
        assertLe(rewardCredit, raise / 1000, "X20 reward <= 0.1 percent R");
    }

    /// @notice Property X10/X16: the live index and migrated layout match their phase.
    function _layout(bool g) internal view {
        if (stream.started()) {
            assertEq(stream.index(), (stream.streamValue() - stream.startValue()) / editionSize, "X10 per item index");
            assertEq(stream.outsideCount(), editionSize - vault.inside(), "X10 outside slots");
        }
        (,, uint128 curveL) = hook.curve();
        (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
        if (g) {
            assertEq(curveL, 0, "X16 curve removed");
            assertGt(ask, 0, "X16 ask exists");
            assertGt(bid, 0, "X16 bid exists");
            if (exceptions["W2-U2-2"] == 0) assertGt(sentinel, 0, "X16 sentinel or named migration gift");
        } else {
            assertGt(curveL, 0, "X16 curve exists");
            assertEq(ask + bid + sentinel + hook.pairedLiquidity(), 0, "X16 only curve before migration");
        }
    }

    /// @notice Property X10: after a successful collect, any owner-liability deficit is at most N-1 raw T (W2-U5-1).
    function _streamCoverage() internal {
        if (!stream.started()) return;
        uint256 held = token.balanceOf(a.itemStream);
        uint256 owed = stream.liabilities();
        if (owed > held) {
            ++exceptions["W2-U5-1"];
            assertLe(owed - held, editionSize - 1, "X10 bounded owner deficit");
        }
    }

    /// @notice Property X10: after every action, a valid collection in a reverted snapshot covers owner liabilities within N-1 raw T.
    function _probeStreamCoverage() internal {
        if (!stream.started()) return;
        uint256 snapshot = vm.snapshotState();
        try this.laneCollect() returns (FeeBatch memory) {
            _streamCoverage();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), IBoxReceiver.BatchTooSmall.selector, "X10 only subminimum collection may refuse");
        }
        uint256 observations = exceptions["W2-U5-1"];
        assertTrue(vm.revertToStateAndDelete(snapshot), "lane: stream coverage probe restored");
        exceptions["W2-U5-1"] = observations;
    }

    /// @notice Property X01-X21: committed claims cover ledgers and independently modelled next batches, with custody and liveness preserved.
    function _check() internal {
        (uint256 q, uint256 t) = receiver.booked();
        uint256 qClaims = pm.balanceOf(a.receiver, 0);
        uint256 tClaims = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
        assertGe(qClaims, q, "X09 Q claims cover ledgers");
        assertGe(tClaims, t, "X09 T claims cover ledgers");
        assertEq(qClaims - q, nextQ, "X09 independently tracked next Q batch");
        assertEq(tClaims - t, nextT, "X09 independently tracked next T batch");
        if (nextQ != 0 || nextT != 0) ++exceptions["W1-U4-3"];
        _conservation();
        _custody();
        _accounting();
        _probeStreamCoverage();
        _queueProgress();
    }

    /// @notice Property X12: any keeper can consume a usable head or enter terminal for a dead one.
    function _queueProgress() internal {
        if (!coordinator.graduated() || tickets.status().terminalAt != 0) return;
        (uint256 key, uint256 since) = _head();
        if (since == 0) return;
        bool dead = _deadHead();
        if (!dead && !_usable(key, since)) return;
        bytes32 proof = keccak256(
            abi.encode(key, since, dead, tickets.status().wordAcceptedAt, vault.pendingTickets(), pool.length)
        );
        if (proof == progressProof) return;
        uint256 snapshot = vm.snapshotState();
        vm.prank(keeper);
        if (dead) tickets.enterTerminal();
        else if (key == 0) tickets.acceptGraduationWord();
        else assertEq(tickets.settle(1), 1, "X12 ready head settles one");
        assertTrue(vm.revertToStateAndDelete(snapshot), "lane: liveness probe restored");
        progressProof = proof;
    }

    /// @notice Property X06/X12/X21: a finite keeper sequence graduates, drains tickets, pays claims and names all residues.
    function afterInvariant() public {
        Count[ACTIONS] memory fuzzCounts = counts;
        uint256[EDGES] memory fuzzEdges = edgeHits;
        uint256 fuzzCalls = checked;
        if (!coordinator.graduated()) {
            if (vm.getBlockTimestamp() < hook.windowEndsAt()) _warpTo(hook.windowEndsAt());
            if (!hook.closed()) _run(Act.Close, 0);
            _run(Act.Graduate, 0);
        }
        // A usable word is consumed even if the keeper waited; an unusable head enters terminal after its deadline.
        for (uint256 i; i <= draws.length + 1; ++i) {
            if (_enabled(Act.Accept)) {
                _run(Act.Accept, 0);
            } else if (_enabled(Act.Settle)) {
                _run(Act.Settle, 7);
            } else {
                (, uint256 since) = _head();
                if (since == 0 || tickets.status().terminalAt != 0) break;
                _warpTo(since + 7 days + 1);
                if (_enabled(Act.Terminal)) _run(Act.Terminal, 0);
                break;
            }
        }
        while (_enabled(Act.Open)) _run(Act.Open, 0);
        while (_enabled(Act.Cancel)) _run(Act.Cancel, 0);
        while (_enabled(Act.HandBack)) _run(Act.HandBack, 0);
        assertEq(vault.pendingTickets(), 0, "X12 no pending ticket after closing driver");
        if (_enabled(Act.Sweep)) _run(Act.Sweep, 0);
        _run(Act.Royalty, 0);
        _run(Act.FundDepth, 0);
        _run(Act.Execute, 0);
        _run(Act.Collect, 0);
        for (uint256 i; i < touchedItems.length + 4; ++i) {
            _run(Act.Stream, i);
        }
        _streamOwnersNamed();
        if (_enabled(Act.PayFit)) _run(Act.PayFit, 0);
        if (_enabled(Act.PayPlatform)) _run(Act.PayPlatform, 0);
        if (_enabled(Act.Reward)) _run(Act.Reward, 0);
        if (_enabled(Act.WithdrawBounty)) _run(Act.WithdrawBounty, 0);
        _fullPartition();
        if (fuzzCalls != 0) _report(fuzzCounts, fuzzCalls, fuzzEdges);
    }

    /// @notice Property X10/X21 (review): once every ticket is closed and every outside item's owner has claimed with
    /// its ids (records at the current J), the stream's liabilities (Σ m·ΔJ less claims) are exactly the T it books to
    /// named owners: no accrual is lost between an item's record and its owner's book.
    function _streamOwnersNamed() internal view {
        uint256 named;
        for (uint256 i; i < _ghostOutside.length; ++i) {
            named += stream.owedOf(_ghostOutside[i]);
        }
        for (uint256 i; i < _ghostSystem.length; ++i) {
            named += stream.owedOf(_ghostSystem[i]);
        }
        assertEq(stream.liabilities(), named, "X21 stream liabilities are owed to named owners");
    }

    /// @notice Property X21: every final balance is escrow, pool liquidity, a named payable ledger, budget, pot, or accepted no-exit gift.
    function _fullPartition() internal view {
        assertEq(receiver.fitOwed(), 0, "X21 FIT claim paid");
        assertEq(receiver.platformOwed(), 0, "X21 Safe claim paid");
        assertEq(rewardCredit, 0, "X21 reward paid");
        assertEq(drand.owedTo(poster), 0, "X21 poster paid");
        assertEq(a.launchRouter.balance, 0, "X21 launch tax swept");
        assertEq(a.royaltyRouter.balance, 0, "X21 royalties flushed");
        for (uint256 i; i < _ghostSystem.length; ++i) {
            address place = _ghostSystem[i];
            // Review: WETH counts as box 0's ETH (the ghost ledger); the closing flush unwraps every royalty in WETH.
            assertEq(IERC20(a.weth).balanceOf(place), 0, "X21 no WETH left at a box address");
            if (
                place == address(pm) || place == address(drand) || place == a.executor || place == a.launchRouter
                    || place == a.royaltyRouter
            ) continue;
            assertEq(place.balance, forced[place], "X21 remaining ETH is named M27");
        }
        uint256 hidden;
        uint256 outside;
        for (uint256 id = tickets.firstId(); id < tickets.firstId() + editionSize; ++id) {
            address owner = collection.ownerOf(id);
            assertTrue(_ghostIsSystem[owner] || _ghostIsOutside[owner], "X03 full item census owner");
            if (vault.isHidden(id)) {
                ++hidden;
                assertEq(owner, a.vault, "X15 hidden custody");
            }
            if (owner != a.vault) ++outside;
            assertEq(vault.isOutside(id), owner != a.vault, "X15 full census classification");
        }
        assertEq(hidden, vault.hiddenCount(), "X15 full hidden census");
        assertEq(outside + vault.inside(), editionSize, "X03 full census N");
    }

    // Cheatcode environment survives EVM snapshot rollback. Rollups include Foundry's final replay explicitly.
    function _rollup(string memory key, uint256 add) internal returns (uint256 value) {
        string memory name = string.concat("SH_SYS_LANE_", campaign, "_", key);
        value = vm.envOr(name, uint256(0)) + add;
        vm.setEnv(name, vm.toString(value));
    }

    function _report(Count[ACTIONS] memory fuzzCounts, uint256 fuzzCalls, uint256[EDGES] memory fuzzEdges) internal {
        console2.log("LANE campaign", campaign);
        console2.log("LANE completed incl replay", _rollup("completed", 1));
        console2.log("LANE fuzz calls incl replay", _rollup("fuzzCalls", fuzzCalls));
        for (uint256 i; i < ACTIONS; ++i) {
            string memory id = vm.toString(i);
            uint256 calls = _rollup(string.concat(id, "_calls"), fuzzCounts[i].calls);
            uint256 passed = _rollup(string.concat(id, "_passed"), fuzzCounts[i].passed);
            console2.log(string.concat("LANE action ", id), calls, passed);
            string memory key = string.concat("SH_SYS_LANE_", campaign, "_", id, "_gas");
            uint256 maximum = vm.envOr(key, uint256(0));
            if (fuzzCounts[i].gasMax > maximum) maximum = fuzzCounts[i].gasMax;
            vm.setEnv(key, vm.toString(maximum));
            console2.log(string.concat("LANE gas ", id), maximum);
        }
        for (uint256 i; i < exceptionNames.length; ++i) {
            console2.log(
                string.concat("LANE exception ", exceptionNames[i]),
                _rollup(exceptionNames[i], exceptions[exceptionNames[i]])
            );
        }
        console2.log("LANE depth changes", _rollup("depthChanges", depthChanges));
        console2.log("LANE execute changes", _rollup("executeChanges", executeChanges));
        for (uint256 i; i < EDGES; ++i) {
            console2.log(
                string.concat("LANE edge ", _edgeName(i)), _rollup(string.concat("edge_", vm.toString(i)), fuzzEdges[i])
            );
        }
    }
}
