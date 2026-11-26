// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DeepenSkip, DepthKind, DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU7ClaudeMath} from "../U7/AuditU7ClaudeBase.sol";
import {Act, AuditSysWorld, Exc} from "./AuditSysWorld.sol";

/// @title AuditSysActions
/// @notice TEST ONLY (SH-AUDIT-B0 round 2). The handler's actions (plan § 3.2), each `h_*` called only through
/// `AuditSysHandler`, fail-safe: every box call runs in a `try this.x_*()` (the world's booked helpers, as the test
/// contract), its outcome counted as a success, a skip (precondition not met: nothing called) or a refusal (called,
/// refused as the rules say), and checked against its rule where the rule gives a cheap oracle (an unexpected success
/// or refusal is a violation, `AuditSysChecks.invariant_AUDIT_SYS_everyActionAsTheRules`). Calls with the gas-burning
/// actor as a party get a gas cap (`BURN_CAP`) so its loop costs a bounded time.
abstract contract AuditSysActions is AuditSysWorld {
    using StateLibrary for *;
    using PoolIdLibrary for *;

    uint256 internal constant BURN_CAP = 8_000_000;

    function _cap(address who) internal view returns (uint256) {
        return who == address(gasBurner) ? BURN_CAP : gasleft() - 200_000;
    }

    function _graduated() internal view returns (bool) {
        return coordinator.graduated();
    }

    // ================================================================================================ trading

    function x_windowBuy(address who, uint256 qIn) external onlySelf returns (uint256) {
        return _windowBuy(who, qIn);
    }

    function x_swap(address who, SwapParams memory p, uint256 ethValue) external onlySelf {
        _swap(who, p, ethValue);
    }

    function x_buy(address who, uint256 eth) external onlySelf returns (uint256) {
        return _buy(who, eth);
    }

    struct WindowCase {
        address who;
        uint256 qIn;
        uint256 step;
        uint256 pips;
        uint256 r0;
        uint256 p0;
        uint256 e0;
    }

    /// Window buys through the launch router at random steps, partial closes included (BC-096, BC-022, BC-024).
    function h_windowBuy(uint256 whoSeed, uint256 qSeed, uint256 stepSeed) external act(Act.WindowBuy) {
        if (hook.closed()) return _skipped();
        uint256 openAt = hook.openAt();
        uint256 now_ = vm.getBlockTimestamp();
        if (now_ < openAt) _warpT(openAt + (stepSeed % 4) * SLOT);
        else if (stepSeed % 3 == 0) _adv(1);
        now_ = vm.getBlockTimestamp();
        if (now_ >= hook.windowEndsAt()) return _skipped();
        WindowCase memory c;
        c.who = _who(whoSeed);
        c.qIn = qSeed % 9 == 0
            ? (raise * 5 / 4) * 1_000_000 / (1_000_000 - launchRouter.taxPips((now_ - openAt) / SLOT)) + 1
            : _amount(qSeed >> 4, 1e15, raise);
        c.step = (now_ - openAt) / SLOT;
        c.pips = launchRouter.taxPips(c.step);
        (uint256 qt,) = launchRouter.quote(c.qIn);
        if (qt != _ceilPips(c.qIn, c.pips)) _violation("BC-024: quote is not the step's tax");
        c.r0 = a.launchRouter.balance;
        c.p0 = address(pm).balance;
        try this.x_windowBuy{gas: _cap(c.who)}(c.who, c.qIn) {
            _ok();
            _checkWindowBuy(c);
        } catch {
            _refused();
            if (!_refuses(c.who) && c.qIn - _ceilPips(c.qIn, c.pips) > 1e9) {
                _violation("BC-096: a window buy the rules allow was refused");
            }
        }
        if (hook.closed() && vm.getBlockTimestamp() < hook.windowEndsAt()) {
            // W2-U2-1 (accepted): the view still answers the clock's step after a close inside the window.
            try launchRouter.quote(1 ether) returns (uint256, uint256) {
                _exc(Exc.W2_U2_1, 1);
            } catch {}
        }
    }

    function _ceilPips(uint256 q, uint256 pips) internal pure returns (uint256) {
        return (q * pips + 999_999) / 1_000_000;
    }

    /// @dev Router conservation (map § 6 gap 3): gross = pool spend + tax + refund; the tax is the step's on the
    /// filled input (the rounded-up rate of the gross on a closing fill).
    function _checkWindowBuy(WindowCase memory c) internal {
        uint256 tax = a.launchRouter.balance - c.r0;
        uint256 spent = address(pm).balance - c.p0;
        if (tax + spent > c.qIn) _violation("X01: a window buy kept more than its gross");
        uint256 refund = c.qIn - tax - spent;
        if (hook.closed()) {
            uint256 kept = (spent * c.pips + (1_000_000 - c.pips) - 1) / (1_000_000 - c.pips);
            uint256 full = _ceilPips(c.qIn, c.pips);
            if (tax != (kept < full ? kept : full)) _violation("BC-096: closing fill tax is not on the filled input");
        } else {
            if (refund != 0) _violation("BC-096: a refund without a close");
            if (tax != _ceilPips(c.qIn, c.pips)) _violation("BC-024: the tax is not the step's");
        }
    }

    /// An exact-input buy through the Universal Router stand-in, with or without a price limit.
    function h_swapBuyIn(uint256 whoSeed, uint256 ethSeed, uint256 limitSeed) external act(Act.SwapBuyIn) {
        address who = _who(whoSeed);
        uint256 eth = _amount(ethSeed, 1e12, 2 ether);
        uint160 limit = TickMath.MIN_SQRT_PRICE + 1;
        if (limitSeed % 3 == 0) {
            (uint160 sp,,,) = pm.getSlot0(poolKey.toId());
            limit = uint160(uint256(sp) * (1_000 - (limitSeed >> 8) % 100) / 1_000);
            if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;
        }
        _swapCase(who, SwapParams({zeroForOne: true, amountSpecified: -int256(eth), sqrtPriceLimitX96: limit}), eth);
    }

    /// An exact-input sell of part of the actor's T.
    function h_swapSellIn(uint256 whoSeed, uint256 partSeed) external act(Act.SwapSellIn) {
        address who = _holder(whoSeed, 1);
        if (who == address(0)) return _skipped();
        uint256 bal = token.balanceOf(who);
        uint256 amt = bal / (1 + partSeed % 8);
        if (amt == 0) return _skipped();
        _swapCase(
            who,
            SwapParams({
                zeroForOne: false, amountSpecified: -int256(amt), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            0
        );
    }

    /// An exact-output buy.
    function h_swapBuyOut(uint256 whoSeed, uint256 tSeed) external act(Act.SwapBuyOut) {
        address who = _who(whoSeed);
        uint256 tOut = _amount(tSeed, 1e18, 5e25);
        _swapCase(
            who,
            SwapParams({
                zeroForOne: true, amountSpecified: int256(tOut), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            3 ether
        );
    }

    /// An exact-output sell (for an ETH amount).
    function h_swapSellOut(uint256 whoSeed, uint256 ethSeed) external act(Act.SwapSellOut) {
        address who = _holder(whoSeed, 1);
        if (who == address(0)) return _skipped();
        uint256 ethOut = _amount(ethSeed, 1e12, 0.5 ether);
        _swapCase(
            who,
            SwapParams({
                zeroForOne: false, amountSpecified: int256(ethOut), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            0
        );
    }

    function _swapCase(address who, SwapParams memory p, uint256 ethValue) internal {
        try this.x_swap{gas: _cap(who)}(who, p, ethValue) {
            _ok();
        } catch {
            _refused();
        }
    }

    function x_swapMulti(address who, AuditRouterSwapper.Call[] memory calls, uint256 ethValue) external onlySelf {
        _fund(who, ethValue);
        vm.prank(who);
        token.approve(address(routerSwapper), type(uint256).max);
        uint256 e0 = who.balance;
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        routerSwapper.swap{value: ethValue}(calls, who);
        _noteEthChange(e0, who.balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, token.balanceOf(who), TIn.Sell, TOut.Buy);
    }

    /// Two or three swaps in one unlock, both directions (the Universal Router's plan shape).
    function h_swapMulti(uint256 whoSeed, uint256 seed) external act(Act.SwapMulti) {
        address who = _holder(whoSeed, 1);
        if (who == address(0)) who = _who(whoSeed);
        uint256 legs = 2 + seed % 2;
        AuditRouterSwapper.Call[] memory calls = new AuditRouterSwapper.Call[](legs);
        uint256 eth;
        for (uint256 i; i < legs; ++i) {
            bool buy = (seed >> (8 + i)) & 1 == 0;
            uint256 amt = _amount(seed >> (16 * (i + 1)), 1e13, 0.3 ether);
            if (buy) eth += amt;
            uint256 tAmt = amt * 1e7;
            uint256 bal = token.balanceOf(who);
            if (!buy && tAmt > bal / 2) tAmt = bal / 2;
            calls[i].key = poolKey;
            calls[i].params = buy
                ? SwapParams({
                    zeroForOne: true, amountSpecified: -int256(amt), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
                })
                : SwapParams({
                    zeroForOne: false,
                    amountSpecified: -int256(tAmt + 1),
                    sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
                });
        }
        try this.x_swapMulti{gas: _cap(who)}(who, calls, eth) {
            _ok();
        } catch {
            _refused();
        }
    }

    /// The closing swap in its shapes: exact input to P1 through the stand-in, exact output past the curve's T, a
    /// launch-router buy in the window (a partial close), and a close followed by a second leg in the same unlock
    /// (which must revert whole: closed exactly once).
    function h_closeCurve(uint256 whoSeed, uint256 modeSeed) external act(Act.CloseCurve) {
        if (hook.closed()) return _skipped();
        address who = _payee(whoSeed);
        uint256 mode = modeSeed % 4;
        uint256 now_ = vm.getBlockTimestamp();
        bool inWindow = now_ >= hook.openAt() && now_ < hook.windowEndsAt();
        if (mode == 2 && !inWindow) mode = 0;
        if (mode != 2 && now_ < hook.windowEndsAt()) _warpT(hook.windowEndsAt());
        uint256 closedBefore = hook.closedAtBlock();
        bool done;
        if (mode == 0) {
            try this.x_closeIn(who) {
                done = true;
            } catch {}
        } else if (mode == 1) {
            try this.x_closeOut(who) {
                done = true;
            } catch {}
        } else if (mode == 2) {
            // Enough that the input left after the step's tax overfills the curve: a partial close (BC-096).
            uint256 pips = launchRouter.taxPips((vm.getBlockTimestamp() - hook.openAt()) / SLOT);
            uint256 qIn = (raise * 5 / 4) * 1_000_000 / (1_000_000 - pips) + 1;
            try this.x_windowBuy(who, qIn) {
                done = true;
            } catch {}
        } else {
            try this.x_closeTwice(who) {
                _violation("X05: a swap after the close passed in the closing unlock");
            } catch {
                _refused();
                return;
            }
        }
        if (!done) {
            _refused();
            _violation("BC-025: a closing swap the rules allow was refused");
            return;
        }
        _ok();
        if (!hook.closed()) _violation("BC-025: the closing swap did not close the curve");
        if (closedBefore != 0) _violation("X05: the curve closed twice");
        if (hook.closedAtBlock() != vm.getBlockNumber()) _violation("BC-025: closed in another block than its swap");
    }

    function x_closeIn(address who) external onlySelf {
        _buyTo(who, 3 * raise, curve.sqrtPriceLowerX96);
    }

    function x_closeOut(address who) external onlySelf {
        _buyExactOut(who, 2e27, 3 * raise);
    }

    function x_closeTwice(address who) external onlySelf {
        AuditRouterSwapper.Call[] memory calls = new AuditRouterSwapper.Call[](2);
        calls[0].key = poolKey;
        calls[0].params = SwapParams({
            zeroForOne: true, amountSpecified: -int256(3 * raise), sqrtPriceLimitX96: curve.sqrtPriceLowerX96
        });
        calls[1].key = poolKey;
        calls[1].params = SwapParams({
            zeroForOne: true, amountSpecified: -int256(1e15), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
        });
        _fund(who, 3 * raise + 1e15);
        vm.prank(who);
        routerSwapper.swap{value: 3 * raise + 1e15}(calls, who);
    }

    // ================================================================================================ graduation

    struct GradCase {
        address caller;
        uint256 gasLimit;
        uint256 reserveMinted;
        uint256 held;
        uint256 supply;
        uint256 gate;
        uint256 coordT;
    }

    function x_graduate(address caller, uint256 gasLimit) external onlySelf returns (uint256 reward, uint256 used) {
        vm.recordLogs();
        _coolAll();
        vm.prank(caller);
        uint256 g = gasleft();
        reward = coordinator.graduate{gas: gasLimit}();
        used = g - gasleft();
        uint256 fails;
        bytes32 sel = keccak256("PokeFailed(address,bytes4)");
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.coordinator && logs[i].topics[0] == sel) ++fails;
        }
        graduationPokeFailures = fails;
        graduationReward = reward;
        reached = AuditPhase.Graduated;
    }

    /// `graduate()` at random gas limits from the poke floor up (X06, BC-098): all of its effects or none; at the
    /// runbook's 15,000,000 it must succeed once closed. A share of the calls first waits for r0's request time, so
    /// the graduation word falls on a committed round.
    function h_graduate(uint256 gasSeed, uint256 modeSeed) external act(Act.Graduate) {
        GradCase memory c;
        c.caller = _who(modeSeed >> 8);
        if (_graduated()) {
            vm.prank(c.caller);
            try coordinator.graduate() {
                _violation("X06: a second graduation passed");
            } catch {
                _refused();
            }
            return;
        }
        if (!hook.closed()) {
            vm.prank(c.caller);
            try coordinator.graduate() {
                _violation("X06: graduated before the close");
            } catch {
                _refused();
            }
            return;
        }
        if (modeSeed % 4 != 0 && vm.getBlockTimestamp() < _requestTimeFor(r0)) _warpT(_requestTimeFor(r0));
        c.gasLimit = modeSeed % 5 == 0 ? GRADUATE_FLOOR : POKE_FLOOR + gasSeed % (TX_CAP - 21_000 - POKE_FLOOR);
        c.reserveMinted = hook.reserveMinted();
        c.held = pm.balanceOf(a.coordinator, 0);
        c.supply = token.totalSupply();
        c.gate = vault.gateOpenedAt();
        c.coordT = token.balanceOf(a.coordinator);
        try this.x_graduate(c.caller, c.gasLimit) returns (uint256 reward, uint256 used) {
            _ok();
            _gas(Act.Graduate, used);
            if (gLeastGraduateGas == 0 || c.gasLimit < gLeastGraduateGas) gLeastGraduateGas = c.gasLimit;
            gGraduatePokeFailures = graduationPokeFailures;
            _checkGraduated(c, reward);
        } catch {
            _refused();
            if (c.gasLimit > gMostRefusedGraduateGas) gMostRefusedGraduateGas = c.gasLimit;
            if (c.gasLimit >= GRADUATE_FLOOR) _violation("X06: graduate() refused with the runbook's gas once closed");
            if (_graduated() || hook.migratedAtBlock() != 0 || vault.gateOpenedAt() != c.gate) {
                _violation("X06: a refused graduation left effects");
            }
            if (token.totalSupply() != c.supply || token.balanceOf(a.coordinator) != c.coordT) {
                _violation("X06: a refused graduation moved T");
            }
        }
    }

    function _checkGraduated(GradCase memory c, uint256 reward) internal {
        if (!_graduated() || coordinator.graduatedAt() != vm.getBlockTimestamp()) _violation("X06: not graduated now");
        if (hook.migratedAtBlock() != vm.getBlockNumber()) _violation("X06: the hook did not migrate in the call");
        if (vault.gateOpenedAt() != vm.getBlockTimestamp()) _violation("X08: the gate did not open at graduation");
        if (coordinator.poolShare() != 0 || token.balanceOf(a.coordinator) != 0) {
            _violation("X09: the coordinator kept T past graduation");
        }
        // The migration's last harvest tops the reserve up inside graduate(), so the minted figure is read after it;
        // the claims held are at least the minted reserve (gifts only add), so the third term never binds here.
        uint256 want = hook.reserveMinted();
        if (want > coordinator.rewardCap()) want = coordinator.rewardCap();
        if (reward != want) _violation("X20: reward != min(reserve minted, 0.1% of R, claims held)");
        if (reward > raise / 1_000) _violation("X20: reward above 0.1% of R");
        if (coordinator.rewardOf(c.caller) != reward) _violation("X20: the reward is not credited to the caller");
        gRewardHolder = c.caller;
        gReward = reward;
        if (gGiftToCoordinator != 0) {
            (,, uint128 sentinel) = hook.graduatedLayout();
            if (sentinel == 0) _exc(Exc.W2_U2_2, gGiftToCoordinator);
        }
    }

    // ================================================================================================ fees and ETH intake

    function x_collect(address caller, address tipTo) external onlySelf returns (uint256 used) {
        uint256 e0 = tipTo.balance;
        _coolAll();
        vm.prank(caller);
        uint256 g = gasleft();
        receiver.collect(tipTo);
        used = g - gasleft();
        if (!_ghostIsSystem[tipTo]) _noteEthChange(e0, tipTo.balance, EthIn.Other, EthOut.Tip);
    }

    /// `collect` by anyone, the tip to any address (a refusing or gas-burning one fails only this call, BC-021).
    function h_collect(uint256 callerSeed, uint256 tipSeed) external act(Act.Collect) {
        address caller = _who(callerSeed);
        address tipTo = tipSeed % 5 == 0 ? _who(tipSeed >> 8) : keeper;
        uint256 e0 = tipTo.balance;
        try this.x_collect{gas: _cap(tipTo)}(caller, tipTo) returns (uint256 used) {
            _ok();
            _gas(Act.Collect, used);
            if (tipTo.balance - e0 > receiver.tipMax()) _violation("BC-017: a tip above its cap");
        } catch {
            _refused();
        }
    }

    function x_fundFees(address who, uint256 amount) external onlySelf {
        _fundFees(who, amount);
    }

    function x_fundDepth(address who, uint256 amount) external onlySelf {
        _fundDepth(who, amount);
    }

    struct FeeCase {
        uint256 amount;
        uint256 fit0;
        uint256 held0;
        uint256 owed0;
        uint256 hookQ0;
        uint256 carry0;
        bool settled0;
        bool grad0;
        uint256 kept0;
    }

    /// `fundFees` (BC-107): 11/15 FIT, 2/15 depth, 2/15 under the cap, remainders carried; big gifts reach the cap.
    function h_fundFees(uint256 whoSeed, uint256 amountSeed) external act(Act.FundFees) {
        FeeCase memory c;
        address who = _payee(whoSeed);
        c.amount = amountSeed % 7 == 0 ? 50 ether + (amountSeed >> 8) % 300 ether : _amount(amountSeed >> 4, 1, 2 ether);
        c.fit0 = receiver.fitOwed();
        c.held0 = receiver.platformHeld();
        c.owed0 = receiver.platformOwed();
        c.hookQ0 = pm.balanceOf(a.hook, 0);
        (c.carry0,) = receiver.carried();
        c.settled0 = receiver.graduationSettled();
        c.grad0 = _graduated();
        (, c.kept0,) = receiver.platformEpoch();
        try this.x_fundFees(who, c.amount) {
            _ok();
            if (c.grad0 == c.settled0) _checkFundFees(c);
        } catch {
            _refused();
            _violation("BC-107: fundFees refused");
        }
    }

    function _checkFundFees(FeeCase memory c) internal {
        uint256 unit = (c.amount + c.carry0) / 15;
        if (receiver.fitOwed() - c.fit0 != 11 * unit) _violation("BC-107: FIT's 11/15 of a fundFees");
        if (!c.grad0) {
            if (receiver.platformHeld() - c.held0 != 2 * unit) _violation("BC-106: the held 2/15 before graduation");
            return;
        }
        // Graduated and settled before the call: keep = min(2u, cap − kept this epoch), the rest and the 2/15 depth to
        // the hook's claims at once.
        (uint256 epochNow, uint256 keptNow,) = receiver.platformEpoch();
        epochNow;
        uint256 keep = receiver.platformOwed() - c.owed0;
        uint256 room = BoxSpecV1.PLATFORM_CAP_WEI - (keptNow - keep);
        uint256 want = 2 * unit < room ? 2 * unit : room;
        if (keep != want) _violation("BC-106: the platform keeps min(P, cap - kept this epoch)");
        if (pm.balanceOf(a.hook, 0) - c.hookQ0 != 4 * unit - keep) {
            _violation("BC-106: depth gets 2/15 plus the excess");
        }
    }

    /// `fundDepth`: the receiver's whole ETH balance (forced ETH included) to depth, held before graduation (BC-109).
    function h_fundDepth(uint256 whoSeed, uint256 amountSeed) external act(Act.FundDepth) {
        address who = _payee(whoSeed);
        uint256 amount = _amount(amountSeed, 1e9, 1 ether);
        uint256 forced = a.receiver.balance;
        bool grad = _graduated();
        bool settled = receiver.graduationSettled();
        uint256 hookQ0 = pm.balanceOf(a.hook, 0);
        (uint256 held0,) = receiver.depthHeld();
        try this.x_fundDepth(who, amount) {
            _ok();
            if (a.receiver.balance != 0) _violation("BC-107: fundDepth left ETH in the receiver");
            if (forced != 0) gForced[a.receiver] = 0;
            if (grad == settled) {
                uint256 got = grad ? pm.balanceOf(a.hook, 0) - hookQ0 : _depthHeldQ() - held0;
                if (got != amount + forced) _violation("BC-107: fundDepth adds its whole balance to depth");
            }
        } catch {
            _refused();
            _violation("BC-107: fundDepth refused");
        }
    }

    function _depthHeldQ() internal view returns (uint256 q) {
        (q,) = receiver.depthHeld();
    }

    /// ETH forced (`vm.deal` on top) onto every box address (M27's shape; never counted as fees).
    function h_forceEth(uint256 targetSeed, uint256 amountSeed) external act(Act.ForceEth) {
        address[14] memory t = [
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
            address(src)
        ];
        address target = t[targetSeed % 14];
        uint256 amount = _amount(amountSeed, 1, 1 ether);
        _forceEth(target, amount);
        gForced[target] += amount;
        gForcedTotal[target] += amount;
        _ok();
    }

    function x_royalty(address who, uint256 amount, bool weth) external onlySelf {
        if (weth) _payRoyaltyWeth(who, amount);
        else _payRoyalty(who, amount);
    }

    /// Royalties to the royalty router in ETH (any amount, 0 included) or WETH (BC-114: never refused).
    function h_royalty(uint256 whoSeed, uint256 amountSeed, uint256 wethSeed) external act(Act.Royalty) {
        address who = _payee(whoSeed);
        uint256 amount = amountSeed % 11 == 0 ? 0 : _amount(amountSeed >> 4, 1, 2 ether);
        bool weth = wethSeed % 3 == 0 && amount != 0;
        try this.x_royalty(who, amount, weth) {
            _ok();
        } catch {
            _refused();
            _violation("BC-114: a royalty payment was refused");
        }
    }

    function x_flush(address caller) external onlySelf returns (uint256 used) {
        _coolAll();
        vm.prank(caller);
        uint256 g = gasleft();
        royaltyRouter.flush();
        used = g - gasleft();
    }

    /// `flush` (anyone, after graduation): every ETH and unwrapped WETH to the receiver's `fundFees` (BC-115).
    function h_flush(uint256 callerSeed) external act(Act.Flush) {
        uint256 eth0 = a.royaltyRouter.balance + _wethOf(a.royaltyRouter);
        bool grad = _graduated();
        try this.x_flush(_who(callerSeed)) returns (uint256 used) {
            _ok();
            _gas(Act.Flush, used);
            if (!grad) _violation("BC-115: a flush before graduation");
            if (a.royaltyRouter.balance != 0 || _wethOf(a.royaltyRouter) != 0) _violation("BC-115: flush left funds");
            if (gForced[a.royaltyRouter] != 0) gForced[a.royaltyRouter] = 0;
            eth0;
        } catch {
            _refused();
            if (grad && eth0 != 0) _violation("BC-115: a flush with funds after graduation was refused");
        }
    }

    function _wethOf(address who) internal view returns (uint256 b) {
        (bool ok, bytes memory ret) = a.weth.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        if (ok && ret.length >= 32) b = abi.decode(ret, (uint256));
    }

    /// `sweep(WETH)` (as flush) and `sweep(T)`, which stays (TokenNotTaken; M02's class).
    function h_sweepWeth(uint256 callerSeed, uint256 modeSeed) external act(Act.SweepWeth) {
        address caller = _who(callerSeed);
        if (modeSeed % 4 == 0) {
            vm.prank(caller);
            try royaltyRouter.sweep(a.token) {
                _violation("BC-114: sweep(T) moved a token other than WETH");
            } catch {
                _refused();
            }
            return;
        }
        uint256 w0 = _wethOf(a.royaltyRouter);
        vm.prank(caller);
        try royaltyRouter.sweep(a.weth) {
            _ok();
            if (_wethOf(a.royaltyRouter) != 0 || a.royaltyRouter.balance != 0) _violation("BC-115: sweep left WETH");
            if (gForced[a.royaltyRouter] != 0) gForced[a.royaltyRouter] = 0;
        } catch {
            _refused();
            if (_graduated() && w0 != 0) _violation("BC-115: a WETH sweep after graduation was refused");
        }
    }

    /// The launch router's `sweep`: after graduation all of its ETH (the tax, and ETH `forceEth` put there) to the
    /// hook's claims (BC-140); an empty router refuses (NothingToSweep). The action forces no ETH of its own.
    function h_routerSweep(uint256 callerSeed) external act(Act.RouterSweep) {
        uint256 bal = a.launchRouter.balance;
        uint256 hookQ0 = pm.balanceOf(a.hook, 0);
        bool migrated = hook.migratedAtBlock() != 0;
        vm.prank(_who(callerSeed));
        try launchRouter.sweep() returns (uint256 amount) {
            _ok();
            if (!migrated) _violation("BC-140: a sweep before graduation");
            if (amount != bal || pm.balanceOf(a.hook, 0) - hookQ0 != bal) {
                _violation("BC-140: sweep is not all to depth");
            }
            gForced[a.launchRouter] = 0;
        } catch {
            _refused();
            if (migrated && bal != 0) _violation("BC-140: a sweep with tax after graduation was refused");
        }
    }

    /// `payFit` (anyone after graduation): the held FIT share into the executor's budget (BC-020).
    function h_payFit(uint256 callerSeed) external act(Act.PayFit) {
        bool settled0 = receiver.graduationSettled();
        uint256 owed = receiver.fitOwed();
        uint256 b0 = a.executor.balance;
        bool grad = _graduated();
        try this.x_payFit(_who(callerSeed)) returns (uint256 amount) {
            _ok();
            if (!grad) _violation("BC-020: FIT paid before graduation");
            if (settled0 && amount != owed) _violation("X01: payFit pays exactly fitOwed");
            if (a.executor.balance != b0 + amount) _violation("X01: payFit's amount is the executor's budget rise");
            if (receiver.fitOwed() != 0) _violation("X01: payFit left FIT owed");
        } catch {
            _refused();
            if (grad && settled0 && owed != 0) _violation("BC-020: payFit refused with FIT owed after graduation");
        }
    }

    function x_payFit(address caller) external onlySelf returns (uint256) {
        return _payFit(caller);
    }

    function x_payPlatform(address caller) external onlySelf returns (uint256) {
        return _payPlatform(caller);
    }

    /// `payPlatform` (anyone): the Safe's credit to the fixed Safe; receipts per epoch (X07, W1-U4-2).
    function h_payPlatform(uint256 callerSeed) external act(Act.PayPlatform) {
        uint256 owed = receiver.platformOwed();
        bool settled0 = receiver.graduationSettled();
        uint256 s0 = safe.balance;
        try this.x_payPlatform(_who(callerSeed)) returns (uint256 amount) {
            _ok();
            if (safe.balance - s0 != amount) _violation("BC-141: the Safe got another amount than paid");
            if (settled0 && amount != owed) _violation("BC-141: payPlatform pays exactly platformOwed");
            _notePlatformPaid(amount);
        } catch {
            _refused();
            if (settled0 && owed != 0) _violation("BC-021: payPlatform refused with a credit (the Safe accepts ETH)");
        }
    }

    function _notePlatformPaid(uint256 amount) internal {
        gSafePaid += amount;
        (uint256 epoch,,) = receiver.platformEpoch();
        if (epoch != gSafePaidEpoch) {
            gSafePaidEpoch = epoch;
            gSafePaidInEpoch = 0;
        }
        gSafePaidInEpoch += amount;
        if (gSafePaidInEpoch > BoxSpecV1.PLATFORM_CAP_WEI) {
            _exc(Exc.W1_U4_2, gSafePaidInEpoch - BoxSpecV1.PLATFORM_CAP_WEI);
        }
    }

    function x_claimReward(address who, address to) external onlySelf returns (uint256) {
        return _claimReward(who, to);
    }

    /// `claimReward(to)`: the credited graduator only, once; a refusing `to` keeps the claim (BC-027, X20).
    function h_claimReward(uint256 whoSeed, uint256 toSeed) external act(Act.ClaimReward) {
        address holder = gRewardHolder;
        address who = (holder != address(0) && whoSeed % 4 != 0) ? holder : _who(whoSeed);
        address to = toSeed % 5 == 0 ? address(ethRefuser) : _payee(toSeed);
        uint256 credited = coordinator.rewardOf(who);
        uint256 e0 = to.balance;
        try this.x_claimReward(who, to) returns (uint256 amount) {
            _ok();
            if (amount != credited || credited == 0) _violation("X20: claimReward paid another amount");
            if (to.balance - e0 != amount) _violation("X20: the reward did not reach its recipient");
            if (coordinator.rewardOf(who) != 0) _violation("X20: the reward was not cleared");
            gRewardClaimed = true;
        } catch {
            _refused();
            if (credited != 0 && !_refuses(to)) _violation("X20: a credited reward was refused");
            if (coordinator.rewardOf(who) != credited) _violation("X20: a refused claim changed the credit");
        }
    }

    function x_giftClaims(address target, uint256 amount) external onlySelf {
        address payer = eoa[5];
        _fund(payer, amount);
        uint256 e0 = payer.balance;
        vm.prank(payer);
        gifter.giftEth{value: amount}(target);
        _noteEthChange(e0, payer.balance, EthIn.Other, EthOut.Other);
    }

    /// A stranger's ERC-6909 ETH claims to the receiver (the next batch, W1-U4-3), the hook (its depth budget) or the
    /// coordinator (before graduation forwarded to the receiver, after it no exit).
    function h_giftClaims(uint256 targetSeed, uint256 amountSeed) external act(Act.GiftClaims) {
        uint256 m = targetSeed % 6;
        address target = m < 3 ? a.receiver : m < 5 ? a.hook : a.coordinator;
        uint256 amount = _amount(amountSeed, 1, 0.05 ether);
        try this.x_giftClaims(target, amount) {
            _ok();
            if (target == a.coordinator && _graduated()) gClaimGift[target] += amount;
            if (target == a.coordinator && !_graduated()) gCoordGiftPre += amount;
        } catch {
            _refused();
            _violation("ERC-6909: a claims gift was refused");
        }
    }

    // ================================================================================================ depth and FIT's executor

    function x_deepen(address tipTo) external onlySelf returns (DepthKind kind, DeepenSkip skip, uint256 used) {
        uint256 e0 = tipTo.balance;
        _coolAll();
        vm.prank(keeper);
        uint256 g = gasleft();
        (kind, skip,,,) = hook.deepen(tipTo);
        used = g - gasleft();
        if (!_ghostIsSystem[tipTo]) _noteEthChange(e0, tipTo.balance, EthIn.Other, EthOut.Tip);
    }

    /// `deepen` after a price push of 90-110 ticks off the average in either direction (BC-119's 99-tick guard), or
    /// without one; the push is unwound after.
    function h_deepen(uint256 pushSeed, uint256 dirSeed, uint256 tipSeed) external act(Act.Deepen) {
        if ((tipSeed >> 8) % 2 == 0) _warmAverage();
        address pusher = eoa[2];
        bool pushed;
        int24 off;
        if (_graduated() && pushSeed % 2 == 0) {
            off = int24(int256(90 + (pushSeed >> 8) % 21));
            if (dirSeed % 2 == 0) off = -off;
            pushed = _pushTo(pusher, off);
        }
        int24 dev = _deviation();
        address tipTo = tipSeed % 6 == 0 ? a.receiver : keeper;
        try this.x_deepen(tipTo) returns (DepthKind kind, DeepenSkip skip, uint256 used) {
            _gas(Act.Deepen, used);
            if (kind == DepthKind.Pair || kind == DepthKind.Convert) {
                _ok();
                if (dev > 99 || dev < -99) _violation("BC-119: deepen added with |spot - average| above 99 ticks");
            } else {
                _refused();
                if (uint256(skip) == 0) _violation("BC-119: deepen added nothing and named no skip");
            }
        } catch {
            _refused();
            // A tip recipient that refuses ETH fails only its caller's own call (BC-021 as for collect's tip; wave 1
            // triage, not entered); with an accepting one deepen skips, never reverts.
            if (tipTo == keeper) _violation("BC-119: deepen reverted (it skips, never reverts)");
        }
        if (pushed) _pushTo(pusher, 0);
    }

    /// @dev After graduation, while the executor's 1-hour average has no full window: a keeper's samples every five
    /// minutes for 65 minutes (one poke per sample's block), so a deepen or an execute can find the average ready.
    function _warmAverage() internal {
        if (!_graduated()) return;
        (bool ready,,) = executor.twap();
        if (ready) return;
        for (uint256 i; i < 13; ++i) {
            _adv(300 / blockSeconds);
            vm.prank(keeper);
            executor.poke();
        }
    }

    /// @dev Moves spot to `off` ticks from the executor's average (0: back to the average); false if not possible.
    function _pushTo(address who, int24 off) internal returns (bool) {
        (bool ready, int24 avg,) = executor.twap();
        if (!ready) return false;
        int24 target = avg + off;
        (uint160 sp,,,) = pm.getSlot0(poolKey.toId());
        uint160 limit = TickMath.getSqrtPriceAtTick(target);
        if (limit == sp) return true;
        bool zeroForOne = limit < sp;
        SwapParams memory p = SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: zeroForOne ? -int256(20 ether) : -int256(token.balanceOf(who) / 2 + 1),
            sqrtPriceLimitX96: limit
        });
        if (!zeroForOne && token.balanceOf(who) == 0) return false;
        try this.x_swap(who, p, zeroForOne ? 20 ether : 0) {
            return true;
        } catch {
            return false;
        }
    }

    /// @dev Spot tick minus the executor's average tick (0 when the average is not ready).
    function _deviation() internal view returns (int24) {
        (bool ready, int24 avg,) = executor.twap();
        if (!ready) return 0;
        (, int24 tick,,) = pm.getSlot0(poolKey.toId());
        return tick - avg;
    }

    /// The executor's `poke` (box 0's price average: one sample per timestamp).
    function h_poke(uint256 callerSeed) external act(Act.Poke) {
        vm.prank(_who(callerSeed));
        try executor.poke() {
            _ok();
        } catch {
            _refused();
            _violation("BC-129: the average's poke reverted");
        }
    }

    function x_execute(uint256 maxChunks) external onlySelf returns (uint256 chunks, uint256 used) {
        _coolAll();
        vm.prank(keeper);
        uint256 g = gasleft();
        (chunks,,) = executor.execute(maxChunks);
        used = g - gasleft();
    }

    /// `execute(c)` (anyone): FIT bought and burned within the bounds, never before graduation, at most one chunk per
    /// block (BC-020, BC-041); it never reverts.
    function h_execute(uint256 chunksSeed) external act(Act.Execute) {
        if ((chunksSeed >> 8) % 2 == 0) _warmAverage();
        uint256 spent0 = executor.totalEthSpent();
        try this.x_execute(1 + chunksSeed % 3) returns (uint256 chunks, uint256 used) {
            _gas(Act.Execute, used);
            gDirectT[a.executor] = 0;
            if (chunks == 0) return _refused();
            _ok();
            if (!_graduated()) _violation("X08: the executor bought before graduation");
            if (gExecBlock != vm.getBlockNumber()) {
                gExecBlock = vm.getBlockNumber();
                gExecChunks = 0;
            }
            gExecChunks += chunks;
            if (gExecChunks > executor.MAX_CHUNKS_PER_BLOCK()) {
                _violation("BC-041: more chunks in a block than allowed");
            }
            if (executor.totalEthSpent() <= spent0) _violation("BC-041: a chunk spent nothing");
        } catch {
            _refused();
            _violation("BC-020: execute reverted (it stops, never reverts)");
        }
    }

    function x_fundBudget(address who, uint256 amount) external onlySelf {
        _fundBudget(who, amount);
    }

    /// `fundBudget` by anyone: the whole amount to the budget, no share to anyone (BC-108).
    function h_fundBudget(uint256 whoSeed, uint256 amountSeed) external act(Act.FundBudget) {
        uint256 amount = _amount(amountSeed, 1, 1 ether);
        uint256 b0 = a.executor.balance;
        try this.x_fundBudget(_payee(whoSeed), amount) {
            _ok();
            gOutsideBudget += amount;
            if (a.executor.balance != b0 + amount) _violation("BC-108: fundBudget did not add the whole amount");
        } catch {
            _refused();
            _violation("BC-108: fundBudget refused");
        }
    }

    // ================================================================================================ tickets on the curve

    function x_take(address who, uint256 k) external onlySelf {
        _take(who, k);
    }

    /// Take k placeholders on the curve: the vault's quote ⌈A·k/n⌉ plus the 1% fee, burned (X14, VLT-08).
    function h_take(uint256 whoSeed, uint256 kSeed) external act(Act.Take) {
        if (vault.gateOpenedAt() != 0 || hook.closed() || vm.getBlockTimestamp() < tickets.openAt()) return _skipped();
        uint256 k = 1 + kSeed % 3;
        (uint256 p, uint256 f) = vault.quoteTake(k);
        address who = _holder(whoSeed, p + f);
        if (who == address(0)) {
            who = _payee(whoSeed);
            _topUpOnCurve(who, p + f);
        }
        if (token.balanceOf(who) < p + f) return _skipped();
        VaultState memory b = _vaultState();
        uint256 t0 = token.balanceOf(who);
        try this.x_take(who, k) {
            _ok();
            _checkLock(b, p, f, t0 - token.balanceOf(who), int256(k), "take");
        } catch {
            _refused();
            _violation("X14: a take on the curve was refused");
        }
    }

    /// @dev Before graduation: a small buy (through the launch router in the window, else the stand-in), so a taker
    /// holds T.
    function _topUpOnCurve(address who, uint256 need) internal {
        if (hook.closed() || _refuses(who)) return;
        uint256 now_ = vm.getBlockTimestamp();
        if (now_ < hook.openAt()) return;
        for (uint256 i; i < 3 && token.balanceOf(who) < need; ++i) {
            if (now_ < hook.windowEndsAt()) {
                try this.x_windowBuy(who, 0.02 ether) {}
                catch {
                    return;
                }
            } else {
                try this.x_buy(who, 0.01 ether) {}
                catch {
                    return;
                }
            }
            if (hook.closed()) return;
        }
    }

    /// @dev X14 for a lock (take, draw, pick, take by number): the payer paid p + f, S fell by f (burned), E rose by p,
    /// with p, f the pre-action quote, the fee ⌈p·bps/10,000⌉ of the pre-action principal.
    function _checkLock(VaultState memory b, uint256 p, uint256 f, uint256 paid, int256 dt, string memory what)
        internal
    {
        VaultState memory c = _vaultState();
        if (paid != p + f) _violation(string.concat("X14: a ", what, " paid another amount than its quote"));
        if (b.s - c.s != f) _violation(string.concat("X14: a ", what, "'s fee was not burned exactly"));
        if (c.e - b.e != p) _violation(string.concat("X14: a ", what, "'s principal is not E's rise"));
        if (int256(c.t) - int256(b.t) != dt) _violation(string.concat("X04: a ", what, " moved t by another count"));
    }

    function x_handBack(address who, uint256[] memory ids) external onlySelf returns (uint256, uint256) {
        return _handBack(who, ids);
    }

    /// Hand back on the curve (and number-less in terminal mode): ⌊A·k/n⌋ less 5% (X14, X04).
    function h_handBack(uint256 idSeed) external act(Act.HandBack) {
        (uint256[] memory ids,) = _livePlaceholders();
        if (ids.length == 0) return _skipped();
        uint256 id = ids[idSeed % ids.length];
        address owner = tickets.ownerOf(id);
        IBoxTickets.TicketState memory s = tickets.status();
        bool allowed = vault.gateOpenedAt() == 0 || (s.terminalAt != 0 && s.wordAcceptedAt == 0);
        uint256[] memory one = new uint256[](1);
        one[0] = id;
        (uint256 qp, uint256 qf) = allowed ? vault.quoteHandBack(1) : (0, 0);
        uint256 t0 = token.balanceOf(owner);
        uint256 s0 = token.totalSupply();
        try this.x_handBack(owner, one) returns (uint256 p, uint256 f) {
            _ok();
            ++gBurnedPlaceholders;
            if (!allowed) _violation("X04: a hand-back passed outside the curve and number-less terminal mode");
            if (p != qp || f != qf) _violation("X14: a hand-back paid another quote than the pre-action one");
            if (token.balanceOf(owner) - t0 != p - f || s0 - token.totalSupply() != f) {
                _violation("X14: a hand-back's net or burned fee");
            }
        } catch (bytes memory err) {
            _refused();
            if (allowed) {
                _violation("X04: a hand-back was refused where the rules allow it");
            } else if (keccak256(err) != keccak256(abi.encodeWithSelector(IBoxTickets.HandBackClosed.selector))) {
                _violation("X04: a closed hand-back refused with the wrong error");
            }
        }
    }

    /// Placeholder transfers (frozen while the graduation word waits; P6.x).
    function h_transferPlaceholder(uint256 idSeed, uint256 toSeed) external act(Act.TransferPlaceholder) {
        (uint256[] memory ids,) = _livePlaceholders();
        if (ids.length == 0) return _skipped();
        uint256 id = ids[idSeed % ids.length];
        address from = tickets.ownerOf(id);
        address to = _payee(toSeed);
        if (to == from) to = eoa[(toSeed % 6 + 1) % 6];
        IBoxTickets.TicketState memory s = tickets.status();
        bool frozen = vault.gateOpenedAt() != 0 && s.terminalAt == 0 && s.wordAcceptedAt == 0;
        vm.prank(from);
        try tickets.transferFrom(from, to, id) {
            _ok();
            if (frozen) _violation("X04: a placeholder moved while frozen");
        } catch (bytes memory err) {
            _refused();
            if (!frozen) {
                _violation("X04: a placeholder transfer was refused outside the freeze");
            } else if (keccak256(err) != keccak256(abi.encodeWithSelector(IBoxTickets.Frozen.selector))) {
                _violation("X04: a frozen transfer refused with the wrong error");
            }
        }
    }

    // ================================================================================================ the graduation word

    function x_requestWord(address who, uint256 value) external onlySelf {
        _requestGraduationWord(who, value);
    }

    /// `requestGraduationWord` by anyone: refused unless graduation's own poke failed (R0-A: no passing path on box 0
    /// as built); a probe of its refusal rules.
    function h_requestWord(uint256 whoSeed, uint256 valueSeed) external act(Act.RequestWord) {
        IBoxTickets.TicketState memory s = tickets.status();
        bool want = vault.gateOpenedAt() != 0 && s.terminalAt == 0 && s.slots != 0 && s.wordRequestedAt == 0;
        try this.x_requestWord(_payee(whoSeed), valueSeed % 1_000 * 1 gwei) {
            _ok();
            if (!want) _violation("X11: the word was requested against the rule");
            (, uint64 round) = src.requestOf(a.tickets, 0);
            _noteRound(round);
        } catch {
            _refused();
            if (want) _violation("X11: a word request the rules allow was refused");
        }
    }

    /// `acceptGraduationWord` (anyone, once the word is usable).
    function h_acceptWord() external act(Act.AcceptWord) {
        IBoxTickets.TicketState memory s = tickets.status();
        bool want = vault.gateOpenedAt() != 0 && s.wordAcceptedAt == 0 && s.terminalAt == 0 && s.wordRequestedAt != 0
            && _usable(0, s.wordRequestedAt);
        vm.prank(_who(s.minted));
        try tickets.acceptGraduationWord() {
            _ok();
            if (!want) _violation("X11: the word was accepted against the rule");
        } catch {
            _refused();
            if (want) _violation("X11: a usable word was refused");
        }
    }

    // ================================================================================================ draws

    struct DrawCase {
        address who;
        uint256 round;
        uint256 pot0;
        uint256 shortfall;
        uint256 value;
        uint256 e0;
        uint256 nextId;
        uint256 p;
        uint256 f;
        uint256 t0;
        bool want;
    }

    function x_draw(address who, uint256 value) external onlySelf returns (uint256) {
        return _draw(who, value);
    }

    /// One draw (U6's oracle): the pot topped to its target, the rest refunded (into the pot for a refuser), the
    /// principal and the 1% fee by the pre-action quote (X14), consecutive ids, refused when the head is dead.
    function h_draw(uint256 whoSeed, uint256 valueSeed) external act(Act.Draw) {
        if (_drawCase(whoSeed, valueSeed)) _ok();
    }

    /// Two to four draws in one block (one round), different drawers.
    function h_drawMany(uint256 seed, uint256 valueSeed) external act(Act.DrawMany) {
        uint256 k = 2 + seed % 3;
        bool any;
        for (uint256 i; i < k; ++i) {
            if (_drawCase(uint256(keccak256(abi.encode(seed, i))), valueSeed >> (8 * i))) any = true;
        }
        if (any) _ok();
    }

    function _drawCase(uint256 whoSeed, uint256 valueSeed) internal returns (bool drew) {
        if (vault.gateOpenedAt() == 0) {
            _skipped();
            return false;
        }
        DrawCase memory c;
        c.who = whoSeed % 3 == 0 ? _who(whoSeed >> 2) : _holder(whoSeed >> 2, 1);
        if (c.who == address(0)) c.who = _payee(whoSeed);
        IBoxTickets.TicketState memory s = tickets.status();
        c.round = _roundNow();
        c.pot0 = drand.bountyOf(c.round);
        uint256 target = _target();
        c.shortfall = c.pot0 < target ? target - c.pot0 : 0;
        uint256 mode = valueSeed % 5;
        if (mode == 0) c.value = c.shortfall;
        else if (mode == 1 || mode == 4) c.value = target;
        else if (mode == 2) c.value = 2 * target + 1;
        else c.value = c.shortfall == 0 ? 0 : c.shortfall - 1;
        try vault.quoteTake(1) returns (uint256 p, uint256 f) {
            (c.p, c.f) = (p, f);
        } catch {
            _skipped();
            return false;
        }
        if (token.balanceOf(c.who) < c.p + c.f) _topUp(c.who, c.p + c.f);
        if (token.balanceOf(c.who) < c.p + c.f) {
            _skipped();
            return false;
        }
        Head memory h = _head();
        bool sendWord = s.slots != 0 && s.wordRequestedAt == 0;
        c.want = s.terminalAt == 0 && (sendWord || !(h.exists && h.dead)) && c.pot0 + c.value >= target;
        c.e0 = c.who.balance;
        c.t0 = token.balanceOf(c.who);
        c.nextId = uint256(s.drawsRequested) + 1;
        VaultState memory b = _vaultState();
        try this.x_draw{gas: _cap(c.who)}(c.who, c.value) returns (uint256 id) {
            drew = true;
            _checkDraw(c, id, b);
        } catch {
            _refused();
            if (c.want && c.who != address(gasBurner)) _violation("X12: a draw the rules allow was refused");
        }
    }

    function _checkDraw(DrawCase memory c, uint256 id, VaultState memory b) internal {
        if (!c.want) _violation("X12: a draw passed against the rule");
        _noteRound(c.round);
        uint256 rest = c.value - c.shortfall;
        uint256 paid = rest != 0 && _refuses(c.who) ? c.value : c.shortfall;
        if (drand.bountyOf(c.round) != c.pot0 + paid) {
            _violation("F75 W3: the pot is not max(pot, target) (+ a refused rest)");
        }
        if (c.who.balance != c.e0 + c.value - paid) _violation("F75 W3: the drawer did not get exactly its rest back");
        if (id != c.nextId) _violation("X04: draw ids are not consecutive");
        _checkLock(b, c.p, c.f, c.t0 - token.balanceOf(c.who), 1, "draw");
    }

    /// @dev After graduation: buys T for `who` until it holds `need` (three tries of 0.05 ETH at most).
    function _topUp(address who, uint256 need) internal {
        if (!_graduated() || who == address(gasBurner)) return;
        for (uint256 i; i < 3 && token.balanceOf(who) < need; ++i) {
            try this.x_buy(who, 0.05 ether) {}
            catch {
                return;
            }
        }
    }

    function x_settle(uint256 k) external onlySelf returns (uint256 n, uint256 used) {
        _coolAll();
        vm.prank(poster);
        uint256 g = gasleft();
        n = tickets.settle(k);
        used = g - gasleft();
    }

    /// `settle(k)`: words applied strictly in request order, as many as the rule allows (X13, X12).
    function h_settle(uint256 kSeed) external act(Act.Settle) {
        uint256 k = 1 + kSeed % 4;
        uint256 want = _settleable(k);
        try this.x_settle(k) returns (uint256 n, uint256 used) {
            _gas(Act.Settle, used);
            _ok();
            if (n != want) _violation("X13: settle settled another count than the rule");
        } catch {
            _refused();
            if (want != 0) _violation("X12: settle refused while the head's word counts");
        }
    }

    function x_open(address who, uint256 id, ItemReveal memory r) external onlySelf returns (uint256 item) {
        vm.prank(who);
        item = tickets.open(id, r);
    }

    /// Open a placeholder (holder), with its reveal or without one after the grace (BC-051).
    function h_openPlaceholder(uint256 idSeed, uint256 modeSeed) external act(Act.OpenPlaceholder) {
        (uint256[] memory ids,) = _livePlaceholders();
        if (ids.length == 0) return _skipped();
        uint256 id = ids[idSeed % ids.length];
        address owner = tickets.ownerOf(id);
        IBoxTickets.TicketState memory s = tickets.status();
        bool withReveal = modeSeed % 3 != 0;
        bool want = s.wordAcceptedAt != 0
            && (withReveal || vm.getBlockTimestamp() >= uint256(s.wordAcceptedAt) + tickets.REVEAL_GRACE());
        uint256 item = s.wordAcceptedAt != 0 ? tickets.numberOf(id) : 0;
        ItemReveal memory r;
        if (withReveal && item != 0) r = tree.itemReveal(item);
        try this.x_open(owner, id, r) {
            _ok();
            ++gBurnedPlaceholders;
            if (!want) _violation("X04: a placeholder opened against the rule");
            if (collection.ownerOf(item) != owner) _violation("X03: a placeholder's item missed its holder");
            _noteDelivered(item);
        } catch {
            _refused();
            if (want) _violation("X12: a placeholder open the rules allow was refused");
        }
    }

    struct OpenCase {
        uint256 ticket;
        uint256 item;
        uint256 graceAt;
        address caller;
        address to;
        address recipient;
        bool want;
        bool withReveal;
    }

    function x_openDraw(address caller, uint256 ticket, address to, ItemReveal memory r)
        external
        onlySelf
        returns (uint256 used)
    {
        _coolAll();
        vm.prank(caller);
        uint256 g = gasleft();
        tickets.openDraw(ticket, to, r);
        used = g - gasleft();
    }

    /// `openDraw` by the drawer (to any address), by a stranger (to the drawer; a contract drawer only after 30 days),
    /// with or without its reveal (U6's oracle; W2-U6-1's saturation in the grace's rule).
    function h_openDraw(uint256 ticketSeed, uint256 modeSeed) external act(Act.OpenDraw) {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.drawsRequested == 0) return _skipped();
        OpenCase memory c;
        c.ticket = 1 + ticketSeed % s.drawsRequested;
        IBoxTickets.DrawView memory d = tickets.drawTicket(c.ticket);
        if (d.status == DrawStatus.Opened || d.status == DrawStatus.Cancelled) {
            ticketSeed = ticketSeed >> 8;
            c.ticket = uint256(s.drawsSettled) >= 1 ? 1 + ticketSeed % s.drawsRequested : c.ticket;
            d = tickets.drawTicket(c.ticket);
        }
        uint256 mode = modeSeed % 4;
        bool willSettle = d.status == DrawStatus.Requested && c.ticket > s.drawsSettled
            && _settleable(type(uint256).max) >= c.ticket - s.drawsSettled;
        bool settledAlready = d.status == DrawStatus.Settled;
        if (settledAlready) {
            (c.item, c.graceAt) = (d.itemId, d.revealFallbackAt);
        } else if (willSettle) {
            c.item = _replayItems(c.ticket)[c.ticket];
            uint256 hoursTaken = (vm.getBlockTimestamp() - d.requestedAt + 1 hours - 1) / 1 hours;
            if (hoursTaken > type(uint16).max) {
                hoursTaken = type(uint16).max;
                _exc(Exc.W2_U6_1, 1);
            }
            c.graceAt = d.requestedAt + hoursTaken * 1 hours + 30 days;
        }
        c.caller = mode == 2 ? eoa[6] : d.drawer;
        c.to = mode == 1 ? eoa[2] : c.caller;
        c.withReveal = mode != 3;
        // An open of a settled draw without a reveal first waits for its 30-day grace (an unrevealed item leaves: the
        // safety net); a draw the open itself settles is opened at once (its grace counts from then: RevealRequired).
        if (!c.withReveal && settledAlready && c.graceAt > vm.getBlockTimestamp()) {
            _warpT(c.graceAt);
            _edge(E_REVEAL_GRACE, 0);
        }
        c.want = (settledAlready || willSettle)
            && (mode != 2 || !_isContract(d.drawer) || vm.getBlockTimestamp() >= c.graceAt)
            && (c.withReveal || vm.getBlockTimestamp() >= c.graceAt);
        c.recipient = mode == 2 ? d.drawer : c.to;
        ItemReveal memory r;
        if (c.withReveal && c.item != 0) r = tree.itemReveal(c.item);
        try this.x_openDraw(c.caller, c.ticket, c.to, r) returns (uint256 used) {
            _ok();
            _gas(Act.OpenDraw, used);
            if (!c.want) _violation("X12: a draw opened against the rule");
            if (collection.ownerOf(c.item) != c.recipient) {
                _violation("X03: the item went to an address the rule does not name");
            }
            if (tickets.ticketInFlight() != 0) _violation("R1: a ticket stayed in flight");
            _noteDelivered(c.item);
        } catch {
            _refused();
            if (c.want) _violation("X12: an open the rules allow was refused");
        }
    }

    // ================================================================================================ randomness

    function x_post(uint256 round) external onlySelf {
        _post(round);
    }

    /// Post a committed round some pending key waits on (also after its backup started: ignored by box 0's source).
    function h_postRound(uint256 seed) external act(Act.PostRound) {
        uint256 round = _pickPendingRound(seed);
        if (round == 0 || !gIsCommitted[round]) return _skipped();
        (, uint64 postedAt) = drand.beaconOf(round);
        if (postedAt != 0 || vm.getBlockTimestamp() < src.roundTime(round)) return _skipped();
        try this.x_post(round) {
            _ok();
        } catch {
            _refused();
            _violation("X11: a valid post was refused");
        }
    }

    /// Every committed, due, unposted round a pending key waits on.
    function h_postAll() external act(Act.PostAll) {
        IBoxTickets.TicketState memory s = tickets.status();
        uint256 from = s.wordAcceptedAt == 0 ? 0 : uint256(s.drawsSettled) + 1;
        for (uint256 key = from; key <= s.drawsRequested; ++key) {
            if (key == 0 && s.wordRequestedAt == 0) continue;
            uint256 round = _pendingRound(key);
            if (round == 0 || !gIsCommitted[round]) continue;
            // A committed round not due yet is at most a few blocks ahead: wait for it.
            if (vm.getBlockTimestamp() < src.roundTime(round)) _warpT(src.roundTime(round));
            (, uint64 postedAt) = drand.beaconOf(round);
            if (postedAt != 0) continue;
            try this.x_post(round) {
                _ok();
            } catch {
                _violation("X11: a valid post was refused");
            }
        }
        if (curOutcome == 0) _skipped();
    }

    function x_addBounty(address who, uint256 round, uint256 value, bool viaBacked) external onlySelf {
        _addBounty(who, round, value, viaBacked);
    }

    /// `addBounty` on the round now, on either source (X01's pots).
    function h_addBounty(uint256 seed, uint256 viaSeed) external act(Act.AddBounty) {
        uint256 round = _roundNow();
        (, uint64 postedAt) = drand.beaconOf(round);
        if (postedAt != 0) return _skipped();
        try this.x_addBounty(_payee(seed), round, (seed % 1_000) * 1 gwei, viaSeed % 2 == 0) {
            _ok();
            _noteRound(round);
        } catch {
            _refused();
            _violation("X01: a bounty was refused");
        }
    }

    function x_withdrawBounty(address to) external onlySelf returns (uint256) {
        return _withdrawBounty(poster, payable(to));
    }

    /// The poster's `withdrawBounty(to)` (a refusing `to` keeps the credit).
    function h_withdrawBounty(uint256 toSeed) external act(Act.WithdrawBounty) {
        uint256 owed = drand.owedTo(poster);
        address to = toSeed % 6 == 0 ? address(ethRefuser) : _payee(toSeed);
        try this.x_withdrawBounty(to) returns (uint256 amount) {
            _ok();
            if (amount != owed || drand.owedTo(poster) != 0) _violation("X01: withdrawBounty paid another amount");
        } catch {
            _refused();
            if (owed != 0 && !_refuses(to)) _violation("X01: a credited bounty was refused");
            if (drand.owedTo(poster) != owed) _violation("X01: a refused withdrawal changed the credit");
        }
    }

    function x_startBackup(uint256 round) external onlySelf {
        _startBackup(round, eoa[6]);
    }

    /// `startBackup` inside and outside [5 d, 5 d 18 h] after its round's time (the edges ± one block first).
    function h_startBackup(uint256 seed, uint256 edgeSeed) external act(Act.StartBackup) {
        uint256 round = _pickPendingRound(seed);
        if (round == 0) return _skipped();
        uint256 rt = src.roundTime(round);
        uint256 e = edgeSeed % 4;
        uint256 edge = e == 0 ? rt + src.BACKUP_AFTER() : e == 1 ? rt + src.LATEST_START() : 0;
        if (edge != 0) {
            edge = edge + (edgeSeed >> 8) % 3;
            if (edge >= 1) edge -= 1;
            if (edge > vm.getBlockTimestamp()) {
                _warpT(edge);
                _edge(e == 0 ? E_BACKUP_AFTER : E_LATEST_START, _offset(edgeSeed));
            }
        }
        uint256 now_ = vm.getBlockTimestamp();
        (uint64 startedAt,,,) = src.backupOf(round);
        (, uint64 postedAt) = drand.beaconOf(round);
        bool want = now_ > rt + src.BACKUP_AFTER() && now_ <= rt + src.LATEST_START() && startedAt == 0 && postedAt == 0;
        try this.x_startBackup(round) {
            _ok();
            gStarted.push(round);
            if (!want) _violation("X11: a backup started against the rule");
        } catch {
            _refused();
            if (want) _violation("X11: a backup start the rule allows was refused");
        }
    }

    function x_fixBackup(uint256 round, bytes32 mix) external onlySelf {
        _fixBackup(round, mix, poster);
    }

    /// `fixBackup` inside its window and past 8,191 blocks (EIP-2935's history).
    function h_fixBackup(uint256 seed, uint256 mixSeed, uint256 lateSeed) external act(Act.FixBackup) {
        if (gStarted.length == 0) return _skipped();
        uint256 round = gStarted[seed % gStarted.length];
        for (uint256 i; i < gStarted.length; ++i) {
            uint256 x = gStarted[(seed % gStarted.length + i) % gStarted.length];
            (,, uint64 fx,) = src.backupOf(x);
            if (fx == 0) {
                round = x;
                break;
            }
        }
        (, uint64 target, uint64 fixedAt,) = src.backupOf(round);
        uint256 window = src.HISTORY_WINDOW();
        if (lateSeed % 5 == 0 && fixedAt == 0) {
            // The history window's edge: 8,190, 8,191 (the last block EIP-2935 serves) or 8,192 blocks past the target.
            uint256 late = uint256(target) + window - 1 + (lateSeed >> 8) % 3;
            if (late > vm.getBlockNumber()) _adv(late - vm.getBlockNumber());
        } else if (target >= vm.getBlockNumber()) {
            _adv(target - vm.getBlockNumber() + 1 + mixSeed % 50);
        }
        uint256 bn = vm.getBlockNumber();
        uint256 dist = target < bn ? bn - target : 0;
        if (dist + 1 >= window && dist <= window + 1) _edge(E_HISTORY, int256(dist) - int256(window));
        bool want = fixedAt == 0 && target < bn && dist <= window;
        try this.x_fixBackup(round, keccak256(abi.encode("audit.sys.mix", mixSeed))) {
            _ok();
            if (dist > gFixOkMaxDistance) gFixOkMaxDistance = dist;
            if (!want) _violation("X11: a backup fixed against the rule");
        } catch {
            _refused();
            if (fixedAt == 0 && dist != 0 && (gFixRefusedMinDistance == 0 || dist < gFixRefusedMinDistance)) {
                gFixRefusedMinDistance = dist;
            }
            if (want) _violation("X11: a backup fix the rule allows was refused");
        }
    }

    /// A pending round's whole backup: to its first start second if earlier, start, 257+ blocks, fix.
    function h_backupCycle(uint256 seed, uint256 mixSeed) external act(Act.BackupCycle) {
        uint256 round = _pickPendingRound(seed);
        if (round == 0) return _skipped();
        (uint64 startedAt,,,) = src.backupOf(round);
        (, uint64 postedAt) = drand.beaconOf(round);
        if (startedAt != 0 || postedAt != 0) return _skipped();
        uint256 rt = src.roundTime(round);
        uint256 first = rt + src.BACKUP_AFTER() + 1;
        if (vm.getBlockTimestamp() < first) _warpT(first + (seed >> 64) % 18 hours);
        if (vm.getBlockTimestamp() > rt + src.LATEST_START()) return _skipped();
        try this.x_startBackup(round) {
            gStarted.push(round);
        } catch {
            _refused();
            _violation("X11: a backup start inside its window was refused");
            return;
        }
        _adv(src.TARGET_BLOCKS() + 1 + (seed >> 128) % 300);
        try this.x_fixBackup(round, keccak256(abi.encode("audit.sys.mix", mixSeed))) {
            _ok();
        } catch {
            _refused();
            _violation("X11: a backup fix inside its window was refused");
        }
    }

    // ================================================================================================ terminal mode

    /// `enterTerminal`: only when the queue head is dead (X12).
    function h_enterTerminal(uint256 whoSeed) external act(Act.EnterTerminal) {
        Head memory h = _head();
        bool want = h.exists && h.dead;
        vm.prank(_who(whoSeed));
        try tickets.enterTerminal() {
            _ok();
            if (!want) _violation("X12: terminal mode entered against the rule");
        } catch {
            _refused();
            if (want) _violation("X12: a dead head did not let anyone enter terminal mode");
        }
    }

    function x_cancel(uint256 ticket) external onlySelf returns (uint256) {
        return _cancelDraw(eoa[2], ticket);
    }

    /// `cancelDraw` in terminal mode: exactly the current principal back to the drawer, the fee stays burned (X19).
    function h_cancelDraw(uint256 seed) external act(Act.CancelDraw) {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.drawsRequested == 0) return _skipped();
        uint256 ticket = 1 + seed % s.drawsRequested;
        IBoxTickets.DrawView memory d = tickets.drawTicket(ticket);
        bool want = s.terminalAt != 0 && d.status == DrawStatus.Requested;
        uint256 quote = want ? vault.quoteReturn(1) : 0;
        uint256 t0 = token.balanceOf(d.drawer);
        uint256 s0 = token.totalSupply();
        try this.x_cancel(ticket) returns (uint256 principal) {
            _ok();
            if (!want) _violation("X19: a draw cancelled against the rule");
            if (principal != quote || token.balanceOf(d.drawer) != t0 + quote) {
                _violation("X19: a cancel did not pay the drawer exactly the current principal");
            }
            if (token.totalSupply() != s0) _violation("X19: a cancel burned or minted T");
        } catch {
            _refused();
            if (want) _violation("X19: a cancel the rule allows was refused");
        }
    }

    function x_takeByNumber(address who, uint256 item, uint256 index, bool withReveal) external onlySelf {
        _approveT(who, a.tickets);
        ItemReveal memory r;
        if (withReveal) r = tree.itemReveal(item);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        tickets.takeByNumber(item, index, type(uint256).max, deadline, r);
        _noteTChange(t0, token.balanceOf(who), TIn.TakeByNumber, TOut.Other);
    }

    /// `takeByNumber` from 3 days into terminal mode: a free pool item, each number once (X19).
    function h_takeByNumber(uint256 seed, uint256 revealSeed) external act(Act.TakeByNumber) {
        IBoxTickets.TicketState memory s = tickets.status();
        if (s.terminalAt == 0) return _skipped();
        if (vm.getBlockTimestamp() < uint256(s.terminalAt) + tickets.TAKE_DELAY()) {
            _warpT(uint256(s.terminalAt) + tickets.TAKE_DELAY());
            _edge(E_TAKE_DELAY, 0);
        }
        uint256 item;
        uint256 index;
        if (s.slots == 0 || s.wordAcceptedAt != 0) {
            uint256 left = editionSize - s.slots - s.drawsSettled;
            if (left == 0) return _skipped();
            index = seed % left;
            uint256 position = tickets.poolPositionAt(index);
            (uint256 u, uint256 v) = BoxShuffle.halves(editionSize);
            item = tickets.firstId()
                + (s.slots == 0 ? position : BoxShuffle.permute(tickets.graduationWord(), position, editionSize, u, v));
        } else {
            item = 1 + seed % editionSize;
        }
        if (!vault.isHidden(item) || vault.inside() <= 1) return _skipped();
        address who = _payee(seed >> 32);
        (uint256 p, uint256 f) = vault.quoteTake(1);
        if (token.balanceOf(who) < p + f) _topUp(who, p + f);
        if (token.balanceOf(who) < p + f) return _skipped();
        VaultState memory b = _vaultState();
        uint256 t0 = token.balanceOf(who);
        try this.x_takeByNumber(who, item, index, revealSeed % 2 == 0) {
            _ok();
            _noteDelivered(item);
            if (collection.ownerOf(item) != who) _violation("X19: a take by number missed its taker");
            _checkLock(b, p, f, t0 - token.balanceOf(who), 0, "take by number");
        } catch {
            _refused();
            _violation("X19: a take by number of a free pool item was refused");
        }
    }

    // ================================================================================================ vault and collection

    /// @dev A returned (shelf) item that is revealed, from `seed`, or 0.
    function _shelfItem(uint256 seed) internal view returns (uint256) {
        uint256 n = gLeft.length;
        for (uint256 i; i < n; ++i) {
            uint256 id = gLeft[(seed % n + i) % n];
            if (vault.isOnShelf(id) && collection.isRevealed(id)) return id;
        }
        return 0;
    }

    /// @dev An outside item held by an actor (not a box contract), from `seed`, or 0.
    function _outsideItem(uint256 seed) internal view returns (uint256 id, address owner) {
        uint256 n = gLeft.length;
        for (uint256 i; i < n; ++i) {
            id = gLeft[(seed % n + i) % n];
            owner = collection.ownerOf(id);
            if (owner != a.vault && gStuckAt[id] == address(0) && _ghostIsOutside[owner]) return (id, owner);
        }
        return (0, address(0));
    }

    function x_pick(address who, uint256 id) external onlySelf {
        _pick(who, id);
    }

    function x_pickBatch(address who, uint256[] memory ids) external onlySelf returns (uint256 used) {
        _approveT(who, a.vault);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        _coolAll();
        vm.prank(who);
        uint256 g = gasleft();
        vault.withdrawBatch(ids, type(uint256).max, deadline);
        used = g - gasleft();
        _noteTChange(t0, token.balanceOf(who), TIn.Pick, TOut.Other);
    }

    /// The vault's named pick of a revealed shelf item: ⌈A·k/n⌉ plus 25%, burned (X14, VLT-08).
    function h_pick(uint256 seed, uint256 whoSeed) external act(Act.Pick) {
        uint256 id = _shelfItem(seed);
        if (id == 0 || vault.inside() <= 1) return _skipped();
        address who = _payee(whoSeed);
        uint256 p = vault.quoteWithdraw(1);
        uint256 f = AuditU7ClaudeMath.feeOf(p, PICK_BPS);
        if (token.balanceOf(who) < p + f) _topUp(who, p + f);
        if (token.balanceOf(who) < p + f) return _skipped();
        VaultState memory b = _vaultState();
        uint256 t0 = token.balanceOf(who);
        try this.x_pick(who, id) {
            _ok();
            _checkLock(b, p, f, t0 - token.balanceOf(who), 0, "pick");
            gReturned[id] = false;
            if (collection.ownerOf(id) != who) _violation("X03: a pick missed its picker");
        } catch {
            _refused();
            _violation("X14: a named pick of a revealed shelf item was refused");
        }
    }

    /// `withdrawBatch` of up to three revealed shelf items (X18's gas, X14).
    function h_pickBatch(uint256 seed, uint256 whoSeed) external act(Act.PickBatch) {
        uint256[] memory ids = new uint256[](3);
        uint256 k;
        uint256 n = gLeft.length;
        for (uint256 i; i < n && k < 3; ++i) {
            uint256 id = gLeft[(seed % n + i) % n];
            if (vault.isOnShelf(id) && collection.isRevealed(id)) ids[k++] = id;
        }
        if (k == 0 || vault.inside() <= k) return _skipped();
        assembly ("memory-safe") {
            mstore(ids, k)
        }
        address who = _payee(whoSeed);
        uint256 p = vault.quoteWithdraw(k);
        uint256 f = AuditU7ClaudeMath.feeOf(p, PICK_BPS);
        if (token.balanceOf(who) < p + f) _topUp(who, p + f);
        if (token.balanceOf(who) < p + f) return _skipped();
        VaultState memory b = _vaultState();
        uint256 t0 = token.balanceOf(who);
        try this.x_pickBatch(who, ids) returns (uint256 used) {
            _ok();
            _gas(Act.PickBatch, used);
            _checkLock(b, p, f, t0 - token.balanceOf(who), 0, "batch pick");
            for (uint256 i; i < k; ++i) {
                gReturned[ids[i]] = false;
            }
        } catch {
            _refused();
            // Fable U7 § 6 (not entered): a batch whose fee burn would take S below E + p + n − k is refused whole.
        }
    }

    function x_return(address who, uint256 id) external onlySelf {
        _returnItem(who, id);
    }

    function x_returns(address who, uint256[] memory ids) external onlySelf returns (uint256 used) {
        vm.prank(who);
        collection.setApprovalForAll(a.vault, true);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        _coolAll();
        vm.prank(who);
        uint256 g = gasleft();
        vault.returnItems(ids, 0, deadline);
        used = g - gasleft();
        _noteTChange(t0, token.balanceOf(who), TIn.Other, TOut.Return);
    }

    function _returnable(uint256 id) internal view returns (bool) {
        return collection.isRevealed(id)
            || (tickets.returnableFrom(id) != 0 && vm.getBlockTimestamp() >= tickets.returnableFrom(id));
    }

    /// `returnItem`: an owner returns a revealed item (or one past `returnableFrom`): ⌊A·k/n⌋ less 5% (X14, X03).
    function h_returnItem(uint256 seed) external act(Act.ReturnItem) {
        (uint256 id, address owner) = _outsideItem(seed);
        if (id == 0 || !_returnable(id)) return _skipped();
        uint256 q = vault.quoteReturn(1);
        uint256 f = AuditU7ClaudeMath.feeOf(q, RETURN_BPS);
        VaultState memory b = _vaultState();
        uint256 t0 = token.balanceOf(owner);
        try this.x_return(owner, id) {
            _ok();
            gReturned[id] = true;
            VaultState memory c2 = _vaultState();
            if (token.balanceOf(owner) - t0 != q - f) _violation("X14: a return paid another net than its quote");
            if (b.s - c2.s != f || b.e - c2.e != q) _violation("X14: a return's fee or principal");
            if (collection.ownerOf(id) != a.vault) _violation("X03: a returned item is not the vault's");
        } catch {
            _refused();
            _violation("X14: a return of an outside returnable item was refused");
        }
    }

    /// `returnItems` of up to three returnable items of one owner (X18's gas).
    function h_returnItems(uint256 seed) external act(Act.ReturnItems) {
        (uint256 first, address owner) = _outsideItem(seed);
        if (first == 0) return _skipped();
        uint256[] memory ids = new uint256[](3);
        uint256 k;
        uint256 n = gLeft.length;
        for (uint256 i; i < n && k < 3; ++i) {
            uint256 id = gLeft[(seed % n + i) % n];
            if (gStuckAt[id] == address(0) && collection.ownerOf(id) == owner && _returnable(id)) ids[k++] = id;
        }
        if (k == 0) return _skipped();
        assembly ("memory-safe") {
            mstore(ids, k)
        }
        try this.x_returns(owner, ids) returns (uint256 used) {
            _ok();
            _gas(Act.ReturnItems, used);
            for (uint256 i; i < k; ++i) {
                gReturned[ids[i]] = true;
            }
        } catch {
            _refused();
            _violation("X14: returnItems of returnable items was refused");
        }
    }

    /// `reveal` by anyone of an item that left the vault unrevealed (once per id, BC-054).
    function h_reveal(uint256 seed) external act(Act.Reveal) {
        uint256 n = gLeft.length;
        uint256 id;
        for (uint256 i; i < n; ++i) {
            uint256 x = gLeft[(seed % n + i) % n];
            if (!collection.isRevealed(x)) {
                id = x;
                break;
            }
        }
        if (id == 0) {
            if (n == 0 || seed % 8 != 0) return _skipped();
            id = gLeft[seed % n];
        }
        bool want = !collection.isRevealed(id) && collection.isRevealable(id);
        ItemReveal memory r = tree.itemReveal(id);
        vm.prank(_who(seed >> 16));
        try collection.reveal(id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof) {
            _ok();
            if (!want) _violation("BC-054: a reveal passed against the rule");
        } catch {
            _refused();
            if (want) _violation("BC-054: a valid reveal was refused");
        }
    }

    /// Item transfers between outside actors (transferFrom or safeTransferFrom; the observer books the stream), and
    /// the refused sends to the vault, T and the collection (BC-042).
    function h_transferItem(uint256 seed, uint256 toSeed, uint256 modeSeed) external act(Act.TransferItem) {
        (uint256 id, address owner) = _outsideItem(seed);
        if (id == 0) return _skipped();
        uint256 m = modeSeed % 8;
        if (m == 7) {
            address[3] memory refused_ = [a.vault, a.token, a.collection];
            address bad = refused_[(modeSeed >> 8) % 3];
            vm.prank(owner);
            try collection.transferFrom(owner, bad, id) {
                _violation("BC-042: an item send to the vault, T or the collection passed");
            } catch {
                _refused();
            }
            return;
        }
        address to = _who(toSeed);
        if (to == owner) to = _payee(toSeed % 7 + 1);
        if (to == owner) return _skipped();
        vm.prank(owner);
        if (m % 2 == 0) {
            try collection.transferFrom(owner, to, id) {
                _ok();
            } catch {
                _refused();
                _violation("X03: an owner's transfer was refused");
            }
        } else {
            try collection.safeTransferFrom(owner, to, id) {
                _ok();
            } catch {
                _refused();
                _violation("X03: an owner's safe transfer to an accepting actor was refused");
            }
        }
        if (curOutcome == 1 && collection.ownerOf(id) != to) _violation("X03: a transfer did not move the item");
    }

    /// W3-U7-1 (accepted, no exit): an item sent with `transferFrom` to a box contract; `safeTransferFrom` to one is
    /// refused (no receiver hook).
    function h_itemToBox(uint256 seed, uint256 targetSeed) external act(Act.ItemToBox) {
        (uint256 id, address owner) = _outsideItem(seed);
        if (id == 0) return _skipped();
        address[9] memory boxes = [
            a.itemStream,
            a.receiver,
            a.coordinator,
            a.hook,
            a.executor,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.table
        ];
        address target = boxes[targetSeed % 9];
        if ((targetSeed >> 8) % 3 == 0) {
            vm.prank(owner);
            try collection.safeTransferFrom(owner, target, id) {
                _violation("W3-U7-1: a safe transfer to a box contract passed");
            } catch {
                _refused();
            }
            return;
        }
        vm.prank(owner);
        try collection.transferFrom(owner, target, id) {
            _ok();
            gStuck.push(id);
            gStuckAt[id] = target;
            _exc(Exc.W3_U7_1, gStuck.length);
        } catch {
            _refused();
            _violation("W3-U7-1: transferFrom to a box contract was refused (the register says it passes)");
        }
    }

    /// Approvals on the collection (owner's `approve` and `setApprovalForAll`).
    function h_approveItem(uint256 seed, uint256 opSeed) external act(Act.ApproveItem) {
        (uint256 id, address owner) = _outsideItem(seed);
        if (id == 0) return _skipped();
        address op = _payee(opSeed);
        vm.prank(owner);
        if (opSeed % 2 == 0) {
            try collection.approve(op, id) {
                _ok();
            } catch {
                _refused();
            }
        } else {
            try collection.setApprovalForAll(op, (opSeed >> 8) % 2 == 0) {
                _ok();
            } catch {
                _refused();
            }
        }
    }

    // ================================================================================================ the stream

    function x_claimStream(address who, uint256[] memory ids) external onlySelf returns (uint256 paid, uint256 used) {
        uint256 t0 = token.balanceOf(who);
        _coolAll();
        vm.prank(who);
        uint256 g = gasleft();
        paid = stream.claim(ids, who);
        used = g - gasleft();
        _noteTChange(t0, token.balanceOf(who), TIn.Other, TOut.StreamClaim);
    }

    function x_claimStreamFor(address caller, address account, uint256[] memory ids)
        external
        onlySelf
        returns (uint256)
    {
        if (_ghostIsSystem[account]) {
            vm.prank(caller);
            return stream.claimFor(account, ids);
        }
        return _claimStreamFor(caller, account, ids);
    }

    /// @dev Every outside item `owner` holds (ids it owns among those that left the vault).
    function _idsOf(address owner) internal view returns (uint256[] memory ids) {
        uint256 n = gLeft.length;
        ids = new uint256[](n);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            if (collection.ownerOf(gLeft[i]) == owner) ids[k++] = gLeft[i];
        }
        assembly ("memory-safe") {
            mstore(ids, k)
        }
    }

    /// An owner's `claim(ids, self)`: what the stream holds, up to what it owes less 1 raw unit (X10).
    function h_streamClaim(uint256 seed) external act(Act.StreamClaim) {
        (uint256 id, address owner) = _outsideItem(seed);
        if (id == 0) return _skipped();
        uint256[] memory ids = _idsOf(owner);
        uint256 held = token.balanceOf(a.itemStream);
        try this.x_claimStream(owner, ids) returns (uint256 paid, uint256 used) {
            _gas(Act.StreamClaim, used);
            if (paid == 0) return _refused();
            _ok();
            if (paid > held) _violation("X10: a claim paid more than the stream held");
        } catch {
            _refused();
            _violation("X10: an owner's stream claim reverted");
        }
    }

    /// Anyone's `claimFor(account, ids)` (pays only the account; a box contract holding items included: M25's class).
    function h_streamClaimFor(uint256 seed, uint256 callerSeed) external act(Act.StreamClaimFor) {
        address account;
        uint256[] memory ids;
        if (gStuck.length != 0 && seed % 4 == 0) {
            uint256 id = gStuck[(seed >> 8) % gStuck.length];
            account = gStuckAt[id];
            if (account == a.itemStream) return _skipped();
            ids = _idsOf(account);
        } else {
            uint256 id;
            (id, account) = _outsideItem(seed);
            if (id == 0) return _skipped();
            ids = _idsOf(account);
        }
        try this.x_claimStreamFor(_who(callerSeed), account, ids) returns (uint256 paid) {
            if (paid == 0) return _refused();
            _ok();
            if (_ghostIsSystem[account]) {
                gDirectT[account] += paid;
                _exc(Exc.M25, gDirectT[account]);
            }
        } catch {
            _refused();
            _violation("X10: a claimFor of an owner's items reverted");
        }
    }

    /// The stream's `burn` (anyone): the items-inside share it holds beyond the owners' accrual.
    function h_streamBurn(uint256 callerSeed) external act(Act.StreamBurn) {
        if (callerSeed % 2 == 0 && stream.started()) {
            address giver = _holder(callerSeed >> 8, 1e18);
            if (giver != address(0)) {
                try this.x_transferT(giver, a.itemStream, token.balanceOf(giver) / 100 + 1) {} catch {}
            }
        }
        uint256 s0 = token.totalSupply();
        vm.prank(_who(callerSeed));
        try stream.burn() returns (uint256 burned) {
            if (burned == 0) return _refused();
            _ok();
            if (s0 - token.totalSupply() != burned) _violation("X02: the stream's burn is not the supply's fall");
        } catch {
            _refused();
            if (stream.started()) _violation("X10: the stream's burn reverted");
        }
    }

    // ================================================================================================ T by holders

    function x_transferT(address who, address to, uint256 amount) external onlySelf {
        _transferT(who, to, amount);
    }

    /// Plain T transfers between outside holders.
    function h_transferT(uint256 fromSeed, uint256 toSeed, uint256 amountSeed) external act(Act.TransferT) {
        address from = _holder(fromSeed, 1);
        address to = _who(toSeed);
        if (from == address(0) || to == from) return _skipped();
        uint256 bal = token.balanceOf(from);
        try this.x_transferT(from, to, bal / (1 + amountSeed % 4)) {
            _ok();
        } catch {
            _refused();
            _violation("X02: a plain T transfer was refused");
        }
    }

    /// T sent straight to a box address: the vault and T refuse (BC-043); the coordinator before graduation joins the
    /// ask (W2-U2-2); the receiver M01, the royalty router M02, the stream a gift it burns, the others M25.
    function h_tToBox(uint256 whoSeed, uint256 targetSeed, uint256 amountSeed) external act(Act.TToBox) {
        address who = _holder(whoSeed, 1);
        if (who == address(0)) return _skipped();
        uint256 bal = token.balanceOf(who);
        address[13] memory t = [
            a.vault,
            a.token,
            a.coordinator,
            a.receiver,
            a.royaltyRouter,
            a.itemStream,
            a.hook,
            a.executor,
            a.launchRouter,
            a.tickets,
            a.collection,
            a.table,
            address(drand)
        ];
        address target = t[targetSeed % 13];
        uint256 amount = amountSeed % 5 == 0 ? 1 : bal / (100 + amountSeed % 900);
        if (amount == 0) amount = 1;
        bool grad = _graduated();
        try this.x_transferT(who, target, amount) {
            _ok();
            if (target == a.vault || target == a.token) _violation("BC-043: T sent to the vault or to T passed");
            _noteDirectT(target, amount, grad);
        } catch {
            _refused();
            if (target != a.vault && target != a.token) _violation("BC-043: a T send to a box address was refused");
        }
    }

    function _noteDirectT(address target, uint256 amount, bool grad) internal {
        if (target == a.coordinator && !grad) {
            gGiftToCoordinator += amount;
        } else if (target == a.receiver) {
            gDirectT[target] += amount;
            _exc(Exc.M01, gDirectT[target]);
        } else if (target == a.royaltyRouter) {
            gDirectT[target] += amount;
            _exc(Exc.M02, gDirectT[target]);
        } else if (target != a.itemStream && target != a.executor) {
            gDirectT[target] += amount;
            _exc(Exc.M25, gDirectT[target]);
        }
    }

    function x_burnT(address who, uint256 amount) external onlySelf {
        _burnT(who, amount);
    }

    /// A holder's own burn above the vault's floor E + n (BC-005).
    function h_burnT(uint256 whoSeed, uint256 amountSeed) external act(Act.BurnT) {
        address who = _holder(whoSeed, 1);
        if (who == address(0)) return _skipped();
        uint256 bal = token.balanceOf(who);
        uint256 amount = bal / (2 + amountSeed % 50);
        if (amount == 0) return _skipped();
        bool want = token.totalSupply() - amount >= vault.supplyFloor();
        try this.x_burnT(who, amount) {
            _ok();
            if (!want) _violation("BC-005: a burn below the floor passed");
        } catch {
            _refused();
            if (want) _violation("BC-005: a burn above the floor was refused");
        }
    }

    // ================================================================================================ probes and time

    /// Outside liquidity and donations, refused in every phase (X16, BC-032).
    function h_probePool(uint256 modeSeed) external act(Act.ProbePool) {
        uint256 m = modeSeed % 3;
        vm.deal(address(lp), address(lp).balance + 1 ether);
        bool passed;
        if (m == 0) {
            try lp.modify{value: 0.5 ether}(
                poolKey,
                ModifyLiquidityParams({
                    tickLower: BoxSpecV1.MIN_USABLE_TICK,
                    tickUpper: BoxSpecV1.MAX_USABLE_TICK,
                    liquidityDelta: 1e12,
                    salt: 0
                }),
                address(lp)
            ) {
                passed = true;
            } catch {}
        } else if (m == 1) {
            try lp.modify(
                poolKey,
                ModifyLiquidityParams({
                    tickLower: BoxSpecV1.MIN_USABLE_TICK,
                    tickUpper: BoxSpecV1.MAX_USABLE_TICK,
                    liquidityDelta: -1,
                    salt: 0
                }),
                address(lp)
            ) {
                passed = true;
            } catch {}
        } else {
            try lp.donate{value: 1e15}(poolKey, 1e15, 0, address(lp)) {
                passed = true;
            } catch {}
        }
        // The probe's ETH never reached box 0 (refused): take it back out of the outside world's view.
        vm.deal(address(lp), 0);
        if (passed) _violation("X16: outside liquidity or a donation passed");
        _refused();
    }

    /// Time: 12 s, 1 h, 1 d, 5 d + offset, 7 d ± 1 s from the head's request, 30 d ± 1 s, epoch boundaries ± 1 s,
    /// the backup's edges, terminal + 3 days.
    function h_warp(uint256 seed) external act(Act.Warp) {
        uint256 mode = seed % 16;
        uint256 now_ = vm.getBlockTimestamp();
        uint256 off = (seed >> 8) % 3;
        uint256 edge;
        uint256 kind;
        if (mode <= 5) {
            _adv(1 + (seed >> 16) % 3);
        } else if (mode == 6) {
            _warpT(now_ + 1 hours);
        } else if (mode == 7) {
            _warpT(now_ + 1 days);
        } else if (mode == 8) {
            _warpT(now_ + 5 days + (seed >> 24) % 1 days);
        } else if (mode == 9) {
            Head memory h = _head();
            if (h.exists) (edge, kind) = (h.deadline, h.requested ? E_HEAD : E_UNREQUESTED);
        } else if (mode == 10) {
            if (vault.gateOpenedAt() != 0) {
                (edge, kind) = (vault.gateOpenedAt() + tickets.SILENCE_UNREQUESTED(), E_UNREQUESTED);
            } else {
                edge = now_ + 30 days;
                kind = N_EDGE;
            }
        } else if (mode == 11) {
            uint256 g = coordinator.graduatedAt();
            if (g != 0) (edge, kind) = (g + ((now_ - g) / 30 days + 1) * 30 days, E_EPOCH);
        } else if (mode == 12 || mode == 13) {
            uint256 round = _pickPendingRound(seed >> 32);
            if (round != 0) {
                edge = src.roundTime(round) + (mode == 12 ? src.BACKUP_AFTER() : src.LATEST_START());
                kind = mode == 12 ? E_BACKUP_AFTER : E_LATEST_START;
            }
        } else if (mode == 14) {
            IBoxTickets.TicketState memory s = tickets.status();
            if (s.terminalAt != 0) {
                (edge, kind) = (uint256(s.terminalAt) + tickets.TAKE_DELAY(), E_TAKE_DELAY);
            } else if (s.wordAcceptedAt != 0) {
                (edge, kind) = (uint256(s.wordAcceptedAt) + tickets.REVEAL_GRACE(), E_REVEAL_GRACE);
            }
        } else {
            uint256 openAt = hook.openAt();
            if (now_ < openAt) (edge, kind) = (openAt, E_OPEN_AT);
            else if (now_ < hook.windowEndsAt()) (edge, kind) = (now_ + SLOT * (1 + (seed >> 16) % 6), E_WINDOW_STEP);
            else if (now_ < _requestTimeFor(r0)) (edge, kind) = (_requestTimeFor(r0), E_REQUEST_R0);
        }
        if (edge != 0) {
            edge = edge + off;
            if (edge >= 1) edge -= 1;
            if (edge > now_) {
                _warpT(edge);
                if (kind < N_EDGE) _edge(kind, _offset(seed));
            } else {
                _adv(1);
            }
        } else if (mode >= 9) {
            _adv(1);
        }
        _ok();
    }

    // ================================================================================================ helpers

    function _posLiq(int24 lower, int24 upper, bytes32 salt) internal view returns (uint128) {
        PoolId id = poolKey.toId();
        bytes32 positionKey = keccak256(abi.encodePacked(a.hook, lower, upper, salt));
        return pm.getPositionLiquidity(id, positionKey);
    }
}
