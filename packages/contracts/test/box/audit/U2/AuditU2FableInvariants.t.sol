// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxPhase, FeeBatch} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditU2FableBase, AuditU2FableClaimsMinter} from "./AuditU2FableBase.sol";

/// @title AuditU2FableHandler
/// @notice TEST ONLY (SH-AUDIT-B0-U2-F). The invariant campaign's handler, which IS the shared world (the factory's
/// box 0, mainnet build, every helper and the ghost ledger): every action is total (a refused call is counted, never
/// propagated), and the ghosts record what must never happen: a window buy that fails to conserve, a `graduate()`
/// refused once the curve is closed, a failed poke, a reward above min(cap, reserve), a sweep before graduation, a
/// supply that rose, a phase that went back. Two starts: at the open (`startClosed` false: the window campaign) and at
/// the close (`startClosed` true: the graduation campaign).
contract AuditU2FableHandler is AuditU2FableBase {
    // ------------------------------------------------------------------ the router's ghosts
    uint256 public sumGross;
    uint256 public sumSpent;
    uint256 public sumTax;
    uint256 public sumRefund;
    uint256 public forcedRouter;
    uint256 public sumSwept;
    uint256 public conservationBreaks;
    uint256 public unexpectedBuyFailures;
    uint256 public sweepsRefusedAfterGraduation;
    uint256 public sweptBeforeGraduation;

    // ------------------------------------------------------------------ the coordinator's ghosts
    uint256 public share0;
    uint256 public graduations;
    uint256 public graduateBlocked;
    /// Failed pokes other than the tickets' `NoPlaceholders` (a box whose curve saw no placeholder has no word to
    /// request: the tickets refuse, which is their rule, not the coordinator's; counted apart).
    uint256 public pokeFailures;
    uint256 public pokeFailuresNoPlaceholders;
    address public graduator;
    uint256 public rewardCredited;
    uint256 public reserveAtGraduation;
    uint256 public rewardClaimed;
    uint256 public claimsGiftedBefore;
    uint256 public claimsGiftedAfter;
    uint256 public tGiftedBefore;
    uint256 public tGiftedAfter;
    uint256 public forcedCoordinator;
    uint256 public claimRefused;

    // ------------------------------------------------------------------ T and phases
    uint256 public supplyLast;
    bool public supplyRose;
    uint8 public phaseLast;
    bool public phaseWentBack;

    // ------------------------------------------------------------------ coverage
    uint256 public cWindowBuy;
    uint256 public cWindowBuyOk;
    uint256 public cPublicBuy;
    uint256 public cPublicBuyOk;
    uint256 public cPublicSell;
    uint256 public cPublicSellOk;
    uint256 public cClose;
    uint256 public cCloseOk;
    uint256 public cGraduate;
    uint256 public cGraduateOk;
    uint256 public cClaim;
    uint256 public cClaimOk;
    uint256 public cSweep;
    uint256 public cSweepOk;
    uint256 public cForce;
    uint256 public cGiftClaims;
    uint256 public cGiftT;
    uint256 public cTransfer;
    uint256 public cBurn;
    uint256 public cWarp;
    uint256 public cCollect;
    uint256 public cCollectOk;
    uint256 public cTake;
    uint256 public cTakeOk;
    bytes public lastTakeError;

    address[10] internal actors;

    constructor(bool startClosed) {
        _setUpAuditWorld();
        minter = new AuditU2FableClaimsMinter(pm);
        actors = [eoa[0], eoa[1], eoa[2], eoa[3], eoa[4], eoa[5], eoa[6], eoa[7], address(contractDrawer), eoa7702];
        share0 = token.balanceOf(a.coordinator);
        if (startClosed) _toClosed();
        else _warpTo(hook.openAt() - SLOT);
        // The drivers' window buys (before the ghosts): their gross, refunds and tax seed the router's ghosts.
        sumGross = ghostEthIn(EthIn.WindowBuy);
        sumRefund = ghostEthOut(EthOut.Refund);
        sumTax = launchRouter.totalTaxCollected();
        sumSpent = sumGross - sumRefund - sumTax;
        supplyLast = token.totalSupply();
        phaseLast = uint8(coordinator.phase());
    }

    // ================================================================================================ actions

    function windowBuy(uint8 whoIdx, uint96 amountRaw, uint8 advance) external {
        ++cWindowBuy;
        if (advance % 4 == 0) _advance(1 + advance % 3);
        address who = actors[whoIdx % 10];
        uint256 gross = bound(uint256(amountRaw), 1e13, 60 ether);
        bool inWindow = vm.getBlockTimestamp() >= hook.openAt() && vm.getBlockTimestamp() < hook.windowEndsAt();
        bool expectPass = inWindow && !hook.closed();
        Buy memory b = _measuredBuy(who, gross, who, 1);
        if (b.ok) {
            ++cWindowBuyOk;
            sumGross += gross;
            sumSpent += b.spent;
            sumTax += b.tax;
            sumRefund += b.refund;
            if (gross != b.spent + b.tax + b.refund) ++conservationBreaks;
            if (b.refund != 0 && !b.closed) ++conservationBreaks;
            if (
                b.tax
                    != (b.refund == 0
                            ? _ceilTax(gross, launchRouter.taxPips(b.step))
                            : _partialTax(gross, b.spent, launchRouter.taxPips(b.step)))
            ) {
                ++conservationBreaks;
            }
        } else if (expectPass) {
            ++unexpectedBuyFailures;
        }
        _after();
    }

    function publicBuy(uint8 whoIdx, uint96 amountRaw) external {
        ++cPublicBuy;
        address who = actors[whoIdx % 10];
        uint256 value = bound(uint256(amountRaw), 1e15, 2 ether);
        if (_trySwap(who, true, value, value, TickMath.MIN_SQRT_PRICE + 1)) ++cPublicBuyOk;
        _after();
    }

    function publicSell(uint8 whoIdx, uint96 pctRaw) external {
        ++cPublicSell;
        address who = actors[whoIdx % 10];
        uint256 bal = token.balanceOf(who);
        uint256 amount = bal * bound(uint256(pctRaw), 1, 10_000) / 10_000;
        if (amount == 0) return _after();
        if (_trySwap(who, false, amount, 0, TickMath.MAX_SQRT_PRICE - 1)) ++cPublicSellOk;
        _after();
    }

    /// A buy sized past P1: through the router inside the window, through the stand-in after it.
    function closeNow(uint8 whoIdx) external {
        ++cClose;
        address who = actors[whoIdx % 10];
        if (hook.closed()) return _after();
        uint256 now_ = vm.getBlockTimestamp();
        if (now_ < hook.openAt()) return _after();
        if (now_ < hook.windowEndsAt()) {
            uint256 pips = launchRouter.taxPips((now_ - hook.openAt()) / SLOT);
            Buy memory b = _measuredBuy(who, _grossFor(_qToP1() + 0.5 ether, pips), who, 1);
            if (b.ok) {
                ++cWindowBuyOk;
                sumGross += b.spent + b.tax + b.refund;
                sumSpent += b.spent;
                sumTax += b.tax;
                sumRefund += b.refund;
                if (!b.closed) ++conservationBreaks;
            } else {
                ++unexpectedBuyFailures;
            }
        } else {
            uint256 value = _qToP1() + 1 ether;
            if (!_trySwap(who, true, value, value, curve.sqrtPriceLowerX96)) ++unexpectedBuyFailures;
        }
        if (hook.closed()) ++cCloseOk;
        _after();
    }

    function graduateNow(uint8 whoIdx, uint8 band) external {
        ++cGraduate;
        address who = actors[whoIdx % 10];
        uint256 cap = 12_000_000 + uint256(band) * 20_000;
        bool must = hook.closed() && !coordinator.graduated();
        uint256 minted0 = hook.reserveMinted();
        uint256 held0 = _claims(a.coordinator);
        vm.recordLogs();
        vm.prank(who);
        (bool ok, bytes memory ret) = a.coordinator.call{gas: cap}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        (uint256 others, uint256 noPlaceholders) = _pokeFailuresByTarget(vm.getRecordedLogs());
        if (ok) {
            ++cGraduateOk;
            ++graduations;
            pokeFailures += others;
            pokeFailuresNoPlaceholders += noPlaceholders;
            graduator = who;
            rewardCredited = abi.decode(ret, (uint256));
            // min(the reserve after the migration's last top-up, the cap, the claims held at that point).
            uint256 minted = hook.reserveMinted();
            uint256 held = held0 + (minted - minted0);
            uint256 expected = minted < coordinator.rewardCap() ? minted : coordinator.rewardCap();
            if (expected > held) expected = held;
            reserveAtGraduation = expected;
        } else if (must) {
            ++graduateBlocked;
        }
        _after();
    }

    function claimNow(uint8 whoIdx, uint8 toIdx) external {
        ++cClaim;
        address who = actors[whoIdx % 10];
        address to = actors[toIdx % 8];
        uint256 e0 = to.balance;
        vm.prank(who);
        try coordinator.claimReward(to) returns (uint256 amount) {
            ++cClaimOk;
            rewardClaimed += amount;
            _noteEthChange(e0, to.balance, EthIn.Other, EthOut.Reward);
        } catch {
            ++claimRefused;
        }
        _after();
    }

    function sweepNow() external {
        ++cSweep;
        uint256 bal = a.launchRouter.balance;
        uint256 h0 = _claims(a.hook);
        bool graduated = coordinator.graduated();
        try launchRouter.sweep() returns (uint256 amount) {
            ++cSweepOk;
            sumSwept += amount;
            if (!graduated) ++sweptBeforeGraduation;
            if (amount != bal || _claims(a.hook) != h0 + amount) ++conservationBreaks;
        } catch {
            if (graduated && bal != 0) ++sweepsRefusedAfterGraduation;
        }
        _after();
    }

    function forceEth(uint8 targetIdx, uint96 amountRaw) external {
        ++cForce;
        uint256 amount = bound(uint256(amountRaw), 1, 0.1 ether);
        uint8 k = targetIdx % 4;
        address target = k == 0 ? a.launchRouter : k == 1 ? a.coordinator : k == 2 ? a.hook : a.receiver;
        _forceEth(target, amount);
        if (k == 0) forcedRouter += amount;
        if (k == 1) forcedCoordinator += amount;
        _after();
    }

    function giftClaims(uint96 amountRaw) external {
        ++cGiftClaims;
        uint256 amount = bound(uint256(amountRaw), 1, 0.5 ether);
        _giftClaims(a.coordinator, amount);
        if (coordinator.graduated()) claimsGiftedAfter += amount;
        else claimsGiftedBefore += amount;
        _after();
    }

    function giftT(uint8 whoIdx, uint96 pctRaw) external {
        ++cGiftT;
        address who = actors[whoIdx % 10];
        uint256 amount = token.balanceOf(who) * bound(uint256(pctRaw), 1, 10_000) / 10_000;
        if (amount == 0) return _after();
        _transferT(who, a.coordinator, amount);
        if (coordinator.graduated()) tGiftedAfter += amount;
        else tGiftedBefore += amount;
        _after();
    }

    function transferT(uint8 fromIdx, uint8 toIdx, uint96 pctRaw) external {
        ++cTransfer;
        address from = actors[fromIdx % 10];
        address to = actors[toIdx % 10];
        uint256 amount = token.balanceOf(from) * bound(uint256(pctRaw), 0, 10_000) / 10_000;
        if (from == to) return _after();
        _transferT(from, to, amount);
        _after();
    }

    function burnT(uint8 whoIdx, uint96 pctRaw) external {
        ++cBurn;
        address who = actors[whoIdx % 10];
        uint256 amount = token.balanceOf(who) * bound(uint256(pctRaw), 0, 10_000) / 10_000;
        _burnT(who, amount);
        _after();
    }

    function warp(uint8 blocks) external {
        ++cWarp;
        _advance(1 + blocks % 24);
        _after();
    }

    function collectNow(uint8 whoIdx) external {
        ++cCollect;
        address who = actors[whoIdx % 10];
        uint256 e0 = who.balance;
        vm.prank(who);
        try receiver.collect(who) returns (FeeBatch memory) {
            ++cCollectOk;
            _noteEthChange(e0, who.balance, EthIn.Other, EthOut.Tip);
        } catch {}
        _after();
    }

    function takePlaceholders(uint8 whoIdx, uint8 countRaw) external {
        ++cTake;
        uint256 count = 1 + countRaw % 3;
        // The first actor from whoIdx on that can pay the quote (a take needs T: the curve's buyers have it).
        (uint256 principal, uint256 fee) = vault.quoteTake(count);
        address who = actors[whoIdx % 10];
        for (uint256 i; i < 10; ++i) {
            address c = actors[(uint256(whoIdx) + i) % 10];
            if (token.balanceOf(c) >= principal + fee) {
                who = c;
                break;
            }
        }
        _approveT(who, a.tickets);
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        try tickets.take(count, type(uint256).max, vm.getBlockTimestamp()) returns (uint256) {
            ++cTakeOk;
            _noteTChange(t0, token.balanceOf(who), TIn.Take, TOut.Other);
        } catch (bytes memory err) {
            lastTakeError = err;
        }
        _after();
    }

    // ================================================================================================ internals

    /// `PokeFailed` events of one graduation: the tickets' with no placeholder taken (their `NoPlaceholders` rule)
    /// apart from every other failure.
    function _pokeFailuresByTarget(VmSafe.Log[] memory logs)
        internal
        view
        returns (uint256 others, uint256 noPlaceholders)
    {
        bool noSlots = tickets.status().slots == 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.coordinator || logs[i].topics.length < 2) continue;
            if (logs[i].topics[0] != IBoxCoordinator.PokeFailed.selector) continue;
            address target = address(uint160(uint256(logs[i].topics[1])));
            if (target == a.tickets && noSlots) ++noPlaceholders;
            else ++others;
        }
    }

    function _trySwap(address who, bool zeroForOne, uint256 amount, uint256 value, uint160 limit)
        internal
        returns (bool ok)
    {
        if (value != 0) _fund(who, value);
        if (!zeroForOne) _approveT(who, address(routerSwapper));
        uint256 e0 = who.balance;
        uint256 t0 = token.balanceOf(who);
        SwapParams memory p =
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit});
        vm.prank(who);
        try routerSwapper.swapOne{value: value}(poolKey, p, "", who) returns (BalanceDelta) {
            ok = true;
            _noteEthChange(e0, who.balance, EthIn.SwapIn, EthOut.SwapOut);
            _noteTChange(t0, token.balanceOf(who), TIn.Sell, TOut.Buy);
        } catch {}
    }

    function _after() internal {
        uint256 s = token.totalSupply();
        if (s > supplyLast) supplyRose = true;
        supplyLast = s;
        uint8 ph = uint8(coordinator.phase());
        if (ph < phaseLast) phaseWentBack = true;
        phaseLast = ph;
    }

    // ================================================================================================ reads

    function handles()
        external
        view
        returns (
            address router,
            address coord,
            address hookA,
            address tok,
            address vaultA,
            address ticketsA,
            address pmA
        )
    {
        return (a.launchRouter, a.coordinator, a.hook, a.token, a.vault, a.tickets, address(pm));
    }

    /// The world's three ghost checks, as booleans (the invariants assert them).
    function ghostOk() external view returns (bool ethOk, bool tOk, bool allT) {
        (ethOk,,,) = _ghostEthBalanced();
        (bool ok2, uint256 heldT,,) = _ghostTBalanced();
        tOk = ok2;
        allT = _ghostSystemT() + heldT == token.totalSupply();
    }

    function coordinatorClaims() external view returns (uint256) {
        return _claims(a.coordinator);
    }

    function coordinatorTClaims() external view returns (uint256) {
        return _tClaims(a.coordinator);
    }
}

/// @title AuditU2FableWindowInvariants
/// @notice SH-AUDIT-B0-U2-F, the launch router's and T's invariant campaign from the open (map § 6 gap 3: "no
/// invariant campaign for the launch router"; U2.md L1): window buys at random steps and sizes (partial closes
/// included), public swaps, forced ETH, gifts of claims and T, graduation by random callers, claims, sweeps, batches
/// and time. The handler is the world itself; only its actions are targeted.
/// forge-config: default.evm_version = "osaka"
contract AuditU2FableWindowInvariants is Test {
    AuditU2FableHandler internal h;
    IBoxLaunchRouter internal router;
    BoxCoordinator internal coord;
    address internal hookA;
    address internal tok;
    address internal vaultA;
    address internal ticketsA;

    function setUp() public virtual {
        h = new AuditU2FableHandler(_startClosed());
        _wire();
    }

    function _startClosed() internal pure virtual returns (bool) {
        return false;
    }

    function _wire() internal {
        (address r, address c, address hk, address t, address v, address tk,) = h.handles();
        router = IBoxLaunchRouter(r);
        coord = BoxCoordinator(c);
        hookA = hk;
        tok = t;
        vaultA = v;
        ticketsA = tk;
        targetContract(address(h));
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = h.windowBuy.selector;
        sel[1] = h.publicBuy.selector;
        sel[2] = h.publicSell.selector;
        sel[3] = h.closeNow.selector;
        sel[4] = h.graduateNow.selector;
        sel[5] = h.claimNow.selector;
        sel[6] = h.sweepNow.selector;
        sel[7] = h.forceEth.selector;
        sel[8] = h.giftClaims.selector;
        sel[9] = h.giftT.selector;
        sel[10] = h.transferT.selector;
        sel[11] = h.burnT.selector;
        sel[12] = h.warp.selector;
        sel[13] = h.collectNow.selector;
        sel[14] = h.takePlaceholders.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
    }

    /// P2.1 / BC-022: the router holds exactly its unswept tax plus the ETH forced into it, and its totals are the
    /// ghosts'.
    function invariant_AUDIT_U2_routerHoldsTaxPlusForcedLessSwept() public view {
        assertEq(address(router).balance, h.sumTax() + h.forcedRouter() - h.sumSwept(), "router balance");
        assertEq(router.totalTaxCollected(), h.sumTax(), "lifetime tax");
        assertEq(router.totalSwept(), h.sumSwept(), "lifetime swept");
    }

    /// P2.1 / M04: every window buy conserved (gross == spend + tax + refund, the tax by the rule, a refund only on a
    /// close) and no buy that should pass failed.
    function invariant_AUDIT_U2_windowBuysConserve() public view {
        assertEq(
            h.sumGross(), h.sumSpent() + h.sumTax() + h.sumRefund(), "sum gross == sum spend + sum tax + sum refund"
        );
        assertEq(h.conservationBreaks(), 0, "no buy broke conservation");
        assertEq(h.unexpectedBuyFailures(), 0, "no buy that should pass failed");
    }

    /// P2.1 / BC-140: nothing is swept before graduation; after it every sweep of a non-empty router passes and moves
    /// exactly the balance into the hook's claims.
    function invariant_AUDIT_U2_sweepOnlyAfterGraduationAndAlwaysWhole() public view {
        if (!coord.graduated()) assertEq(router.totalSwept(), 0, "no sweep before graduation");
        assertEq(h.sweptBeforeGraduation(), 0);
        assertEq(h.sweepsRefusedAfterGraduation(), 0, "a non-empty router is always sweepable after graduation");
    }

    /// P2.5 / IBoxToken.sol:27: totalSupply + totalBurned == 1e27, the supply never rose, every unit of T is in the
    /// system or with an outside holder, and the supply never went below the vault's floor.
    function invariant_AUDIT_U2_tokenSupplyIdentity() public view {
        (bool ethOk, bool tOk, bool allT) = h.ghostOk();
        (bool s, bytes memory d) = tok.staticcall(abi.encodeWithSignature("totalSupply()"));
        (bool s2, bytes memory d2) = tok.staticcall(abi.encodeWithSignature("totalBurned()"));
        (bool s3, bytes memory d3) = vaultA.staticcall(abi.encodeWithSignature("supplyFloor()"));
        assertTrue(s && s2 && s3);
        uint256 supply = abi.decode(d, (uint256));
        assertEq(supply + abi.decode(d2, (uint256)), BoxSpecV1.ISSUANCE, "supply + burned == issuance");
        assertFalse(h.supplyRose(), "the supply never rises");
        assertTrue(tOk, "outside T == sum out - sum in");
        assertTrue(allT, "system T + outside T == supply");
        assertTrue(ethOk, "system ETH == sum in - sum out");
        assertGe(supply, abi.decode(d3, (uint256)), "never below the floor");
    }

    /// IBoxCoordinator.sol:24-25 / BC-043: before graduation the coordinator holds the pool share plus gifted T and the
    /// reserve plus gifted claims, nothing else; after it only the unclaimed reward (and gifts made after, which have
    /// no exit by design); never T claims; only the ETH forced into it.
    function invariant_AUDIT_U2_coordinatorHoldsOnlyItsShareAndReserve() public view {
        (bool s, bytes memory d) = tok.staticcall(abi.encodeWithSignature("balanceOf(address)", address(coord)));
        assertTrue(s);
        uint256 t = abi.decode(d, (uint256));
        (bool s2, bytes memory d2) = hookA.staticcall(abi.encodeWithSignature("reserveMinted()"));
        assertTrue(s2);
        uint256 minted = abi.decode(d2, (uint256));
        if (!coord.graduated()) {
            assertEq(t, h.share0() + h.tGiftedBefore(), "T: the share plus gifts");
            assertEq(h.coordinatorClaims(), minted + h.claimsGiftedBefore(), "Q claims: the reserve plus gifts");
            assertLe(minted, coord.rewardCap(), "the reserve never exceeds the cap");
        } else {
            assertEq(t, h.tGiftedAfter(), "T: nothing of its own after graduation");
            uint256 unclaimed = coord.rewardOf(h.graduator());
            assertEq(h.coordinatorClaims(), unclaimed + h.claimsGiftedAfter(), "Q claims: the unclaimed reward");
        }
        assertEq(h.coordinatorTClaims(), 0, "never T claims");
        assertEq(address(coord).balance, h.forcedCoordinator(), "only forced ETH");
    }

    /// BC-026 / BC-027 / BC-098 / X06: at most one graduation, only after the close, never refused once closed with an
    /// ample cap, no failed poke; the reward is min(cap, reserve minted, held) and paid at most once; the hook, the
    /// coordinator and the vault agree on it.
    function invariant_AUDIT_U2_graduationOnceAfterTheCloseWithTheRightReward() public view {
        assertLe(h.graduations(), 1, "at most once");
        assertEq(h.graduateBlocked(), 0, "never blocked once closed");
        assertEq(h.pokeFailures(), 0, "no poke failed (the tickets' NoPlaceholders apart)");
        (bool s, bytes memory d) = hookA.staticcall(abi.encodeWithSignature("closed()"));
        (bool s2, bytes memory d2) = hookA.staticcall(abi.encodeWithSignature("migratedAtBlock()"));
        (bool s3, bytes memory d3) = vaultA.staticcall(abi.encodeWithSignature("gateOpen()"));
        assertTrue(s && s2 && s3);
        bool closed = abi.decode(d, (bool));
        if (coord.graduated()) {
            assertTrue(closed, "graduated implies closed");
            assertEq(h.graduations(), 1);
            assertEq(coord.graduatedAtBlock(), abi.decode(d2, (uint256)), "the hook's migration block");
            assertTrue(abi.decode(d3, (bool)), "the gate is open");
            assertEq(h.rewardCredited(), h.reserveAtGraduation(), "reward == min(minted, cap, held)");
            assertLe(h.rewardCredited(), coord.rewardCap());
            uint256 unclaimed = coord.rewardOf(h.graduator());
            assertTrue(unclaimed == 0 || unclaimed == h.rewardCredited(), "credited once");
            assertEq(unclaimed + h.rewardClaimed(), h.rewardCredited(), "paid at most once, exactly what was credited");
        } else {
            assertEq(abi.decode(d2, (uint256)), 0);
            assertFalse(abi.decode(d3, (bool)), "the gate waits for graduation");
            assertEq(h.rewardClaimed(), 0);
        }
    }

    /// X05 / AR-15: the coordinator's phase never went back, and the hook, the router and the tickets open together.
    function invariant_AUDIT_U2_phasesForwardAndOneOpenTime() public view {
        assertFalse(h.phaseWentBack(), "phases never go back");
        (bool s, bytes memory d) = hookA.staticcall(abi.encodeWithSignature("openAt()"));
        (bool s2, bytes memory d2) = ticketsA.staticcall(abi.encodeWithSignature("openAt()"));
        assertTrue(s && s2);
        assertEq(router.openAt(), abi.decode(d, (uint256)));
        assertEq(router.openAt(), abi.decode(d2, (uint256)));
    }

    /// Reachability (plan § 3.2: every action must succeed in at least 1% of its calls): a seeded scripted run of
    /// 480 handler actions, the counters logged, every action reached and passing where the phase allows.
    function testProperty_AUDIT_U2_handlerReachesEveryAction() public {
        // A prologue the random order cannot guarantee: T in two hands and placeholders taken before any graduation.
        if (!_startClosed()) {
            h.warp(0);
            h.windowBuy(0, 1 ether, 1);
            h.windowBuy(1, 2 ether, 1);
        }
        h.takePlaceholders(0, 1);
        h.takePlaceholders(1, 2);
        for (uint256 i; i < 480; ++i) {
            uint256 r = uint256(keccak256(abi.encode("audit.u2.fable", _startClosed(), i)));
            _act(r % 15, r >> 8);
        }
        emit log_named_uint("windowBuy calls", h.cWindowBuy());
        emit log_named_uint("windowBuy ok", h.cWindowBuyOk());
        emit log_named_uint("publicBuy calls", h.cPublicBuy());
        emit log_named_uint("publicBuy ok", h.cPublicBuyOk());
        emit log_named_uint("publicSell calls", h.cPublicSell());
        emit log_named_uint("publicSell ok", h.cPublicSellOk());
        emit log_named_uint("closeNow calls", h.cClose());
        emit log_named_uint("closeNow ok", h.cCloseOk());
        emit log_named_uint("graduateNow calls", h.cGraduate());
        emit log_named_uint("graduateNow ok", h.cGraduateOk());
        emit log_named_uint("claimNow calls", h.cClaim());
        emit log_named_uint("claimNow ok", h.cClaimOk());
        emit log_named_uint("sweepNow calls", h.cSweep());
        emit log_named_uint("sweepNow ok", h.cSweepOk());
        emit log_named_uint("collectNow calls", h.cCollect());
        emit log_named_uint("collectNow ok", h.cCollectOk());
        emit log_named_uint("forceEth calls", h.cForce());
        emit log_named_uint("giftClaims calls", h.cGiftClaims());
        emit log_named_uint("giftT calls", h.cGiftT());
        emit log_named_uint("transferT calls", h.cTransfer());
        emit log_named_uint("burnT calls", h.cBurn());
        emit log_named_uint("warp calls", h.cWarp());
        emit log_named_uint("takePlaceholders calls", h.cTake());
        emit log_named_uint("takePlaceholders ok", h.cTakeOk());
        emit log_named_bytes("last take error", h.lastTakeError());
        emit log_named_uint("pokes failed (other than NoPlaceholders)", h.pokeFailures());
        emit log_named_uint("pokes failed with NoPlaceholders", h.pokeFailuresNoPlaceholders());
        if (!_startClosed()) assertGt(h.cWindowBuyOk(), 0, "window buys reached");
        assertGt(h.cCloseOk() + (_startClosed() ? 1 : 0), 0, "the close reached");
        assertEq(h.cGraduateOk(), 1, "graduation reached once");
        assertGt(h.cClaimOk(), 0, "the claim reached");
        assertGt(h.cSweepOk(), 0, "the sweep reached");
        assertGt(h.cPublicBuyOk(), 0, "public buys reached");
        assertGt(h.cPublicSellOk(), 0, "public sells reached");
        assertGt(h.cCollectOk(), 0, "batches reached");
        assertGt(h.cTakeOk(), 0, "placeholders reached");
        invariant_AUDIT_U2_routerHoldsTaxPlusForcedLessSwept();
        invariant_AUDIT_U2_windowBuysConserve();
        invariant_AUDIT_U2_sweepOnlyAfterGraduationAndAlwaysWhole();
        invariant_AUDIT_U2_tokenSupplyIdentity();
        invariant_AUDIT_U2_coordinatorHoldsOnlyItsShareAndReserve();
        invariant_AUDIT_U2_graduationOnceAfterTheCloseWithTheRightReward();
        invariant_AUDIT_U2_phasesForwardAndOneOpenTime();
    }

    function _act(uint256 which, uint256 r) internal {
        uint8 x = uint8(r);
        uint8 y = uint8(r >> 8);
        uint96 z = uint96(r >> 16);
        if (which == 0) h.windowBuy(x, z, y);
        else if (which == 1) h.publicBuy(x, z);
        else if (which == 2) h.publicSell(x, z);
        else if (which == 3) h.closeNow(x);
        else if (which == 4) h.graduateNow(x, y);
        else if (which == 5) h.claimNow(x, y);
        else if (which == 6) h.sweepNow();
        else if (which == 7) h.forceEth(x, z);
        else if (which == 8) h.giftClaims(z);
        else if (which == 9) h.giftT(x, z);
        else if (which == 10) h.transferT(x, y, z);
        else if (which == 11) h.burnT(x, z);
        else if (which == 12) h.warp(x);
        else if (which == 13) h.collectNow(x);
        else h.takePlaceholders(x, y);
    }
}

/// @notice The same campaign from the close (plan § 3.2's "graduated" and "closed" starts for this unit): graduation
/// by random callers under gifts, forced ETH and public trading, claims, sweeps and batches dominate.
/// forge-config: default.evm_version = "osaka"
contract AuditU2FableGraduationInvariants is AuditU2FableWindowInvariants {
    function _startClosed() internal pure override returns (bool) {
        return true;
    }
}
