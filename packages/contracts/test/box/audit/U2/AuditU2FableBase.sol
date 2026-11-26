// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {CoreBox0Kit} from "../../conformance/core/CoreBox0Kit.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";
import {AuditPhases} from "../common/AuditPhases.sol";

/// @notice TEST ONLY (SH-AUDIT-B0-U2-F). Mints ERC-6909 Q claims (id 0) on the PoolManager to any address from its own
/// ETH: the stand-in for "a third party transfers Q claims to the coordinator" (P2.3). A plain v4 use: unlock, settle
/// the ETH, mint the claims to `to`.
contract AuditU2FableClaimsMinter is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function mintTo(address to) external payable {
        pm.unlock(abi.encode(to, msg.value));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "minter: pm");
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.mint(to, 0, amount);
        return "";
    }
}

/// @notice TEST ONLY (SH-AUDIT-B0-U2-F). A stranger that calls a box contract's `unlockCallback` from inside its own
/// PoolManager unlock (P2.8: a foreign unlock must not reach the coordinator's or the router's callback).
contract AuditU2FableForeignUnlocker is IUnlockCallback {
    IPoolManager public immutable pm;
    address public target;
    bytes public lastError;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function run(address target_, bytes calldata data) external returns (bytes memory) {
        target = target_;
        return pm.unlock(data);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "foreign: pm");
        (bool ok, bytes memory ret) = target.call(abi.encodeWithSelector(IUnlockCallback.unlockCallback.selector, data));
        require(!ok, "foreign: the target accepted a stranger's unlock");
        lastError = ret;
        return "";
    }
}

/// @notice TEST ONLY (SH-AUDIT-B0-U2-F). A stand-in put at a graduation poke's target with `vm.etch` (its runtime code,
/// immutables included). It answers every selector the coordinator pokes with `mode`: returns, reverts, uses every unit
/// of gas, re-enters the coordinator (`graduate`, `claimReward`), the receiver (`collect`) and the launch router
/// (`sweep`, `buy`), returns 1 MB, or reverts with 1 MB. It writes no storage (an etched contract would alias the
/// target's slots): everything it saw is in its events. `Poked.gasLeft` is `gas()` right after the dispatcher, so
/// (the gas it was given) = gasLeft + the dispatcher's constant cost, calibrated by `calibrate` with a known gas.
contract AuditU2FableHostilePoke {
    enum Mode {
        Ok,
        Revert,
        BurnGas,
        Reenter,
        ReturnBomb,
        RevertBomb
    }

    event Poked(bytes4 selector, uint256 gasLeft);
    event Reentry(bytes4 call, bool ok, bytes4 err);

    Mode public immutable mode;
    address public immutable coordinator;
    address public immutable receiverAddr;
    address public immutable routerAddr;

    constructor(Mode mode_, address coordinator_, address receiver_, address router_) {
        mode = mode_;
        coordinator = coordinator_;
        receiverAddr = receiver_;
        routerAddr = router_;
    }

    receive() external payable {}

    fallback() external payable {
        uint256 g;
        assembly ("memory-safe") {
            g := gas()
        }
        emit Poked(msg.sig, g);
        Mode m = mode;
        if (m == Mode.Ok) return;
        if (m == Mode.Revert) revert("hostile: no");
        if (m == Mode.BurnGas) {
            assembly ("memory-safe") {
                for {} 1 {} {}
            }
        }
        if (m == Mode.Reenter) {
            _reenter(coordinator, abi.encodeCall(IBoxCoordinator.graduate, ()));
            _reenter(coordinator, abi.encodeCall(IBoxCoordinator.claimReward, (address(this))));
            if (receiverAddr != address(this)) {
                _reenter(receiverAddr, abi.encodeWithSignature("collect(address)", address(this)));
            }
            _reenter(routerAddr, abi.encodeCall(IBoxLaunchRouter.sweep, ()));
            _reenter(routerAddr, abi.encodeCall(IBoxLaunchRouter.buy, (0, 0, address(this), block.timestamp)));
            return;
        }
        if (m == Mode.ReturnBomb) {
            assembly ("memory-safe") {
                return(0, 1048576)
            }
        }
        assembly ("memory-safe") {
            revert(0, 1048576)
        }
    }

    function _reenter(address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        emit Reentry(bytes4(data), ok, ret.length >= 4 ? bytes4(ret) : bytes4(0));
    }
}

/// @notice TEST ONLY (SH-AUDIT-B0-U2-F). A launch-router payer whose `receive` (the partial-close refund) re-enters
/// `buy`, `sweep` and `graduate`, recording each outcome in an event; its own refund never fails, so the outer buy's
/// result shows what the lock and the phase rules did to the re-entries (P2.10).
contract AuditU2FableReentrantPayer {
    event Reentry(bytes4 call, bool ok, bytes4 err);

    IBoxLaunchRouter public immutable router;
    IBoxCoordinator public immutable coordinator;
    bool public graduateOnRefund;

    constructor(IBoxLaunchRouter router_, IBoxCoordinator coordinator_) {
        router = router_;
        coordinator = coordinator_;
    }

    function setGraduateOnRefund(bool on) external {
        graduateOnRefund = on;
    }

    function buy(uint256 qIn) external payable returns (uint256) {
        return router.buy{value: qIn}(qIn, 1, address(this), block.timestamp);
    }

    receive() external payable {
        _try(
            address(router), abi.encodeCall(IBoxLaunchRouter.buy, (1 ether, 1, address(this), block.timestamp)), 1 ether
        );
        _try(address(router), abi.encodeCall(IBoxLaunchRouter.sweep, ()), 0);
        if (graduateOnRefund) _try(address(coordinator), abi.encodeCall(IBoxCoordinator.graduate, ()), 0);
    }

    function _try(address target, bytes memory data, uint256 value) private {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        emit Reentry(bytes4(data), ok, ret.length >= 4 ? bytes4(ret) : bytes4(0));
    }
}

/// @title AuditU2FableBase
/// @notice TEST ONLY (SH-AUDIT-B0-U2-F, the Fable auditor of box 0's unit U2: coordinator, launch router, token T).
/// The shared world (`AuditPhases`: the factory's box 0 on the mainnet build, real everything) plus the helpers these
/// suites share: a measured window buy (gross = pool spend + tax + refund, read from balances), claim gifts, poke
/// stand-ins, a `graduate()` probe with a gas cap that reports every poke's budget, and the pool's price.
abstract contract AuditU2FableBase is AuditPhases {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant PIPS = 1_000_000;
    uint256 internal constant POKE_GAS = 2_600_000;
    /// @dev BoxCoordinator's floor at every poke: POKE_GAS + POKE_GAS / 63 + 10,000 (`_POKE_GAS_REQUIRED`).
    uint256 internal constant POKE_FLOOR = POKE_GAS + POKE_GAS / 63 + 10_000;
    /// @dev EIP-7825's transaction gas cap (2^24).
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    /// @dev GAS; PUSH1 0; MSTORE; PUSH1 32; PUSH1 0; LOG0; STOP: logs the gas left after GAS (the gas given, less 2).
    bytes internal constant GAS_LOGGER = hex"5a60005260206000a000";

    AuditU2FableClaimsMinter internal minter;

    /// One measured launch-router buy.
    struct Buy {
        bool ok;
        bytes err;
        uint256 tOut;
        uint256 spent;
        uint256 tax;
        uint256 refund;
        uint256 step;
        uint256 eventTax;
        uint256 eventRefund;
        uint256 eventOut;
        bool closed;
    }

    /// One `graduate()` attempt under a gas cap, reverted after: outcome and what each poke target logged.
    struct Probe {
        bool ok;
        bytes err;
        uint256 pokeFailed;
        uint256 pokeLogs;
        uint256[4] given;
        bool[4] seen;
    }

    function setUp() public virtual override {
        super.setUp();
        minter = new AuditU2FableClaimsMinter(pm);
    }

    /// @notice The world's own `_setUpAuditWorld` (AuditBox0World.sol:157-210, step for step) with two switches the
    /// world has no hook for: `nowOpen` puts 0 (Now) in the spec's openAt (the world's setUp asserts the spec's time,
    /// so it cannot be used for Now), and `prefund` forces that much ETH onto every predicted box address before the
    /// creation transaction (L8: a pre-existing balance at a predicted address must change nothing), booked as Forced.
    function _setUpAuditWorldVariant(bool nowOpen, uint256 prefund) internal {
        _requireEip2537();
        _loadBoxDrand();
        r0 = _localFirst();
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        pm = kit.pm();
        src = kit.source();
        drand = kit.drand();
        factory = kit.factory();
        assertEq(address(src), BackedSourcePins.ADDRESS_MAINNET, "world: the pinned BoxBackedSource");
        assertEq(address(drand), DrandSourcePins.ADDRESS_MAINNET, "world: the pinned DrandSource");
        vm.warp(src.roundTime(r0) - 1 days);
        vm.fee(AUDIT_BASE_FEE);
        _makeActors();
        BoxSpecV1.BoxSpec memory s = _auditSpec();
        if (nowOpen) s.openAt = 0;
        editionSize = s.n;
        raise = s.raise;
        kit.prepare(s);
        createdAt = vm.getBlockTimestamp();
        createdAtBlock = vm.getBlockNumber();
        uint256 forced = prefund == 0 ? 0 : _prefundPredicted(prefund);
        kit.create();
        a = kit.addresses();
        poolKey = kit.poolKey();
        curve = kit.curve();
        coordinator = BoxCoordinator(a.coordinator);
        hook = BoxHook(a.hook);
        launchRouter = BoxLaunchRouter(payable(a.launchRouter));
        receiver = BoxReceiver(payable(a.receiver));
        executor = FitBuybackExecutor(payable(a.executor));
        tickets = BoxTickets(a.tickets);
        vault = BoxVault(a.vault);
        collection = BoxCollection(a.collection);
        stream = BoxItemStream(a.itemStream);
        royaltyRouter = BoxRoyaltyRouter(payable(a.royaltyRouter));
        token = BoxToken(a.token);
        safe = a.platform;
        assertEq(coordinator.raise(), BoxBuildV1.RAISE, "world: the mainnet build's raise");
        assertEq(hook.openAt(), nowOpen ? createdAt + 1 : s.openAt, "world: openAt");
        _labelWorld();
        _bookWorld();
        if (forced != 0) _noteEthIn(EthIn.Forced, forced);
        _assertGhostLedger();
        minter = new AuditU2FableClaimsMinter(pm);
    }

    /// @dev ETH forced onto every predicted box address (the factory's fixed box 0 addresses and the mined hook).
    function _prefundPredicted(uint256 amount) private returns (uint256 forced) {
        address[12] memory predicted = _predictedAddresses();
        for (uint256 i; i < predicted.length; ++i) {
            if (predicted[i] == address(0)) continue;
            assertEq(predicted[i].code.length, 0, "variant: nothing lives at the predicted address yet");
            vm.deal(predicted[i], amount);
            forced += amount;
        }
    }

    function _predictedAddresses() internal view returns (address[12] memory x) {
        IBoxFactoryV1.Box0Addresses memory p = factory.box0Addresses();
        x[0] = p.coordinator;
        x[1] = p.table;
        x[2] = p.token;
        x[3] = p.vault;
        x[4] = p.collection;
        x[5] = p.receiver;
        x[6] = p.launchRouter;
        x[7] = p.executor;
        x[8] = p.tickets;
        x[9] = p.itemStream;
        x[10] = p.royaltyRouter;
        x[11] = kit.addresses().hook;
    }

    /// One graduation as the hook and the coordinator reported it: the `Migrated` event (the curve's Q and T, the
    /// three L7 liquidities, the T pulled from the coordinator, the Q dust to the receiver) and the `Graduated` event
    /// (the T balance handed to `migrate`, the dust burned).
    struct Migrated {
        bool seen;
        uint256 qFromCurve;
        uint256 tFromCurve;
        uint256 askLiquidity;
        uint256 bidLiquidity;
        uint256 sentinelLiquidity;
        uint256 tokenPulled;
        uint256 qDust;
        uint256 sharePassed;
        uint256 dustBurned;
    }

    /// @notice `graduate()` by `caller` (booked like the world's `_graduate`): the reward, the `PokeFailed` count, the
    /// `Migrated` figures and the forwarded claims (`ClaimsForwarded`).
    function _graduateMeasured(address caller)
        internal
        returns (uint256 reward, uint256 pokeFailures, Migrated memory m, uint256 forwarded)
    {
        vm.recordLogs();
        vm.prank(caller);
        reward = coordinator.graduate();
        (pokeFailures, m, forwarded) = _parseGraduation(vm.getRecordedLogs());
    }

    function _parseGraduation(VmSafe.Log[] memory logs)
        internal
        view
        returns (uint256 pokeFailures, Migrated memory m, uint256 forwarded)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            bytes32 t0 = logs[i].topics[0];
            if (logs[i].emitter == a.coordinator && t0 == IBoxCoordinator.PokeFailed.selector) ++pokeFailures;
            if (logs[i].emitter == a.coordinator && t0 == keccak256("ClaimsForwarded(address,uint256)")) {
                forwarded += abi.decode(logs[i].data, (uint256));
            }
            if (logs[i].emitter == a.hook && t0 == IBoxHook.Migrated.selector) m = _decodeMigrated(logs[i].data);
        }
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.coordinator || logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] != IBoxCoordinator.Graduated.selector) continue;
            (, m.sharePassed, m.dustBurned,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
        }
    }

    function _decodeMigrated(bytes memory data) private pure returns (Migrated memory m) {
        uint256[7] memory v = abi.decode(data, (uint256[7]));
        m.seen = true;
        m.qFromCurve = v[0];
        m.tFromCurve = v[1];
        m.askLiquidity = v[2];
        m.bidLiquidity = v[3];
        m.sentinelLiquidity = v[4];
        m.tokenPulled = v[5];
        m.qDust = v[6];
    }

    // ================================================================================================ router

    /// @notice A launch-router buy by `who` (funded with `qIn`), T to `recipient`, every amount read from balances: the
    /// pool's ETH rise is the spend, the router's rise the tax, the payer's ETH back the refund. Booked in the ghost
    /// ledger when it passed.
    function _measuredBuy(address who, uint256 qIn, address recipient, uint256 minOut) internal returns (Buy memory b) {
        _fund(who, qIn);
        Snap memory s0 = _snap(who, recipient);
        b.step = _stepNow();
        vm.recordLogs();
        vm.prank(who);
        try launchRouter.buy{value: qIn}(qIn, minOut, recipient, vm.getBlockTimestamp()) returns (uint256 tOut) {
            b.ok = true;
            b.tOut = tOut;
        } catch (bytes memory err) {
            b.err = err;
        }
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        if (!b.ok) return b;
        _settleBuy(b, s0, who, recipient, qIn);
        _parseTaxedBuy(b, logs, qIn);
    }

    /// Balances around one buy.
    struct Snap {
        uint256 payer;
        uint256 pool;
        uint256 router;
        uint256 recipientT;
    }

    function _snap(address who, address recipient) private view returns (Snap memory s0) {
        s0.payer = who.balance;
        s0.pool = address(pm).balance;
        s0.router = a.launchRouter.balance;
        s0.recipientT = token.balanceOf(recipient);
    }

    function _settleBuy(Buy memory b, Snap memory s0, address who, address recipient, uint256 qIn) private {
        b.spent = address(pm).balance - s0.pool;
        b.tax = a.launchRouter.balance - s0.router;
        b.refund = who.balance + qIn - s0.payer;
        b.closed = hook.closed();
        _noteEthIn(EthIn.WindowBuy, qIn);
        if (b.refund != 0) _noteEthOut(EthOut.Refund, b.refund);
        _noteTChange(s0.recipientT, token.balanceOf(recipient), TIn.Other, TOut.Buy);
    }

    /// @notice The window step of the current block (max when before the open).
    function _stepNow() internal view returns (uint256) {
        uint256 open = launchRouter.openAt();
        uint256 now_ = vm.getBlockTimestamp();
        return now_ >= open ? (now_ - open) / SLOT : type(uint256).max;
    }

    function _parseTaxedBuy(Buy memory b, VmSafe.Log[] memory logs, uint256 qIn) private view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.launchRouter || logs[i].topics[0] != IBoxLaunchRouter.TaxedBuy.selector) continue;
            (uint256 step, uint256 q, uint256 tax, uint256 out, uint256 refund) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
            assertEq(step, b.step, "TaxedBuy.step");
            assertEq(q, qIn, "TaxedBuy.qIn");
            b.eventTax = tax;
            b.eventOut = out;
            b.eventRefund = refund;
        }
    }

    /// @notice ceil(qIn x pips / 10^6), the router's tax rule.
    function _ceilTax(uint256 qIn, uint256 pips) internal pure returns (uint256) {
        if (pips == 0) return 0;
        return (qIn * pips + PIPS - 1) / PIPS;
    }

    /// @notice The tax on a partial fill: ceil(spent x pips / (10^6 - pips)), capped at the gross tax.
    function _partialTax(uint256 qIn, uint256 spent, uint256 pips) internal pure returns (uint256 tax) {
        tax = _ceilTax(qIn, pips);
        uint256 kept = (spent * pips + (PIPS - pips) - 1) / (PIPS - pips);
        if (kept < tax) tax = kept;
    }

    /// @notice A gross that nets at least `net` after the tax at `pips`.
    function _grossFor(uint256 net, uint256 pips) internal pure returns (uint256) {
        return (net * PIPS + (PIPS - pips) - 1) / (PIPS - pips) + 1;
    }

    /// @notice A lower bound of the Q a buy must still put into the curve to reach P1, from the pool's ETH less every
    /// claim (the pool holds the curve's principal plus unharvested LP fees; the curve holds exactly R when fully
    /// crossed, so a net input above this bound plus the fees closes it).
    function _qToP1() internal view returns (uint256) {
        uint256 held = address(pm).balance - pm.balanceOf(a.coordinator, 0) - pm.balanceOf(a.receiver, 0)
            - pm.balanceOf(a.hook, 0);
        return held >= raise ? 0 : raise - held;
    }

    // ================================================================================================ claims

    /// @notice `amount` of fresh ERC-6909 Q claims minted to `to` by the stand-in (outside ETH, booked as `Other`).
    function _giftClaims(address to, uint256 amount) internal {
        vm.deal(address(this), address(this).balance + amount);
        minter.mintTo{value: amount}(to);
        _noteEthIn(EthIn.Other, amount);
    }

    function _claims(address who) internal view returns (uint256) {
        return pm.balanceOf(who, 0);
    }

    function _tClaims(address who) internal view returns (uint256) {
        return pm.balanceOf(who, uint256(uint160(a.token)));
    }

    // ================================================================================================ graduation

    /// @notice The four poke targets in poke order (BoxCoordinator.graduate: receiver, tickets, executor, stream).
    function _pokeTargets() internal view returns (address[4] memory) {
        return [a.receiver, a.tickets, a.executor, a.itemStream];
    }

    /// @notice The runtime code of a hostile poke stand-in in `mode`.
    function _hostileCode(AuditU2FableHostilePoke.Mode mode) internal returns (bytes memory) {
        AuditU2FableHostilePoke h = new AuditU2FableHostilePoke(mode, a.coordinator, a.receiver, a.launchRouter);
        return address(h).code;
    }

    /// @notice Puts `code` at every poke target.
    function _etchPokeTargets(bytes memory code) internal {
        address[4] memory t = _pokeTargets();
        for (uint256 i; i < 4; ++i) {
            vm.etch(t[i], code);
        }
    }

    /// @notice The dispatcher cost of the hostile stand-in: a direct call with a known gas, its `Poked.gasLeft` read.
    function _hostileOverhead(bytes memory code) internal returns (uint256) {
        address probe = address(0xA0D17);
        vm.etch(probe, code);
        vm.recordLogs();
        (bool ok,) = probe.call{gas: 1_000_000}(abi.encodeWithSelector(bytes4(0x12345678)));
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        vm.etch(probe, "");
        require(logs.length != 0, "calibration: no Poked");
        (, uint256 left) = abi.decode(logs[0].data, (bytes4, uint256));
        ok;
        return 1_000_000 - left;
    }

    /// @notice `graduate()` by `caller` with `gasCap`, from a snapshot that is restored afterwards: the outcome, the
    /// coordinator's `PokeFailed` count and, per target, the gas the stand-in logged (`GAS_LOGGER`: + 2 is the gas
    /// given; a hostile stand-in: + its dispatcher overhead).
    function _probe(address caller, uint256 gasCap, uint256 overhead) internal returns (Probe memory p) {
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vm.prank(caller);
        (p.ok, p.err) = a.coordinator.call{gas: gasCap}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        vm.revertToState(snap);
        address[4] memory t = _pokeTargets();
        for (uint256 i; i < logs.length; ++i) {
            _probeLog(p, logs[i], t, overhead);
        }
    }

    function _probeLog(Probe memory p, VmSafe.Log memory l, address[4] memory t, uint256 overhead) private view {
        if (l.emitter == a.coordinator) {
            if (l.topics.length != 0 && l.topics[0] == IBoxCoordinator.PokeFailed.selector) ++p.pokeFailed;
            return;
        }
        for (uint256 j; j < 4; ++j) {
            if (l.emitter != t[j] || p.seen[j]) continue;
            if (l.topics.length == 0 && l.data.length == 32) {
                p.given[j] = abi.decode(l.data, (uint256)) + 2;
            } else if (l.topics.length != 0 && l.topics[0] == AuditU2FableHostilePoke.Poked.selector) {
                (bytes4 sel, uint256 left) = abi.decode(l.data, (bytes4, uint256));
                // Only the coordinator's own pokes (a re-entering stand-in's nested calls carry other selectors).
                if (!_isPokeSelector(sel)) continue;
                p.given[j] = left + overhead;
            } else {
                continue;
            }
            p.seen[j] = true;
            ++p.pokeLogs;
        }
    }

    function _isPokeSelector(bytes4 sel) private pure returns (bool) {
        return sel == IBoxReceiver.onGraduation.selector || sel == IBoxTickets.requestGraduationWord.selector
            || sel == IBoxPriceAverage.poke.selector || sel == IBoxItemStream.onGraduation.selector;
    }

    /// @notice The least gas cap with which `graduate()` passes (bisection from one state; `ample` must pass).
    function _leastGraduate(address caller, uint256 ample, uint256 overhead) internal returns (uint256 hi) {
        uint256 lo = 100_000;
        hi = ample;
        require(_probe(caller, hi, overhead).ok, "least: ample gas graduates");
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            if (_probe(caller, mid, overhead).ok) hi = mid;
            else lo = mid;
        }
    }

    function _gasArgs(bytes memory err) internal pure returns (uint256 left, uint256 required) {
        require(err.length == 68, "GasTooLow data");
        assembly ("memory-safe") {
            left := mload(add(err, 36))
            required := mload(add(err, 68))
        }
    }

    // ================================================================================================ pool

    function _sqrtPrice() internal view returns (uint160 sqrtP) {
        (sqrtP,,,) = pm.getSlot0(poolKey.toId());
    }

    function _selector(bytes memory err) internal pure returns (bytes4 s) {
        if (err.length >= 4) s = bytes4(err);
    }

    function _isAmsterdam() internal view returns (bool) {
        return keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
    }
}
