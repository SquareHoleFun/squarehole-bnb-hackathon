// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxBuildV1 as RehearsalBuildV1} from "../../../../src/box/build/rehearsal/BoxBuildV1.sol";
import {BoxPhase} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {EthIn, EthOut, TOut} from "../common/AuditGhostLedger.sol";
import {
    AuditU2ClaudeBase,
    AuditU2ClaudeCloser,
    AuditU2ClaudeForeignUnlocker,
    AuditU2ClaudeGraduation,
    AuditU2ClaudeSenderProbe
} from "./AuditU2ClaudeBase.sol";

/// @notice U2's coordinator on the factory's box 0 (mainnet build): L2 callers and once-only steps, L1 the reward and
/// the pool share under third parties' gifts, L5 graduation that nobody can block, L7 the packed words, L8 the
/// deployment.
/// - P2.3 (BoxCoordinator.sol:268-283; BC-027; IBoxCoordinator.sol:15-20, :24-25): the reward is min(reserve minted,
///   0.1% of R, Q claims held); claims a third party sent to the coordinator never raise it and become the receiver's
///   fees in the graduation settlement (split as every next batch: FIT, platform in epoch 0, depth).
/// - P2.4 (BC-043; IBoxCoordinator.sol:14; BoxHookExtension.sol:208-223): T sent to the coordinator before graduation
///   joins the ask or is burned, never breaking graduation (today it joins the ask: the effect on the layout and on
///   BC-029 is AUDIT-U2-02, `AuditU2ClaudeProofs.t.sol`).
/// - P2.7, P2.8, P2.17: deploy/launch the factory's once, graduate anyone's once after the close, claimReward the
///   credited caller's once, the unlock callbacks only inside their own guarded unlock, every role at its nonce.
/// - P2.12 (BC-098; launch-pipeline-v1.md:208-216): after any mix of third-party gifts (T, Q claims, T claims), forced
///   ETH into every box address and a close of any shape (to P1, past it to the lowest price, by exact output, from a
///   price pushed to P0), graduate() with the runbook's 15,000,000 gas succeeds with no PokeFailed.
/// - P2.16: the reward cap is R/1,000 of the build; `_w`'s graduatedAt holds every timestamp below 2^40.
/// forge-config: default.evm_version = "osaka"
contract AuditU2ClaudeCoordinatorTest is AuditU2ClaudeBase {
    // ============================================================================================ deployment (P2.17)

    function testProperty_AUDIT_U2_deployCreatedEveryRoleAtItsNonceAndOnlyOnce() public {
        address[9] memory roles = [
            coordinator.token(),
            coordinator.vault(),
            coordinator.collection(),
            coordinator.receiver(),
            coordinator.launchRouter(),
            coordinator.tickets(),
            coordinator.royaltyRouter(),
            coordinator.itemStream(),
            coordinator.executor()
        ];
        address[9] memory kitRoles = [
            a.token,
            a.vault,
            a.collection,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.itemStream,
            a.executor
        ];
        uint256 seen;
        for (uint8 r; r < 9; ++r) {
            uint256 nonce = coordinator.nonceOf(r);
            assertGt(nonce, 0, "box 0 creates every role here");
            assertEq(seen & (1 << nonce), 0, "no nonce twice");
            seen |= 1 << nonce;
            assertEq(roles[r], vm.computeCreateAddress(a.coordinator, nonce), "the role's CREATE address at its nonce");
            assertEq(roles[r], kitRoles[r], "the factory's planned address");
            assertGt(roles[r].code.length, 0);
        }
        assertEq(coordinator.nonceOf(9), 0, "no tenth role");
        // Every clone's runtime is exactly the planned code `deploy` was given at its nonce (BoxClones.initCode: a
        // 10-byte constructor, then the runtime).
        bytes[] memory codes = kit.codes();
        for (uint8 r; r < 9; ++r) {
            bytes memory c = codes[coordinator.nonceOf(r) - 1];
            if (c.length > 10 && c[0] == 0x61 && bytes7(_slice(c, 3, 7)) == bytes7(hex"3d81600a3d39f3")) {
                assertEq(keccak256(roles[r].code), keccak256(_slice(c, 10, c.length - 10)), "the planned runtime");
            }
        }
        // The hook: CREATE2 by the coordinator over the hook's init code, at the mined salt.
        assertEq(
            a.hook,
            vm.computeCreate2Address(a.hookSalt, factory.hookInitCodeHash(uint32(hook.openAt())), a.coordinator),
            "the hook at its CREATE2 address"
        );
        assertEq(coordinator.hook(), a.hook);
        // The clones run the version's implementations; T is the full BoxToken naming this box.
        CoreImpls memory im = kit.impls();
        _assertCloneOf(a.vault, im.vault);
        _assertCloneOf(a.collection, im.collection);
        _assertCloneOf(a.receiver, im.receiver);
        _assertCloneOf(a.launchRouter, im.launchRouter);
        _assertCloneOf(a.tickets, im.tickets);
        _assertReceivingCloneOf(a.royaltyRouter, im.royaltyRouter);
        _assertCloneOf(a.itemStream, im.itemStream);
        _assertCloneOf(a.hook, im.hook);
        assertEq(IBoxToken(a.token).initialHolder(), a.coordinator, "T issued to the coordinator");
        assertEq(IBoxToken(a.token).vault(), a.vault);
        // A second deploy or launch: refused, by the factory too.
        bytes[] memory none = new bytes[](0);
        vm.prank(address(factory));
        vm.expectRevert(BoxCoordinator.AlreadyDeployed.selector);
        coordinator.deploy(none, "", bytes32(0), 0);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, eoa[0]));
        coordinator.deploy(none, "", bytes32(0), 0);
        vm.deal(address(factory), 1 ether);
        vm.prank(address(factory));
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        coordinator.launch{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.deal(eoa[0], 1 ether);
        vm.prank(eoa[0]);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, eoa[0]));
        coordinator.launch{value: BoxSpecV1.BOOTSTRAP_ETH}();
        // The implementation itself is inert (deployed and launched in its constructor).
        BoxCoordinator impl = BoxCoordinator(im.coordinator);
        vm.prank(address(factory));
        vm.expectRevert(BoxCoordinator.AlreadyDeployed.selector);
        impl.deploy(none, "", bytes32(0), 0);
        vm.prank(address(factory));
        vm.expectRevert(IBoxCoordinator.AlreadyLaunched.selector);
        impl.launch{value: BoxSpecV1.BOOTSTRAP_ETH}();
        vm.deal(address(factory), 0);
        vm.deal(eoa[0], 0);
    }

    function _slice(bytes memory b, uint256 from, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = b[from + i];
        }
    }

    function _assertCloneOf(address clone, address impl) internal view {
        bytes memory code = clone.code;
        assertEq(bytes10(code), bytes10(CLONE_PREFIX), "an EIP-1167 clone");
        address target;
        assembly ("memory-safe") {
            target := shr(96, mload(add(add(code, 0x20), 10)))
        }
        assertEq(target, impl, "of the version's implementation");
    }

    /// @dev The royalty router's receiving runtime (BoxClones.sol:16-21): a 6-byte prefix, then the proxy.
    function _assertReceivingCloneOf(address clone, address impl) internal view {
        bytes memory code = clone.code;
        assertEq(bytes6(code), bytes6(hex"36600557005b"), "the receiving prefix");
        address target;
        assembly ("memory-safe") {
            target := shr(96, mload(add(add(code, 0x20), 16)))
        }
        assertEq(target, impl, "of the version's royalty router");
    }

    // ============================================================================================ callers (P2.7, P2.8)

    function testProperty_AUDIT_U2_graduateOnlyAfterTheCloseAndOnlyOnce() public {
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        coordinator.graduate();
        _toWindow();
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        coordinator.graduate();
        _toBonding();
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        coordinator.graduate();
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Bonding));
        uint256 share = coordinator.poolShare();
        assertEq(share, curve.poolShare, "before graduation the coordinator holds the pool share");
        assertEq(coordinator.reserve(), hook.reserveMinted(), "and the reserve the hook minted");
        _toClosed();
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Closed));
        AuditU2ClaudeGraduation memory g = _graduateRecorded(eoa[4]);
        assertEq(g.reward, coordinator.rewardCap(), "the whole reserve, at the cap");
        assertEq(coordinator.rewardOf(eoa[4]), g.reward, "credited to the caller");
        assertTrue(coordinator.graduated());
        assertEq(coordinator.graduatedAt(), vm.getBlockTimestamp());
        assertEq(coordinator.graduatedAtBlock(), vm.getBlockNumber());
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Graduated));
        assertEq(coordinator.poolShare(), 0);
        assertEq(coordinator.reserve(), 0);
        assertEq(g.poolShare, share, "the Graduated event names the share handed to migrate");
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        coordinator.graduate();
        vm.prank(keeper);
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        coordinator.graduate();
    }

    function testProperty_AUDIT_U2_claimRewardOnlyByTheCreditedCallerOnce() public {
        _toClosed();
        (uint256 reward,) = _graduate(eoa[4]);
        vm.prank(keeper);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(keeper);
        vm.prank(eoa[4]);
        vm.expectRevert(IBoxCoordinator.ZeroAddress.selector);
        coordinator.claimReward(address(0));
        // Recipients that refuse Q: the whole claim reverts and stays.
        address[6] memory refusing =
            [a.coordinator, address(pm), a.hook, a.launchRouter, address(ethRefuser), address(gasBurner)];
        for (uint256 i; i < refusing.length; ++i) {
            vm.prank(eoa[4]);
            vm.expectRevert(IBoxCoordinator.ClaimFailed.selector);
            coordinator.claimReward{gas: 5_000_000}(refusing[i]);
            assertEq(coordinator.rewardOf(eoa[4]), reward, "the claim stays");
            assertEq(pm.balanceOf(a.coordinator, 0), reward, "and so do its claims");
        }
        uint256 e0 = eoa[5].balance;
        assertEq(_claimReward(eoa[4], eoa[5]), reward);
        assertEq(eoa[5].balance - e0, reward, "paid in Q to any address");
        assertEq(pm.balanceOf(a.coordinator, 0), 0, "its claims redeemed");
        assertEq(coordinator.rewardOf(eoa[4]), 0);
        vm.prank(eoa[4]);
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(eoa[4]);
        _assertGhostLedger();
    }

    /// @notice P2.8: both unlock callbacks refuse a direct call, a call with the PoolManager's address outside any
    /// unlock, and one inside a third party's unlock (the contract's own lock is not held then).
    function testProperty_AUDIT_U2_unlockCallbacksActOnlyInsideTheirOwnUnlock() public {
        _toGraduated();
        _forceEth(a.launchRouter, 1 ether);
        bytes memory sweepData = abi.encode(uint8(2), abi.encode(uint256(1 ether), eoa[0]));
        bytes memory claimData = abi.encode(eoa[0], coordinator.rewardOf(keeper));
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxLaunchRouter.NotPoolManager.selector);
        launchRouter.unlockCallback(sweepData);
        vm.prank(eoa[0]);
        vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
        coordinator.unlockCallback(claimData);
        vm.prank(address(pm));
        vm.expectRevert(IBoxLaunchRouter.NotPoolManager.selector);
        launchRouter.unlockCallback(sweepData);
        vm.prank(address(pm));
        vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
        coordinator.unlockCallback(claimData);
        AuditU2ClaudeForeignUnlocker f = new AuditU2ClaudeForeignUnlocker(pm);
        // Control: inside the third party's unlock the call does come from the PoolManager's address.
        AuditU2ClaudeSenderProbe probe = new AuditU2ClaudeSenderProbe();
        f.run(address(probe), "");
        assertTrue(f.lastSucceeded());
        assertEq(probe.lastSender(), address(pm), "control: the callee sees the PoolManager as msg.sender");
        f.run(a.launchRouter, sweepData);
        assertFalse(f.lastSucceeded(), "the router's callback inside a third party's unlock");
        assertEq(bytes4(f.lastRevert()), IBoxLaunchRouter.NotPoolManager.selector);
        f.run(a.coordinator, claimData);
        assertFalse(f.lastSucceeded(), "the coordinator's callback inside a third party's unlock");
        assertEq(bytes4(f.lastRevert()), IBoxCoordinator.NotPoolManager.selector);
        assertEq(a.launchRouter.balance, launchRouter.totalTaxCollected() + 1 ether, "nothing moved");
        assertEq(pm.balanceOf(eoa[0], 0), 0);
        assertEq(coordinator.rewardOf(keeper), graduationReward);
    }

    /// @notice BC-010 for U2's entry points: a random caller is refused by every gated one.
    function testFuzz_AUDIT_U2_aRandomCallerIsRefusedByEveryGatedEntryPoint(address caller) public {
        vm.assume(
            caller != address(factory) && caller != a.coordinator && caller != address(pm) && caller != address(0)
        );
        vm.assume(caller.code.length == 0 && uint160(caller) > 0x1000);
        bytes[] memory none = new bytes[](0);
        vm.startPrank(caller);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, caller));
        coordinator.deploy(none, "", bytes32(0), 0);
        vm.expectRevert(abi.encodeWithSelector(IBoxCoordinator.NotFactory.selector, caller));
        coordinator.launch();
        vm.expectRevert(IBoxCoordinator.NothingToClaim.selector);
        coordinator.claimReward(caller);
        vm.expectRevert(IBoxCoordinator.NotPoolManager.selector);
        coordinator.unlockCallback(abi.encode(caller, uint256(1)));
        vm.expectRevert(IBoxCoordinator.NotClosed.selector);
        coordinator.graduate();
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, caller));
        launchRouter.initialize();
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, caller));
        launchRouter.bootstrap();
        vm.expectRevert(abi.encodeWithSelector(IBoxLaunchRouter.NotCoordinator.selector, caller));
        launchRouter.creatorBuy(caller, 1);
        vm.expectRevert(IBoxLaunchRouter.NotPoolManager.selector);
        launchRouter.unlockCallback(abi.encode(uint8(2), abi.encode(uint256(1), caller)));
        vm.stopPrank();
        _forceEth(a.launchRouter, 1);
        vm.prank(caller);
        vm.expectRevert(IBoxLaunchRouter.NotGraduated.selector);
        launchRouter.sweep();
    }

    // ============================================================================================ the reward (P2.3)

    /// @notice A third party's Q claims sent to the coordinator before graduation (`qGift`, any time, before or after a
    /// collect) never raise the reward above the minted reserve; graduation forwards exactly them to the receiver,
    /// whose settlement splits them as fees (compared with the same life without the gift); the coordinator keeps
    /// the reward only. T claims (id = T) sent there stay (no path reads them; observed, see the evidence).
    function testFuzz_AUDIT_U2_giftedClaimsNeverRaiseTheRewardAndBecomeFees(uint256 qSeed, uint256 tSeed, bool early)
        public
    {
        uint256 qGift = bound(qSeed, 1, 20 ether);
        uint256 tGift = bound(tSeed, 0, 1e24);
        if (early) {
            _toWindow();
            _giftEthClaims(a.coordinator, qGift);
            _toClosed();
        } else {
            _toClosed();
            _giftEthClaims(a.coordinator, qGift);
        }
        if (tGift != 0) _giftTokenClaims(eoa[3], a.coordinator, tGift);
        uint256 held = pm.balanceOf(a.coordinator, 0);
        uint256 minted = hook.reserveMinted();
        assertEq(held, minted + qGift, "the coordinator holds the reserve and the gift");
        assertEq(coordinator.reserve(), minted, "the reserve view ignores the gift");

        uint256 snap = vm.snapshotState();
        // The control: the same life without the gift (the coordinator's claims set back to the reserve alone; this
        // move exists only to build the control and is rolled back).
        vm.prank(a.coordinator);
        pm.transfer(eoa[7], 0, qGift);
        AuditU2ClaudeGraduation memory g0 = _graduateRecorded(keeper);
        uint256 fees0 = _receiverQFees();
        vm.revertToState(snap);

        AuditU2ClaudeGraduation memory g = _graduateRecorded(keeper);
        uint256 cap = coordinator.rewardCap();
        uint256 expected = minted < cap ? minted : cap;
        if (expected > held) expected = held;
        assertEq(g.reward, expected, "reward == min(reserve minted, 0.1% of R, claims held)");
        assertLe(g.reward, minted, "never above the minted reserve");
        assertEq(g.reward, g0.reward, "the gift changes nothing in the reward");
        assertEq(g.forwarded, held - g.reward, "ClaimsForwarded: every claim beyond the reward");
        assertEq(pm.balanceOf(a.coordinator, 0), g.reward, "the coordinator keeps the reward only");
        assertEq(pm.balanceOf(a.coordinator, uint256(uint160(a.token))), tGift, "T claims: no path moves them");
        assertEq(g.pokeFailures, 0);
        uint256 fees = _receiverQFees();
        // Split in fifteenths with the remainder carried: within 15 wei of the gift.
        assertApproxEqAbs(fees - fees0, qGift, 15, "the receiver split the gift as fees");
        _assertGhostLedger();
    }

    /// @dev Σ the receiver's Q fee outlets so far (FIT, platform, depth) plus its unbooked and carried Q.
    function _receiverQFees() internal view returns (uint256) {
        (uint256 toFit, uint256 toPlatform, uint256 qToDepth,,,,) = receiver.totals();
        return toFit + toPlatform + qToDepth;
    }

    // ============================================================================================ the pool share (P2.4)

    /// @notice BC-043, the whole sentence ("T sent to the coordinator joins the ask or is burned at graduation, never
    /// breaking it"): after a gift of 0 to all of a holder's T, graduation completes with no PokeFailed, every unit of
    /// the coordinator's T (the pool share and the gift) went into the ask or was burned, the coordinator ends with no
    /// T, the pool's Q is still exactly R and the reward is unchanged. Today the code takes the first branch (the share
    /// handed to `migrate` includes the gift, only the ask's rounding is burned: logged); that branch's effect on the
    /// layout and on BC-029 is AUDIT-U2-02. This test holds for either branch. (The U2 brief's P2.4 expects the second.)
    function testFuzz_AUDIT_U2_tSentToTheCoordinatorJoinsTheAskOrIsBurned(uint256 giftSeed) public {
        _toClosed();
        uint256 have = token.balanceOf(eoa[3]);
        uint256 gift = bound(giftSeed, 0, have);
        uint256 snap = vm.snapshotState();
        AuditU2ClaudeGraduation memory g0 = _graduateRecorded(keeper);
        vm.revertToState(snap);
        uint256 share = token.balanceOf(a.coordinator);
        if (gift != 0) _transferT(eoa[3], a.coordinator, gift);
        uint256 supply0 = token.totalSupply();
        AuditU2ClaudeGraduation memory g = _graduateRecorded(keeper);
        assertEq(g.pokeFailures, 0, "never breaking graduation");
        assertEq(g.tokenPulled + g.dustBurned, share + gift, "every unit into the ask or burned");
        assertEq(supply0 - token.totalSupply(), g.dustBurned, "and nothing else burned");
        assertEq(token.balanceOf(a.coordinator), 0, "the coordinator holds no T after graduation");
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE);
        assertEq(g.qFromCurve, raise, "the pool's Q is still R");
        assertEq(g.reward, g0.reward, "the reward does not depend on the gift");
        // Today's branch, logged: the share handed to `migrate` and the ask's rounding.
        uint256 unit = (uint256(_p1()) - TickMath.getSqrtPriceAtTick(BoxSpecV1.MIN_USABLE_TICK)) / (1 << 96) + 2;
        if (g.poolShare == g0.poolShare + gift && g.dustBurned <= unit) {
            emit log_string("U2C|BC-043 branch: the gift joined the ask (only the ask's rounding burned)");
        } else {
            emit log_string("U2C|BC-043 branch: the gift was burned");
        }
        _assertGhostLedger();
    }

    // ============================================================================================ BC-026, BC-028

    /// @notice BC-026 ("in the closing block, in the same transaction as the closing buy"): a closer's partial closing
    /// fill through the launch router and its `graduate()` in one transaction, either right after the buy returns or
    /// from inside the router's refund (the router's lock held): graduation completes with no PokeFailed, the closer is
    /// credited the reward, the router kept exactly the partial fill's tax, the buy conserved, and the tax is swept
    /// afterwards into the hook's claims.
    function testProperty_AUDIT_U2_closeAndGraduateInOneTransaction() public {
        for (uint256 inRefund; inRefund < 2; ++inRefund) {
            uint256 snap = vm.snapshotState();
            _toWindow();
            // A placeholder in the window, so the graduation word is needed (without one the tickets' poke refuses,
            // NoPlaceholders, by design: see the evidence).
            _windowBuy(eoa[3], 0.5 ether);
            _take(eoa[3], 1);
            uint256 pips = launchRouter.taxPips((vm.getBlockTimestamp() - hook.openAt()) / 12);
            AuditU2ClaudeCloser c = new AuditU2ClaudeCloser(launchRouter, coordinator);
            _ghostAddOutside(address(c));
            uint256 r0_ = a.launchRouter.balance;
            uint256 p0 = address(pm).balance;
            vm.deal(address(this), address(this).balance + 300 ether);
            vm.recordLogs();
            c.closeAndGraduate{value: 300 ether}(300 ether, inRefund == 1);
            _assertNoPokeFailed();
            assertTrue(hook.closed() && coordinator.graduated(), "closed and graduated in one transaction");
            assertEq(hook.closedAtBlock(), hook.migratedAtBlock(), "in the closing block");
            assertEq(c.graduatedInRefund(), inRefund == 1, "inside the router's refund when asked");
            assertEq(c.reward(), coordinator.rewardCap(), "the closer is credited the reward");
            assertEq(coordinator.rewardOf(address(c)), c.reward());
            uint256 tax = a.launchRouter.balance - r0_;
            uint256 refund = address(c).balance;
            uint256 spentQ = address(pm).balance - p0;
            assertGt(refund, 0, "a partial closing fill");
            assertEq(300 ether, spentQ + tax + refund, "the buy conserved");
            assertEq(tax, _taxPartial(spentQ, pips), "the partial fill's tax");
            _noteEthIn(EthIn.WindowBuy, 300 ether);
            _noteEthOut(EthOut.Refund, refund);
            _noteTOut(TOut.Buy, c.tokensOut());
            uint256 hook0 = pm.balanceOf(a.hook, 0);
            uint256 swept = launchRouter.sweep();
            assertEq(pm.balanceOf(a.hook, 0) - hook0, swept, "then the tax becomes the hook's claims");
            assertEq(_claimReward(address(c), eoa[1]), c.reward());
            _assertGhostLedger();
            vm.revertToState(snap);
        }
    }

    /// @notice BC-028 ("the graduated layout and the burns are identical for any caller"): from one closed state,
    /// graduation by an EOA, a contract, the 7702 EOA or the keeper gives the same layout, price, burns and reserve;
    /// only the reward's holder differs.
    function testProperty_AUDIT_U2_anyCallerGraduatesIntoTheSameLayout() public {
        _toClosed();
        address[4] memory callers = [eoa[4], address(contractDrawer), eoa7702, keeper];
        bytes32 first;
        for (uint256 i; i < callers.length; ++i) {
            uint256 snap = vm.snapshotState();
            AuditU2ClaudeGraduation memory g = _graduateRecorded(callers[i]);
            (uint128 ask, uint128 bid, uint128 sentinel) = hook.graduatedLayout();
            bytes32 d = keccak256(
                abi.encode(
                    ask, bid, sentinel, _sqrtP(), g.dustBurned, g.tokenPulled, g.qDust, token.totalSupply(), g.reward
                )
            );
            if (i == 0) first = d;
            assertEq(d, first, "the same layout, price, burns and reward for every caller");
            assertEq(coordinator.rewardOf(callers[i]), g.reward, "credited to this caller");
            vm.revertToState(snap);
        }
    }

    // ============================================================================================ never blocked (P2.12)

    /// @notice After any mix of third-party actions before the close and a close of any shape, graduate() with the
    /// runbook's 15,000,000 gas succeeds, every poke succeeds, the price is P1 and the reward is the cap.
    function testFuzz_AUDIT_U2_graduateIsNeverBlockedByThirdParties(uint256 seed) public {
        _toBonding();
        uint256 s = seed;
        // T and claims to the coordinator.
        if (s & 1 != 0) _transferT(eoa[0], a.coordinator, bound(s >> 8, 0, token.balanceOf(eoa[0])));
        if (s & 2 != 0) _giftEthClaims(a.coordinator, bound(s >> 16, 1, 50 ether));
        if (s & 4 != 0) _giftTokenClaims(eoa[1], a.coordinator, bound(s >> 24, 0, token.balanceOf(eoa[1])));
        // Forced ETH into every box address (no code runs), the PoolManager included.
        if (s & 8 != 0) {
            address[12] memory targets = [
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
                a.token,
                address(pm)
            ];
            for (uint256 i; i < targets.length; ++i) {
                _forceEth(targets[i], bound(uint256(keccak256(abi.encode(s, i))), 0, 100 ether));
            }
        }
        // A price pushed back towards P0 first (every outside holder sells all it can).
        if (s & 16 != 0) {
            _sell(eoa[3], token.balanceOf(eoa[3]));
            _sell(eoa[4], token.balanceOf(eoa[4]));
            _sell(address(contractDrawer), token.balanceOf(address(contractDrawer)));
        }
        // The close: to P1, past P1 to the lowest price, or by exact output of every T the curve has left.
        uint256 shape = (s >> 40) % 3;
        if (shape == 0) {
            _closeWith(eoa[2], 3 * raise, _p1());
        } else if (shape == 1) {
            _closeWith(eoa[2], 3 * raise, _minLimit());
        } else {
            _buyExactOut(eoa[2], token.balanceOf(address(pm)) - 1e18, 3 * raise);
            if (!hook.closed()) _closeWith(eoa[2], 3 * raise, _p1());
        }
        assertTrue(hook.closed());
        uint256 heldQ = pm.balanceOf(a.coordinator, 0);
        uint256 shareT = token.balanceOf(a.coordinator);
        vm.recordLogs();
        vm.prank(keeper);
        (bool ok, bytes memory ret) =
            a.coordinator.call{gas: RUNBOOK_GRADUATE_GAS}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        assertTrue(ok, "graduate() with the runbook's gas is never blocked");
        _assertNoPokeFailed();
        assertEq(abi.decode(ret, (uint256)), coordinator.rewardCap(), "the reward is the cap");
        assertEq(_sqrtP(), _p1(), "the price is exactly P1 after migration");
        assertTrue(vault.gateOpen());
        assertTrue(receiver.graduationSettled(), "the receiver settled");
        assertTrue(stream.started(), "the stream started");
        assertTrue(executor.fitGraduated());
        assertEq(pm.balanceOf(a.coordinator, 0), coordinator.rewardCap(), "the coordinator keeps the reward only");
        assertGe(heldQ, coordinator.rewardCap());
        assertGt(shareT, 0);
        assertEq(token.balanceOf(a.coordinator), 0);
        _assertGhostLedger();
    }

    function _assertNoPokeFailed() internal {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == a.coordinator && logs[i].topics.length > 0
                    && logs[i].topics[0] == IBoxCoordinator.PokeFailed.selector
            ) ++n;
        }
        assertEq(n, 0, "no poke failed");
    }

    // ============================================================================================ L7 (P2.16)

    function testProperty_AUDIT_U2_rewardCapIsTheBuildsRaiseOverAThousand() public {
        assertEq(coordinator.raise(), BoxBuildV1.RAISE, "the active build's R");
        assertEq(coordinator.rewardCap(), BoxBuildV1.RAISE * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / 10_000);
        assertEq(coordinator.rewardCap(), 4_206_980_085_000_000, "0.1% of 4.206980085 ETH");
        assertEq(coordinator.rewardCap(), hook.reserveCap(), "the hook's cap is the same");
        assertEq(hook.reserveMinted(), 0, "nothing before the first fee");
        _toBonding();
        assertLe(hook.reserveMinted(), hook.reserveCap());
        _toClosed();
        assertLe(hook.reserveMinted(), hook.reserveCap());
        (uint256 reward,) = _graduate(keeper);
        assertEq(hook.reserveMinted(), hook.reserveCap(), "topped up to the cap by the curve's fees");
        assertEq(reward, hook.reserveCap());
        // The 96-bit amount field of `_r` holds any reward of this build with room: the cap is below 2^52.
        assertLt(coordinator.rewardCap(), uint256(1) << 52);
    }

    /// @notice P2.16 for the rehearsal build (F78; `src/box/build/rehearsal/BoxBuildV1.sol:24`): both caps are read from
    /// the clone's raise argument with BoxSpecV1's 10 bps (`BoxCoordinator.sol:365-367`, `BoxHookBase.sol:182-184`),
    /// never from a build constant, so an EIP-1167 clone of this build's coordinator or hook whose arguments carry the
    /// rehearsal raise answers R / 1,000 of it: 420,698,008,500,000 wei, the runbook's "0.00042 SepETH". (The rehearsal
    /// build's own implementations refuse chain id 1, this world's; their cap code is the same source, F78.)
    function testProperty_AUDIT_U2_rewardCapForTheRehearsalRaise() public {
        uint256 r = RehearsalBuildV1.RAISE;
        assertEq(r, 420_698_008_500_000_000, "the rehearsal raise, 1/10 of the mainnet one");
        CoreImpls memory im = kit.impls();
        // casting to 'uint128' is safe because the raise is below 2^63
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes16 raise16 = bytes16(uint128(r));
        address c = _cloneWithArgs(im.coordinator, abi.encodePacked(bytes21(0), raise16, new bytes(154 - 37)));
        address h = _cloneWithArgs(im.hook, abi.encodePacked(new bytes(127), raise16, new bytes(203 - 143)));
        assertEq(BoxCoordinator(c).raise(), r);
        assertEq(BoxCoordinator(c).rewardCap(), 420_698_008_500_000, "the coordinator's cap: R / 1,000");
        assertEq(BoxHook(h).raise(), r);
        assertEq(BoxHook(h).reserveCap(), BoxCoordinator(c).rewardCap(), "the hook's reserve cap is the same");
        // The same code with the mainnet raise reads this world's cap.
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes16 mainnet16 = bytes16(uint128(raise));
        address cm = _cloneWithArgs(im.coordinator, abi.encodePacked(bytes21(0), mainnet16, new bytes(154 - 37)));
        assertEq(BoxCoordinator(cm).rewardCap(), coordinator.rewardCap());
    }

    function _cloneWithArgs(address impl, bytes memory args) internal returns (address clone) {
        clone = address(uint160(uint256(keccak256(abi.encode("audit.u2.claude.clone", impl, args)))));
        vm.etch(clone, abi.encodePacked(hex"363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3", args));
    }

    /// @notice `_w`'s graduatedAt field (bits 209-248, BoxCoordinator.sol:73-75, :249) holds every timestamp below
    /// 2^40: a graduation at 2^40 − 1 reads back exactly and stays once-only. The measured boundary: 2^40 itself does
    /// not fit 40 bits (see the evidence, no finding: about the year 36,812).
    function testProperty_AUDIT_U2_graduatedAtHoldsEveryTimestampBelowTwoToTheForty() public {
        _toClosed();
        uint256 t = (uint256(1) << 40) - 1;
        vm.warp(t);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        (bool ok,) = a.coordinator.call{gas: RUNBOOK_GRADUATE_GAS}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        assertTrue(ok);
        assertTrue(coordinator.graduated());
        assertEq(coordinator.graduatedAt(), t, "the last timestamp of 40 bits reads back exactly");
        assertEq(uint8(coordinator.phase()), uint8(BoxPhase.Graduated));
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        coordinator.graduate();
        assertEq(coordinator.boxId(), 0, "the box id field is untouched");
        assertEq(coordinator.hook(), a.hook, "and so is the hook");
    }
}

/// @notice The same properties under Amsterdam (Glamsterdam's repricing): graduation's gas and the 15,000,000 of the
/// runbook depend on the fork.
/// forge-config: default.evm_version = "amsterdam"
contract AuditU2ClaudeCoordinatorAmsterdamTest is AuditU2ClaudeCoordinatorTest {}
