// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {ModuleProceedsTo} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRegistry} from "../../../../src/box/interfaces/IBoxRegistry.sol";
import {BoxEncoding} from "../../../../src/box/libraries/BoxEncoding.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {EthIn, EthOut} from "../common/AuditGhostLedger.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";

/// @notice TEST ONLY: several calls (with value) inside one transaction, the outcome of each kept.
contract AuditU9ClaudeWorldMulticall {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    function run(Call[] calldata calls) external payable returns (bool[] memory ok, bytes[] memory ret) {
        ok = new bool[](calls.length);
        ret = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (ok[i], ret[i]) = calls[i].target.call{value: calls[i].value}(calls[i].data);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}

/// @notice TEST ONLY: a keeper's tip recipient that, while it is paid (inside the receiver's guarded `collect` and
/// the PoolManager's unlock), tries every way back into the receiver and records what each attempt answered.
contract AuditU9ClaudeTipThief {
    IPoolManager internal immutable _pm;
    address internal immutable _receiver;
    bool internal _armed;
    bool[6] public ok;
    bytes[6] internal _ret;
    uint256 public receiverEthDuring;

    constructor(IPoolManager pm_, address receiver_) {
        _pm = pm_;
        _receiver = receiver_;
    }

    function arm() external {
        _armed = true;
    }

    function ret(uint256 i) external view returns (bytes memory) {
        return _ret[i];
    }

    receive() external payable {
        if (!_armed) return;
        _armed = false;
        // 0, 1: the hot half's guarded entries; 2, 3: the extension's (forwarded by DELEGATECALL).
        (ok[0], _ret[0]) = _receiver.call(abi.encodeCall(IBoxReceiver.collect, (address(this))));
        (ok[1], _ret[1]) = _receiver.call(abi.encodeCall(IBoxReceiver.fundDepth, ()));
        (ok[2], _ret[2]) = _receiver.call(abi.encodeCall(IBoxReceiver.noteModuleFees, (1, 0)));
        (ok[3], _ret[3]) = _receiver.call(abi.encodeCall(IBoxReceiver.proposeCreatorPayee, (address(this))));
        // 4: the PoolManager callback, called directly.
        (ok[4], _ret[4]) = _receiver.call(abi.encodeWithSignature("unlockCallback(bytes)", abi.encode(uint8(2), "")));
        // 5: the open unlock lets anyone take: 1 wei to the receiver, which the gate accepts (the PoolManager inside the
        // receiver's own guarded call), then settled from the tip so this frame owes nothing.
        try _pm.take(Currency.wrap(address(0)), _receiver, 1) {
            ok[5] = true;
            _pm.settle{value: 1}();
        } catch (bytes memory r) {
            _ret[5] = r;
        }
        receiverEthDuring = _receiver.balance;
    }
}

/// @title AuditU9ClaudeWorldTest (SH-AUDIT-B0-U9, Claude; P9.1, P9.3, P9.6, P9.8, P9.10, P9.11; lenses L1, L3, L6, L8)
/// @notice U9's libraries inside the factory's box 0 (test/box/audit/common: the mainnet build, N 1,969): the
/// registry records keccak256 of the spec's ABI encoding; the live curve and the migrated layout are BoxLayoutV1's to
/// the unit, in the pinned v4 PoolManager's own state; the hook address carries exactly HOOK_FLAGS; the transient lock
/// of the receiver (both halves), FIT's executor and the collection is released after each guarded call and refuses
/// re-entry from a tip payment; the PoolManager callbacks and the receiver's `receive` refuse every caller outside a
/// guarded call; out-of-range enums in calldata revert in the decoder; box 0's rendered metadata parses.
/// forge-config: default.evm_version = "osaka"
contract AuditU9ClaudeWorldTest is AuditPhases {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    bytes4 internal constant REENTRANCY = 0xab143c06;

    AuditU9ClaudeWorldMulticall internal multi;

    function setUp() public virtual override {
        super.setUp();
        multi = new AuditU9ClaudeWorldMulticall();
        vm.label(address(multi), "audit.u9.multicall");
    }

    /// @dev Box 0's spec as the world created it (AuditBox0World._auditSpec at the creation time).
    function _createdSpec() internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = abi.decode(
            vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), AUDIT_SPEC_FILE)), ".encoded"),
            (BoxSpecV1.BoxSpec)
        );
        // casting to 'uint32' is safe because N and openAt are the world's (1,969; a 2026 time)
        // forge-lint: disable-next-line(unsafe-typecast)
        s.n = uint32(editionSize);
        s.revealRoot = AuditRevealSet.root(editionSize);
        // forge-lint: disable-next-line(unsafe-typecast)
        s.openAt = uint32(hook.openAt());
    }

    // ================================================================================================ P9.11, L8

    /// P9.11: the registry records keccak256(abi.encode(spec)) (BoxFactoryV1.sol:236-262, BoxRegistry.sol:72-74), the
    /// coordinator's clone argument is the same hash, and it equals BoxSpecV1.specHash of the spec as created; the
    /// spec passes validate() under version 1's context and template 0's rules with the version's Safe.
    function testProperty_AUDIT_U9_registryRecordsTheSpecHash() public {
        BoxSpecV1.BoxSpec memory s = _createdSpec();
        bytes32 h = BoxSpecV1.specHash(s);
        assertEq(h, keccak256(abi.encode(s)));
        assertEq(coordinator.specHash(), h, "the coordinator's clone argument");
        BoxRegistry registry = BoxRegistry(factory.registry());
        IBoxRegistry.BoxRecord memory r = registry.recordOf(0);
        assertEq(r.specHash, h, "the registry's record");
        assertEq(r.boxId, 0);
        assertEq(r.raise, BoxSpecV1.qListV1()[0].raisePresets[0]);
        (uint16 reason,) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK);
        assertEq(new BoxFactoryV1Planner().refusal(s, safe).length, 0, "template 0");
        // Changing any one field moves the hash (unique per spec): N, the reveal root, openAt.
        s.n += 1;
        assertTrue(BoxSpecV1.specHash(s) != h);
    }

    // ================================================================================================ P9.1, P9.6, L6

    function _poolId() internal view returns (PoolId) {
        return poolKey.toId();
    }

    /// P9.6 at creation: the pool the hook launched holds exactly BoxLayoutV1's curve: the position at the curve's
    /// ticks (salt 0) has the library's liquidity, both ticks are initialised with it, and the active liquidity is it;
    /// BoxLayoutV1.curve(R, T as currency1) is the world's curve; the hook address has exactly HOOK_FLAGS and not the
    /// forbidden 0x91 prefix (BoxSpecV1.sol:37-40).
    function testProperty_AUDIT_U9_liveCurveIsTheLayout() public view {
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raise, BoxLayoutV1.tIsCurrency0(address(token), address(0)));
        BoxLayoutV1.Curve memory w = curve;
        assertEq(keccak256(abi.encode(c)), keccak256(abi.encode(w)), "the library's curve is the world's");
        assertFalse(c.tIsCurrency0, "native ETH is currency0");
        PoolId id = _poolId();
        assertEq(
            pm.getPositionLiquidity(
                id, keccak256(abi.encodePacked(address(hook), c.tickLower, c.tickUpper, bytes32(0)))
            ),
            c.liquidity
        );
        (uint128 grossLower,) = pm.getTickLiquidity(id, c.tickLower);
        (uint128 grossUpper,) = pm.getTickLiquidity(id, c.tickUpper);
        assertEq(grossLower, c.liquidity);
        assertEq(grossUpper, c.liquidity);
        assertEq(pm.getLiquidity(id), c.liquidity, "the curve is the only active liquidity");
        (uint160 sqrtP, int24 tick,,) = pm.getSlot0(id);
        assertLe(sqrtP, c.sqrtPriceStartX96, "at or below P0 after the bootstrap");
        assertGt(sqrtP, c.sqrtPriceEndX96);
        assertTrue(tick < c.tickUpper && tick >= c.tickLower);
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, BoxSpecV1.HOOK_FLAGS, "HOOK_FLAGS");
        assertTrue(uint160(address(hook)) >> 152 != BoxSpecV1.HOOK_FORBIDDEN_ADDRESS_PREFIX);
        // The flags are beforeInitialize, before add and remove liquidity, before and after swap, before donate.
        assertEq(
            BoxSpecV1.HOOK_FLAGS,
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
                | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_DONATE_FLAG
        );
    }

    /// P9.1 / P9.6 / BC-067 at graduation: the curve raised exactly R (the removal returns R and no T at exactly P1),
    /// and the migrated positions are BoxLayoutV1.graduated(ASK_FULL_BID_SENTINEL, R, the pool share) to the unit, in
    /// the PoolManager's own state (salt 1); the T the ask cannot take (`tDust`) is what the coordinator burns, the Q
    /// dust what the receiver gets; the price is exactly P1; the coordinator keeps no T.
    struct Migration {
        uint256 qFromCurve;
        uint256 tFromCurve;
        uint256 askL;
        uint256 bidL;
        uint256 sentinelL;
        uint256 tokenPulled;
        uint256 qDust;
        uint256 poolShare;
        uint256 dustBurned;
    }

    /// @dev IBoxHook.Migrated's data (after the indexed pool id).
    struct MigratedData {
        uint256 qFromCurve;
        uint256 tFromCurve;
        uint128 askL;
        uint128 bidL;
        uint128 sentinelL;
        uint256 tokenPulled;
        uint256 qDust;
    }

    /// @dev IBoxCoordinator.Graduated's data (after the indexed caller).
    struct GraduatedData {
        uint256 blockNumber;
        uint256 poolShare;
        uint256 dust;
        uint256 reward;
    }

    /// @dev The hook's `Migrated` and the coordinator's `Graduated` of one graduation.
    function _migration(VmSafe.Log[] memory logs) internal view returns (Migration memory m) {
        bool seenMigrated;
        bool seenGraduated;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.hook && logs[i].topics[0] == IBoxHook.Migrated.selector) {
                MigratedData memory d = abi.decode(logs[i].data, (MigratedData));
                (m.qFromCurve, m.tFromCurve, m.tokenPulled, m.qDust) =
                (d.qFromCurve, d.tFromCurve, d.tokenPulled, d.qDust);
                (m.askL, m.bidL, m.sentinelL) = (d.askL, d.bidL, d.sentinelL);
                seenMigrated = true;
            }
            if (logs[i].emitter == a.coordinator && logs[i].topics[0] == IBoxCoordinator.Graduated.selector) {
                GraduatedData memory d = abi.decode(logs[i].data, (GraduatedData));
                (m.poolShare, m.dustBurned) = (d.poolShare, d.dust);
                seenGraduated = true;
            }
        }
        require(seenMigrated && seenGraduated, "both events");
    }

    /// P9.1 / P9.6 / BC-067 at graduation: the curve raised exactly R (the removal returns R and no T at exactly P1),
    /// and the migrated positions are BoxLayoutV1.graduated(ASK_FULL_BID_SENTINEL, R, the pool share) to the unit, in
    /// the PoolManager's own state (salt 1); the T the ask cannot take (`tDust`) is what the coordinator burns, the Q
    /// dust what the receiver gets; the price is exactly P1; the coordinator keeps no T.
    function testProperty_AUDIT_U9_liveGraduationIsTheLayout() public {
        _toClosed();
        _warpTo(_requestTimeFor(r0));
        uint256 share = token.balanceOf(a.coordinator);
        uint256 supplyBefore = token.totalSupply();
        vm.recordLogs();
        vm.prank(keeper);
        coordinator.graduate();
        Migration memory m = _migration(vm.getRecordedLogs());
        reached = AuditPhase.Graduated;
        assertEq(m.poolShare, share);
        assertEq(m.qFromCurve, raise, "the curve raised exactly R");
        assertEq(m.tFromCurve, 0, "and holds no T at P1");
        BoxLayoutV1.Graduated memory g = BoxLayoutV1.graduated(
            curve, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, m.qFromCurve, share + m.tFromCurve
        );
        assertEq(m.askL, g.ask.liquidity, "ask");
        assertEq(m.bidL, g.bid.liquidity, "bid");
        assertEq(m.sentinelL, g.sentinel.liquidity, "sentinel");
        assertEq(m.tokenPulled, g.ask.amount - m.tFromCurve);
        assertEq(m.qDust, g.qDust);
        assertEq(m.dustBurned, g.tDust, "the coordinator burns exactly the layout's T dust");
        assertEq(token.balanceOf(a.coordinator), 0);
        assertEq(supplyBefore - token.totalSupply(), m.dustBurned);
        _checkPositions(g);
        _assertGhostLedger();
    }

    function _checkPositions(BoxLayoutV1.Graduated memory g) internal view {
        PoolId id = _poolId();
        BoxLayoutV1.Position[3] memory ps = [g.bid, g.sentinel, g.ask];
        for (uint256 k; k < 3; ++k) {
            bytes32 key =
                keccak256(abi.encodePacked(address(hook), ps[k].tickLower, ps[k].tickUpper, bytes32(uint256(1))));
            assertEq(pm.getPositionLiquidity(id, key), ps[k].liquidity, "the PoolManager's position");
        }
        (uint160 sqrtP,,,) = pm.getSlot0(id);
        assertEq(sqrtP, curve.sqrtPriceEndX96, "exactly P1");
    }

    // ================================================================================================ P9.3: the lock

    function _call(address target, uint256 value, bytes memory data)
        internal
        pure
        returns (AuditU9ClaudeWorldMulticall.Call memory)
    {
        return AuditU9ClaudeWorldMulticall.Call({target: target, value: value, data: data});
    }

    /// P9.3 on box 0's receiver and FIT's executor: guarded calls back to back in one transaction all succeed (the
    /// lock is released each time), and a caught revert inside a guarded call (`collect` below the batch minimum)
    /// leaves the lock released for the next one.
    function testProperty_AUDIT_U9_guardedCallsBackToBackOnBox0() public {
        AuditU9ClaudeWorldMulticall.Call[] memory c = new AuditU9ClaudeWorldMulticall.Call[](7);
        c[0] = _call(a.receiver, 1 gwei, abi.encodeCall(IBoxReceiver.fundDepth, ()));
        c[1] = _call(a.receiver, 2 gwei, abi.encodeCall(IBoxReceiver.fundDepth, ()));
        c[2] = _call(a.receiver, 0, abi.encodeCall(IBoxReceiver.collect, (address(multi))));
        c[3] = _call(a.receiver, 3 gwei, abi.encodeCall(IBoxReceiver.fundDepth, ()));
        c[4] = _call(a.executor, 4 gwei, "");
        c[5] = _call(a.executor, 5 gwei, abi.encodeWithSignature("fundBudget()"));
        c[6] = _call(a.executor, 0, abi.encodeWithSignature("poke()"));
        vm.deal(address(this), 1 ether);
        (bool[] memory ok, bytes[] memory ret) = multi.run{value: 15 gwei}(c);
        assertTrue(ok[0] && ok[1], "two guarded calls in one transaction");
        assertFalse(ok[2]);
        assertEq(bytes4(ret[2]), IBoxReceiver.BatchTooSmall.selector, "collect reverted inside its lock");
        assertTrue(ok[3], "the caught revert left the lock released");
        assertTrue(ok[4] && ok[5] && ok[6], "the executor's guarded receive, fundBudget and poke");
        _noteEthIn(EthIn.FundDepth, 6 gwei);
        _noteEthIn(EthIn.FundBudget, 9 gwei);
        _assertGhostLedger();
    }

    /// P9.3 / L3 (with U4 P4.10): the receiver's two DELEGATECALL halves share one lock. A tip recipient paid inside
    /// `collect` (the receiver's lock held, the PoolManager unlocked) gets Reentrancy() from both halves' guarded entries
    /// (`collect` and `fundDepth` here, `noteModuleFees` and `proposeCreatorPayee` in BoxReceiverExtension) and
    /// NotPoolManager from a direct `unlockCallback`. The one thing it can do through the open unlock is have the
    /// PoolManager pay the receiver 1 wei (the `receive` gate accepts the PoolManager inside the receiver's call) and
    /// settle it itself: a gift that stays the receiver's plain ETH until `fundDepth()` books it as depth (BC-107),
    /// with no ledger or claim of the batch touched.
    function testProperty_AUDIT_U9_tipRecipientCannotReenterEitherHalf() public {
        _toBonding();
        // Fees for a batch above the 0.005 ETH minimum.
        _buy(eoa[3], 0.4 ether);
        _buy(eoa[4], 0.4 ether);
        AuditU9ClaudeTipThief thief = new AuditU9ClaudeTipThief(pm, a.receiver);
        _ghostAddOutside(address(thief));
        thief.arm();
        uint256 e0 = address(thief).balance;
        vm.prank(keeper);
        receiver.collect(address(thief));
        uint256 tip = address(thief).balance + 1 - e0;
        _noteEthOut(EthOut.Tip, tip);
        for (uint256 i; i < 4; ++i) {
            assertFalse(thief.ok(i), "a guarded entry of either half");
            assertEq(thief.ret(i), abi.encodeWithSelector(REENTRANCY), "exactly Reentrancy()");
        }
        assertFalse(thief.ok(4));
        assertEq(bytes4(thief.ret(4)), IBoxReceiver.NotPoolManager.selector);
        assertTrue(thief.ok(5), "the open unlock lets the PoolManager pay the receiver");
        assertEq(thief.receiverEthDuring(), 1);
        assertEq(a.receiver.balance, 1, "a gift: plain ETH, in no ledger");
        _noteEthIn(EthIn.Forced, 1);
        vm.prank(eoa[5]);
        receiver.fundDepth();
        assertEq(a.receiver.balance, 0, "fundDepth booked the gift as depth");
        _assertGhostLedger();
    }

    /// P9.3: every PoolManager callback of box 0 (`unlockCallback` of the coordinator, the launch router, the receiver
    /// and FIT's executor) refuses the PoolManager itself outside the contract's own guarded call, and a stranger
    /// always; the receiver's `receive` refuses ETH from both (EthRefused).
    function testProperty_AUDIT_U9_callbacksRefusedOutsideGuardedCalls() public {
        address[4] memory callees = [a.coordinator, a.launchRouter, a.receiver, a.executor];
        bytes memory data =
            abi.encodeWithSignature("unlockCallback(bytes)", abi.encode(uint8(1), abi.encode(1, address(1))));
        for (uint256 i; i < 4; ++i) {
            for (uint256 who; who < 2; ++who) {
                vm.prank(who == 0 ? address(pm) : eoa[2]);
                (bool ok, bytes memory ret) = callees[i].call(data);
                assertFalse(ok, "refused outside a guarded call");
                assertEq(bytes4(ret), bytes4(keccak256("NotPoolManager()")), "NotPoolManager()");
            }
        }
        vm.deal(address(pm), address(pm).balance + 1);
        vm.prank(address(pm));
        (bool sent, bytes memory err) = a.receiver.call{value: 1}("");
        assertFalse(sent);
        assertEq(err, abi.encodeWithSelector(IBoxReceiver.EthRefused.selector, address(pm)));
        vm.deal(eoa[2], 1);
        vm.prank(eoa[2]);
        (sent, err) = a.receiver.call{value: 1}("");
        assertFalse(sent);
        assertEq(err, abi.encodeWithSelector(IBoxReceiver.EthRefused.selector, eoa[2]));
        vm.deal(address(pm), address(pm).balance - 1);
    }

    /// P9.3 on box 0's collection (its guarded `_transfer`, BoxCollection.sol:684, with the stream as the observer):
    /// two transfers in one transaction both succeed; the observer runs inside the lock each time.
    function testProperty_AUDIT_U9_collectionTransfersBackToBack() public {
        _toDrawing();
        vm.prank(eoa[3]);
        collection.transferFrom(eoa[3], address(multi), itemA);
        vm.prank(eoa[0]);
        collection.transferFrom(eoa[0], address(multi), itemP1);
        AuditU9ClaudeWorldMulticall.Call[] memory c = new AuditU9ClaudeWorldMulticall.Call[](2);
        c[0] = _call(
            a.collection,
            0,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(multi), eoa[1], itemA)
        );
        c[1] = _call(
            a.collection,
            0,
            abi.encodeWithSignature("transferFrom(address,address,uint256)", address(multi), eoa[1], itemP1)
        );
        (bool[] memory ok,) = multi.run(c);
        assertTrue(ok[0] && ok[1], "two guarded transfers in one transaction");
        assertEq(collection.ownerOf(itemA), eoa[1]);
        assertEq(collection.ownerOf(itemP1), eoa[1]);
    }

    /// P9.3 on box 0's launch router (its guarded `buy`, BoxLaunchRouter.sol:157-191): two taxed buys in one
    /// transaction inside the window both succeed.
    function testProperty_AUDIT_U9_routerBuysBackToBack() public {
        _warpTo(hook.openAt() + 3 * SLOT);
        uint256 ts = vm.getBlockTimestamp();
        AuditU9ClaudeWorldMulticall.Call[] memory c = new AuditU9ClaudeWorldMulticall.Call[](2);
        c[0] = _call(
            a.launchRouter,
            0.01 ether,
            abi.encodeWithSignature("buy(uint256,uint256,address,uint256)", 0.01 ether, 1, address(multi), ts)
        );
        c[1] = _call(
            a.launchRouter,
            0.02 ether,
            abi.encodeWithSignature("buy(uint256,uint256,address,uint256)", 0.02 ether, 1, address(multi), ts)
        );
        vm.deal(address(this), 1 ether);
        (bool[] memory ok, bytes[] memory ret) = multi.run{value: 0.03 ether}(c);
        assertTrue(ok[0], "the first taxed buy");
        assertTrue(ok[1], "the second, in the same transaction");
        assertGt(abi.decode(ret[1], (uint256)), 0, "T bought");
    }

    // ================================================================================================ P9.10

    /// P9.10 in calldata: an out-of-range `ModuleProceedsTo` reverts in the ABI decoder (empty revert data) before any
    /// of `moduleProceeds`' logic; an in-range one reaches the logic (box 0 has no swap module: NotModule).
    function testProperty_AUDIT_U9_enumCalldataRefusedBeforeLogic() public {
        bytes4 sel = IBoxReceiver.moduleProceeds.selector;
        for (uint256 v; v < 6; ++v) {
            vm.prank(eoa[2]);
            (bool ok, bytes memory ret) = a.receiver.call(abi.encodeWithSelector(sel, v, uint256(1)));
            assertFalse(ok);
            if (v <= uint256(type(ModuleProceedsTo).max)) {
                assertEq(bytes4(ret), IBoxReceiver.NotModule.selector, "a member reaches the logic");
            } else {
                assertEq(ret.length, 0, "a non-member stops in the decoder");
            }
        }
    }

    // ================================================================================================ P9.8

    /// @dev The JSON inside a `data:application/json;base64,` URI (RFC 4648 decoding, written here: forge has no
    /// base64 decoder).
    function _json(string memory uri) internal pure returns (string memory) {
        bytes memory u = bytes(uri);
        bytes memory prefix = "data:application/json;base64,";
        for (uint256 i; i < prefix.length; ++i) {
            require(u[i] == prefix[i], "a JSON data URI");
        }
        uint256 n = u.length - prefix.length;
        require(n % 4 == 0, "base64 length");
        uint256 pad = n == 0 ? 0 : (u[u.length - 1] == "=" ? (u[u.length - 2] == "=" ? 2 : 1) : 0);
        bytes memory out = new bytes(n / 4 * 3 - pad);
        uint256 o;
        for (uint256 i = prefix.length; i < u.length; i += 4) {
            uint256 v = (_b64(u[i]) << 18) | (_b64(u[i + 1]) << 12) | (_b64(u[i + 2]) << 6) | _b64(u[i + 3]);
            for (uint256 k; k < 3 && o < out.length; ++k) {
                out[o++] = bytes1(uint8(v >> (16 - 8 * k)));
            }
        }
        return string(out);
    }

    function _b64(bytes1 c) internal pure returns (uint256) {
        uint8 x = uint8(c);
        if (x >= 0x41 && x <= 0x5a) return x - 0x41;
        if (x >= 0x61 && x <= 0x7a) return x - 0x61 + 26;
        if (x >= 0x30 && x <= 0x39) return x - 0x30 + 52;
        if (x == 0x2b) return 62;
        if (x == 0x2f) return 63;
        require(x == 0x3d, "a base64 character");
        return 0;
    }

    /// P9.8 on box 0 itself (its table, texts and hidden picture): the hidden JSON of an item in the vault, a revealed
    /// item's tokenURI, a live placeholder's tokenURI (BoxTickets.sol:500-514) and contractURI all decode to JSON that
    /// parses, with the expected fields; tokenURI is exactly base64 of tokenJSON.
    function testProperty_AUDIT_U9_box0MetadataParses() public {
        string memory hidden = _json(collection.tokenURI(editionSize));
        assertEq(hidden, collection.tokenJSON(editionSize));
        assertGt(vm.parseJsonKeys(hidden, "$").length, 3, "an item still in the vault");
        assertEq(vm.parseJsonString(hidden, ".attributes[0].value"), "Not revealed");
        assertEq(
            vm.parseJsonString(hidden, ".image"),
            string.concat("data:image/svg+xml;base64,", vm.toBase64(bytes(collection.hiddenSvg())))
        );
        _toDrawing();
        string memory revealed = _json(collection.tokenURI(itemA));
        assertEq(revealed, collection.tokenJSON(itemA));
        assertGt(vm.parseJsonKeys(revealed, "$").length, 3, "a revealed item");
        assertEq(vm.parseJsonString(revealed, ".name"), string.concat(collection.name(), " #", vm.toString(itemA)));
        assertTrue(vm.keyExistsJson(revealed, ".attributes"));
        // A live placeholder (2 and 3 are eoa[0]'s, 4 and 5 eoa[1]'s).
        string memory p = _json(tickets.tokenURI(2));
        assertEq(vm.parseJsonString(p, ".attributes[0].value"), "Placeholder");
        assertEq(vm.parseJsonString(p, ".name"), tickets.name());
        // P9.5 on box 0 itself (its 3,341-byte test-set table): the views' gas, per token (each a call of its own).
        uint256 g = gasleft();
        collection.tokenURI(itemA);
        emit log_named_uint("box 0: tokenURI gas, a revealed item", g - gasleft());
        g = gasleft();
        collection.tokenURI(editionSize);
        emit log_named_uint("box 0: tokenURI gas, an item in the vault", g - gasleft());
        g = gasleft();
        tickets.tokenURI(2);
        emit log_named_uint("box 0: tokenURI gas, a placeholder", g - gasleft());
        g = gasleft();
        collection.contractURI();
        emit log_named_uint("box 0: contractURI gas", g - gasleft());
        assertEq(collection.metadataTableBytes().length, 3_341, "the Sepolia test set's full table");
        string memory c = _json(collection.contractURI());
        assertEq(vm.parseJsonString(c, ".name"), collection.name());
        assertEq(vm.parseJsonString(c, ".description"), collection.description());
        assertEq(
            vm.parseJsonString(c, ".image"),
            string.concat("ipfs://", BoxEncoding.rawCidV1(collection.collectionCoverSha256()))
        );
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU9ClaudeWorldAmsterdamTest is AuditU9ClaudeWorldTest {}
