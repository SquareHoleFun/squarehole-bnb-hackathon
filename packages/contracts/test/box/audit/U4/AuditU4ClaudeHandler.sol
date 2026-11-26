// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {DeepenSkip, DepthKind, FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {AuditU4ClaudeClaimGifter, AuditU4ClaudeStipendPayer} from "./AuditU4ClaudeHelpers.sol";

interface IU4Weth {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice What the handler needs from the world (AuditBox0World), passed once.
struct U4HandlerWorld {
    IPoolManager pm;
    CoreBoxAddresses a;
    PoolKey key;
    AuditRouterSwapper swapper;
    AuditU4ClaudeClaimGifter gifter;
    address[] actors;
    address[] tipTos;
    address[] badTips;
    uint160 sqrtP1;
    uint256 raise;
}

/// @title AuditU4ClaudeHandler
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). The invariant handler for box 0's receiver and royalty router on the
/// factory's box 0: trades (buys, sells), collect (tips to EOAs, a contract, the EIP-7702 EOA, the receiver itself),
/// collect with a tip recipient that refuses ETH or burns its gas, fundFees, fundDepth, royalties in ETH and WETH (with
/// all gas, and as a marketplace's 2,300-gas `transfer`, `send` or call) with flush and sweep, payFit, payPlatform,
/// onGraduation, forced ETH on the receiver and the router, claim gifts to the receiver (and to the coordinator before
/// graduation, which graduate() forwards), FIT's executor's real buy (which notes its fee), deepen() (which pokes the
/// pair and notes conversion fees), the curve's close with graduate() (bonding world), and clock steps of 12 s, 1 h,
/// 1 d, 30 d ± 1 s and to the next epoch edge − 1 s, exactly, + 1 s.
/// Fail-safe (`fail_on_revert`): every call is wrapped; the ghosts below record what must never happen, and the
/// invariant contracts assert them. Expectations per action: the receiver's unbooked claims (the next batch) change
/// only as the action allows (a collect or a settlement leaves none; a gift adds itself; deepen() may add the pair's
/// fees; nothing else changes them); its plain ETH is exactly the forced ETH and self-tips since the last fundDepth;
/// the Safe's ETH moves only in payPlatform, by the owed amount; the executor's only in payFit (in) and its own buys
/// (out); the router's ETH and WETH leave only into the receiver's fundFees; no PoolManager delta is left open; before
/// graduation nothing reaches the Safe, the executor, the hook or the stream. Credits per epoch, REV-16 returns, cap
/// excess and streamed T are read from the receiver's own events, only of an action that succeeded (Foundry records
/// the logs of reverted frames too), and each action's PlatformCredited sum is checked against its `totals()` change
/// (`eventsMismatch`) before it is booked.
/// Every action takes two words (`a`, `b`), so the invariant runner and the reach test drive them alike.
contract AuditU4ClaudeHandler is CommonBase, StdCheats, StdUtils {
    using TransientStateLibrary for IPoolManager;

    IPoolManager internal pm;
    CoreBoxAddresses internal a;
    PoolKey internal key;
    AuditRouterSwapper internal swapper;
    AuditU4ClaudeClaimGifter internal gifter;
    AuditU4ClaudeStipendPayer internal payer;
    BoxReceiver internal receiver;
    BoxRoyaltyRouter internal router;
    BoxCoordinator internal coordinator;
    BoxHook internal hook;
    FitBuybackExecutor internal executor;
    BoxToken internal token;
    address[] internal actors;
    address[] internal tipTos;
    address[] internal badTips;
    uint160 internal sqrtP1;
    uint256 internal raise;
    bool internal canGraduate;

    // ------------------------------------------------------------------ ghosts (must stay zero)
    uint256 public collectRefusedOther;
    uint256 public intakeReverted;
    uint256 public payoutWrong;
    uint256 public safeMovedElsewhere;
    uint256 public executorMovedElsewhere;
    uint256 public unbookedWrong;
    uint256 public rawEthWrong;
    uint256 public routerLeak;
    uint256 public openDelta;
    uint256 public settleWrong;
    uint256 public paidBeforeGraduation;
    uint256 public eventsMismatch;
    uint256 public badTipPaid;
    uint256 public coordinatorGiftWrong;
    bytes public lastUnexpected;
    string public lastWhere;

    // ------------------------------------------------------------------ books from the receiver's events
    mapping(uint256 => uint256) public creditedInEpoch;
    uint256 public maxEpoch;
    uint256 public creditedTotal;
    uint256 public capExcessTotal;
    uint256 public moduleQReturned;
    uint256 public hookQReturned;
    uint256 public streamedT;
    uint256 public paidToSafe;
    uint256 public paidToFit;
    uint256 public executorSpent;
    uint256 public fundDepthTotal;
    uint256 public expectedRawEth;
    uint256 public routerHeld;
    uint256 public coordinatorGifts;
    uint256 public safe0;
    uint256 public executor0;

    // ------------------------------------------------------------------ coverage: successes (or expected refusals)
    uint256 public calls;
    uint256 public nBuy;
    uint256 public nSell;
    uint256 public nCollect;
    uint256 public nCollectSmall;
    uint256 public nCollectBadTip;
    uint256 public nFundFees;
    uint256 public nFundDepth;
    uint256 public nGift;
    uint256 public nGiftCoordinator;
    uint256 public nForce;
    uint256 public nRoyalty;
    uint256 public nRoyaltyStipend;
    uint256 public nFlush;
    uint256 public nPayFit;
    uint256 public nPayPlatform;
    uint256 public nOnGraduation;
    uint256 public nSettlements;
    uint256 public nExecute;
    uint256 public nDeepen;
    uint256 public nGraduate;
    uint256 public nWarp;
    uint256 public nEpochEdges;

    constructor(U4HandlerWorld memory w, bool canGraduate_) {
        pm = w.pm;
        a = w.a;
        key = w.key;
        swapper = w.swapper;
        gifter = w.gifter;
        actors = w.actors;
        tipTos = w.tipTos;
        badTips = w.badTips;
        sqrtP1 = w.sqrtP1;
        raise = w.raise;
        canGraduate = canGraduate_;
        payer = new AuditU4ClaudeStipendPayer();
        receiver = BoxReceiver(payable(a.receiver));
        router = BoxRoyaltyRouter(payable(a.royaltyRouter));
        coordinator = BoxCoordinator(a.coordinator);
        hook = BoxHook(a.hook);
        executor = FitBuybackExecutor(payable(a.executor));
        token = BoxToken(a.token);
        safe0 = a.platform.balance;
        executor0 = a.executor.balance;
        expectedRawEth = a.receiver.balance;
        routerHeld = a.royaltyRouter.balance + IU4Weth(a.weth).balanceOf(a.royaltyRouter);
        // The settlement inside graduate() (graduated world) credited epoch 0 before the campaign.
        if (receiver.graduationSettled()) {
            creditedInEpoch[0] = receiver.platformOwed();
            creditedTotal = receiver.platformOwed();
        }
    }

    /// @notice Successes (or expected refusals, for the bad tip) per action, in the order of the reach test's names.
    function coverage() external view returns (uint256[23] memory c) {
        c = [
            calls,
            nBuy,
            nSell,
            nCollect,
            nCollectSmall,
            nCollectBadTip,
            nFundFees,
            nFundDepth,
            nGift,
            nGiftCoordinator,
            nForce,
            nRoyalty,
            nRoyaltyStipend,
            nFlush,
            nPayFit,
            nPayPlatform,
            nOnGraduation,
            nSettlements,
            nExecute,
            nDeepen,
            nGraduate,
            nWarp,
            nEpochEdges
        ];
    }

    // ================================================================================================ the snapshot

    struct Snap {
        uint256 uq;
        uint256 ut;
        uint256 safeEth;
        uint256 execEth;
        uint256 routerAll;
        uint256 streamT;
        uint256 hookQ;
        uint256 hookT;
        uint256 toPlatform;
        bool settled;
        bool graduated;
    }

    function _snap() internal view returns (Snap memory s) {
        (uint256 bq, uint256 bt) = receiver.booked();
        s.uq = pm.balanceOf(a.receiver, 0) - bq;
        s.ut = pm.balanceOf(a.receiver, uint256(uint160(a.token))) - bt;
        s.safeEth = a.platform.balance;
        s.execEth = a.executor.balance;
        s.routerAll = a.royaltyRouter.balance + IU4Weth(a.weth).balanceOf(a.royaltyRouter);
        s.streamT = token.balanceOf(a.itemStream);
        s.hookQ = pm.balanceOf(a.hook, 0);
        s.hookT = pm.balanceOf(a.hook, uint256(uint160(a.token)));
        (, s.toPlatform,,,,,) = receiver.totals();
        s.settled = receiver.graduationSettled();
        s.graduated = coordinator.graduated();
    }

    function _begin() internal returns (Snap memory s) {
        ++calls;
        s = _snap();
        vm.recordLogs();
    }

    /// @dev After every action: books the receiver's events if the action succeeded (`ok`), then checks what holds
    /// after any action.
    function _end(Snap memory s0, string memory where, bool ok) internal {
        _endWith(s0, where, ok, vm.getRecordedLogs());
    }

    /// @dev `_end` with the action's logs already read (the flush reads them first).
    function _endWith(Snap memory s0, string memory where, bool ok, VmSafe.Log[] memory logs) internal {
        if (ok) _absorbChecked(logs, s0, where);
        Snap memory s1 = _snap();
        if (pm.isUnlocked() || pm.getNonzeroDeltaCount() != 0) {
            ++openDelta;
            lastWhere = where;
        }
        if (a.receiver.balance != expectedRawEth) {
            ++rawEthWrong;
            lastWhere = where;
        }
        if (s1.safeEth != s0.safeEth && keccak256(bytes(where)) != keccak256("payPlatform")) {
            ++safeMovedElsewhere;
            lastWhere = where;
        }
        if (s1.graduated && !s1.settled && s0.settled) {
            ++settleWrong;
            lastWhere = where;
        }
        if (!s1.graduated) {
            if (
                s1.safeEth != s0.safeEth || s1.execEth != s0.execEth || s1.streamT != s0.streamT || s1.hookQ != s0.hookQ
                    || s1.hookT != s0.hookT || receiver.platformOwed() != 0
            ) {
                ++paidBeforeGraduation;
                lastWhere = where;
            }
        }
        // The unbooked claims: a settlement during the action consumes them all.
        if (!s0.settled && s1.settled) {
            ++nSettlements;
            if (s1.uq != 0 || s1.ut != 0) {
                ++unbookedWrong;
                lastWhere = string.concat(where, " (settlement)");
            }
        }
    }

    /// @dev Books an action's receiver events once they are shown to be the action's own: their PlatformCredited sum is
    /// the action's `totals().toPlatform` change, and a GraduationSettled event comes with a settlement that stayed.
    function _absorbChecked(VmSafe.Log[] memory logs, Snap memory s0, string memory where) internal {
        uint256 kept;
        bool settledEvent;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IBoxReceiver.PlatformCredited.selector) {
                (uint256 k,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                kept += k;
            } else if (t0 == IBoxReceiver.GraduationSettled.selector) {
                settledEvent = true;
            }
        }
        (, uint256 toPlatform,,,,,) = receiver.totals();
        bool settledHere = !s0.settled && receiver.graduationSettled();
        if (kept != toPlatform - s0.toPlatform || settledEvent != settledHere) {
            ++eventsMismatch;
            lastWhere = where;
            return;
        }
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == IBoxReceiver.PlatformCredited.selector) {
                uint256 epoch = uint256(logs[i].topics[1]);
                (uint256 k, uint256 toDepth,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                creditedInEpoch[epoch] += k;
                creditedTotal += k;
                capExcessTotal += toDepth;
                if (epoch > maxEpoch) maxEpoch = epoch;
            } else if (t0 == IBoxReceiver.ModuleFeesReturned.selector) {
                (uint256 mq,, uint256 hq) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                moduleQReturned += mq;
                hookQReturned += hq;
            } else if (t0 == IBoxReceiver.StreamFunded.selector || t0 == IBoxReceiver.StreamNotifyFailed.selector) {
                streamedT += abi.decode(logs[i].data, (uint256));
            } else if (t0 == IBoxReceiver.DepthGifted.selector) {
                fundDepthTotal += abi.decode(logs[i].data, (uint256));
            }
        }
    }

    // ================================================================================================ trades

    function buy(uint256 actorSeed, uint256 amount) external {
        Snap memory s0 = _begin();
        address who = actors[actorSeed % actors.length];
        amount = bound(amount, 0.001 ether, 3 ether);
        vm.deal(who, who.balance + amount);
        SwapParams memory p = SwapParams({
            zeroForOne: true, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
        bool ok;
        vm.prank(who);
        try swapper.swapOne{value: amount}(key, p, "", who) {
            ok = true;
            ++nBuy;
        } catch {}
        _end(s0, "buy", ok);
        _expectUnbookedSame(s0, "buy");
    }

    function sell(uint256 actorSeed, uint256 frac) external {
        Snap memory s0 = _begin();
        address who = actors[actorSeed % actors.length];
        uint256 amount = token.balanceOf(who) * bound(frac, 1, 50) / 100;
        bool ok;
        if (amount != 0) {
            vm.prank(who);
            token.approve(address(swapper), type(uint256).max);
            SwapParams memory p = SwapParams({
                zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            });
            vm.prank(who);
            try swapper.swapOne(key, p, "", who) {
                ok = true;
                ++nSell;
            } catch {}
        }
        _end(s0, "sell", ok);
        _expectUnbookedSame(s0, "sell");
    }

    // ================================================================================================ batches and intake

    function collect(uint256 callerSeed, uint256 tipSeed) external {
        Snap memory s0 = _begin();
        address caller = actors[callerSeed % actors.length];
        address tipTo = tipTos[tipSeed % tipTos.length];
        uint256 tip0 = tipTo.balance;
        vm.prank(caller);
        try receiver.collect(tipTo) returns (FeeBatch memory b) {
            ++nCollect;
            if (tipTo == a.receiver) expectedRawEth += b.tip;
            else if (tipTo.balance - tip0 != b.tip) ++payoutWrong;
            _end(s0, "collect", true);
            (uint256 uq, uint256 ut) = _unbooked();
            if (uq != 0 || ut != 0) {
                ++unbookedWrong;
                lastWhere = "collect";
            }
        } catch (bytes memory err) {
            if (bytes4(err) == IBoxReceiver.BatchTooSmall.selector) {
                ++nCollectSmall;
            } else {
                ++collectRefusedOther;
                lastUnexpected = err;
            }
            _end(s0, "collect refused", false);
            _expectUnbookedSame(s0, "collect refused");
        }
    }

    /// @notice A collect whose caller names a tip recipient that refuses ETH or burns all its gas (BC-021, P4.12): it
    /// reverts whenever a tip is due, and the batch waits whole for the next caller. Gas-capped: a gas burner takes
    /// all it is given.
    function collectBadTip(uint256 callerSeed, uint256 badSeed) external {
        Snap memory s0 = _begin();
        address caller = actors[callerSeed % actors.length];
        address bad = badTips[badSeed % badTips.length];
        vm.prank(caller);
        try receiver.collect{gas: 3_000_000}(bad) returns (FeeBatch memory b) {
            // Only a batch with no tip due can pass a refusing recipient.
            if (b.tip != 0) {
                ++badTipPaid;
                lastWhere = "collectBadTip";
            }
            ++nCollect;
            _end(s0, "collectBadTip", true);
        } catch {
            ++nCollectBadTip;
            _end(s0, "collectBadTip refused", false);
            _expectUnbookedSame(s0, "collectBadTip refused");
        }
    }

    function fundFees(uint256 amount, uint256) external {
        Snap memory s0 = _begin();
        amount = bound(amount, 1, 300 ether);
        address who = actors[amount % actors.length];
        vm.deal(who, who.balance + amount);
        bool ok;
        vm.prank(who);
        try receiver.fundFees{value: amount}() {
            ok = true;
            ++nFundFees;
        } catch (bytes memory err) {
            ++intakeReverted;
            lastUnexpected = err;
        }
        _end(s0, "fundFees", ok);
        _expectUnbookedSameUnlessSettled(s0, "fundFees");
    }

    function fundDepth(uint256 amount, uint256) external {
        Snap memory s0 = _begin();
        amount = bound(amount, 0, 5 ether);
        address who = actors[amount % actors.length];
        vm.deal(who, who.balance + amount);
        bool ok;
        vm.prank(who);
        try receiver.fundDepth{value: amount}() {
            ok = true;
            ++nFundDepth;
            expectedRawEth = 0;
        } catch (bytes memory err) {
            ++intakeReverted;
            lastUnexpected = err;
        }
        _end(s0, "fundDepth", ok);
        _expectUnbookedSameUnlessSettled(s0, "fundDepth");
    }

    function giftClaims(uint256 amount, uint256) external {
        Snap memory s0 = _begin();
        amount = bound(amount, 1, 50 ether);
        vm.deal(address(this), address(this).balance + amount);
        gifter.giftEth{value: amount}(a.receiver);
        ++nGift;
        _end(s0, "gift", true);
        (uint256 uq, uint256 ut) = _unbooked();
        if (uq != s0.uq + amount || ut != s0.ut) {
            ++unbookedWrong;
            lastWhere = "gift";
        }
    }

    /// @notice Q claims gifted to the coordinator before graduation: graduate() forwards what is above the reward to
    /// the receiver, whose settlement splits it in epoch 0 (BoxCoordinator.sol:276-283; P4.4's coordinator path).
    function giftCoordinator(uint256 amount, uint256) external {
        if (coordinator.graduated()) return;
        Snap memory s0 = _begin();
        amount = bound(amount, 1, 50 ether);
        uint256 c0 = pm.balanceOf(a.coordinator, 0);
        vm.deal(address(this), address(this).balance + amount);
        gifter.giftEth{value: amount}(a.coordinator);
        coordinatorGifts += amount;
        ++nGiftCoordinator;
        if (pm.balanceOf(a.coordinator, 0) != c0 + amount) ++coordinatorGiftWrong;
        _end(s0, "giftCoordinator", true);
        _expectUnbookedSame(s0, "giftCoordinator");
    }

    function forceEth(uint256 amount, uint256 onRouterSeed) external {
        Snap memory s0 = _begin();
        amount = bound(amount, 1, 5 ether);
        bool onRouter = onRouterSeed % 2 == 1;
        address target = onRouter ? a.royaltyRouter : a.receiver;
        vm.deal(target, target.balance + amount);
        if (onRouter) routerHeld += amount;
        else expectedRawEth += amount;
        ++nForce;
        _end(s0, "force", true);
        _expectUnbookedSame(s0, "force");
    }

    // ================================================================================================ royalties

    function payRoyalty(uint256 amount, uint256 wethSeed) external {
        Snap memory s0 = _begin();
        amount = bound(amount, 0, 40 ether);
        bool inWeth = wethSeed % 2 == 1;
        address who = actors[amount % actors.length];
        vm.deal(who, who.balance + amount);
        vm.startPrank(who);
        bool ok = true;
        if (inWeth) {
            IU4Weth(a.weth).deposit{value: amount}();
            ok = IU4Weth(a.weth).transfer(a.royaltyRouter, amount);
        } else {
            (ok,) = a.royaltyRouter.call{value: amount}("");
        }
        vm.stopPrank();
        if (!ok) {
            ++routerLeak; // the router must accept every payment
            lastWhere = "royalty";
        } else {
            routerHeld += amount;
            ++nRoyalty;
        }
        _end(s0, "royalty", ok);
        _expectUnbookedSame(s0, "royalty");
    }

    /// @notice A marketplace paying the router with a 2,300-gas stipend: Solidity's `transfer`, `send`, or a call with
    /// 2,300 gas and no calldata (P4.16, BC-114).
    function payRoyaltyStipend(uint256 amount, uint256 mode) external {
        Snap memory s0 = _begin();
        amount = bound(amount, 0, 5 ether);
        vm.deal(address(this), address(this).balance + amount);
        bool ok;
        uint256 m = mode % 3;
        if (m == 0) {
            try payer.payTransfer{value: amount}(payable(a.royaltyRouter)) {
                ok = true;
            } catch {}
        } else if (m == 1) {
            ok = payer.paySend{value: amount}(payable(a.royaltyRouter));
        } else {
            ok = payer.payCall{value: amount}(a.royaltyRouter, 2_300, "");
        }
        if (!ok) {
            ++routerLeak;
            lastWhere = "royaltyStipend";
        } else {
            routerHeld += amount;
            ++nRoyaltyStipend;
        }
        _end(s0, "royaltyStipend", ok);
        _expectUnbookedSame(s0, "royaltyStipend");
    }

    function flush(uint256 seed, uint256 sweepSeed) external {
        Snap memory s0 = _begin();
        bool viaSweep = sweepSeed % 2 == 1;
        uint256 before = s0.routerAll;
        bool ok;
        bytes memory err;
        if (viaSweep) {
            address t = seed % 3 == 0 ? address(uint160(seed)) : a.weth;
            try router.sweep(t) {
                ok = true;
            } catch (bytes memory e) {
                err = e;
                if (t != a.weth && bytes4(e) != IBoxRoyaltyRouter.TokenNotTaken.selector) {
                    ++routerLeak;
                    lastWhere = "sweep";
                }
            }
        } else {
            try router.flush() {
                ok = true;
            } catch (bytes memory e) {
                err = e;
            }
        }
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        if (ok) {
            // The router's fundFees, all of it, to box 0's receiver.
            uint256 fundedByRouter = _feesFundedBy(logs, a.royaltyRouter);
            ++nFlush;
            if (
                fundedByRouter != before || a.royaltyRouter.balance != 0
                    || IU4Weth(a.weth).balanceOf(a.royaltyRouter) != 0
            ) {
                ++routerLeak;
                lastWhere = "flush";
            }
            routerHeld = 0;
        } else {
            if (err.length >= 4) {
                bytes4 e4 = bytes4(err);
                bool expected = e4 == IBoxRoyaltyRouter.NothingToFlush.selector
                    || e4 == IBoxRoyaltyRouter.TokenNotTaken.selector
                    || (e4 == IBoxRoyaltyRouter.NotGraduated.selector && !s0.graduated);
                if (!expected) {
                    ++routerLeak;
                    lastUnexpected = err;
                    lastWhere = "flush refused";
                }
            }
            if ((a.royaltyRouter.balance + IU4Weth(a.weth).balanceOf(a.royaltyRouter)) != before) ++routerLeak;
        }
        _endWith(s0, "flush", ok, logs);
        _expectUnbookedSameUnlessSettled(s0, "flush");
    }

    // ================================================================================================ payouts

    function payFit(uint256 callerSeed, uint256) external {
        Snap memory s0 = _begin();
        address caller = actors[callerSeed % actors.length];
        uint256 owedBefore = receiver.fitOwed();
        bool ok;
        vm.prank(caller);
        try receiver.payFit() returns (uint256 amount) {
            ok = true;
            ++nPayFit;
            paidToFit += amount;
            if (a.executor.balance - s0.execEth != amount || amount < owedBefore) ++payoutWrong;
            if (receiver.fitOwed() != 0) ++payoutWrong;
        } catch (bytes memory err) {
            bytes4 e4 = bytes4(err);
            bool expected = (e4 == IBoxReceiver.NotGraduated.selector && !s0.graduated)
                || (e4 == IBoxReceiver.NothingOwed.selector && s0.graduated);
            if (!expected) {
                ++payoutWrong;
                lastUnexpected = err;
                lastWhere = "payFit";
            }
            if (a.executor.balance != s0.execEth) ++executorMovedElsewhere;
        }
        _end(s0, "payFit", ok);
        _expectUnbookedSameUnlessSettled(s0, "payFit");
    }

    function payPlatform(uint256 callerSeed, uint256) external {
        Snap memory s0 = _begin();
        address caller = actors[callerSeed % actors.length];
        bool ok;
        vm.prank(caller);
        try receiver.payPlatform() returns (uint256 amount) {
            ok = true;
            ++nPayPlatform;
            paidToSafe += amount;
            if (a.platform.balance - s0.safeEth != amount || receiver.platformOwed() != 0) ++payoutWrong;
        } catch (bytes memory err) {
            if (bytes4(err) != IBoxReceiver.NothingOwed.selector) {
                ++payoutWrong;
                lastUnexpected = err;
                lastWhere = "payPlatform";
            }
            if (a.platform.balance != s0.safeEth) ++payoutWrong;
        }
        _end(s0, "payPlatform", ok);
        _expectUnbookedSameUnlessSettled(s0, "payPlatform");
    }

    function onGraduation(uint256 callerSeed, uint256) external {
        Snap memory s0 = _begin();
        address caller = actors[callerSeed % actors.length];
        bool ok;
        vm.prank(caller);
        try receiver.onGraduation() {
            ok = true;
            ++nOnGraduation;
            if (!s0.graduated || s0.settled) ++settleWrong;
        } catch (bytes memory err) {
            bytes4 e4 = bytes4(err);
            bool expected = (e4 == IBoxReceiver.NotGraduated.selector && !s0.graduated)
                || (e4 == IBoxReceiver.AlreadySettled.selector && s0.settled);
            if (!expected) {
                ++settleWrong;
                lastUnexpected = err;
                lastWhere = "onGraduation";
            }
        }
        _end(s0, "onGraduation", ok);
        _expectUnbookedSameUnlessSettled(s0, "onGraduation");
    }

    // ================================================================================================ other box parts

    function execute(uint256 chunks, uint256) external {
        Snap memory s0 = _begin();
        bool ok;
        try executor.execute(bound(chunks, 1, 3)) returns (uint256 c, uint256 spent, uint256) {
            ok = true;
            if (c != 0) ++nExecute;
            executorSpent += spent;
            if (s0.execEth - a.executor.balance != spent) ++executorMovedElsewhere;
        } catch {}
        _end(s0, "execute", ok);
        _expectUnbookedSame(s0, "execute");
    }

    function deepen(uint256 tipSeed, uint256) external {
        Snap memory s0 = _begin();
        address tipTo = actors[tipSeed % actors.length];
        bool ok;
        try hook.deepen(tipTo) returns (DepthKind, DeepenSkip skip, uint256, uint256, uint256) {
            ok = true;
            if (skip == DeepenSkip.None) ++nDeepen;
        } catch {}
        _end(s0, "deepen", ok);
        (uint256 uq, uint256 ut) = _unbooked();
        if (uq < s0.uq || ut < s0.ut) {
            ++unbookedWrong;
            lastWhere = "deepen";
        }
    }

    function closeAndGraduate(uint256 callerSeed, uint256) external {
        if (!canGraduate || coordinator.graduated()) return;
        Snap memory s0 = _begin();
        address who = actors[callerSeed % actors.length];
        bool ok;
        if (!hook.closed()) {
            uint256 amount = 3 * raise;
            vm.deal(who, who.balance + amount);
            SwapParams memory p =
                SwapParams({zeroForOne: true, amountSpecified: -int256(amount), sqrtPriceLimitX96: sqrtP1});
            vm.prank(who);
            try swapper.swapOne{value: amount}(key, p, "", who) {} catch {}
        }
        if (hook.closed()) {
            uint256 c0 = pm.balanceOf(a.coordinator, 0);
            vm.prank(who);
            try coordinator.graduate() returns (uint256 reward) {
                ok = true;
                ++nGraduate;
                // The coordinator keeps the reward only; every gift and the reserve above it reach the receiver.
                if (pm.balanceOf(a.coordinator, 0) != reward || c0 < reward) ++coordinatorGiftWrong;
            } catch {}
        }
        _end(s0, "graduate", ok);
        if (coordinator.graduated() && !receiver.graduationSettled()) ++settleWrong;
    }

    // ================================================================================================ the clock

    function warp(uint256 seed, uint256) external {
        Snap memory s0 = _begin();
        uint256 now_ = block.timestamp;
        uint256 t;
        uint256 kind = seed % 9;
        uint256 g = coordinator.graduatedAt();
        if (kind == 0) {
            t = now_ + 12;
        } else if (kind == 1) {
            t = now_ + 1 hours;
        } else if (kind == 2) {
            t = now_ + 1 days;
        } else if (kind == 3) {
            t = now_ + 30 days - 1;
        } else if (kind == 4) {
            t = now_ + 30 days;
        } else if (kind == 5) {
            t = now_ + 30 days + 1;
        } else if (g != 0) {
            uint256 next = g + ((now_ - g) / BoxSpecV1.PLATFORM_EPOCH_SECONDS + 1) * BoxSpecV1.PLATFORM_EPOCH_SECONDS;
            t = kind == 6 ? next - 1 : kind == 7 ? next : next + 1;
            if (t <= now_) t = now_ + 1;
            ++nEpochEdges;
        } else {
            t = now_ + 12;
        }
        vm.roll(block.number + 1 + (t - now_) / 3600);
        vm.warp(t);
        ++nWarp;
        _end(s0, "warp", true);
        _expectUnbookedSame(s0, "warp");
    }

    // ================================================================================================ reads

    function _unbooked() internal view returns (uint256 uq, uint256 ut) {
        (uint256 bq, uint256 bt) = receiver.booked();
        uq = pm.balanceOf(a.receiver, 0) - bq;
        ut = pm.balanceOf(a.receiver, uint256(uint160(a.token))) - bt;
    }

    function _expectUnbookedSame(Snap memory s0, string memory where) internal {
        (uint256 uq, uint256 ut) = _unbooked();
        if (uq != s0.uq || ut != s0.ut) {
            ++unbookedWrong;
            lastWhere = where;
        }
    }

    /// @dev A settlement inside the action consumed everything (checked in `_end`); otherwise unchanged.
    function _expectUnbookedSameUnlessSettled(Snap memory s0, string memory where) internal {
        if (!s0.settled && receiver.graduationSettled()) return;
        _expectUnbookedSame(s0, where);
    }

    function _feesFundedBy(VmSafe.Log[] memory logs, address from) internal view returns (uint256 amount) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.receiver || logs[i].topics[0] != IBoxReceiver.FeesFunded.selector) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != from) continue;
            amount += abi.decode(logs[i].data, (uint256));
        }
    }

    receive() external payable {}
}
