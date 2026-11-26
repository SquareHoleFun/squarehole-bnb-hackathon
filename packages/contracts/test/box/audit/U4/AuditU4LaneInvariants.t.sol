// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {AuditU4LaneBase} from "./AuditU4LaneBase.sol";
import {CoreBox0Kit} from "../../conformance/core/CoreBox0Kit.sol";
import {EthClaimsMinter, MockWETH} from "../../s45/BoxS45Mocks.sol";
import {ClaimsFunder} from "../../../utils/ClaimsFunder.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";

/// @notice Real factory box 0, seeded at the closed curve after harvesting. Every handler ends with an audit;
/// expected refusals are caught. Ghost next-batch amounts come from deposits, never balance-minus-booked.
/// Graduation alone measures the migration/forwarding arrival, with the receiver poke deliberately refused.
/// Stream deliveries and epoch allocations are independently summed from events, including late epoch-zero credit.
contract AuditU4LaneHandler is AuditU4LaneBase {
    using TransientStateLibrary for IPoolManager;

    uint256 public qInput;
    uint256 public tInput;
    uint256 public qNext;
    uint256 public tNext;
    uint256 public tips;
    uint256 public streamed;
    uint256 public calls;
    uint256 public collects;
    uint256 public feeCalls;
    uint256 public depthCalls;
    uint256 public royaltyPayments;
    uint256 public flushes;
    uint256 public sweeps;
    uint256 public fits;
    uint256 public platforms;
    uint256 public settlements;
    uint256 public lateSettlements;
    uint256 public epochWarps;
    uint256 public rejected;
    uint256 public paidFit;
    uint256 public paidPlatform;
    uint256 public initialFitBudget;
    uint256 public initialSafe;
    mapping(uint256 => uint256) public epochCredits;
    bool public badAccounting;
    bool public badCap;
    bool public badPayout;
    bool public badDelta;
    bool public badDormant;

    constructor(CoreBox0Kit kit_) {
        kit = kit_;
        a = kit.addresses();
        pm = kit.pm();
        r = BoxReceiver(payable(a.receiver));
        coordinator = BoxCoordinator(a.coordinator);
        token = BoxToken(a.token);
        royalty = BoxRoyaltyRouter(payable(a.royaltyRouter));
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
        (uint256 qc, uint256 tc) = r.carried();
        Totals memory t = _totals();
        qInput = t.fit + t.platform + t.depthQ + r.platformHeld() + qc;
        tInput = t.depthT + t.burned + r.tBurnPending() + tc;
        initialFitBudget = FitBuybackExecutor(payable(a.executor)).budget();
        initialSafe = a.platform.balance;
    }

    // Deliberately override the inherited fixture: only the invariant suite creates the world.
    function setUp() public override {}

    function seedClaims(uint96 qSeed, uint96 tSeed) external {
        uint256 q = bound(qSeed, 0, 500 ether);
        uint256 t = bound(tSeed, 0, 1e20);
        uint256 held = token.balanceOf(kit.carol());
        if (t > held) t = held;
        vm.deal(address(this), q);
        minter.mintTo{value: q}(a.receiver);
        if (t != 0) funder.deposit(a.token, kit.carol(), t, a.receiver);
        qInput += q;
        tInput += t;
        qNext += q;
        tNext += t;
        _audit();
    }

    function fees(uint96 seed) external {
        uint256 amount = bound(seed, 0, 500 ether);
        if (_call(a.receiver, abi.encodeCall(IBoxReceiver.fundFees, ()), amount)) {
            qInput += amount;
            ++feeCalls;
        }
        _audit();
    }

    function depth(uint96 seed, uint96 forcedSeed) external {
        uint256 amount = bound(seed, 0, 5 ether);
        uint256 forced = bound(forcedSeed, 0, 1 ether);
        vm.deal(a.receiver, a.receiver.balance + forced);
        uint256 raw = a.receiver.balance;
        uint256 fit = r.fitOwed();
        uint256 p = r.platformOwed() + r.platformHeld();
        bool settled = r.graduationSettled();
        if (_call(a.receiver, abi.encodeCall(IBoxReceiver.fundDepth, ()), amount)) {
            qInput += raw + amount;
            ++depthCalls;
            if (settled && (r.fitOwed() != fit || r.platformOwed() + r.platformHeld() != p)) badPayout = true;
            if (a.receiver.balance != 0) badAccounting = true;
        }
        _audit();
    }

    function royaltyPay(uint96 ethSeed, uint96 wethSeed) external {
        uint256 eth = bound(ethSeed, 0, 250 ether);
        uint256 wrapped = bound(wethSeed, 0, 250 ether);
        vm.deal(address(this), eth + wrapped);
        (bool ok,) = a.royaltyRouter.call{value: eth}("");
        if (!ok) badAccounting = true;
        MockWETH(a.weth).deposit{value: wrapped}();
        MockWETH(a.weth).transfer(a.royaltyRouter, wrapped);
        ++royaltyPayments;
        _audit();
    }

    function royaltyFlush(bool sweep) external {
        uint256 total = a.royaltyRouter.balance + MockWETH(a.weth).balanceOf(a.royaltyRouter);
        bytes memory data =
            sweep ? abi.encodeCall(BoxRoyaltyRouter.sweep, (a.weth)) : abi.encodeCall(BoxRoyaltyRouter.flush, ());
        if (_call(a.royaltyRouter, data, 0)) {
            if (
                !coordinator.graduated() || a.royaltyRouter.balance != 0
                    || MockWETH(a.weth).balanceOf(a.royaltyRouter) != 0
            ) badPayout = true;
            qInput += total;
            if (sweep) ++sweeps;
            else ++flushes;
        } else if (a.royaltyRouter.balance + MockWETH(a.weth).balanceOf(a.royaltyRouter) != total) {
            badAccounting = true;
        }
        _audit();
    }

    function collect() external {
        if (_call(a.receiver, abi.encodeCall(IBoxReceiver.collect, (tipper)), 0)) {
            qNext = 0;
            tNext = 0;
            ++collects;
        }
        _audit();
    }

    function payFit() external {
        uint256 before = FitBuybackExecutor(payable(a.executor)).budget();
        uint256 owed = r.fitOwed();
        bool settled = r.graduationSettled();
        if (_call(a.receiver, abi.encodeCall(IBoxReceiver.payFit, ()), 0)) {
            uint256 received = FitBuybackExecutor(payable(a.executor)).budget() - before;
            paidFit += received;
            ++fits;
            if (!coordinator.graduated() || r.fitOwed() != 0 || (settled && received != owed)) badPayout = true;
        }
        _audit();
    }

    function payPlatform() external {
        uint256 before = a.platform.balance;
        uint256 owed = r.platformOwed();
        bool settled = r.graduationSettled();
        if (_call(a.receiver, abi.encodeCall(IBoxReceiver.payPlatform, ()), 0)) {
            uint256 received = a.platform.balance - before;
            paidPlatform += received;
            ++platforms;
            if (!coordinator.graduated() || r.platformOwed() != 0 || (settled && received != owed)) badPayout = true;
        }
        _audit();
    }

    /// @notice mode 0 settles immediately, 1 settles 60 days+1 late, 2 leaves the poke for a later public call.
    function onGraduation(uint8 mode, uint96 giftSeed) external {
        if (!coordinator.graduated()) {
            uint256 gift = bound(giftSeed, 0, 500 ether);
            vm.deal(address(this), gift);
            minter.mintTo{value: gift}(a.coordinator);
            uint256 qb = pm.balanceOf(a.receiver, 0);
            uint256 tb = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
            vm.mockCallRevert(a.receiver, abi.encodeCall(IBoxReceiver.onGraduation, ()), hex"01");
            (bool ok,) = a.coordinator.call(abi.encodeCall(BoxCoordinator.graduate, ()));
            vm.clearMockedCalls();
            if (!ok) {
                badAccounting = true;
                _audit();
                return;
            }
            uint256 q = pm.balanceOf(a.receiver, 0) - qb;
            uint256 t = pm.balanceOf(a.receiver, uint256(uint160(a.token))) - tb;
            qInput += q;
            tInput += t;
            qNext += q;
            tNext += t;
            if (mode % 3 == 1) vm.warp(block.timestamp + 60 days + 1);
            if (mode % 3 == 2) {
                _audit();
                return;
            }
        }
        _call(a.receiver, abi.encodeCall(IBoxReceiver.onGraduation, ()), 0);
        _audit();
    }

    /// @notice Always monotonic. Each new edge is tested at -1, exact, or +1 second, at most 3 epochs ahead.
    function warpEdge(uint8 epochs, uint8 side) external {
        uint256 g = coordinator.graduatedAt();
        if (g == 0) {
            vm.warp(block.timestamp + 1);
            _audit();
            return;
        }
        uint256 nextEpoch = (block.timestamp - g) / 30 days + 1 + epochs % 3;
        uint256 at = g + nextEpoch * 30 days;
        if (side % 3 == 0) --at;
        if (side % 3 == 2) ++at;
        vm.warp(at);
        ++epochWarps;
        _audit();
    }

    function _call(address target, bytes memory data, uint256 value) internal returns (bool ok) {
        vm.deal(address(this), value);
        bool wasSettled = r.graduationSettled();
        vm.recordLogs();
        (ok,) = target.call{value: value, gas: 3_000_000}(data);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            ++rejected;
            return false;
        }
        if (!wasSettled && r.graduationSettled()) {
            qNext = 0;
            tNext = 0;
            ++settlements;
            if (block.timestamp >= coordinator.graduatedAt() + 30 days) ++lateSettlements;
        }
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.emitter != a.receiver) continue;
            if (l.topics[0] == IBoxReceiver.PlatformCredited.selector) {
                (uint256 kept,, uint256 reported) = abi.decode(l.data, (uint256, uint256, uint256));
                uint256 e = uint256(l.topics[1]);
                epochCredits[e] += kept;
                if (epochCredits[e] > r.PLATFORM_CAP_WEI() || reported != epochCredits[e]) badCap = true;
            } else if (l.topics[0] == IBoxReceiver.Collected.selector) {
                (,,,, uint256 tip) = abi.decode(l.data, (address, uint256, uint256, uint256, uint256));
                tips += tip;
            } else if (
                l.topics[0] == IBoxReceiver.StreamFunded.selector
                    || l.topics[0] == IBoxReceiver.StreamNotifyFailed.selector
            ) {
                streamed += abi.decode(l.data, (uint256));
            }
        }
    }

    function _audit() internal {
        ++calls;
        Totals memory t = _totals();
        (uint256 qc, uint256 tc) = r.carried();
        (uint256 dq, uint256 dt) = r.depthHeld();
        (uint256 qb, uint256 tb) = r.booked();
        if (
            qb != r.fitOwed() + r.platformOwed() + r.platformHeld() + dq + qc || tb != dt + tc
                || pm.balanceOf(a.receiver, 0) != qb + qNext
                || pm.balanceOf(a.receiver, uint256(uint160(a.token))) != tb + tNext
                || token.balanceOf(a.receiver) != r.tBurnPending() || qc >= 15 || tc >= 15
        ) badAccounting = true;
        if (
            t.fit + t.platform + t.depthQ + r.platformHeld() + qc + qNext + tips != qInput
                || t.depthT + t.burned + r.tBurnPending() + streamed + tc + tNext != tInput
        ) badAccounting = true;
        if (
            a.platform.balance != initialSafe + paidPlatform
                || FitBuybackExecutor(payable(a.executor)).budget() != initialFitBudget + paidFit
                || (!coordinator.graduated() && (paidPlatform != 0 || paidFit != 0))
        ) badPayout = true;
        if (pm.isUnlocked() || pm.getNonzeroDeltaCount() != 0) badDelta = true;
        if (
            r.swapModule() != address(0) || r.creatorPayee() != address(0) || r.pendingCreatorPayee() != address(0)
                || t.creatorQ != 0 || t.creatorT != 0
        ) badDormant = true;
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU4LaneInvariants is AuditU4LaneBase {
    AuditU4LaneHandler internal handler;

    function setUp() public override {
        super.setUp();
        _closed();
        handler = new AuditU4LaneHandler(kit);
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = handler.seedClaims.selector;
        selectors[1] = handler.fees.selector;
        selectors[2] = handler.depth.selector;
        selectors[3] = handler.royaltyPay.selector;
        selectors[4] = handler.royaltyFlush.selector;
        selectors[5] = handler.collect.selector;
        selectors[6] = handler.payFit.selector;
        selectors[7] = handler.payPlatform.selector;
        selectors[8] = handler.onGraduation.selector;
        selectors[9] = handler.warpEdge.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    /// @notice BC-015/016/017/107/118/139, F77: two-asset conservation and exact books plus ghost next batch.
    function invariant_AUDIT_U4_accountingAfterEveryCall() public view {
        assertFalse(handler.badAccounting());
    }

    /// @notice BC-106/107, F62/F65: aggregate every allocation event by its origin epoch, including late settlement.
    function invariant_AUDIT_U4_capAcrossEveryPath() public view {
        assertFalse(handler.badCap());
        assertFalse(handler.badPayout());
    }

    /// @notice BC-100/109/130: no dormant payee/module acquires funds; every receiver unlock is balanced and closed.
    function invariant_AUDIT_U4_noDeltaOrDormantRole() public view {
        assertFalse(handler.badDelta());
        assertFalse(handler.badDormant());
    }

    /// @notice Non-vacuity sequence: every action succeeds where eligible; both flush modes, all edge offsets,
    /// coordinator forwarding, and late settlement are covered even independently of the random campaign.
    function testProperty_AUDIT_U4_handlerCoverage() public {
        handler.seedClaims(1 ether, 1e18);
        handler.collect();
        handler.fees(300 ether);
        handler.depth(1 ether, 1 ether);
        handler.royaltyPay(1 ether, 2 ether);
        handler.royaltyFlush(false); // graduation gate, funds retained
        handler.payFit();
        handler.payPlatform();
        handler.onGraduation(1, 300 ether);
        handler.royaltyFlush(false);
        handler.royaltyPay(1 ether, 2 ether);
        handler.royaltyFlush(true);
        handler.seedClaims(1 ether, 1e18);
        handler.collect();
        handler.payFit();
        handler.payPlatform();
        for (uint8 side; side < 3; ++side) {
            handler.warpEdge(0, side);
            handler.fees(300 ether);
            handler.payPlatform();
        }
        invariant_AUDIT_U4_accountingAfterEveryCall();
        invariant_AUDIT_U4_capAcrossEveryPath();
        invariant_AUDIT_U4_noDeltaOrDormantRole();
        assertEq(handler.settlements(), 1);
        assertEq(handler.lateSettlements(), 1);
        assertEq(handler.collects(), 2);
        assertEq(handler.flushes(), 1);
        assertEq(handler.sweeps(), 1);
        assertEq(handler.epochWarps(), 3);
        assertGt(handler.fits(), 0);
        assertGt(handler.platforms(), 0);
    }

    function afterInvariant() external view {
        console.log("handler calls", handler.calls());
        console.log("collects / fee calls", handler.collects(), handler.feeCalls());
        console.log("depth / royalty payments", handler.depthCalls(), handler.royaltyPayments());
        console.log("flushes / sweeps", handler.flushes(), handler.sweeps());
        console.log("FIT / Safe payouts", handler.fits(), handler.platforms());
        console.log("settlements / late", handler.settlements(), handler.lateSettlements());
        console.log("epoch warps / caught refusals", handler.epochWarps(), handler.rejected());
    }
}
