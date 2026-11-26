// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {DeepenSkip, DepthKind, ModuleProceedsTo} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "../../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {AuditGhostLedger, EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU4FableBase, AuditU4FableGasSink, AuditU4FableTallyLib, AuditU4Tally} from "./AuditU4FableBase.sol";

/// @notice What the handler needs to drive box 0 (one struct: the constructor stays within the stack).
struct AuditU4HandlerWorld {
    IPoolManager pm;
    CoreBoxAddresses a;
    PoolKey key;
    AuditRouterSwapper swapper;
    address[5] tips;
    address ethRefuser;
    address gasBurner;
    address[] system;
    address[] outside;
}

/// @title AuditU4FableHandler
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Fable). A fail-safe driver of box 0's receiver and royalty router on the
/// factory's box 0, from the closed curve on: graduation (with or without a failing receiver poke, so the settlement
/// runs late), buys and sells through the Universal Router stand-in, collects with tip recipients that accept, refuse
/// or burn gas, `fundFees`, `fundDepth`, forced ETH, royalties in ETH and WETH with flushes and sweeps, `payFit`,
/// `payPlatform`, the executor's own buys (its REV-16 notes), `deepen` (the hook's notes), gifts of claims, dormant
/// calls by every identity, and warps across epoch edges. After every call it checks the batch identities from the
/// receiver's events and books the boundary moves in a ghost ledger; a broken property is recorded, never reverted, so
/// the campaign goes on and the invariants report it.
contract AuditU4FableHandler is CommonBase, StdCheats, StdUtils, AuditGhostLedger, IUnlockCallback {
    uint256 internal constant CAP = BoxSpecV1.PLATFORM_CAP_WEI;
    uint256 internal constant EPOCH = BoxSpecV1.PLATFORM_EPOCH_SECONDS;

    IPoolManager internal immutable pm;
    BoxReceiver internal immutable receiver;
    BoxCoordinator internal immutable coordinator;
    BoxHook internal immutable hook;
    FitBuybackExecutor internal immutable executor;
    BoxRoyaltyRouter internal immutable router;
    BoxToken internal immutable token;
    address internal immutable stream;
    address internal immutable weth;
    address internal immutable safe;
    AuditRouterSwapper internal immutable swapper;
    PoolKey internal key;
    address[5] internal tips;
    address internal immutable ethRefuser;
    address internal immutable gasBurner;

    // ------------------------------------------------------------------------------------------ ghosts
    /// The first broken property, if any.
    string public violation;
    uint256 public violations;
    /// What each epoch was credited to the Safe's ledger (`PlatformCredited`).
    mapping(uint256 => uint256) public credited;
    uint256 public maxEpoch;
    uint256 public creditedTotal;
    /// ETH forced into the receiver and not yet taken by `fundDepth`.
    uint256 public forcedPending;
    uint256 public paidPlatform;
    uint256 public paidFit;
    uint256 public dormantAccepted;
    bool public graduatedWithFailedPoke;
    /// Coverage: calls and successes per action.
    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public successes;

    struct Pre {
        uint256 unbookedQ;
        uint256 unbookedT;
        uint256 carryQ;
        uint256 carryT;
        uint256 safeBalance;
        uint256 receiverBalance;
        uint256 executorBalance;
        uint256 streamT;
        uint256 supply;
        uint256 heldP;
        bool settled;
    }

    constructor(AuditU4HandlerWorld memory w) {
        pm = w.pm;
        receiver = BoxReceiver(payable(w.a.receiver));
        coordinator = BoxCoordinator(w.a.coordinator);
        hook = BoxHook(w.a.hook);
        executor = FitBuybackExecutor(payable(w.a.executor));
        router = BoxRoyaltyRouter(payable(w.a.royaltyRouter));
        token = BoxToken(w.a.token);
        stream = w.a.itemStream;
        weth = w.a.weth;
        safe = w.a.platform;
        swapper = w.swapper;
        key = w.key;
        tips = w.tips;
        ethRefuser = w.ethRefuser;
        gasBurner = w.gasBurner;
        _ghostToken = w.a.token;
        _ghostWeth = w.a.weth;
        for (uint256 i; i < w.system.length; ++i) {
            _ghostAddSystem(w.system[i]);
        }
        for (uint256 i; i < w.outside.length; ++i) {
            _ghostAddOutside(w.outside[i]);
        }
        _ghostAddOutside(address(this));
        // The ledger starts balanced on today's holdings.
        _noteEthIn(EthIn.Other, _ghostSystemEth());
        _noteTOut(TOut.Other, _ghostOutsideT());
        token.approve(address(swapper), type(uint256).max);
    }

    // ================================================================================================ actions

    /// `graduate()` by the handler; with `breakPoke` the receiver's code is a gas sink during the call (a stand-in),
    /// so the settlement is left to the first later receiver call.
    function graduate(bool breakPoke) external {
        _count("graduate");
        if (coordinator.graduated()) return;
        // The snapshot first: it reads the receiver, whose code is the gas sink during the call when `breakPoke`.
        Pre memory p = _pre();
        bytes memory code;
        if (breakPoke) {
            code = address(receiver).code;
            vm.etch(address(receiver), address(new AuditU4FableGasSink()).code);
        }
        vm.recordLogs();
        bool ok;
        try coordinator.graduate{gas: 15_000_000}() {
            ok = true;
            _ok("graduate");
            if (breakPoke) graduatedWithFailedPoke = true;
        } catch {}
        VmSafe.Log[] memory logs = _logsIf(ok);
        if (breakPoke) vm.etch(address(receiver), code);
        _post(p, logs, false, address(0));
    }

    function buy(uint256 amount) external {
        _count("buy");
        if (!coordinator.graduated()) return;
        amount = bound(amount, 0.01 ether, 3 ether);
        vm.deal(address(this), address(this).balance + amount);
        Pre memory p = _pre();
        vm.recordLogs();
        uint256 e0 = address(this).balance;
        uint256 t0 = token.balanceOf(address(this));
        // forge-lint: disable-next-line(unsafe-typecast)
        SwapParams memory s = SwapParams(true, -int256(amount), TickMath.MIN_SQRT_PRICE + 1);
        bool ok;
        try swapper.swapOne{value: amount}(key, s, "", address(this)) {
            ok = true;
            _ok("buy");
        } catch {}
        _noteEthChange(e0, address(this).balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, token.balanceOf(address(this)), TIn.Sell, TOut.Buy);
        _post(p, _logsIf(ok), false, address(0));
    }

    function sell(uint256 frac) external {
        _count("sell");
        uint256 held = token.balanceOf(address(this));
        uint256 amount = held * bound(frac, 1, 100) / 100;
        if (amount == 0 || !coordinator.graduated()) return;
        Pre memory p = _pre();
        vm.recordLogs();
        uint256 e0 = address(this).balance;
        // forge-lint: disable-next-line(unsafe-typecast)
        SwapParams memory s = SwapParams(false, -int256(amount), TickMath.MAX_SQRT_PRICE - 1);
        bool ok;
        try swapper.swapOne(key, s, "", address(this)) {
            ok = true;
            _ok("sell");
        } catch {}
        _noteEthChange(e0, address(this).balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(held, token.balanceOf(address(this)), TIn.Sell, TOut.Buy);
        _post(p, _logsIf(ok), false, address(0));
    }

    /// `collect(tipTo)`: the handler, two EOAs (one delegated), a refuser or a gas burner as the recipient (six of
    /// eight draws take an accepting recipient, so collects succeed often enough to split many batches).
    function collect(uint256 tipIdx) external {
        _count("collect");
        uint256 draw = tipIdx % 8;
        address tipTo = tips[draw < 6 ? draw % 3 : draw - 3];
        Pre memory p = _pre();
        uint256 e0 = tipTo.balance;
        vm.recordLogs();
        bool ok;
        bytes memory ret;
        if (tipTo == gasBurner) {
            (ok, ret) = address(receiver).call{gas: 3_000_000}(abi.encodeCall(IBoxReceiver.collect, (tipTo)));
        } else {
            (ok, ret) = address(receiver).call(abi.encodeCall(IBoxReceiver.collect, (tipTo)));
        }
        if (ok) {
            _ok("collect");
            if (tipTo == ethRefuser || tipTo == gasBurner) _fail("a refusing or gas-burning tip recipient was paid");
            if (!_ghostIsSystem[tipTo]) _noteEthOut(EthOut.Tip, tipTo.balance - e0);
        } else if (tipTo != ethRefuser && tipTo != gasBurner) {
            // A well-formed collect refuses for one reason only (P4.13): the batch below the minimum.
            if (_sel(ret) != IBoxReceiver.BatchTooSmall.selector) {
                _fail("collect refused for a reason the rules do not name");
            }
        }
        _post(p, _logsIf(ok), ok, tipTo);
    }

    function fundFees(uint256 amount) external {
        _count("fundFees");
        amount = bound(amount, 0, 300 ether);
        vm.deal(address(this), address(this).balance + amount);
        Pre memory p = _pre();
        vm.recordLogs();
        uint256 e0 = address(this).balance;
        bool ok;
        try receiver.fundFees{value: amount}() {
            ok = true;
            _ok("fundFees");
        } catch {
            _fail("fundFees reverted");
        }
        _noteEthChange(e0, address(this).balance, EthIn.FundFees, EthOut.Other);
        _post(p, _logsIf(ok), false, address(0));
    }

    function fundDepth(uint256 amount) external {
        _count("fundDepth");
        amount = bound(amount, 0, 5 ether);
        vm.deal(address(this), address(this).balance + amount);
        Pre memory p = _pre();
        vm.recordLogs();
        uint256 e0 = address(this).balance;
        bool ok;
        try receiver.fundDepth{value: amount}() {
            ok = true;
            _ok("fundDepth");
        } catch {
            _fail("fundDepth reverted");
        }
        _noteEthChange(e0, address(this).balance, EthIn.FundDepth, EthOut.Other);
        VmSafe.Log[] memory logs = _logsIf(ok);
        AuditU4Tally memory t = AuditU4FableTallyLib.tally(logs, address(receiver));
        if (ok && t.depthGifted != amount + forcedPending) {
            _fail("fundDepth did not take msg.value plus the forced ETH");
        }
        if (ok) forcedPending = 0;
        _post(p, logs, false, address(0));
    }

    /// ETH forced onto the receiver (no code runs).
    function forceEth(uint256 amount) external {
        _count("forceEth");
        amount = bound(amount, 1, 2 ether);
        vm.deal(address(receiver), address(receiver).balance + amount);
        forcedPending += amount;
        _noteEthIn(EthIn.Forced, amount);
        _ok("forceEth");
    }

    /// A royalty paid to the router, in ETH or in WETH.
    function royalty(uint256 amount, bool asWeth) external {
        _count("royalty");
        amount = bound(amount, 1, 50 ether);
        vm.deal(address(this), address(this).balance + amount);
        if (asWeth) {
            (bool ok,) = weth.call{value: amount}(abi.encodeWithSignature("deposit()"));
            if (!ok) return _fail("weth deposit");
            (ok,) = weth.call(abi.encodeWithSignature("transfer(address,uint256)", address(router), amount));
            if (!ok) return _fail("weth transfer");
            _noteEthIn(EthIn.RoyaltyWeth, amount);
        } else {
            (bool ok,) = address(router).call{value: amount}("");
            if (!ok) return _fail("the royalty router refused a payment");
            _noteEthIn(EthIn.Royalty, amount);
        }
        _ok("royalty");
    }

    function flush(bool viaSweep) external {
        _count("flush");
        Pre memory p = _pre();
        vm.recordLogs();
        bool ok;
        bytes memory ret;
        (ok, ret) = address(router)
            .call(
                viaSweep ? abi.encodeCall(IBoxRoyaltyRouter.sweep, (weth)) : abi.encodeCall(IBoxRoyaltyRouter.flush, ())
            );
        if (ok) {
            _ok("flush");
            if (address(router).balance != 0) _fail("a flush left ETH in the router");
        } else {
            bytes4 sel = _sel(ret);
            bool legit = sel == IBoxRoyaltyRouter.NotGraduated.selector && !coordinator.graduated()
                || sel == IBoxRoyaltyRouter.NothingToFlush.selector && address(router).balance == 0
                && _wethOf(address(router)) == 0;
            if (!legit) _fail("flush refused for a reason the rules do not name");
        }
        _post(p, _logsIf(ok), false, address(0));
    }

    /// `sweep` of T or ETH must always be refused.
    function sweepOther(bool t) external {
        _count("sweepOther");
        try router.sweep(t ? address(token) : address(0)) {
            _fail("sweep took a token other than WETH");
        } catch {
            _ok("sweepOther");
        }
    }

    function payFit() external {
        _count("payFit");
        Pre memory p = _pre();
        vm.recordLogs();
        uint256 owed = receiver.fitOwed();
        bool ok;
        try receiver.payFit() returns (uint256 amount) {
            ok = true;
            _ok("payFit");
            paidFit += amount;
            if (!coordinator.graduated()) _fail("payFit before graduation");
            if (address(executor).balance != p.executorBalance + amount) {
                _fail("payFit paid the executor another amount");
            }
            if (receiver.graduationSettled() && p.settled && amount != owed) _fail("payFit paid other than fitOwed");
        } catch {}
        _post(p, _logsIf(ok), false, address(0));
    }

    function payPlatform() external {
        _count("payPlatform");
        Pre memory p = _pre();
        vm.recordLogs();
        uint256 owed = receiver.platformOwed();
        bool ok;
        try receiver.payPlatform() returns (uint256 amount) {
            ok = true;
            _ok("payPlatform");
            paidPlatform += amount;
            _noteEthOut(EthOut.Platform, safe.balance - p.safeBalance);
            if (safe.balance != p.safeBalance + amount) _fail("payPlatform paid the Safe another amount");
            if (p.settled && amount != owed) _fail("payPlatform paid other than platformOwed");
        } catch {}
        _post(p, _logsIf(ok), false, address(0));
    }

    /// The executor's own buy-and-burn (its fee comes back through REV-16 in the next batch); its oracle poke.
    function executeFit(uint256 chunks, bool pokeOnly) external {
        _count("executeFit");
        Pre memory p = _pre();
        vm.recordLogs();
        bool ok;
        if (pokeOnly) {
            try executor.poke() {
                ok = true;
                _ok("executeFit");
            } catch {}
        } else {
            try executor.execute(bound(chunks, 1, 4)) returns (uint256 c, uint256, uint256) {
                ok = true;
                if (c != 0) _ok("executeFit");
                if (!coordinator.graduated() && c != 0) _fail("the executor bought before graduation");
            } catch {}
        }
        _post(p, _logsIf(ok), false, address(0));
    }

    /// `deepen` (the hook's conversion notes reach the receiver), the tip to the handler.
    function deepen() external {
        _count("deepen");
        Pre memory p = _pre();
        vm.recordLogs();
        uint256 e0 = address(this).balance;
        bool ok;
        try hook.deepen(address(this)) returns (DepthKind k, DeepenSkip, uint256, uint256, uint256) {
            ok = true;
            if (k != DepthKind.None) _ok("deepen");
        } catch {}
        _noteEthChange(e0, address(this).balance, EthIn.Other, EthOut.Tip);
        _post(p, _logsIf(ok), false, address(0));
    }

    /// A gift of ETH claims to the receiver (the next batch).
    function giftClaims(uint256 amount) external {
        _count("giftClaims");
        amount = bound(amount, 1, 1 ether);
        vm.deal(address(this), address(this).balance + amount);
        uint256 e0 = address(this).balance;
        pm.unlock(abi.encode(amount));
        _noteEthChange(e0, address(this).balance, EthIn.Other, EthOut.Other);
        _ok("giftClaims");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "handler: pm");
        uint256 amount = abi.decode(data, (uint256));
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.mint(address(receiver), 0, amount);
        return "";
    }

    function warp(uint256 choice) external {
        _count("warp");
        uint256[9] memory menu = [uint256(12), 1 hours, 1 days, 5 days, 7 days, 30 days, EPOCH - 1, EPOCH, EPOCH + 1];
        uint256 secs = menu[choice % 9];
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs / 12 + 1);
        _ok("warp");
    }

    /// Every dormant path, as the handler or as one of box 0's own identities: must revert.
    function dormant(uint256 which, uint256 callerIdx) external {
        _count("dormant");
        address[5] memory callers = [address(this), address(hook), address(executor), address(coordinator), stream];
        address who = callers[callerIdx % 5];
        bytes[7] memory data = [
            abi.encodeCall(IBoxReceiver.pullForModule, ()),
            abi.encodeCall(IBoxReceiver.moduleProceeds, (ModuleProceedsTo.FitQ, 1)),
            abi.encodeCall(IBoxReceiver.claimCreator, (who)),
            abi.encodeCall(IBoxReceiver.proposeCreatorPayee, (who)),
            abi.encodeCall(IBoxReceiver.acceptCreatorPayee, ()),
            abi.encodeCall(IBoxReceiver.fundCreator, ()),
            abi.encodeCall(IBoxReceiver.noteModuleFees, (1, 1))
        ];
        uint256 i = which % 7;
        // A note from the hook or the executor is allowed (and moves no claim); every other case must revert. Box 0's
        // hook notes only inside a conversion (BoxHookExtension.sol:407: it needs the hook's own claims, which exist
        // from the settlement on) and its executor only after a spend (FitBuybackExecutor.sol:270: after graduation),
        // so the campaign impersonates them only once graduated. (The receiver itself takes a note from either
        // identity in any phase and returns it with the next batch even on the curve: an observation, see evidence.)
        bool allowed = i == 6 && (who == address(hook) || who == address(executor));
        if (allowed && !coordinator.graduated()) return;
        (uint256 bq, uint256 bt) = receiver.booked();
        vm.prank(who);
        (bool ok,) = address(receiver).call(data[i]);
        if (ok && !allowed) {
            ++dormantAccepted;
            _fail("a dormant path accepted a call");
        }
        (uint256 bq1, uint256 bt1) = receiver.booked();
        if (bq1 != bq || bt1 != bt) _fail("a dormant call changed a ledger");
        _ok("dormant");
    }

    function onGraduationAgain() external {
        _count("onGraduationAgain");
        Pre memory p = _pre();
        vm.recordLogs();
        bool settledBefore = receiver.graduationSettled();
        bool ok;
        try receiver.onGraduation() {
            ok = true;
            if (settledBefore || !coordinator.graduated()) _fail("onGraduation ran twice or before graduation");
            _ok("onGraduationAgain");
        } catch {
            if (coordinator.graduated() && !settledBefore) _fail("onGraduation refused a due settlement");
        }
        _post(p, _logsIf(ok), false, address(0));
    }

    // ================================================================================================ checks

    function _pre() internal view returns (Pre memory p) {
        (uint256 bq, uint256 bt) = receiver.booked();
        p.unbookedQ = pm.balanceOf(address(receiver), 0) - bq;
        p.unbookedT = pm.balanceOf(address(receiver), uint256(uint160(address(token)))) - bt;
        (p.carryQ, p.carryT) = receiver.carried();
        p.safeBalance = safe.balance;
        p.receiverBalance = address(receiver).balance;
        p.executorBalance = address(executor).balance;
        p.streamT = token.balanceOf(stream);
        p.supply = token.totalSupply();
        p.heldP = receiver.platformHeld();
        p.settled = receiver.graduationSettled();
    }

    /// The batch identities of one call, from the receiver's events (see `AuditU4FableBase._assertBatchConserved`).
    function _post(Pre memory p, VmSafe.Log[] memory logs, bool collected, address tipTo) internal {
        AuditU4Tally memory t = AuditU4FableTallyLib.tally(logs, address(receiver));
        if (collected && !t.collected) _fail("a successful collect emitted no Collected");
        _checkConservation(p, t);
        _checkFifteenths(t);
        _checkCredits(p, t);
        _checkPayouts(p, t, tipTo);
        _checkHoldings(t);
    }

    function _checkConservation(Pre memory p, AuditU4Tally memory t) internal {
        (uint256 cq, uint256 ct) = receiver.carried();
        uint256 heldP = receiver.graduationSettled() ? 0 : BoxSpecV1.BOX0_FEE_SHARE_PLATFORM * (t.qFit / 11);
        // A settlement inside `graduate()` splits the claims unbooked before the call plus those the migration's last
        // harvest and the forwarded gift moved in before its poke (`qInBeforeSettled`); elsewhere that term is zero.
        uint256 qIn = (t.settled ? p.unbookedQ + t.qInBeforeSettled : 0)
            + (t.collected ? t.collectedQ - t.qToReserve : 0) + t.funded;
        uint256 qOut = t.back + t.hookBack + t.tip + t.qFit + t.qDepth + t.qPlatform + heldP;
        if (qIn + p.carryQ != qOut + cq) _fail("Q batch identity broken");
        uint256 tIn = (t.settled ? p.unbookedT + t.tInBeforeSettled : 0) + (t.collected ? t.collectedT : 0);
        if (tIn + p.carryT != t.tDepth + t.tBurned + t.tStream + ct) _fail("T batch identity broken");
        if (t.backT != 0) _fail("box 0 returned a T note");
        if (cq >= 15 || ct >= 15) _fail("a carry reached a fifteenth");
    }

    function _checkFifteenths(AuditU4Tally memory t) internal {
        if (t.splits == 0) return;
        uint256 excess;
        uint256 kept;
        for (uint256 i; i < t.credits && i < 8; ++i) {
            excess += t.creditToDepth[i];
            kept += t.creditKept[i];
        }
        if (t.settled) {
            excess -= t.heldToDepth;
            kept -= t.heldKept;
        }
        if (t.qFit % 11 != 0) _fail("FIT not a whole number of units");
        uint256 u = t.qFit / 11;
        if (t.qDepth != 2 * u + excess) _fail("Q depth != 2u + excess");
        if (receiver.graduationSettled()) {
            if (t.qPlatform != kept || kept + excess != 2 * u) _fail("platform part != 2u (kept + excess)");
        } else if (t.qPlatform != 0 || excess != 0) {
            _fail("a platform credit before graduation");
        }
        if (t.tDepth % 2 != 0 || t.tBurned + t.tStream != 13 * (t.tDepth / 2)) _fail("T parts not 13 : 2");
    }

    function _checkCredits(Pre memory p, AuditU4Tally memory t) internal {
        for (uint256 i; i < t.credits && i < 8; ++i) {
            uint256 e = t.creditEpoch[i];
            credited[e] += t.creditKept[i];
            creditedTotal += t.creditKept[i];
            if (e > maxEpoch) maxEpoch = e;
            if (t.creditTotal[i] != credited[e]) _fail("PlatformCredited's running total disagrees");
            if (credited[e] > CAP) _fail("an epoch was credited above the cap");
            // BC-106: every credit the settlement makes (the held share, the final harvest's split) names epoch 0,
            // however late the settlement runs; the same call's own batch names the calendar epoch.
            if (t.settled && t.creditAtSettlement[i] && e != 0) {
                _fail("a settlement credit was not counted in epoch 0");
            }
        }
        if (t.settled && t.heldKept + t.heldToDepth != p.heldP) _fail("the held platform share was not capped whole");
        if (t.credits > 8) _fail("more than 8 cap calls in one call (tally overflow)");
    }

    function _checkPayouts(Pre memory p, AuditU4Tally memory t, address tipTo) internal {
        if (safe.balance != p.safeBalance + t.platformPaid) {
            _fail("the Safe's balance moved other than by payPlatform");
        }
        if (t.fitPaid != 0 && address(executor).balance != p.executorBalance + t.fitPaid) {
            _fail("FIT's budget did not rise by what payFit paid");
        }
        if (!coordinator.graduated() && (t.fitPaid != 0 || t.platformPaid != 0)) _fail("a payout before graduation");
        if (tipTo != address(0) && (tipTo == ethRefuser || tipTo == gasBurner) && t.tip != 0) {
            _fail("a tip was booked for a recipient that cannot take it");
        }
    }

    function _checkHoldings(AuditU4Tally memory t) internal {
        (uint256 bq, uint256 bt) = receiver.booked();
        uint256 q = pm.balanceOf(address(receiver), 0);
        uint256 tt = pm.balanceOf(address(receiver), uint256(uint160(address(token))));
        if (q < bq || tt < bt) _fail("ledgers above the claims");
        if (t.collected && (q - bq != 0 || tt - bt != 0)) _fail("unbooked claims left after a collect");
        if (address(receiver).balance != forcedPending) _fail("the receiver holds ETH that is not forced ETH");
        if (!coordinator.graduated() && (address(executor).balance != 0 || pm.balanceOf(address(hook), 0) != 0)) {
            _fail("ETH reached the executor or the hook's claims before graduation");
        }
    }

    /// @dev Drains the log recorder; a reverted call's logs are discarded (Foundry 1.8.3 keeps the logs a reverted
    /// call emitted before it failed in `getRecordedLogs`, while its state is rolled back: tallying them would book a
    /// split or a credit that never happened).
    function _logsIf(bool ok) internal returns (VmSafe.Log[] memory logs) {
        logs = vm.getRecordedLogs();
        if (!ok) logs = new VmSafe.Log[](0);
    }

    function _wethOf(address who) internal view returns (uint256) {
        (bool ok, bytes memory r) = weth.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        return ok ? abi.decode(r, (uint256)) : 0;
    }

    function _sel(bytes memory data) internal pure returns (bytes4 s) {
        if (data.length < 4) return 0;
        assembly ("memory-safe") {
            s := mload(add(data, 0x20))
        }
    }

    function _count(string memory name) internal {
        ++calls[keccak256(bytes(name))];
    }

    function _ok(string memory name) internal {
        ++successes[keccak256(bytes(name))];
    }

    function _fail(string memory why) internal {
        if (violations == 0) violation = why;
        ++violations;
    }

    function callsOf(string memory name) external view returns (uint256 c, uint256 s) {
        c = calls[keccak256(bytes(name))];
        s = successes[keccak256(bytes(name))];
    }

    function ghostEthOk() external view returns (bool ok, uint256 held, uint256 inTotal, uint256 outTotal) {
        return _ghostEthBalanced();
    }

    function ghostTOk() external view returns (bool ok, uint256 held, uint256 inTotal, uint256 outTotal) {
        return _ghostTBalanced();
    }

    function systemT() external view returns (uint256) {
        return _ghostSystemT();
    }

    receive() external payable {}
}

/// @notice SH-AUDIT-B0 U4 (Fable): the invariant campaign on the factory's box 0 from the closed curve: every batch
/// identity, box 0's fifteenths, the cap per epoch by every path (the late settlement included), claims == ledgers +
/// the next batch, forced ETH, nothing to the executor or the hook before graduation, dormant paths inert, the Safe
/// paid only by `payPlatform`, and the ghost ledger at the system's boundary (X01, X02).
/// forge-config: default.evm_version = "osaka"
contract AuditU4FableInvariants is AuditU4FableBase {
    AuditU4FableHandler internal handler;
    uint256 internal safeStart;

    function setUp() public override {
        super.setUp();
        _toClosed();
        AuditU4HandlerWorld memory w;
        w.pm = pm;
        w.a = a;
        w.key = poolKey;
        w.swapper = routerSwapper;
        w.ethRefuser = address(ethRefuser);
        w.gasBurner = address(gasBurner);
        w.system = _ghostSystem;
        w.outside = _ghostOutside;
        // The handler itself is the first tip recipient: its address is known before it is built (CREATE by nonce).
        address self = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        w.tips = [self, eoa[1], eoa7702, address(ethRefuser), address(gasBurner)];
        handler = new AuditU4FableHandler(w);
        require(address(handler) == self, "u4: the handler's address");
        vm.label(address(handler), "audit.u4.handler");
        safeStart = safe.balance;
        targetContract(address(handler));
        bytes4[] memory s = new bytes4[](18);
        s[0] = handler.graduate.selector;
        s[1] = handler.buy.selector;
        s[2] = handler.sell.selector;
        s[3] = handler.collect.selector;
        s[4] = handler.fundFees.selector;
        s[5] = handler.fundDepth.selector;
        s[6] = handler.forceEth.selector;
        s[7] = handler.royalty.selector;
        s[8] = handler.flush.selector;
        s[9] = handler.sweepOther.selector;
        s[10] = handler.payFit.selector;
        s[11] = handler.payPlatform.selector;
        s[12] = handler.executeFit.selector;
        s[13] = handler.deepen.selector;
        s[14] = handler.giftClaims.selector;
        s[15] = handler.warp.selector;
        s[16] = handler.dormant.selector;
        s[17] = handler.onGraduationAgain.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
    }

    /// One campaign (one `invariant_` function: each function would run the whole campaign again), checking after
    /// every call: (1) every per-call check the handler makes held (the first broken one is named: the batch
    /// identities, the fifteenths, the credits per epoch, the payouts, the holdings); (2) X09 / P4.3: the claims cover
    /// the ledgers; (3) P4.4 / X07: no epoch above the cap, every credit is paid or owed, the Safe rose only by
    /// `payPlatform`; (4) P4.5: the receiver's ETH balance is forced ETH only; (5) X08 / BC-020: before graduation
    /// nothing reaches the executor or the hook's claims, no platform credit, no settlement; (6) P4.8: no dormant call
    /// was ever accepted; (7) X01, X02 at the boundary: the system's ETH (and WETH) equals what came in less what left,
    /// outside T equals what left less what came in, supply + burned == issuance.
    function invariant_AUDIT_U4_receiverAndRouterProperties() public view {
        assertEq(handler.violations(), 0, handler.violation());
        (uint256 bq, uint256 bt) = receiver.booked();
        assertGe(_claimsQ(a.receiver), bq, "X09: Q claims cover the ledgers");
        assertGe(_claimsT(a.receiver), bt, "X09: T claims cover the ledgers");
        for (uint256 e; e <= handler.maxEpoch(); ++e) {
            assertLe(handler.credited(e), CAP, "X07: an epoch above the cap");
        }
        assertEq(handler.creditedTotal(), _toPlatform(), "credits == totals.toPlatform");
        assertEq(safe.balance - safeStart, handler.paidPlatform(), "the Safe rose only by payPlatform");
        assertEq(safe.balance - safeStart + receiver.platformOwed(), _toPlatform(), "paid + owed == counted");
        assertEq(a.receiver.balance, handler.forcedPending(), "P4.5: the receiver holds forced ETH only");
        if (!coordinator.graduated()) {
            assertEq(a.executor.balance, 0, "BC-020: nothing to the executor before graduation");
            assertEq(_claimsQ(a.hook), 0, "depth is held in the receiver on the curve");
            assertEq(receiver.platformOwed(), 0, "no platform credit before graduation");
            assertFalse(receiver.graduationSettled());
        }
        assertEq(handler.dormantAccepted(), 0, "P4.8: a dormant path accepted a call");
        (, uint256 heldEth, uint256 inEth, uint256 outEth) = handler.ghostEthOk();
        assertEq(heldEth + outEth, inEth, "ghost: system ETH + booked out == booked in");
        (, uint256 heldT, uint256 inT, uint256 outT) = handler.ghostTOk();
        assertEq(heldT + inT, outT, "ghost: outside T + booked in == booked out");
        assertEq(handler.systemT() + heldT, token.totalSupply(), "ghost: system T + outside T == supply");
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE, "ghost: supply + burned == issuance");
    }

    /// Coverage witness (deterministic): one scripted sequence in which every handler action succeeds at least once
    /// with no violation, so every action of the campaign is known to be reachable (a fuzzed run resets the handler's
    /// counters, so `afterInvariant` can only log one run's counts). The late settlement (`graduate(true)` then
    /// `onGraduationAgain`), a real `deepen` (the executor's average made ready by hourly pokes) and the executor's own
    /// buy are all in it; the campaign's invariant holds at the end.
    function testProperty_AUDIT_U4_handlerReachesEveryAction() public {
        handler.forceEth(1 ether);
        handler.giftClaims(0.1 ether);
        handler.fundFees(20 ether);
        handler.fundDepth(1 ether);
        handler.royalty(1 ether, false);
        handler.royalty(1 ether, true);
        handler.sweepOther(true);
        handler.sweepOther(false);
        handler.dormant(0, 0);
        handler.warp(0);
        handler.graduate(true);
        assertTrue(handler.graduatedWithFailedPoke(), "the receiver's poke failed: the settlement waits");
        assertFalse(receiver.graduationSettled());
        handler.onGraduationAgain();
        assertTrue(receiver.graduationSettled(), "a stranger's onGraduation settled late");
        handler.buy(1 ether);
        handler.sell(50);
        handler.collect(0);
        handler.flush(false);
        handler.royalty(1 ether, true);
        handler.flush(true);
        handler.payFit();
        handler.payPlatform();
        handler.executeFit(1, true);
        handler.executeFit(2, false);
        handler.fundDepth(5 ether);
        handler.dormant(6, 1);
        handler.dormant(6, 2);
        // The executor's average follows spot by at most MAX_OBSERVATION_STEP (100 ticks) per observation and the
        // 1 ETH buy moved spot about 2,000 ticks: pokes in distinct blocks first, then hourly warps (the 300-block
        // cooldown) with `deepen` until a real add or conversion ran.
        for (uint256 i; i < 30; ++i) {
            handler.warp(0);
            handler.executeFit(1, true);
        }
        for (uint256 i; i < 6; ++i) {
            (, uint256 ok) = handler.callsOf("deepen");
            if (ok != 0) break;
            handler.warp(1);
            handler.deepen();
        }
        for (uint256 i; i < 18; ++i) {
            (uint256 c, uint256 ok) = handler.callsOf(_name(i));
            emit log_named_uint(string.concat("witness calls: ", _name(i)), c);
            assertGe(ok, 1, string.concat("the action succeeded at least once: ", _name(i)));
        }
        assertEq(handler.violations(), 0, handler.violation());
        invariant_AUDIT_U4_receiverAndRouterProperties();
    }

    /// Coverage: calls and successes per action over the campaign (reported; the run's log shows them).
    function afterInvariant() public {
        for (uint256 i; i < 18; ++i) {
            string memory name = _name(i);
            (uint256 c, uint256 ok) = handler.callsOf(name);
            emit log_named_uint(string.concat("calls: ", name), c);
            emit log_named_uint(string.concat("successes: ", name), ok);
        }
        emit log_named_uint("violations", handler.violations());
        emit log_named_string("first violation", handler.violation());
    }

    function _name(uint256 i) internal pure returns (string memory) {
        if (i == 0) return "graduate";
        if (i == 1) return "buy";
        if (i == 2) return "sell";
        if (i == 3) return "collect";
        if (i == 4) return "fundFees";
        if (i == 5) return "fundDepth";
        if (i == 6) return "forceEth";
        if (i == 7) return "royalty";
        if (i == 8) return "flush";
        if (i == 9) return "sweepOther";
        if (i == 10) return "payFit";
        if (i == 11) return "payPlatform";
        if (i == 12) return "executeFit";
        if (i == 13) return "deepen";
        if (i == 14) return "giftClaims";
        if (i == 15) return "warp";
        if (i == 16) return "dormant";
        return "onGraduationAgain";
    }
}
