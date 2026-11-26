// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm, VmSafe} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {BoxKind, RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxRegistry} from "../../../../src/box/interfaces/IBoxRegistry.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {BoxEncoding} from "../../../../src/box/libraries/BoxEncoding.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {MockWETH} from "../../s45/BoxS45Mocks.sol";
import {ClaimsDuster} from "../../s7/BoxS7Base.sol";
import {AuditU1ClaudeKitBase} from "./AuditU1ClaudeBase.sol";

/// @notice TEST ONLY: a stand-in randomness source that would call back into whatever calls it (L3: the factory's
/// pin checks must refuse it before any box exists).
contract AuditU1ClaudeReentrantSource {
    address public target;

    function setTarget(address t) external {
        target = t;
    }

    fallback() external payable {
        (bool ok,) = target.call(msg.data);
        ok;
    }
}

/// @title AuditU1ClaudeCreateTest
/// @notice SH-AUDIT-B0 U1, lenses L1 (P1.1, P1.2), L2 (P1.3), L3 (P1.7), L4 (P1.8), L6 (P1.10, P1.11) and L8 (P1.16,
/// P1.17) on the factory's box 0 as the deploy script builds it (`AuditU1ClaudeKitBase`), osaka.
/// forge-config: default.evm_version = "osaka"
contract AuditU1ClaudeCreateTest is AuditU1ClaudeKitBase {
    using PoolIdLibrary for PoolKey;

    // ================================================================================================ L1 value flow

    /// P1.1 (`BoxFactoryV1.sol:75-76`, `:240-260` MW_ETH; IBoxFactoryV1 step 2): createBox moves exactly
    /// BOOTSTRAP_ETH, along creator → factory → coordinator.launch → launch router.bootstrap → PoolManager.settle and
    /// nowhere else; afterwards the factory, planner and registry hold what they held before (0), every box 0 address
    /// holds 0 wei, no ERC-6909 claim exists yet, the PoolManager holds exactly the bootstrap more, and the
    /// bootstrap's T (the BoxLaunched figure) is exactly T's burned total.
    function testProperty_AUDIT_U1_createMovesExactlyTheBootstrap() public {
        kit.prepare(_spec());
        CoreBoxAddresses memory a = kit.addresses();
        address[12] memory l = _box0List(factory.box0Addresses(), a.hook);
        uint256 pmBefore = address(pm).balance;
        uint256 kitBefore = address(kit).balance;
        vm.recordLogs();
        vm.startStateDiffRecording();
        kit.create();
        Vm.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // Every value transfer of the transaction, in order.
        address[5] memory path = [address(kit), address(factory), a.coordinator, a.launchRouter, address(pm)];
        uint256 hops;
        for (uint256 i; i < acc.length; ++i) {
            bool frame = acc[i].kind == VmSafe.AccountAccessKind.Call || acc[i].kind == VmSafe.AccountAccessKind.Create;
            if (!frame || acc[i].value == 0 || acc[i].reverted) continue;
            assertEq(acc[i].value, BoxSpecV1.BOOTSTRAP_ETH, "every value hop is the bootstrap");
            assertLt(hops, 4, "four value hops only");
            assertEq(acc[i].accessor, path[hops], "hop from");
            assertEq(acc[i].account, path[hops + 1], "hop to");
            ++hops;
        }
        assertEq(hops, 4, "creator -> factory -> coordinator -> launch router -> PoolManager");
        assertEq(address(kit).balance, kitBefore, "the creator paid exactly the bootstrap it was dealt");
        assertEq(address(pm).balance, pmBefore + BoxSpecV1.BOOTSTRAP_ETH, "the pool took exactly the bootstrap");
        assertEq(address(factory).balance, 0, "factory holds 0 wei");
        assertEq(address(planner).balance, 0, "planner holds 0 wei");
        assertEq(address(registry).balance, 0, "registry holds 0 wei");
        for (uint256 i; i < l.length; ++i) {
            assertEq(l[i].balance, 0, string.concat("0 wei at ", _box0Names()[i]));
            assertEq(pm.balanceOf(l[i], 0), 0, string.concat("no ETH claim at ", _box0Names()[i]));
            if (i != 2) assertEq(pm.balanceOf(l[i], uint256(uint160(a.token))), 0, "no T claim");
        }
        // The bootstrap's T is exactly what was burned (BoxLaunched.bootstrapTokensBurned == T.totalBurned()).
        uint256 burnedFromEvent;
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.coordinator && logs[i].topics[0] == IBoxCoordinator.BoxLaunched.selector) {
                (, burnedFromEvent,,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
                seen = true;
            }
        }
        assertTrue(seen, "BoxLaunched emitted");
        BoxToken t = BoxToken(a.token);
        assertGt(burnedFromEvent, 0, "the bootstrap bought T");
        assertEq(t.totalBurned(), burnedFromEvent, "all of the bootstrap's T burned, nothing else");
        assertEq(t.totalSupply() + t.totalBurned(), BoxSpecV1.ISSUANCE, "one issue");
        assertEq(t.balanceOf(a.coordinator), kit.curve().poolShare, "the coordinator holds the pool share");
        assertEq(t.balanceOf(a.launchRouter), 0, "router holds no T");
        assertEq(
            t.balanceOf(address(pm)) + t.balanceOf(a.coordinator), t.totalSupply(), "T only in the pool or coordinator"
        );
    }

    /// P1.2 (BC-011; `BoxFactoryV1.sol:240-244` "ETH anyone sent to a predicted address must not block the creation";
    /// IBoxLaunchRouter "forced ETH swept with the tax"; IBoxReceiver.fundDepth "the whole ETH balance ... may only
    /// join the depth budget" (BC-107); FitBuybackExecutor `budget() == balance` (money review M10); BoxCoordinator
    /// "Q claims beyond the reserve (a gift) ... the receiver's fees at graduation"; BoxHook "its only balances are its
    /// ERC-6909 claims ... the depth budget"; BoxRoyaltyRouter "accepts any ETH, flushes all of it"): plain ETH and
    /// ERC-6909 ETH claims sent in advance to every address of `box0Addresses()` and to the predicted hook, and WETH to
    /// the royalty router, leave every creation check, ledger and quote of the box as created equal to a control
    /// creation without them (64 views compared, reverts included), and each gift ends where its contract's rule puts
    /// it; the life to graduation runs with no failed poke.
    function testFuzz_AUDIT_U1_prefundedAddressesChangeNothing(uint96 ethDust, uint96 claimDust, uint96 wethDust)
        public
    {
        Gifts memory g = Gifts({
            eth: bound(ethDust, 1, 100 ether),
            claims: bound(claimDust, 1, 100 ether),
            weth: bound(wethDust, 1, 100 ether)
        });
        kit.prepare(_spec());
        CoreBoxAddresses memory a = kit.addresses();
        address[12] memory l = _box0List(factory.box0Addresses(), a.hook);

        uint256 snap = vm.snapshotState();
        kit.create();
        bytes32[] memory control = _fingerprint(a);
        vm.revertToState(snap);

        _giftEverywhere(l, a, g);
        kit.create();
        bytes32[] memory dusted = _fingerprint(a);
        assertEq(dusted.length, control.length, "same views");
        for (uint256 i; i < control.length; ++i) {
            assertEq(dusted[i], control[i], string.concat("view unchanged by the gifts: #", vm.toString(i)));
        }
        _assertGiftsAtCreation(l, a, g);
        kit.toGraduated();
        _assertGiftsAfterGraduation(l, a, g);
    }

    struct Gifts {
        uint256 eth;
        uint256 claims;
        uint256 weth;
    }

    function _giftEverywhere(address[12] memory l, CoreBoxAddresses memory a, Gifts memory g) internal {
        ClaimsDuster duster = new ClaimsDuster(pm);
        vm.deal(address(this), 1_000_000 ether);
        for (uint256 i; i < l.length; ++i) {
            (bool ok,) = payable(l[i]).call{value: g.eth}("");
            assertTrue(ok, "ETH to a codeless address");
            duster.dust{value: g.claims}(l[i], g.claims);
        }
        MockWETH weth = MockWETH(factory.weth());
        weth.deposit{value: g.weth}();
        assertTrue(weth.transfer(a.royaltyRouter, g.weth));
    }

    /// @dev Where the gifts sit at creation, by each contract's own rule.
    function _assertGiftsAtCreation(address[12] memory l, CoreBoxAddresses memory a, Gifts memory g) internal view {
        (uint256 qBudget,) = BoxHook(a.hook).depthBudget();
        assertEq(qBudget, g.claims, "hook: claims are its depth budget");
        assertEq(FitBuybackExecutor(payable(a.executor)).budget(), g.eth, "executor: budget == balance");
        assertEq(FitBuybackExecutor(payable(a.executor)).totalToBudget(), 0, "executor: no credited budget");
        assertEq(BoxCoordinator(a.coordinator).reserve(), 0, "coordinator: the D6 reserve counts no gift");
        assertEq(BoxLaunchRouter(payable(a.launchRouter)).totalTaxCollected(), 0, "router: no gift is tax");
        for (uint256 i; i < l.length; ++i) {
            assertEq(l[i].balance, g.eth, string.concat("ETH stays at ", _box0Names()[i]));
            assertEq(pm.balanceOf(l[i], 0), g.claims, string.concat("claims stay at ", _box0Names()[i]));
        }
    }

    /// @dev The life: graduation with no failed poke; the gifts that have a rule move by it, the others stay.
    function _assertGiftsAfterGraduation(address[12] memory l, CoreBoxAddresses memory a, Gifts memory g) internal {
        assertEq(kit.pokeFailures(), 0, "graduation's pokes all ran");
        assertTrue(BoxCoordinator(a.coordinator).graduated(), "graduated");
        BoxLaunchRouter r = BoxLaunchRouter(payable(a.launchRouter));
        assertEq(r.totalSwept(), r.totalTaxCollected() + g.eth, "router: forced ETH swept with the tax");
        assertEq(a.launchRouter.balance, 0, "router: nothing left");
        assertEq(pm.balanceOf(a.coordinator, 0), 0, "coordinator: claims beyond the reward forwarded");
        assertEq(a.royaltyRouter.balance, 0, "royalty router: flushed");
        assertEq(MockWETH(factory.weth()).balanceOf(a.royaltyRouter), 0, "royalty router: WETH unwrapped, flushed");
        // No exit (the accepted unsolicited-asset class of the money review, M25/M27): plain ETH at contracts that
        // refuse ETH, and claims at contracts that never move their own claims.
        uint256[8] memory stays = [uint256(0), 1, 2, 3, 4, 8, 9, 11];
        for (uint256 k; k < stays.length; ++k) {
            assertEq(l[stays[k]].balance, g.eth, string.concat("ETH has no exit at ", _box0Names()[stays[k]]));
        }
        uint256[9] memory claimsStay = [uint256(1), 2, 3, 4, 6, 7, 8, 9, 10];
        for (uint256 k; k < claimsStay.length; ++k) {
            assertEq(
                pm.balanceOf(l[claimsStay[k]], 0),
                g.claims,
                string.concat("claims have no exit at ", _box0Names()[claimsStay[k]])
            );
        }
        assertEq(a.receiver.balance, g.eth, "receiver: forced ETH waits for fundDepth");
        uint256 depthBefore = _depthHeldQ(a.receiver);
        vm.prank(makeAddr("u1.anyone"));
        BoxReceiver(payable(a.receiver)).fundDepth();
        assertEq(a.receiver.balance, 0, "receiver: fundDepth took the whole balance");
        assertEq(_depthHeldQ(a.receiver), depthBefore, "receiver: after graduation depth goes straight to the hook");
    }

    function _depthHeldQ(address receiver_) internal view returns (uint256 q) {
        (q,) = BoxReceiver(payable(receiver_)).depthHeld();
    }

    /// @dev Every ledger, quote and check view of box 0 right after creation, as (success, keccak256(return data)).
    function _fingerprint(CoreBoxAddresses memory a) internal view returns (bytes32[] memory out) {
        bytes[] memory calls = new bytes[](64);
        address[] memory at = new address[](64);
        uint256 n;
        (at[n], calls[n++]) = (a.coordinator, abi.encodeWithSignature("reserve()"));
        (at[n], calls[n++]) = (a.coordinator, abi.encodeWithSignature("poolShare()"));
        (at[n], calls[n++]) = (a.coordinator, abi.encodeWithSignature("phase()"));
        (at[n], calls[n++]) = (a.coordinator, abi.encodeWithSignature("rewardOf(address)", address(kit)));
        (at[n], calls[n++]) = (a.coordinator, abi.encodeWithSignature("streamStartBalance()"));
        (at[n], calls[n++]) = (a.coordinator, abi.encodeWithSignature("streamStartClaims()"));
        (at[n], calls[n++]) = (a.hook, abi.encodeWithSignature("phase()"));
        (at[n], calls[n++]) = (a.hook, abi.encodeWithSignature("openAt()"));
        (at[n], calls[n++]) = (a.hook, abi.encodeWithSignature("deployBlock()"));
        (at[n], calls[n++]) = (a.hook, abi.encodeWithSignature("reserveMinted()"));
        (at[n], calls[n++]) = (a.hook, abi.encodeWithSignature("curve()"));
        (at[n], calls[n++]) = (a.hook, abi.encodeWithSignature("pairedLiquidity()"));
        (at[n], calls[n++]) = (a.hook, abi.encodeWithSignature("graduatedLayout()"));
        (at[n], calls[n++]) = (a.launchRouter, abi.encodeWithSignature("openAt()"));
        (at[n], calls[n++]) = (a.launchRouter, abi.encodeWithSignature("bootstrapped()"));
        (at[n], calls[n++]) = (a.launchRouter, abi.encodeWithSignature("totalTaxCollected()"));
        (at[n], calls[n++]) = (a.launchRouter, abi.encodeWithSignature("totalSwept()"));
        (at[n], calls[n++]) = (a.launchRouter, abi.encodeWithSignature("quote(uint256)", 1 ether));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("booked()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("fitOwed()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("platformOwed()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("platformHeld()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("fitWaitingT()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("depthHeld()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("creatorOwed()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("hookFeesPending()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("tBurnPending()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("carried()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("platformEpoch()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("graduationSettled()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("totals()"));
        (at[n], calls[n++]) = (a.receiver, abi.encodeWithSignature("moduleFeesPending()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("inside()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("hiddenCount()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("pendingTickets()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("shelfCount()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("gateOpen()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("activeSupply()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("unsolicitedToken()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("supplyFloor()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("quoteWithdraw(uint256)", 1));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("quoteReturn(uint256)", 1));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("quoteTake(uint256)", 1));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("escrowPrincipal()"));
        (at[n], calls[n++]) = (a.vault, abi.encodeWithSignature("escrowSurplus()"));
        (at[n], calls[n++]) = (a.token, abi.encodeWithSignature("totalSupply()"));
        (at[n], calls[n++]) = (a.token, abi.encodeWithSignature("totalBurned()"));
        (at[n], calls[n++]) = (a.token, abi.encodeWithSignature("balanceOf(address)", a.coordinator));
        (at[n], calls[n++]) = (a.token, abi.encodeWithSignature("balanceOf(address)", address(pm)));
        (at[n], calls[n++]) = (a.executor, abi.encodeWithSignature("totalToBudget()"));
        (at[n], calls[n++]) = (a.executor, abi.encodeWithSignature("latestSampleTick()"));
        (at[n], calls[n++]) = (a.executor, abi.encodeWithSignature("oracle()"));
        (at[n], calls[n++]) = (a.executor, abi.encodeWithSignature("graduationSeen()"));
        (at[n], calls[n++]) = (a.tickets, abi.encodeWithSignature("phase()"));
        (at[n], calls[n++]) = (a.tickets, abi.encodeWithSignature("status()"));
        (at[n], calls[n++]) = (a.itemStream, abi.encodeWithSignature("index()"));
        (at[n], calls[n++]) = (a.itemStream, abi.encodeWithSignature("outsideCount()"));
        (at[n], calls[n++]) = (a.itemStream, abi.encodeWithSignature("liabilities()"));
        (at[n], calls[n++]) = (a.itemStream, abi.encodeWithSignature("started()"));
        (at[n], calls[n++]) = (a.collection, abi.encodeWithSignature("balanceOf(address)", a.vault));
        (at[n], calls[n++]) = (a.collection, abi.encodeWithSignature("revealedCount()"));
        (at[n], calls[n++]) = (address(registry), abi.encodeWithSignature("entry(uint256)", 0));
        (at[n], calls[n++]) = (address(registry), abi.encodeWithSignature("recordOf(uint256)", 0));
        (at[n], calls[n++]) = (a.royaltyRouter, abi.encodeWithSignature("destination()"));
        out = new bytes32[](n + 3);
        for (uint256 i; i < n; ++i) {
            (bool ok, bytes memory ret) = at[i].staticcall(calls[i]);
            out[i] = keccak256(abi.encode(ok, ret));
        }
        PoolId id = BoxHook(a.hook).poolId();
        (uint160 sqrtP, int24 tick, uint24 protocolFee, uint24 lpFee) = StateLibrary.getSlot0(pm, id);
        out[n] = keccak256(abi.encode(sqrtP, tick, protocolFee, lpFee));
        out[n + 1] = bytes32(uint256(StateLibrary.getLiquidity(pm, id)));
        out[n + 2] = keccak256(abi.encode(kit.creationGas() > 0));
    }

    // ================================================================================================ L2 access

    /// P1.3 (BC-064, BC-011, BC-034; `BoxFactoryV1.sol:233-239`, IBoxFactoryV1 step 1): createBox succeeds only for
    /// `box0Creator`, once, with exactly BOOTSTRAP_ETH, the pinned executor code hash, a mined salt and a template-0
    /// spec; each refusal names its reason and leaves nothing at any predicted address (no code, no nonce), no record,
    /// the factory's nonce at 2 and no pool; after them all the creator's own call still creates box 0 at the addresses
    /// fixed at the factory's deployment.
    function testProperty_AUDIT_U1_onlyTheCreatorOnceExactValueAndCode() public {
        BoxSpecV1.BoxSpec memory s = _spec();
        bytes32 salt = _mined(s.openAt);
        address hookAt = factory.predictHook(s.openAt, salt);
        assertEq(factory.box0Creator(), address(kit), "the kit is box 0's creator");
        _refuseCallers(s, salt, hookAt);
        _refuseValues(s, salt, hookAt);
        _refuseCodes(s, salt, hookAt);
        _refuseSaltAndSpecs(s, salt, hookAt);

        // The creator's call creates box 0 where the factory fixed it, once.
        (bool ok, bytes memory ret) = _tryCreate(address(kit), s, salt, BoxSpecV1.BOOTSTRAP_ETH, _executorCode());
        assertTrue(ok, "the creator creates box 0");
        (uint256 boxId, address coordinator, address hook) = abi.decode(ret, (uint256, address, address));
        assertEq(boxId, 0);
        assertEq(coordinator, factory.box0Addresses().coordinator, "at the fixed coordinator address");
        assertEq(hook, hookAt, "at the predicted hook");
        assertEq(registry.boxCount(), 1);
        // Once: the same call again is Box0Exists with nothing more created.
        (ok, ret) = _tryCreate(address(kit), s, salt, BoxSpecV1.BOOTSTRAP_ETH, _executorCode());
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(IBoxFactoryV1.Box0Exists.selector), "Box0Exists");
        assertEq(vm.getNonce(address(factory)), 3, "the factory created the registry and box 0 only");
        assertEq(registry.boxCount(), 1, "one record");
    }

    function _refuseCallers(BoxSpecV1.BoxSpec memory s, bytes32 salt, address hookAt) internal {
        // Not the factory itself: Foundry counts a top-level pranked call as a transaction of the pranked account and
        // raises its nonce, which no real caller can do to a contract (it would move box 0's coordinator address).
        address[8] memory strangers = [
            makeAddr("u1.stranger"),
            makeAddr("u1.stranger2"),
            address(planner),
            address(registry),
            address(pm),
            BoxSpecV1.PLATFORM_SAFE_MAINNET,
            impls.coordinator,
            address(this)
        ];
        for (uint256 i; i < strangers.length; ++i) {
            _refused(
                strangers[i],
                s,
                salt,
                BoxSpecV1.BOOTSTRAP_ETH,
                _executorCode(),
                abi.encodeWithSelector(IBoxFactoryV1.NotBox0Creator.selector, strangers[i]),
                hookAt
            );
        }
    }

    function _refuseValues(BoxSpecV1.BoxSpec memory s, bytes32 salt, address hookAt) internal {
        uint256 v = BoxSpecV1.BOOTSTRAP_ETH;
        uint256[5] memory values = [uint256(0), v - 1, v + 1, 2 * v, 1 ether];
        for (uint256 i; i < values.length; ++i) {
            _refused(
                address(kit),
                s,
                salt,
                values[i],
                _executorCode(),
                abi.encodeWithSelector(IBoxFactoryV1.WrongValue.selector, values[i], v),
                hookAt
            );
        }
    }

    /// @dev Executor code: one byte changed, one byte more, one byte less, empty.
    function _refuseCodes(BoxSpecV1.BoxSpec memory s, bytes32 salt, address hookAt) internal {
        bytes memory code = _executorCode();
        bytes memory flipped = bytes.concat(code);
        flipped[100] = bytes1(uint8(flipped[100]) ^ 1);
        bytes memory shorter = new bytes(code.length - 1);
        for (uint256 i; i < shorter.length; ++i) {
            shorter[i] = code[i];
        }
        bytes[4] memory codes = [flipped, bytes.concat(code, hex"00"), shorter, bytes("")];
        for (uint256 i; i < codes.length; ++i) {
            _refused(
                address(kit),
                s,
                salt,
                BoxSpecV1.BOOTSTRAP_ETH,
                codes[i],
                abi.encodeWithSelector(IBoxFactoryV1.ExecutorCodeMismatch.selector, keccak256(codes[i])),
                hookAt
            );
        }
    }

    /// @dev An unmined salt; openAt beyond 14 days; one structural field off template 0 at a time.
    function _refuseSaltAndSpecs(BoxSpecV1.BoxSpec memory s, bytes32 salt, address hookAt) internal {
        bytes32 bad = bytes32(uint256(salt) + 1);
        address badHook = factory.predictHook(s.openAt, bad);
        if (uint160(badHook) & 0x3FFF != 0x2AE0) {
            _refused(
                address(kit),
                s,
                bad,
                BoxSpecV1.BOOTSTRAP_ETH,
                _executorCode(),
                abi.encodeWithSelector(IBoxFactoryV1.HookSaltNotMined.selector, badHook),
                hookAt
            );
        }
        BoxSpecV1.BoxSpec memory x = _spec();
        // forge-lint: disable-next-line(unsafe-typecast)
        x.openAt = uint32(block.timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS + 1);
        _refused(
            address(kit),
            x,
            salt,
            BoxSpecV1.BOOTSTRAP_ETH,
            _executorCode(),
            abi.encodeWithSelector(
                IBoxFactoryV1.OpenAtTooFar.selector, x.openAt, block.timestamp + BoxSpecV1.MAX_OPEN_AHEAD_SECONDS
            ),
            hookAt
        );
        x = _spec();
        x.marketplaceOwner = makeAddr("u1.notTheSafe");
        _refused(
            address(kit),
            x,
            salt,
            BoxSpecV1.BOOTSTRAP_ETH,
            _executorCode(),
            abi.encodeWithSelector(IBoxFactoryV1.NotTemplate0.selector, BoxSpecV1.FIELD_MARKETPLACE_OWNER),
            hookAt
        );
        x = _spec();
        x.qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        bytes memory why = factory.refusal(x, address(kit));
        assertGt(why.length, 0, "another buyers' action is refused");
        _refused(address(kit), x, salt, BoxSpecV1.BOOTSTRAP_ETH, _executorCode(), why, hookAt);
    }

    /// P1.3, fuzzed: any caller other than the creator, any value other than the bootstrap, any salt and any executor
    /// code is refused with nothing created (the creator's exact call is the only one that passes).
    function testFuzz_AUDIT_U1_refusedCreationLeavesNothing(address caller, uint256 value, bytes32 salt, uint8 flip)
        public
    {
        BoxSpecV1.BoxSpec memory s = _spec();
        bytes32 good = _mined(s.openAt);
        address hookAt = factory.predictHook(s.openAt, good);
        value = bound(value, 0, 10 ether);
        bytes memory code = _executorCode();
        if (flip != 0) code[uint256(flip) % code.length] = bytes1(uint8(code[uint256(flip) % code.length]) ^ flip);
        bool exact = caller == address(kit) && value == BoxSpecV1.BOOTSTRAP_ETH && flip == 0
            && uint160(factory.predictHook(s.openAt, salt)) & 0x3FFF == 0x2AE0
            && uint160(factory.predictHook(s.openAt, salt)) >> 152 != 0x91;
        vm.assume(!exact);
        assumeNotForgeAddress(caller);
        assumeNotPrecompile(caller);
        // A pranked top-level call raises the pranked account's nonce in Foundry; no real caller can do that to the
        // factory (it would move box 0's coordinator address), so the factory is not a fuzzed caller.
        vm.assume(caller != address(factory));
        vm.assume(caller != address(0) && (caller.code.length == 0 || caller == address(kit)));
        (bool ok,) = _tryCreate(caller, s, salt, value, code);
        assertFalse(ok, "refused");
        _assertNothingCreated(hookAt, "fuzzed refusal");
        _assertNothingCreated(factory.predictHook(s.openAt, salt), "fuzzed refusal (its own hook)");
    }

    function _refused(
        address caller,
        BoxSpecV1.BoxSpec memory s,
        bytes32 salt,
        uint256 value,
        bytes memory code,
        bytes memory err,
        address hookAt
    ) internal {
        (bool ok, bytes memory ret) = _tryCreate(caller, s, salt, value, code);
        assertFalse(ok, "refused");
        assertEq(ret, err, "with its reason");
        _assertNothingCreated(hookAt, "after a refusal");
        assertEq(_poolPrice(hookAt), 0, "no pool");
    }

    function _poolPrice(address hookAt) internal view returns (uint160 sqrtP) {
        PoolKey memory key = PoolKey(
            Currency.wrap(address(0)), Currency.wrap(factory.box0Addresses().token), 10_000, 60, IHooks(hookAt)
        );
        (sqrtP,,,) = StateLibrary.getSlot0(pm, key.toId());
    }

    // ================================================================================================ L3 reentrancy

    /// P1.7 (IBoxFactoryV1 steps 2-4; `BoxFactoryV1.sol:240-243` "the calls below are to this version's own contracts
    /// and the PoolManager"): every call of the creation transaction, traced, goes only between the creator, the
    /// factory, its planner and registry, box 0's twelve contracts, the version's implementations (only ever by
    /// DELEGATECALL, never in their own context) and the PoolManager: no call reaches WETH, either source, the Safe or any other code; nothing but
    /// the creator calls the factory, nothing but the factory calls the registry or the coordinator's `deploy` and
    /// `launch`, and every PoolManager callback lands on box 0's hook or the unlocking box contract. So no external code
    /// runs inside createBox that could re-enter it.
    function testProperty_AUDIT_U1_noForeignCodeRunsInsideCreation() public {
        kit.prepare(_spec());
        CoreBoxAddresses memory a = kit.addresses();
        address[12] memory l = _box0List(factory.box0Addresses(), a.hook);
        vm.startStateDiffRecording();
        kit.create();
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        uint256 calls;
        for (uint256 i; i < acc.length; ++i) {
            if (_checkCall(acc[i], a, l)) ++calls;
        }
        assertGt(calls, 50, "the trace has the whole creation");
    }

    /// @dev One traced access: false for a non-call; for a call, the edge must be one of the creation's own.
    function _checkCall(VmSafe.AccountAccess memory x, CoreBoxAddresses memory a, address[12] memory l)
        internal
        view
        returns (bool isCall)
    {
        VmSafe.AccountAccessKind k = x.kind;
        isCall = k == VmSafe.AccountAccessKind.Call || k == VmSafe.AccountAccessKind.StaticCall
            || k == VmSafe.AccountAccessKind.DelegateCall || k == VmSafe.AccountAccessKind.CallCode;
        if (!isCall) return false;
        assertTrue(k != VmSafe.AccountAccessKind.CallCode, "no CALLCODE");
        address to = x.account;
        address from = x.accessor;
        if (uint160(to) <= 0x11) return true; // precompiles
        assertTrue(to != factory.weth() && to != a.randomness, "no WETH, no backed source");
        assertTrue(to != DrandSourcePins.ADDRESS_MAINNET, "no DrandSource");
        assertTrue(to != BoxSpecV1.PLATFORM_SAFE_MAINNET, "no Safe");
        if (to == address(factory)) assertEq(from, address(kit), "only the creator calls the factory");
        if (to == address(registry)) assertEq(from, address(factory), "only the factory calls the registry");
        if (to == a.coordinator && x.data.length >= 4) {
            bytes4 sel = bytes4(x.data);
            if (sel == BoxCoordinator.deploy.selector || sel == BoxCoordinator.launch.selector) {
                assertEq(from, address(factory), "only the factory drives the coordinator");
            }
        }
        if (from == address(pm) && k != VmSafe.AccountAccessKind.DelegateCall) {
            assertTrue(_isIn(to, l), "the PoolManager calls back only box 0's contracts");
        }
        bool known = to == address(kit) || to == address(factory) || to == address(planner) || to == address(registry)
            || to == address(pm) || _isIn(to, l) || _isImpl(to);
        assertTrue(known, string.concat("a call to an unknown account: ", vm.toString(to)));
        // A DELEGATECALL's recorded accessor is the delegated frame's msg.sender (the clone's caller), so the
        // property checked is that no implementation ever runs in its own context during the creation.
        if (_isImpl(to)) {
            assertTrue(k == VmSafe.AccountAccessKind.DelegateCall, "implementations run only by delegation");
        }
    }

    /// P1.7, the stand-in half: a source that would call back into its caller is refused by the factory's pin
    /// checks before any box exists, whether it sits at another address or at the pinned address itself.
    function testProperty_AUDIT_U1_reentrantStandInSourcesAreRefused() public {
        AuditU1ClaudeReentrantSource fake = new AuditU1ClaudeReentrantSource();
        IBoxFactoryV1.Implementations memory im = factory.implementations();
        bytes32 h = factory.executorInitCodeHash();
        address w = factory.weth();
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, address(fake)));
        new BoxFactoryV1(pm, im, planner, address(fake), w, BoxSpecV1.PLATFORM_SAFE_MAINNET, address(kit), h);
        // The same code at the pinned address: its code hash is not the pinned one.
        vm.etch(BackedSourcePins.ADDRESS_MAINNET, address(fake).code);
        vm.expectRevert(
            abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, BackedSourcePins.ADDRESS_MAINNET)
        );
        new BoxFactoryV1(
            pm, im, planner, BackedSourcePins.ADDRESS_MAINNET, w, BoxSpecV1.PLATFORM_SAFE_MAINNET, address(kit), h
        );
    }

    function _isIn(address x, address[12] memory l) internal pure returns (bool) {
        for (uint256 i; i < l.length; ++i) {
            if (l[i] == x) return true;
        }
        return false;
    }

    function _isImpl(address x) internal view returns (bool) {
        return x == impls.coordinator || x == impls.hook || x == impls.hookExtension || x == impls.launchRouter
            || x == impls.receiver || x == impls.receiverExtension || x == impls.collection || x == impls.vault
            || x == impls.tickets || x == impls.royaltyRouter || x == impls.itemStream;
    }

    // ================================================================================================ L4 randomness

    /// P1.8 (BC-101, F143; `BoxFactoryV1.sol:50-53`, `:198-201`): box 0's source is exactly the pinned BoxBackedSource
    /// naming the pinned DrandSource; the factory's constructor refuses every other chain state: the DrandSource
    /// itself as box 0's source, a twin of the backed source at another address, other code (and a delegation
    /// designator) at either pinned address, no code at either, and every chain id but 1 and 11155111. The factory's
    /// constructor is the only check: createBox reads no pin, and none is needed after it, because code at a CREATE2
    /// address cannot change (no SELFDESTRUCT in either source, EIP-6780) and an address with code cannot take a 7702
    /// delegation.
    function testProperty_AUDIT_U1_sourcePinsRefuseEveryOtherState() public {
        address backed = BackedSourcePins.ADDRESS_MAINNET;
        address drandAt = DrandSourcePins.ADDRESS_MAINNET;
        assertEq(factory.randomness(), backed, "box 0's source is the pinned backed source");
        assertEq(address(BoxBackedSource(backed).DRAND()), drandAt, "naming the pinned DrandSource");
        assertEq(backed.codehash, BackedSourcePins.CODE_HASH_MAINNET);
        assertEq(drandAt.codehash, DrandSourcePins.CODE_HASH_MAINNET);
        _create();
        assertEq(BoxCoordinator(factory.box0Addresses().coordinator).randomness(), backed, "coordinator");
        assertEq(BoxTickets(factory.box0Addresses().tickets).source(), backed, "tickets");

        IBoxFactoryV1.Implementations memory im = factory.implementations();
        // The DrandSource itself, and a twin of the backed source elsewhere.
        _constructorRefused(im, drandAt, drandAt);
        address twin = makeAddr("u1.twin");
        vm.etch(twin, backed.code);
        _constructorRefused(im, twin, twin);
        // Other code, a delegation designator and no code at the pinned backed address.
        bytes memory keep = backed.code;
        vm.etch(backed, hex"00");
        _constructorRefused(im, backed, backed);
        vm.etch(backed, abi.encodePacked(hex"ef0100", backed));
        _constructorRefused(im, backed, backed);
        vm.etch(backed, "");
        _constructorRefused(im, backed, backed);
        vm.etch(backed, keep);
        // The same at the pinned DrandSource (the backed source pinned, the one it names not).
        bytes memory keepDrand = drandAt.code;
        vm.etch(drandAt, hex"00");
        _constructorRefused(im, backed, drandAt);
        vm.etch(drandAt, abi.encodePacked(hex"ef0100", drandAt));
        _constructorRefused(im, backed, drandAt);
        vm.etch(drandAt, "");
        _constructorRefused(im, backed, drandAt);
        vm.etch(drandAt, keepDrand);
        // Another chain.
        vm.chainId(10);
        _constructorRefused(im, backed, backed);
        vm.chainId(1);
        // Positive control: with every pin intact the constructor passes the source checks and stops at the next
        // check (the coordinator implementation names the deployed factory, not this one).
        address w = factory.weth();
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.ImplementationMiswired.selector, 1));
        new BoxFactoryV1(pm, im, planner, backed, w, BoxSpecV1.PLATFORM_SAFE_MAINNET, address(kit), bytes32(uint256(1)));
    }

    function _constructorRefused(IBoxFactoryV1.Implementations memory im, address source, address named) internal {
        address w = factory.weth();
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, named));
        new BoxFactoryV1(pm, im, planner, source, w, BoxSpecV1.PLATFORM_SAFE_MAINNET, address(kit), bytes32(uint256(1)));
    }

    // ================================================================================================ L6 v4

    /// P1.10 (`BoxFactoryV1.sol:361-366`, BoxSpecV1 HOOK_FLAGS 0x2AE0 and HOOK_FORBIDDEN_ADDRESS_PREFIX 0x91, ADR-0016
    /// checklist item 8): the hook is at `predictHook(openAt, salt)` with exactly the six flags in its low 14 bits
    /// (beforeInitialize, beforeAdd, beforeRemove, beforeSwap, afterSwap, beforeDonate) and no 0x91 prefix, and its
    /// permissions say the same; a 0x2AE0 salt with the 0x91 prefix is refused before anything is created; for the
    /// first three mined salts the prediction is the deployed hook.
    function testProperty_AUDIT_U1_hookFlagsAndPrediction() public {
        BoxSpecV1.BoxSpec memory s = _spec();
        bytes32 initHash = factory.hookInitCodeHash(s.openAt);
        address deployer = factory.box0Addresses().coordinator;
        bytes32[3] memory salts;
        uint256 found;
        for (uint256 k; found < 3; ++k) {
            address h = BoxClones.predict(deployer, bytes32(k), initHash);
            if (uint160(h) & 0x3FFF == 0x2AE0 && uint160(h) >> 152 != 0x91) salts[found++] = bytes32(k);
        }
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            address predicted = factory.predictHook(s.openAt, salts[i]);
            (bool ok, bytes memory ret) =
                _tryCreate(address(kit), s, salts[i], BoxSpecV1.BOOTSTRAP_ETH, _executorCode());
            assertTrue(ok, "a mined salt creates");
            (,, address hook) = abi.decode(ret, (uint256, address, address));
            assertEq(hook, predicted, "predictHook is the deployed hook");
            assertEq(uint160(hook) & 0x3FFF, BoxSpecV1.HOOK_FLAGS, "exactly 0x2AE0");
            assertTrue(uint160(hook) >> 152 != 0x91, "no 0x91 prefix");
            Hooks.Permissions memory p = BoxHook(hook).getHookPermissions();
            assertTrue(p.beforeInitialize && p.beforeAddLiquidity && p.beforeRemoveLiquidity && p.beforeSwap);
            assertTrue(p.afterSwap && p.beforeDonate);
            assertFalse(p.afterInitialize || p.afterAddLiquidity || p.afterRemoveLiquidity || p.beforeSwapReturnDelta);
            assertFalse(p.afterSwapReturnDelta || p.afterDonate || p.afterAddLiquidityReturnDelta);
            assertFalse(p.afterRemoveLiquidityReturnDelta);
            assertEq(BoxCoordinator(deployer).hook(), hook, "the coordinator records it");
            vm.revertToState(snap);
        }
        // The forbidden prefix: mine a 0x2AE0 salt whose hook starts with 0x91 (about 2^22 tries).
        bytes32 forbidden;
        bool hit;
        vm.pauseGasMetering();
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore8(p, 0xff)
            mstore(add(p, 0x01), shl(96, deployer))
            mstore(add(p, 0x35), initHash)
            for { let k := 0 } lt(k, 0x8000000) { k := add(k, 1) } {
                mstore(add(p, 0x15), k)
                let h := and(keccak256(p, 0x55), 0xffffffffffffffffffffffffffffffffffffffff)
                if and(eq(and(h, 0x3fff), 0x2ae0), eq(shr(152, h), 0x91)) {
                    forbidden := k
                    hit := 1
                    break
                }
            }
        }
        vm.resumeGasMetering();
        assertTrue(hit, "a 0x91-prefixed 0x2AE0 salt exists within 2^27 tries");
        address bad = factory.predictHook(s.openAt, forbidden);
        assertEq(uint160(bad) & 0x3FFF, 0x2AE0, "its flags are right");
        assertEq(uint160(bad) >> 152, 0x91, "its prefix is the forbidden one");
        _refused(
            address(kit),
            s,
            forbidden,
            BoxSpecV1.BOOTSTRAP_ETH,
            _executorCode(),
            abi.encodeWithSelector(IBoxFactoryV1.HookSaltNotMined.selector, bad),
            bad
        );
    }

    /// P1.10, fuzzed: a salt whose hook address carries other flag bits (or the 0x91 prefix) is refused before any
    /// state change; predictHook is CREATE2(coordinator, salt, hookInitCodeHash(openAt)) for every salt and openAt.
    function testFuzz_AUDIT_U1_unminedSaltRefusedBeforeAnyState(bytes32 salt, uint32 openAt) public {
        BoxSpecV1.BoxSpec memory s = _spec();
        address predicted = factory.predictHook(s.openAt, salt);
        address deployer = factory.box0Addresses().coordinator;
        assertEq(predicted, vm.computeCreate2Address(salt, factory.hookInitCodeHash(s.openAt), deployer), "CREATE2");
        assertEq(
            factory.predictHook(openAt, salt),
            vm.computeCreate2Address(salt, factory.hookInitCodeHash(openAt), deployer),
            "CREATE2 for any openAt"
        );
        vm.assume(uint160(predicted) & 0x3FFF != 0x2AE0 || uint160(predicted) >> 152 == 0x91);
        _refused(
            address(kit),
            s,
            salt,
            BoxSpecV1.BOOTSTRAP_ETH,
            _executorCode(),
            abi.encodeWithSelector(IBoxFactoryV1.HookSaltNotMined.selector, predicted),
            predicted
        );
    }

    /// P1.11 (`BoxFactoryV1.sol:88-91`, `:503-512`; StateLibrary POOLS_SLOT 6 and LIQUIDITY_OFFSET 3 at 46c68346): the
    /// pool the factory re-reads is the one keyed (native ETH, T, fee 10,000, spacing 60, the hook): the hook's
    /// poolId is PoolIdLibrary.toId of that key, its Slot0 and liquidity read through v4's own StateLibrary are the
    /// factory's reading (lp fee 1%, the tick inside the curve, the curve's liquidity), and no other key a reader could
    /// confuse it with (another fee, a dynamic fee, another spacing, no hook, WETH as currency0) names an initialised
    /// pool.
    function testProperty_AUDIT_U1_poolReadIsTheInitializedPool() public {
        CoreBoxAddresses memory a = _create();
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(a.token), 10_000, 60, IHooks(a.hook));
        PoolId id = key.toId();
        assertEq(PoolId.unwrap(BoxHook(a.hook).poolId()), PoolId.unwrap(id), "the hook's pool id is the key's");
        assertEq(keccak256(abi.encode(BoxHook(a.hook).poolKey())), keccak256(abi.encode(key)), "the hook's key");
        (uint160 sqrtP, int24 tick,, uint24 lpFee) = StateLibrary.getSlot0(pm, id);
        BoxLayoutV1.Curve memory c = kit.curve();
        assertGt(sqrtP, 0, "initialised");
        assertEq(lpFee, BoxSpecV1.LP_FEE, "1%");
        assertTrue(tick >= c.tickLower && tick < c.tickUpper, "inside the curve after the bootstrap");
        assertLt(sqrtP, c.sqrtPriceUpperX96, "below P0 after the bootstrap buy");
        assertEq(StateLibrary.getLiquidity(pm, id), c.liquidity, "the curve's liquidity is active");
        // The factory's own slots.
        bytes32 stateSlot = keccak256(abi.encodePacked(PoolId.unwrap(id), bytes32(uint256(6))));
        assertEq(StateLibrary._getPoolStateSlot(id), stateSlot, "POOLS_SLOT 6");
        assertEq(uint128(uint256(pm.extsload(bytes32(uint256(stateSlot) + 3)))), c.liquidity, "LIQUIDITY_OFFSET 3");
        // Look-alike keys name no pool.
        uint24[3] memory fees = [uint24(3_000), 0x800000, 100];
        for (uint256 i; i < fees.length; ++i) {
            PoolKey memory k2 = PoolKey(key.currency0, key.currency1, fees[i], 60, key.hooks);
            (uint160 p2,,,) = StateLibrary.getSlot0(pm, k2.toId());
            assertEq(p2, 0, "another fee: no pool");
        }
        int24[3] memory spacings = [int24(1), 10, 200];
        for (uint256 i; i < spacings.length; ++i) {
            PoolKey memory k2 = PoolKey(key.currency0, key.currency1, 10_000, spacings[i], key.hooks);
            (uint160 p2,,,) = StateLibrary.getSlot0(pm, k2.toId());
            assertEq(p2, 0, "another spacing: no pool");
        }
        PoolKey memory noHook = PoolKey(key.currency0, key.currency1, 10_000, 60, IHooks(address(0)));
        (uint160 p3,,,) = StateLibrary.getSlot0(pm, noHook.toId());
        assertEq(p3, 0, "no hook: no pool");
        address weth = factory.weth();
        if (weth < a.token) {
            PoolKey memory wk = PoolKey(Currency.wrap(weth), Currency.wrap(a.token), 10_000, 60, key.hooks);
            (uint160 p4,,,) = StateLibrary.getSlot0(pm, wk.toId());
            assertEq(p4, 0, "WETH: no pool");
        }
    }

    /// P1.11, L5 (BC-011 "cannot be front-run"; v4 `Hooks.callHook` at 46c68346: a hook call must return its selector):
    /// nobody can initialise box 0's pool ahead of createBox, so nobody can pick its starting price or make the hook's
    /// launch fail: with the predicted hook still without code, `PoolManager.initialize` of box 0's exact key reverts
    /// (the beforeInitialize flag makes v4 call the empty address and reject its empty answer), at any price; after
    /// the creation a second initialise reverts, and a look-alike key on the same hook reverts in the hook's
    /// `beforeInitialize` (ForeignInitialize).
    function testFuzz_AUDIT_U1_poolCannotBeInitialisedAheadOrBeside(uint160 sqrtPrice, uint24 fee) public {
        sqrtPrice =
            uint160(bound(sqrtPrice, 4_295_128_739, 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341));
        kit.prepare(_spec());
        CoreBoxAddresses memory a = kit.addresses();
        assertEq(a.hook.code.length, 0, "the hook does not exist yet");
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(a.token), 10_000, 60, IHooks(a.hook));
        vm.expectRevert(Hooks.InvalidHookResponse.selector);
        pm.initialize(key, sqrtPrice);
        kit.create();
        vm.expectRevert();
        pm.initialize(key, sqrtPrice);
        fee = uint24(bound(fee, 0, 999_999));
        vm.assume(fee != 10_000);
        PoolKey memory other = PoolKey(Currency.wrap(address(0)), Currency.wrap(a.token), fee, 60, IHooks(a.hook));
        vm.expectRevert();
        pm.initialize(other, sqrtPrice);
        (uint160 p,,,) = StateLibrary.getSlot0(pm, other.toId());
        assertEq(p, 0, "no look-alike pool");
    }

    /// P1.17, the deployment's "present but different" path: `CoreV1Deployment._deploySources` skips a source whenever
    /// its pinned address has code (`code.length != 0`, CoreV1Deployment.sol:198, :215); with other code at the pinned
    /// DrandSource (or the pinned BoxBackedSource) the version's factory refuses in its constructor (SourceNotPinned), so
    /// the deployment fails at the factory step and no factory, registry or box exists.
    function testProperty_AUDIT_U1_presentButDifferentSourceStopsTheDeployment() public {
        address[2] memory pins = [DrandSourcePins.ADDRESS_MAINNET, BackedSourcePins.ADDRESS_MAINNET];
        for (uint256 i; i < 2; ++i) {
            uint256 snap = vm.snapshotState();
            CoreBox0Kit k2 = new CoreBox0Kit();
            vm.etch(pins[i], hex"00");
            vm.expectRevert(bytes("core v1: CREATE failed: BoxFactoryV1 (and its BoxRegistry)"));
            k2.setUpWorld();
            vm.revertToState(snap);
        }
    }

    // ================================================================================================ L8 deployment

    /// P1.16 (`BoxFactoryV1.sol:61-63` "what the planner encodes and no re-read covers ... follows from the planner's
    /// code"; BoxFactoryV1Planner `_collectionArgs`, `_ticketsArgs`, `_codes`; add-ons.v1.json params): every value the
    /// factory does not re-read, read back from the created box's own getters (and, where no getter exists, from the
    /// clone's argument bytes), equals the spec field it came from, decoded here independently of the planner: the
    /// collection's name, symbol, description, hidden description and SVG, external link, banner, cover, generator
    /// hash, royalty rate and destination, royaltyInfo, reveal triggers and unlocker; the tickets' name, symbol and
    /// description; the royalty router's destination; the receiver's stream actions, royalty destination, payee, module
    /// and cap; the coordinator's creator buy and Q; the curve's √P1, √P0, ticks, liquidity and raise in the hook, router
    /// and stream; T's name and symbol; the table's bytes; the registry's record.
    function testProperty_AUDIT_U1_planTrustedFieldsEqualTheSpec() public {
        BoxSpecV1.BoxSpec memory s = _spec();
        CoreBoxAddresses memory a = _create();
        _assertTrustedFields(s, a);
    }

    /// @dev The spec's add-ons decoded here, independently of the planner.
    struct SpecAddOns {
        string[5] placeholders;
        uint16 bps;
        uint8 dest;
        bool royalties;
        bytes32 banner;
        string link;
    }

    function _assertTrustedFields(BoxSpecV1.BoxSpec memory s, CoreBoxAddresses memory a) internal view {
        SpecAddOns memory d = _decodeAddOns(s);
        _assertCollectionTexts(s, a, d);
        _assertCollectionRoyalties(a, d);
        _assertTicketsReceiverCoordinator(s, a, d);
        _assertCurve(s, a);
        _assertRecord(s);
    }

    function _assertCollectionTexts(BoxSpecV1.BoxSpec memory s, CoreBoxAddresses memory a, SpecAddOns memory d)
        internal
        view
    {
        BoxCollection col = BoxCollection(a.collection);
        assertEq(col.name(), s.collectionName, "collection name");
        assertEq(col.symbol(), s.collectionSymbol, "collection symbol");
        assertEq(col.description(), s.description, "collection description");
        assertEq(col.hiddenDescription(), d.placeholders[3], "hidden description (placeholders param 4)");
        assertEq(col.hiddenSvg(), d.placeholders[4], "hidden SVG (placeholders param 5)");
        assertEq(col.externalLink(), d.link, "external link (collection metadata param 3)");
        assertEq(col.bannerSha256(), d.banner, "banner (collection metadata param 1)");
        assertEq(col.collectionCoverSha256(), s.collectionCoverSha256, "collection cover (field 28)");
        assertEq(col.generatorHash(), s.generatorHash, "generator hash");
        assertEq(col.revealRoot(), s.revealRoot, "reveal root");
        assertEq(col.revealTriggers(), 1, "reveal on exit only");
        assertEq(col.revealUnlocker(), address(0), "no unlocker");
        assertEq(col.owner(), s.marketplaceOwner, "owner() is the spec's marketplaceOwner");
        assertEq(col.collectionSize(), s.n, "N");
        assertEq(col.firstId(), s.firstId, "firstId");
        assertEq(col.metadataTableHash(), keccak256(s.metadataTable), "table hash");
        assertEq(col.metadataTableBytes(), s.metadataTable, "table bytes");
        assertEq(a.table.code, bytes.concat(hex"00", s.metadataTable), "the table's data contract is 0x00 ++ table");
        assertEq(
            col.contractURI(),
            string.concat(
                "data:application/json;base64,", BoxEncoding.base64(bytes(_expectedContractJson(s, d.banner, d.link)))
            ),
            "contractURI from the spec's texts and hashes"
        );
    }

    function _assertCollectionRoyalties(CoreBoxAddresses memory a, SpecAddOns memory d) internal view {
        BoxCollection col = BoxCollection(a.collection);
        assertEq(col.royaltyBps(), d.royalties ? d.bps : 0, "royalty rate (royalties param 1)");
        if (!d.royalties) return;
        assertEq(uint8(col.royaltyDestination()), d.dest, "royalty destination (royalties param 2)");
        assertEq(col.royaltyRouter(), a.royaltyRouter, "the router");
        (address to, uint256 amount) = col.royaltyInfo(1, 1 ether);
        assertEq(to, a.royaltyRouter, "royaltyInfo pays the router");
        assertEq(amount, 1 ether * uint256(d.bps) / 10_000, "royaltyInfo at the spec's rate");
        assertTrue(col.supportsInterface(0x2a55205a), "ERC-2981 with the add-on");
        assertEq(uint8(BoxRoyaltyRouter(payable(a.royaltyRouter)).destination()), d.dest, "router destination");
    }

    function _assertTicketsReceiverCoordinator(
        BoxSpecV1.BoxSpec memory s,
        CoreBoxAddresses memory a,
        SpecAddOns memory d
    ) internal view {
        BoxTickets tk = BoxTickets(a.tickets);
        assertEq(tk.name(), d.placeholders[0], "placeholder name (placeholders param 1)");
        assertEq(tk.symbol(), d.placeholders[1], "placeholder symbol (placeholders param 2)");
        assertEq(_ticketsDescription(a.tickets), d.placeholders[2], "placeholder description (placeholders param 3)");
        BoxReceiver r = BoxReceiver(payable(a.receiver));
        assertEq(r.qStream(), s.qStream, "receiver Q stream");
        assertEq(r.tStream(), s.tStream, "receiver T stream");
        assertEq(uint8(r.royaltyDestination()), BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING, "receiver royalty byte");
        assertEq(r.creatorPayee(), s.creatorFeeRecipient, "no creator payee (field 26 zero)");
        assertEq(r.swapModule(), address(0), "no module");
        (uint256 cap,,,,) = r.creatorCap();
        assertEq(cap, 0, "no creator cap");
        BoxCoordinator c = BoxCoordinator(a.coordinator);
        assertEq(c.creatorBuyAmount(), s.creatorBuy, "creator buy (field 27)");
        assertEq(c.q(), s.q, "Q (field 10)");
        assertEq(c.raise(), s.raise, "raise (field 11)");
        assertEq(c.specHash(), keccak256(abi.encode(s)), "spec hash");
        assertEq(BoxToken(a.token).name(), s.tokenName, "T name");
        assertEq(BoxToken(a.token).symbol(), s.tokenSymbol, "T symbol");
        assertEq(BoxVault(a.vault).collectionSize(), s.n, "vault N");
        assertEq(BoxVault(a.vault).firstId(), s.firstId, "vault firstId");
        assertEq(BoxItemStream(a.itemStream).collectionSize(), s.n, "stream N");
        assertEq(BoxItemStream(a.itemStream).firstId(), s.firstId, "stream firstId");
    }

    /// @dev The curve behind the pool's re-read, from BoxLayoutV1 for the spec's raise (not from the planner).
    function _assertCurve(BoxSpecV1.BoxSpec memory s, CoreBoxAddresses memory a) internal view {
        BoxLayoutV1.Curve memory cv = BoxLayoutV1.curve(s.raise, false);
        (int24 lo, int24 hi, uint128 liq) = BoxHook(a.hook).curve();
        assertEq(lo, cv.tickLower, "hook tick lower");
        assertEq(hi, cv.tickUpper, "hook tick upper");
        assertEq(liq, cv.liquidity, "hook liquidity");
        assertEq(BoxHook(a.hook).raise(), s.raise, "hook raise");
        assertEq(_argUint(a.hook, 45, 40, 20), cv.sqrtPriceLowerX96, "hook sqrt P1");
        assertEq(_argUint(a.hook, 45, 60, 20), cv.sqrtPriceUpperX96, "hook sqrt P0");
        assertEq(cv.sqrtPriceLowerX96, TickMath.getSqrtPriceAtTick(cv.tickLower), "sqrt P1 is the tick's");
        assertEq(_argUint(a.hook, 45, 107, 4), s.openAt, "hook openAt argument");
        assertEq(_argUint(a.launchRouter, 45, 81, 20), cv.sqrtPriceLowerX96, "router sqrt P1");
        assertEq(_argUint(a.launchRouter, 45, 101, 4), s.openAt, "router openAt argument");
        assertEq(_argUint(a.tickets, 45, 100, 4), s.openAt, "tickets openAt argument");
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(_argUint(a.itemStream, 45, 140, 3), uint256(uint24(cv.tickLower)), "stream tick lower");
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(_argUint(a.itemStream, 45, 143, 3), uint256(uint24(cv.tickUpper)), "stream tick upper");
        assertEq(FitBuybackExecutor(payable(a.executor)).latestSampleTick(), cv.tickLower, "executor seeded at P1");
    }

    /// @dev The record (BC-012) carries the spec's values and hashes to the stored record hash.
    function _assertRecord(BoxSpecV1.BoxSpec memory s) internal view {
        IBoxRegistry.BoxRecord memory rec = registry.recordOf(0);
        assertEq(rec.specHash, keccak256(abi.encode(s)), "record spec hash");
        assertEq(rec.templateId, factory.templateIdOf(s), "record template id");
        assertEq(rec.q, s.q);
        assertEq(rec.raise, s.raise);
        assertEq(rec.openAt, s.openAt, "record openAt (a time ahead)");
        assertEq(rec.creator, address(kit), "record creator");
        (,,,, bytes32 recordHash) = registry.entry(0);
        assertEq(keccak256(abi.encode(rec)), recordHash, "the rebuilt record hashes to the stored one");
    }

    function _decodeAddOns(BoxSpecV1.BoxSpec memory s) internal pure returns (SpecAddOns memory d) {
        for (uint256 i; i < s.addOns.length; ++i) {
            uint16 id = s.addOns[i].id;
            bytes memory params = s.addOns[i].params;
            if (id == BoxSpecV1.ADD_ON_PLACEHOLDERS) {
                string[5] memory p;
                (p[0], p[1], p[2], p[3], p[4]) = abi.decode(params, (string, string, string, string, string));
                d.placeholders = p;
            } else if (id == BoxSpecV1.ADD_ON_ROYALTIES) {
                (d.bps, d.dest) = abi.decode(params, (uint16, uint8));
                d.royalties = true;
            } else if (id == BoxSpecV1.ADD_ON_COLLECTION_METADATA) {
                (d.banner,, d.link) = abi.decode(params, (bytes32, bytes32[], string));
            }
        }
    }

    /// @dev contractURI's JSON as add-ons.v1.json (add-on 6 "defaults") describes it.
    function _expectedContractJson(BoxSpecV1.BoxSpec memory s, bytes32 banner, string memory link)
        internal
        pure
        returns (string memory json)
    {
        json = string.concat(
            '{"name":"',
            s.collectionName,
            '","symbol":"',
            s.collectionSymbol,
            '","description":"',
            s.description,
            '","image":"ipfs://',
            BoxEncoding.rawCidV1(s.collectionCoverSha256)
        );
        if (banner != bytes32(0)) {
            json = string.concat(json, '","banner_image":"ipfs://', BoxEncoding.rawCidV1(banner));
        }
        if (bytes(link).length != 0) json = string.concat(json, '","external_link":"', link);
        if (s.generatorHash != bytes32(0)) {
            json = string.concat(json, '","generator_hash":"', BoxEncoding.toHexString(s.generatorHash));
        }
        json = string.concat(json, '"}');
    }

    /// @dev The tickets' description text (third argument text; BoxCloneArgs T_TEXTS header).
    function _ticketsDescription(address tk) internal view returns (string memory) {
        uint256 nameLength = _argUint(tk, 45, 140, 1);
        uint256 symbolLength = _argUint(tk, 45, 141, 1);
        uint256 descriptionLength = _argUint(tk, 45, 142, 2);
        return string(_argBytes(tk, 45 + 144 + nameLength + symbolLength, descriptionLength));
    }

    /// @dev `size` bytes at argument offset `offset` of `at`'s clone code (arguments from byte `base`).
    function _argUint(address at, uint256 base, uint256 offset, uint256 size) internal view returns (uint256 v) {
        bytes memory b = _argBytes(at, base + offset, size);
        for (uint256 i; i < size; ++i) {
            v = (v << 8) | uint8(b[i]);
        }
    }

    function _argBytes(address at, uint256 from, uint256 length) internal view returns (bytes memory out) {
        out = new bytes(length);
        assembly ("memory-safe") {
            extcodecopy(at, add(out, 0x20), from, length)
        }
    }

    /// P1.17 (`DrandSourcePins.sol:7-12`, `BackedSourcePins.sol:9-11`; `CoreV1Deployment.sol:193-232`): both pins are
    /// CREATE2(Arachnid deployer, salt, init code) of this compilation's sources: each INIT_CODE_HASH is keccak256 of
    /// the source's creation code, each ADDRESS the CREATE2 address of it (mainnet and Sepolia the same), each
    /// CODE_HASH the runtime's keccak256 and the deployed source's EXTCODEHASH. The deployment skips a source only when
    /// the pinned address has code (`code.length != 0`, not its hash): with other code there ("present but different")
    /// the version's factory refuses in its constructor (SourceNotPinned), so no factory and no box can exist on it.
    function testProperty_AUDIT_U1_sourcePinsAreCreate2OfTheCompiledSources() public view {
        bytes memory dInit = type(DrandSource).creationCode;
        bytes memory bInit = type(BoxBackedSource).creationCode;
        assertEq(keccak256(dInit), DrandSourcePins.INIT_CODE_HASH, "DrandSource init code hash");
        assertEq(keccak256(bInit), BackedSourcePins.INIT_CODE_HASH, "BoxBackedSource init code hash");
        address dAt = vm.computeCreate2Address(DrandSourcePins.SALT, keccak256(dInit), DrandSourcePins.DEPLOYER);
        address bAt = vm.computeCreate2Address(BackedSourcePins.SALT, keccak256(bInit), BackedSourcePins.DEPLOYER);
        assertEq(dAt, DrandSourcePins.ADDRESS_MAINNET, "DrandSource address");
        assertEq(dAt, DrandSourcePins.ADDRESS_SEPOLIA, "the same on Sepolia");
        assertEq(bAt, BackedSourcePins.ADDRESS_MAINNET, "BoxBackedSource address");
        assertEq(bAt, BackedSourcePins.ADDRESS_SEPOLIA, "the same on Sepolia");
        assertEq(DrandSourcePins.CODE_HASH_MAINNET, DrandSourcePins.CODE_HASH_SEPOLIA);
        assertEq(BackedSourcePins.CODE_HASH_MAINNET, BackedSourcePins.CODE_HASH_SEPOLIA);
        assertEq(dAt.codehash, DrandSourcePins.CODE_HASH_MAINNET, "deployed DrandSource code hash");
        assertEq(bAt.codehash, BackedSourcePins.CODE_HASH_MAINNET, "deployed BoxBackedSource code hash");
        assertEq(keccak256(type(DrandSource).runtimeCode), DrandSourcePins.CODE_HASH_MAINNET, "DrandSource runtime");
        assertEq(keccak256(type(BoxBackedSource).runtimeCode), BackedSourcePins.CODE_HASH_MAINNET, "backed runtime");
        assertEq(DrandSourcePins.DEPLOYER, 0x4e59b44847b379578588920cA78FbF26c0B4956C, "Arachnid's deployer");
        assertEq(BackedSourcePins.DEPLOYER, DrandSourcePins.DEPLOYER);
    }
}
