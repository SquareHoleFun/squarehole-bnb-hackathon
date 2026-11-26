// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {AuditU2ClaudeBase, AuditU2ClaudeClaimGifter} from "./AuditU2ClaudeBase.sol";

/// @notice The box 0 contracts and actors the handler drives (set once by the invariant contract's setUp).
struct AuditU2ClaudeWiring {
    IPoolManager pm;
    BoxCoordinator coordinator;
    BoxHook hook;
    BoxLaunchRouter router;
    BoxToken token;
    BoxVault vault;
    AuditRouterSwapper swapper;
    AuditU2ClaudeClaimGifter gifter;
    PoolKey key;
    address safe;
    uint160 sqrtP1;
    uint256 openAt;
    uint256 plannedShare;
    address[8] actors;
}

/// @title AuditU2ClaudeHandler
/// @notice TEST ONLY (SH-AUDIT-B0 U2, Claude). A fail-safe handler (S5M4Handler's pattern: every call wrapped, nothing
/// aborts a run) over U2's surface on the factory's box 0: launch-router buys of 1 wei to 300 ETH at any second
/// (partial closes included), the closing buy, buys and sells through the Universal Router stand-in (exact input to
/// P1 or past it), forced ETH into the router, the coordinator, the hook and the receiver, T transfers to anyone
/// (the coordinator, the vault and T included), approvals and `transferFrom` (finite and max), holders' burns, a third
/// party's Q claims to the coordinator, `graduate()` at random gas limits by anyone, `sweep()`, `claimReward`. It keeps
/// its own clock (forge resets the block between handler calls) and records in ghosts everything that must never
/// happen; the invariant contracts assert them after every call.
contract AuditU2ClaudeHandler is CommonBase, StdCheats, StdUtils {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant PIPS = 1_000_000;
    uint256 internal constant RUNBOOK_GRADUATE_GAS = 15_000_000;
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    AuditU2ClaudeWiring internal w;

    uint256 public clock;
    uint256 public height;

    // ------------------------------------------------------------------ ghosts that must stay zero
    uint256 public conservationViolations;
    uint256 public taxViolations;
    uint256 public refundOutsideClose;
    uint256 public unexpectedBuyReverts;
    uint256 public refusedSendLeaks;
    uint256 public allowanceViolations;
    uint256 public burnViolations;
    uint256 public supplyRose;
    uint256 public graduateBlocked;
    uint256 public rewardViolations;
    uint256 public sweepViolations;
    uint256 public claimViolations;
    bytes public lastUnexpected;

    // ------------------------------------------------------------------ ledgers
    uint256 public forcedRouter;
    uint256 public giftsT;
    uint256 public giftsQ;
    uint256 public giftsTAfter;
    uint256 public giftsQAfter;
    uint256 public lastSupply;
    uint256 public graduations;
    address public graduator;
    uint256 public reward;
    bool public rewardClaimed;

    // ------------------------------------------------------------------ coverage
    uint256 public calls;
    mapping(bytes4 => uint256) public succeeded;
    mapping(bytes4 => uint256) public refused;
    uint256 public partialCloses;
    uint256 public routerCloses;
    uint256 public pokeFailures;

    constructor(AuditU2ClaudeWiring memory w_) {
        w = w_;
        clock = block.timestamp;
        height = block.number;
        lastSupply = w_.token.totalSupply();
    }

    // ================================================================== actions

    function advance(uint256 secs) external {
        _sync();
        uint256 s = bound(secs, 0, 40);
        clock += s;
        height += s == 0 ? 0 : (s + 11) / 12;
        _done(this.advance.selector, true);
    }

    function routerBuy(uint256 who, uint256 amt, uint256 rcp) external {
        _sync();
        uint256 qIn = _amount(amt, 300 ether);
        address payer = _actor(who);
        address recipient = rcp % 8 == 0 ? address(w.coordinator) : _actor(rcp >> 8);
        _buy(payer, qIn, recipient, this.routerBuy.selector);
    }

    /// @notice One in four: a buy of 300 ETH (a partial close at any step). Otherwise a buy sized to bring the curve to
    /// 90%-99.9% of what it still needs, so later small buys meet a nearly full curve and close it partially.
    function routerClose(uint256 who) external {
        _sync();
        address payer = _actor(who);
        uint256 qIn = 300 ether;
        if (who % 4 != 0 && !w.hook.closed() && clock >= w.openAt && clock < w.openAt + 384) {
            uint256 pips = w.router.taxPips((clock - w.openAt) / 12);
            // The curve takes about R / 0.99 in all; the PoolManager holds what it took so far (box 0's only pool).
            uint256 need = 4.25 ether > address(w.pm).balance ? 4.25 ether - address(w.pm).balance : 1;
            uint256 share = 900 + (who >> 8) % 100;
            qIn = need * share / 1000 * PIPS / (PIPS - pips) + 1;
        }
        _buy(payer, qIn, payer, this.routerClose.selector);
    }

    function standInBuy(uint256 who, uint256 amt, uint256 limitSeed) external {
        _sync();
        address payer = _actor(who);
        uint256 qIn = _amount(amt, 20 ether);
        // P1 as the limit until the close (a buy to it closes); past P1 sometimes; after graduation the price sits at
        // P1, so a buy needs a lower limit.
        bool low = limitSeed % 4 == 0 || w.coordinator.graduated();
        uint160 limit = low ? TickMath.MIN_SQRT_PRICE + 1 : w.sqrtP1;
        vm.deal(payer, payer.balance + qIn);
        SwapParams memory p = SwapParams({zeroForOne: true, amountSpecified: -int256(qIn), sqrtPriceLimitX96: limit});
        vm.prank(payer);
        try w.swapper.swapOne{value: qIn}(w.key, p, "", payer) {
            _done(this.standInBuy.selector, true);
        } catch {
            _done(this.standInBuy.selector, false);
        }
    }

    function standInSell(uint256 who, uint256 frac) external {
        _sync();
        address seller = _actor(who);
        uint256 amount = w.token.balanceOf(seller) * bound(frac, 1, 100) / 100;
        if (amount == 0) return _done(this.standInSell.selector, false);
        vm.prank(seller);
        w.token.approve(address(w.swapper), type(uint256).max);
        SwapParams memory p = SwapParams({
            zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
        });
        vm.prank(seller);
        try w.swapper.swapOne(w.key, p, "", seller) {
            _done(this.standInSell.selector, true);
        } catch {
            _done(this.standInSell.selector, false);
        }
    }

    function forceEth(uint256 which, uint256 amt) external {
        _sync();
        address[4] memory targets = [address(w.router), address(w.coordinator), address(w.hook), _receiver()];
        address t = targets[which % 4];
        uint256 v = bound(amt, 1, 5 ether);
        vm.deal(t, t.balance + v);
        if (t == address(w.router)) forcedRouter += v;
        _done(this.forceEth.selector, true);
    }

    function transferT(uint256 from, uint256 to, uint256 amt) external {
        _sync();
        address sender = _actor(from);
        uint256 bal = w.token.balanceOf(sender);
        address[5] memory special = [address(w.coordinator), address(w.vault), address(w.token), DEAD, address(0)];
        address recipient = to % 3 == 0 ? special[(to >> 8) % 5] : _actor(to >> 16);
        uint256 amount = amt % 9 == 0 ? bal + 1 : bound(amt, 0, bal);
        bool mustFail =
            recipient == address(w.vault) || recipient == address(w.token) || recipient == address(0) || amount > bal;
        uint256 r0 = recipient == address(0) ? 0 : w.token.balanceOf(recipient);
        vm.prank(sender);
        try w.token.transfer(recipient, amount) returns (bool ok) {
            if (mustFail || !ok) {
                ++refusedSendLeaks;
                lastUnexpected = abi.encode("transfer passed", recipient, amount);
            }
            if (recipient != sender && w.token.balanceOf(recipient) != r0 + amount) ++conservationViolations;
            if (recipient == address(w.coordinator)) {
                if (w.coordinator.graduated()) giftsTAfter += amount;
                else giftsT += amount;
            }
            _done(this.transferT.selector, true);
        } catch (bytes memory err) {
            if (!mustFail) {
                ++refusedSendLeaks;
                lastUnexpected = err;
            }
            _done(this.transferT.selector, false);
        }
    }

    function transferFromT(uint256 owner, uint256 spender, uint256 amt, bool useMax) external {
        _sync();
        uint256 oi = owner % 8;
        address o = w.actors[oi];
        address s = w.actors[(oi + 1 + spender % 7) % 8];
        uint256 bal = w.token.balanceOf(o);
        uint256 amount = bound(amt, 0, bal);
        uint256 allow = useMax ? type(uint256).max : amount + (amt >> 200);
        vm.prank(o);
        w.token.approve(s, allow);
        vm.prank(s);
        try w.token.transferFrom(o, s, amount) {
            uint256 left = w.token.allowance(o, s);
            if (useMax ? left != type(uint256).max : left != allow - amount) ++allowanceViolations;
            _done(this.transferFromT.selector, true);
        } catch (bytes memory err) {
            ++allowanceViolations;
            lastUnexpected = err;
            _done(this.transferFromT.selector, false);
        }
    }

    function burnT(uint256 who, uint256 amt) external {
        _sync();
        address holder = _actor(who);
        uint256 bal = w.token.balanceOf(holder);
        uint256 amount = bound(amt, 0, bal);
        uint256 supply = w.token.totalSupply();
        uint256 floor = w.vault.supplyFloor();
        vm.prank(holder);
        try w.token.burn(amount) {
            if (w.token.totalSupply() != supply - amount || w.token.balanceOf(holder) != bal - amount) {
                ++burnViolations;
            }
            if (supply - amount < floor) ++burnViolations;
            _done(this.burnT.selector, true);
        } catch (bytes memory err) {
            if (supply - amount >= floor) {
                ++burnViolations;
                lastUnexpected = err;
            }
            _done(this.burnT.selector, false);
        }
    }

    function giftClaims(uint256 amt) external {
        _sync();
        uint256 v = bound(amt, 1, 5 ether);
        vm.deal(address(this), address(this).balance + v);
        try w.gifter.giftEthClaims{value: v}(address(w.coordinator)) {
            if (w.coordinator.graduated()) giftsQAfter += v;
            else giftsQ += v;
            _done(this.giftClaims.selector, true);
        } catch {
            _done(this.giftClaims.selector, false);
        }
    }

    function graduate(uint256 who, uint256 gasSeed) external {
        _sync();
        address caller = _actor(who);
        uint256 g = gasSeed % 4 == 0 ? RUNBOOK_GRADUATE_GAS : bound(gasSeed, 1_000_000, 16_000_000);
        bool closed = w.hook.closed();
        bool already = w.coordinator.graduated();
        uint256 held = w.pm.balanceOf(address(w.coordinator), 0);
        uint256 minted = w.hook.reserveMinted();
        vm.recordLogs();
        vm.prank(caller);
        (bool ok, bytes memory ret) = address(w.coordinator).call{gas: g}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        _countPokeFailures(ok);
        if (ok) {
            if (!closed || already) ++rewardViolations;
            ++graduations;
            graduator = caller;
            reward = abi.decode(ret, (uint256));
            // The migration's last harvest tops the reserve up inside the call: read it after, add it to what was held.
            uint256 mintedAfter = w.hook.reserveMinted();
            uint256 heldAtCredit = held + (mintedAfter - minted);
            uint256 cap = w.coordinator.rewardCap();
            uint256 expected = mintedAfter < cap ? mintedAfter : cap;
            if (expected > heldAtCredit) expected = heldAtCredit;
            minted = mintedAfter;
            if (reward != expected || reward > minted) ++rewardViolations;
            if (w.pm.balanceOf(address(w.coordinator), 0) != reward) ++rewardViolations;
            if (w.coordinator.rewardOf(caller) != reward) ++rewardViolations;
            _done(this.graduate.selector, true);
        } else {
            bytes4 e = bytes4(ret);
            bool expectedRefusal = (!closed && e == IBoxCoordinator.NotClosed.selector)
                || (already && e == IBoxCoordinator.AlreadyGraduated.selector);
            if (closed && !already && g >= RUNBOOK_GRADUATE_GAS) {
                ++graduateBlocked;
                lastUnexpected = ret;
            } else if (!closed || already) {
                if (!expectedRefusal) {
                    ++rewardViolations;
                    lastUnexpected = ret;
                }
            }
            _done(this.graduate.selector, false);
        }
    }

    function sweep(uint256 who) external {
        _sync();
        address caller = _actor(who);
        uint256 bal = address(w.router).balance;
        uint256 hookClaims = w.pm.balanceOf(address(w.hook), 0);
        bool graduated = w.hook.migratedAtBlock() != 0;
        vm.prank(caller);
        try w.router.sweep() returns (uint256 amount) {
            if (!graduated || amount != bal || address(w.router).balance != 0) ++sweepViolations;
            if (w.pm.balanceOf(address(w.hook), 0) != hookClaims + amount) ++sweepViolations;
            _done(this.sweep.selector, true);
        } catch (bytes memory err) {
            bytes4 e = bytes4(err);
            bool expected = (bal == 0 && e == IBoxLaunchRouter.NothingToSweep.selector)
                || (bal != 0 && !graduated && e == IBoxLaunchRouter.NotGraduated.selector);
            if (!expected) {
                ++sweepViolations;
                lastUnexpected = err;
            }
            _done(this.sweep.selector, false);
        }
    }

    function claimReward(uint256 toSeed) external {
        _sync();
        address to = _actor(toSeed);
        address by = graduator == address(0) ? _actor(toSeed >> 8) : graduator;
        uint256 e0 = to.balance;
        vm.prank(by);
        try w.coordinator.claimReward(to) returns (uint256 amount) {
            if (rewardClaimed || amount != reward || to.balance != e0 + amount) ++claimViolations;
            rewardClaimed = true;
            _done(this.claimReward.selector, true);
        } catch (bytes memory err) {
            bool expected = bytes4(err) == IBoxCoordinator.NothingToClaim.selector
                && (rewardClaimed || reward == 0 || graduator == address(0));
            if (!expected) {
                ++claimViolations;
                lastUnexpected = err;
            }
            _done(this.claimReward.selector, false);
        }
    }

    // ================================================================== internals

    /// @dev One measured launch-router buy (P2.1, P2.15): conservation to the wei, the table's tax, the refund only at
    /// the closing fill, then exactly at P1; a refusal only for the documented reasons.
    function _buy(address payer, uint256 qIn, address recipient, bytes4 sel) internal {
        bool wasClosed = w.hook.closed();
        vm.deal(payer, payer.balance + qIn);
        uint256[4] memory b =
            [payer.balance, address(w.router).balance, address(w.pm).balance, w.token.balanceOf(recipient)];
        vm.prank(payer);
        try w.router.buy{value: qIn}(qIn, 1, recipient, clock) returns (uint256 out) {
            uint256 spent = address(w.pm).balance - b[2];
            uint256 tax = address(w.router).balance - b[1];
            uint256 refund = payer.balance + qIn - b[0];
            if (spent + tax + refund != qIn) ++conservationViolations;
            if (w.token.balanceOf(recipient) - b[3] != out || out == 0) ++conservationViolations;
            uint256 pips = w.router.taxPips((clock - w.openAt) / 12);
            uint256 full = (qIn * pips + PIPS - 1) / PIPS;
            if (refund == 0) {
                if (tax != full) ++taxViolations;
            } else {
                ++partialCloses;
                if (wasClosed || !w.hook.closed()) ++refundOutsideClose;
                if (tax != (spent * pips + (PIPS - pips) - 1) / (PIPS - pips) || tax > full) ++taxViolations;
                (uint160 p,,,) = w.pm.getSlot0(w.key.toId());
                if (p != w.sqrtP1) ++refundOutsideClose;
            }
            if (!wasClosed && w.hook.closed()) ++routerCloses;
            if (recipient == address(w.coordinator)) giftsT += out;
            _done(sel, true);
        } catch (bytes memory err) {
            bytes4 e = bytes4(err);
            bool expected = (clock < w.openAt && e == IBoxLaunchRouter.NotOpen.selector)
                || (clock >= w.openAt + 384 && e == IBoxLaunchRouter.WindowClosed.selector)
                || (wasClosed && e == IBoxLaunchRouter.CurveIsClosed.selector)
                || e == IBoxLaunchRouter.AmountTooSmall.selector;
            if (!expected) {
                ++unexpectedBuyReverts;
                lastUnexpected = err;
            }
            _done(sel, false);
        }
    }

    function _countPokeFailures(bool ok) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) return;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(w.coordinator) && logs[i].topics.length > 0
                    && logs[i].topics[0] == IBoxCoordinator.PokeFailed.selector
            ) ++pokeFailures;
        }
    }

    function _sync() internal {
        vm.warp(clock);
        vm.roll(height);
        ++calls;
    }

    function _done(bytes4 sel, bool ok) internal {
        if (ok) ++succeeded[sel];
        else ++refused[sel];
        uint256 s = w.token.totalSupply();
        if (s > lastSupply) ++supplyRose;
        lastSupply = s;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return w.actors[seed % 8];
    }

    function _receiver() internal view returns (address) {
        return w.coordinator.receiver();
    }

    /// @dev Log-uniform in [1, hi].
    function _amount(uint256 seed, uint256 hi) internal pure returns (uint256 x) {
        uint256 bits = seed % 69;
        x = (uint256(1) << bits) + ((seed >> 8) % (uint256(1) << bits));
        if (x > hi) x = hi;
        if (x == 0) x = 1;
    }

    function wiring() external view returns (AuditU2ClaudeWiring memory) {
        return w;
    }
}

/// @notice The handler's world: box 0 at a chosen start (`_start`), the handler wired to it as the only target, and
/// the checks the invariant contracts assert after every call.
abstract contract AuditU2ClaudeHandlerSetup is AuditU2ClaudeBase {
    AuditU2ClaudeHandler internal handler;

    function setUp() public virtual override {
        super.setUp();
        _start();
        address[8] memory actors = [eoa[0], eoa[1], eoa[2], eoa[3], eoa[4], eoa[5], eoa7702, address(contractDrawer)];
        handler = new AuditU2ClaudeHandler(
            AuditU2ClaudeWiring({
                pm: pm,
                coordinator: coordinator,
                hook: hook,
                router: launchRouter,
                token: token,
                vault: vault,
                swapper: routerSwapper,
                gifter: gifter,
                key: poolKey,
                safe: safe,
                sqrtP1: _p1(),
                openAt: hook.openAt(),
                plannedShare: token.balanceOf(a.coordinator),
                actors: actors
            })
        );
        _ghostAddOutside(0x000000000000000000000000000000000000dEaD);
        targetContract(address(handler));
        targetSelector(FuzzSelector({addr: address(handler), selectors: _selectors()}));
    }

    /// @dev Where the campaign starts: two blocks before the open.
    function _start() internal virtual {
        _warpTo(hook.openAt() - 24);
    }

    function _selectors() internal pure returns (bytes4[] memory sels) {
        sels = new bytes4[](13);
        sels[0] = AuditU2ClaudeHandler.advance.selector;
        sels[1] = AuditU2ClaudeHandler.routerBuy.selector;
        sels[2] = AuditU2ClaudeHandler.routerClose.selector;
        sels[3] = AuditU2ClaudeHandler.standInBuy.selector;
        sels[4] = AuditU2ClaudeHandler.standInSell.selector;
        sels[5] = AuditU2ClaudeHandler.forceEth.selector;
        sels[6] = AuditU2ClaudeHandler.transferT.selector;
        sels[7] = AuditU2ClaudeHandler.transferFromT.selector;
        sels[8] = AuditU2ClaudeHandler.burnT.selector;
        sels[9] = AuditU2ClaudeHandler.giftClaims.selector;
        sels[10] = AuditU2ClaudeHandler.graduate.selector;
        sels[11] = AuditU2ClaudeHandler.sweep.selector;
        sels[12] = AuditU2ClaudeHandler.claimReward.selector;
    }

    function _checkRouterConservesEveryBuy() internal view {
        assertEq(handler.conservationViolations(), 0, "msg.value == spend + tax + refund; T delivered");
        assertEq(handler.taxViolations(), 0, "the table's tax, or the partial fill's");
        assertEq(handler.refundOutsideClose(), 0, "a refund only at the closing fill, at P1");
        assertEq(
            handler.unexpectedBuyReverts(), 0, "refused only before the open, after the window, closed or too small"
        );
    }

    function _checkRouterHoldsUnsweptTaxAndForcedEthOnly() internal view {
        assertEq(
            a.launchRouter.balance + launchRouter.totalSwept(),
            launchRouter.totalTaxCollected() + handler.forcedRouter(),
            "router ETH + swept == tax kept + forced ETH"
        );
    }

    function _checkTSupplyIdentityAndFloor() internal view {
        uint256 s = token.totalSupply();
        assertEq(s + token.totalBurned(), BoxSpecV1.ISSUANCE, "supply + burned == 1e27");
        assertEq(handler.supplyRose(), 0, "supply never rises");
        assertEq(handler.burnViolations(), 0, "burns: own balance, exact, never below the floor");
        assertGe(s, vault.supplyFloor(), "supply >= E + n");
        assertEq(_ghostSystemT() + _ghostOutsideT(), s, "the known holders hold every unit");
    }

    function _checkRefusedSendsStayRefused() internal view {
        assertEq(handler.refusedSendLeaks(), 0, "sends to the vault and to T revert; nothing else does");
        assertEq(handler.allowanceViolations(), 0, "finite allowances exact, max never decremented");
    }

    function _checkGraduationOnceAfterTheCloseAndNeverBlocked() internal view {
        assertLe(handler.graduations(), 1, "at most once");
        assertEq(coordinator.graduated(), handler.graduations() == 1);
        if (coordinator.graduated()) {
            assertTrue(hook.closed(), "only after the close");
            assertGt(hook.migratedAtBlock(), 0);
        }
        assertEq(handler.graduateBlocked(), 0, "never blocked after the close with the runbook's gas");
        assertEq(handler.rewardViolations(), 0, "reward == min(reserve minted, 0.1% of R, claims held)");
        assertEq(handler.claimViolations(), 0, "the reward claimed once, by its holder, to the wei");
        assertEq(handler.sweepViolations(), 0, "sweep: only after graduation, the whole balance, into the hook");
    }

    function _checkCoordinatorHoldsShareReserveAndGiftsOnly() internal view {
        uint256 t = token.balanceOf(a.coordinator);
        uint256 q = pm.balanceOf(a.coordinator, 0);
        if (!coordinator.graduated()) {
            assertEq(
                t, handler.wiring().plannedShare + handler.giftsT(), "before graduation: the share and T sent here"
            );
            assertEq(q, hook.reserveMinted() + handler.giftsQ(), "and the reserve and claims sent here");
            assertEq(coordinator.reserve(), hook.reserveMinted());
        } else {
            assertEq(t, handler.giftsTAfter(), "after: only T sent after graduation");
            uint256 unclaimed = handler.rewardClaimed() ? 0 : handler.reward();
            assertEq(q, unclaimed + handler.giftsQAfter(), "and the unclaimed reward and later gifts");
        }
        assertLe(hook.reserveMinted(), coordinator.rewardCap(), "the reserve never above 0.1% of R");
    }

    function _checkTaxNeverReachesTheSafe() internal view {
        assertEq(safe.balance, 0, "no ETH to the Safe");
        assertEq(pm.balanceOf(safe, 0), 0, "no claims to the Safe");
    }

    function _checkAll() internal view {
        _checkRouterConservesEveryBuy();
        _checkRouterHoldsUnsweptTaxAndForcedEthOnly();
        _checkTSupplyIdentityAndFloor();
        _checkRefusedSendsStayRefused();
        _checkGraduationOnceAfterTheCloseAndNeverBlocked();
        _checkCoordinatorHoldsShareReserveAndGiftsOnly();
        _checkTaxNeverReachesTheSafe();
    }
}

/// @title AuditU2ClaudeLaunchInvariants
/// @notice The invariant suite of U2 (plan § 6 gap 3, the launch router's campaign; T's own campaign): box 0 from two
/// blocks before its open, through the window, the curve, the close (by the router's partial fill or the stand-in, to
/// P1 or past it) and graduation, into trading after it. After every call: the router conservation and tax ghosts,
/// the router's balance identity, T's supply identity and floor, the refused sends, graduation once and only after
/// the close and never blocked with the runbook's gas, the coordinator's holdings, the Safe untouched.
/// forge-config: default.evm_version = "osaka"
/// forge-config: default.invariant.show_metrics = true
contract AuditU2ClaudeLaunchInvariants is AuditU2ClaudeHandlerSetup {
    function invariant_AUDIT_U2_routerConservesEveryBuy() public view {
        _checkRouterConservesEveryBuy();
    }

    function invariant_AUDIT_U2_routerHoldsUnsweptTaxAndForcedEthOnly() public view {
        _checkRouterHoldsUnsweptTaxAndForcedEthOnly();
    }

    function invariant_AUDIT_U2_tSupplyIdentityAndFloor() public view {
        _checkTSupplyIdentityAndFloor();
    }

    function invariant_AUDIT_U2_refusedSendsStayRefused() public view {
        _checkRefusedSendsStayRefused();
    }

    function invariant_AUDIT_U2_graduationOnceAfterTheCloseAndNeverBlocked() public view {
        _checkGraduationOnceAfterTheCloseAndNeverBlocked();
    }

    function invariant_AUDIT_U2_coordinatorHoldsShareReserveAndGiftsOnly() public view {
        _checkCoordinatorHoldsShareReserveAndGiftsOnly();
    }

    function invariant_AUDIT_U2_taxNeverReachesTheSafe() public view {
        _checkTaxNeverReachesTheSafe();
    }

    function invariant_AUDIT_U2_callSummary() public {
        emit log_named_uint("calls", handler.calls());
        emit log_named_uint("routerBuy ok", handler.succeeded(AuditU2ClaudeHandler.routerBuy.selector));
        emit log_named_uint("routerBuy refused", handler.refused(AuditU2ClaudeHandler.routerBuy.selector));
        emit log_named_uint("routerClose ok", handler.succeeded(AuditU2ClaudeHandler.routerClose.selector));
        emit log_named_uint("partial closes", handler.partialCloses());
        emit log_named_uint("router closes", handler.routerCloses());
        emit log_named_uint("standInBuy ok", handler.succeeded(AuditU2ClaudeHandler.standInBuy.selector));
        emit log_named_uint("standInSell ok", handler.succeeded(AuditU2ClaudeHandler.standInSell.selector));
        emit log_named_uint("transferT ok", handler.succeeded(AuditU2ClaudeHandler.transferT.selector));
        emit log_named_uint("transferT refused", handler.refused(AuditU2ClaudeHandler.transferT.selector));
        emit log_named_uint("transferFromT ok", handler.succeeded(AuditU2ClaudeHandler.transferFromT.selector));
        emit log_named_uint("burnT ok", handler.succeeded(AuditU2ClaudeHandler.burnT.selector));
        emit log_named_uint("giftClaims ok", handler.succeeded(AuditU2ClaudeHandler.giftClaims.selector));
        emit log_named_uint("graduate ok", handler.succeeded(AuditU2ClaudeHandler.graduate.selector));
        emit log_named_uint("graduate refused", handler.refused(AuditU2ClaudeHandler.graduate.selector));
        emit log_named_uint("poke failures", handler.pokeFailures());
        emit log_named_uint("sweep ok", handler.succeeded(AuditU2ClaudeHandler.sweep.selector));
        emit log_named_uint("claimReward ok", handler.succeeded(AuditU2ClaudeHandler.claimReward.selector));
    }
}

/// @notice The same suite from the close (the world's `_toClosed`: window and bonding behind, a fee batch collected,
/// the curve closed at P1 by the stand-in), so every call of the campaign is spent on graduation and after it.
/// forge-config: default.evm_version = "osaka"
/// forge-config: default.invariant.show_metrics = true
contract AuditU2ClaudeClosedInvariants is AuditU2ClaudeLaunchInvariants {
    function _start() internal override {
        _toClosed();
    }
}

/// @notice The campaign from the close under Amsterdam: graduation at random gas limits and with the runbook's
/// 15,000,000 under Glamsterdam's repricing.
/// forge-config: default.evm_version = "amsterdam"
/// forge-config: default.invariant.show_metrics = true
contract AuditU2ClaudeClosedAmsterdamInvariants is AuditU2ClaudeClosedInvariants {}

/// @notice The handler is not vacuous: one scripted sequence through it reaches every action's success, a partial
/// close by the router, graduation with the runbook's gas, the sweep and the claim, with every check still holding.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeHandlerReachTest is AuditU2ClaudeHandlerSetup {
    function testProperty_AUDIT_U2_handlerReachesEveryAction() public {
        handler.advance(30);
        handler.routerBuy(60, 60, 1);
        handler.forceEth(0, 1 ether);
        handler.transferT(0, 3, 1);
        handler.transferFromT(0, 1, 1e18, false);
        handler.transferFromT(0, 2, 1e18, true);
        handler.burnT(0, 1e18);
        handler.giftClaims(1 ether);
        handler.standInSell(0, 10);
        handler.routerClose(1);
        assertFalse(hook.closed(), "a fill to 90%-99.9% of what the curve still needs");
        handler.routerClose(4);
        assertGe(handler.partialCloses(), 1, "a partial close by the router");
        handler.graduate(2, 4);
        assertEq(handler.graduations(), 1, "graduated with the runbook's gas");
        handler.sweep(3);
        assertEq(a.launchRouter.balance, 0, "swept");
        handler.claimReward(4);
        assertTrue(handler.rewardClaimed());
        handler.advance(90);
        handler.standInBuy(5, 60, 1);
        handler.standInSell(5, 50);
        bytes4[] memory sels = _selectors();
        for (uint256 i; i < sels.length; ++i) {
            assertGt(handler.succeeded(sels[i]), 0, "every action succeeded at least once");
        }
        _checkAll();
    }

    /// @notice One long pseudo-random life through the handler (600 calls, the 13 actions drawn evenly, arguments from
    /// keccak, every check after every third call and at the end), each action's successes and refusals logged
    /// (`U2C|life|` lines): a measure of how often the campaigns' calls reach each success path. It asserts the life
    /// closed the curve by a router buy and graduated; the scripted test above asserts every action's success.
    function testProperty_AUDIT_U2_aLongRandomLifeReachesEveryAction() public {
        bytes4[] memory sels = _selectors();
        for (uint256 i; i < 600; ++i) {
            uint256 r = uint256(keccak256(abi.encode("audit.u2.claude.life", i)));
            uint256 k = r % sels.length;
            uint256 x = r >> 8;
            uint256 y = uint256(keccak256(abi.encode(r)));
            uint256 z = uint256(keccak256(abi.encode(y)));
            if (k == 0) handler.advance(x);
            else if (k == 1) handler.routerBuy(x, y, z);
            else if (k == 2) handler.routerClose(x);
            else if (k == 3) handler.standInBuy(x, y, z);
            else if (k == 4) handler.standInSell(x, y);
            else if (k == 5) handler.forceEth(x, y);
            else if (k == 6) handler.transferT(x, y, z);
            else if (k == 7) handler.transferFromT(x, y, z, z & 1 == 0);
            else if (k == 8) handler.burnT(x, y);
            else if (k == 9) handler.giftClaims(x);
            else if (k == 10) handler.graduate(x, y);
            else if (k == 11) handler.sweep(x);
            else handler.claimReward(x);
            if (i % 3 == 2) _checkAll();
        }
        _checkAll();
        string[13] memory names = [
            "advance",
            "routerBuy",
            "routerClose",
            "standInBuy",
            "standInSell",
            "forceEth",
            "transferT",
            "transferFromT",
            "burnT",
            "giftClaims",
            "graduate",
            "sweep",
            "claimReward"
        ];
        for (uint256 i; i < sels.length; ++i) {
            emit log_named_string(
                string.concat("U2C|life|", names[i]),
                string.concat(
                    vm.toString(handler.succeeded(sels[i])), " ok / ", vm.toString(handler.refused(sels[i])), " refused"
                )
            );
        }
        emit log_named_uint("U2C|life|partial closes", handler.partialCloses());
        emit log_named_uint("U2C|life|router closes", handler.routerCloses());
        emit log_named_uint("U2C|life|poke failures", handler.pokeFailures());
        assertEq(handler.routerCloses(), 1, "the life closed the curve by a router buy");
        assertEq(handler.graduations(), 1, "and graduated");
    }
}
