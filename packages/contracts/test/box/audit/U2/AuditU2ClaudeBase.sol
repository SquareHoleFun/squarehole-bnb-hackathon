// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {EthIn, EthOut, TIn, TOut} from "../common/AuditGhostLedger.sol";

/// @notice TEST ONLY (SH-AUDIT-B0 U2, Claude). A third party's ERC-6909 claims on the PoolManager: ETH it pays in (or
/// T it holds) settled in its own unlock and minted as claims to any address (`to`), the way anyone can hand claims to
/// box 0's coordinator, hook or receiver. Plain code; no box contract is replaced.
contract AuditU2ClaudeClaimGifter is IUnlockCallback {
    IPoolManager public immutable pm;

    error OnlyPoolManager(address caller);

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @notice ETH claims (id 0) worth `msg.value`, minted to `to`.
    function giftEthClaims(address to) external payable {
        pm.unlock(abi.encode(uint8(0), to, address(0), msg.value));
    }

    /// @notice `amount` of `token` (held here) settled into the PoolManager and minted to `to` as claims.
    function giftTokenClaims(address token, address to, uint256 amount) external {
        pm.unlock(abi.encode(uint8(1), to, token, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(pm)) revert OnlyPoolManager(msg.sender);
        (uint8 kind, address to, address token, uint256 amount) = abi.decode(data, (uint8, address, address, uint256));
        if (kind == 0) {
            pm.sync(Currency.wrap(address(0)));
            pm.settle{value: amount}();
            pm.mint(to, 0, amount);
        } else {
            pm.sync(Currency.wrap(token));
            (bool ok,) = token.call(abi.encodeWithSelector(0xa9059cbb, address(pm), amount));
            require(ok, "gifter: T transfer");
            pm.settle();
            pm.mint(to, uint256(uint160(token)), amount);
        }
        return "";
    }

    receive() external payable {}
}

/// @notice TEST ONLY. A payer of the launch router whose `receive` re-enters `buy` (P2.10): it records the inner call's
/// revert data and accepts the refund, so the outer buy completes and the lock's answer can be read.
contract AuditU2ClaudeReentrantBuyer {
    IBoxLaunchRouter public immutable router;
    bytes public innerRevert;
    bool public innerSucceeded;
    uint256 public receipts;

    constructor(IBoxLaunchRouter router_) {
        router = router_;
    }

    function buy(uint256 qIn, address recipient) external payable returns (uint256) {
        return router.buy{value: qIn}(qIn, 1, recipient, block.timestamp);
    }

    receive() external payable {
        ++receipts;
        if (receipts > 1) return;
        uint256 v = address(this).balance;
        try router.buy{value: v}(v, 1, address(this), block.timestamp) {
            innerSucceeded = true;
        } catch (bytes memory err) {
            innerRevert = err;
        }
    }
}

/// @notice TEST ONLY. Holds the PoolManager unlocked (a third party's unlock) and, inside its own callback, makes the
/// PoolManager's address call `target.unlockCallback(data)` (P2.8: "a call from the PoolManager during someone else's
/// unlock"). Cheatcodes are reachable from any contract in forge's EVM; this is the only way to model it.
contract AuditU2ClaudeForeignUnlocker is IUnlockCallback {
    VmSafe private constant VM = VmSafe(address(uint160(uint256(keccak256("hevm cheat code")))));
    IPoolManager public immutable pm;
    bytes public lastRevert;
    bool public lastSucceeded;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function run(address target, bytes calldata inner) external {
        pm.unlock(abi.encode(target, inner));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "foreign: pm");
        (address target, bytes memory inner) = abi.decode(data, (address, bytes));
        _prank(address(pm));
        (bool ok, bytes memory ret) =
            target.call(abi.encodeWithSelector(IUnlockCallback.unlockCallback.selector, inner));
        lastSucceeded = ok;
        lastRevert = ret;
        return "";
    }

    function _prank(address who) private {
        (bool ok,) = address(VM).call(abi.encodeWithSignature("prank(address)", who));
        require(ok, "foreign: prank");
    }
}

/// @notice TEST ONLY. The control for `AuditU2ClaudeForeignUnlocker`: records who called its `unlockCallback`, so a test
/// shows the call really came with the PoolManager's address.
contract AuditU2ClaudeSenderProbe {
    address public lastSender;

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        lastSender = msg.sender;
        return "";
    }
}

/// @notice TEST ONLY. The behaviour a graduation poke target is given in the re-entering mode (P2.9): run by
/// DELEGATECALL from the target's own address (its storage, its arguments), it tries `graduate()`, `claimReward`,
/// the receiver's `collect` and the launch router's `sweep` from inside the poke, logs each answer, then runs the
/// target's real poke (`real`, the original implementation or a copy of its code) and returns its result.
contract AuditU2ClaudeReenterer {
    event AuditU2ClaudeReentry(bytes4 indexed call, bool ok, bytes4 err);

    IBoxCoordinator public immutable coordinator;
    IBoxReceiver public immutable receiver;
    IBoxLaunchRouter public immutable launchRouter;
    address public immutable real;
    bytes4 public immutable pokeSelector;

    constructor(IBoxCoordinator c, IBoxReceiver r, IBoxLaunchRouter lr, address real_, bytes4 pokeSelector_) {
        coordinator = c;
        receiver = r;
        launchRouter = lr;
        real = real_;
        pokeSelector = pokeSelector_;
    }

    fallback(bytes calldata data) external payable returns (bytes memory) {
        if (msg.sig == pokeSelector) {
            _try(IBoxCoordinator.graduate.selector, address(coordinator), abi.encodeCall(IBoxCoordinator.graduate, ()));
            _try(
                IBoxCoordinator.claimReward.selector,
                address(coordinator),
                abi.encodeCall(IBoxCoordinator.claimReward, (address(this)))
            );
            _try(
                IBoxReceiver.collect.selector, address(receiver), abi.encodeCall(IBoxReceiver.collect, (address(this)))
            );
            _try(IBoxLaunchRouter.sweep.selector, address(launchRouter), abi.encodeCall(IBoxLaunchRouter.sweep, ()));
        }
        (bool ok, bytes memory ret) = real.delegatecall(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    function _try(bytes4 what, address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        bytes4 err;
        if (!ok && ret.length >= 4) err = bytes4(ret);
        emit AuditU2ClaudeReentry(what, ok, err);
    }
}

/// @notice TEST ONLY. A closer that buys through the launch router in the window (a partial closing fill) and calls
/// `graduate()` in the same transaction (BC-026): right after its buy returns, or from inside the router's refund
/// (`receive`, while the router's own lock is held). It keeps the refund and the T, and pulls its reward on request.
contract AuditU2ClaudeCloser {
    IBoxLaunchRouter public immutable router;
    IBoxCoordinator public immutable coordinator;
    bool public graduateInRefund;
    bool public graduatedInRefund;
    uint256 public reward;
    uint256 public tokensOut;

    constructor(IBoxLaunchRouter router_, IBoxCoordinator coordinator_) {
        router = router_;
        coordinator = coordinator_;
    }

    function closeAndGraduate(uint256 qIn, bool inRefund) external payable {
        graduateInRefund = inRefund;
        tokensOut = router.buy{value: qIn}(qIn, 1, address(this), block.timestamp);
        if (!inRefund) reward = coordinator.graduate();
    }

    receive() external payable {
        if (graduateInRefund && !graduatedInRefund) {
            graduatedInRefund = true;
            reward = coordinator.graduate();
        }
    }
}

/// @notice One launch-router buy, measured from the outside: the payer's, the router's and the PoolManager's ETH and
/// the recipient's T before and after, beside what the router's `TaxedBuy` event says.
struct AuditU2ClaudeBuy {
    bool ok;
    bytes err;
    uint256 qIn;
    uint256 step;
    uint256 pips;
    uint256 tokensOut;
    /// PoolManager ETH delta (the swap's input that entered the pool).
    uint256 spent;
    /// Router ETH delta (the tax kept).
    uint256 tax;
    /// Payer ETH delta over the call, plus qIn (what came back).
    uint256 refund;
    /// The recipient's T delta.
    uint256 tDelivered;
    bool closedBefore;
    bool closedAfter;
    /// From the event (zero when it reverted).
    uint256 eventTax;
    uint256 eventRefund;
    uint256 eventStep;
}

/// @notice A probe of `graduate()` at one gas limit, run inside a snapshot that is rolled back afterwards.
struct AuditU2ClaudeProbe {
    bool ok;
    bytes err;
    uint256 used;
    /// The gas each logged poke target was given (logged value + 2), in the order the targets first logged.
    uint256[] given;
    address[] givenTo;
    uint256 pokeFailures;
    uint256 reentries;
    uint256 reentriesRefusedByLock;
    bool graduated;
    bool settled;
    bool wordRequested;
    bool executorGraduated;
    bool streamStarted;
    uint256 reward;
    /// `_graduationDigest()` right after the call, before the rollback.
    bytes32 digest;
    /// F126's baseline as the coordinator recorded it, and the two balances it snapshots, read after the call.
    uint256 baselineBalance;
    uint256 baselineClaims;
    uint256 streamT;
    uint256 receiverTClaims;
}

/// @notice What one successful `graduate()` reported in its events (the hook's `Migrated`, the coordinator's
/// `Graduated` and `ClaimsForwarded`, the `PokeFailed` count).
struct AuditU2ClaudeGraduation {
    uint256 reward;
    uint256 pokeFailures;
    uint256 qFromCurve;
    uint256 tFromCurve;
    uint128 askLiquidity;
    uint128 bidLiquidity;
    uint128 sentinelLiquidity;
    uint256 tokenPulled;
    uint256 qDust;
    uint256 poolShare;
    uint256 dustBurned;
    uint256 forwarded;
}

/// @notice One BC-029 round trip on the factory's box 0 (the GraduationForcing scenario as
/// `test/box/s45/BoxHookCurve.t.sol:393-415` runs it on a mock coordinator): the forcer buys to exactly P1 through the
/// Universal Router stand-in (closing the curve), sends `gift` of the T it bought to the coordinator (0: none),
/// calls `graduate()` and sells every T it still holds into the graduated layout, all in one block.
struct AuditU2ClaudeForcing {
    /// The Q the curve position held before the attack.
    uint256 qBefore;
    /// ETH the closing buy took (the 1% pool fee included) and the T it bought.
    uint256 paid;
    uint256 tBought;
    uint256 gift;
    /// ETH the sell returned; cost = paid − received (BC-029's figure; the D6 reward is not netted).
    uint256 received;
    uint256 cost;
    /// The Q left in box 0's graduated positions after the sell (BC-029's "pool's Q after").
    uint256 poolQAfter;
    uint128 ask;
    uint128 bid;
    uint128 sentinel;
    uint256 reward;
}

/// @title AuditU2ClaudeBase
/// @notice TEST ONLY (SH-AUDIT-B0 U2, Claude). The R0-A world (`AuditPhases`: the factory's box 0 on the mainnet build)
/// plus what unit U2 (coordinator, launch router, token T) needs: measured launch-router buys, a third party's claims,
/// and stand-ins for the four graduation poke targets that log the gas each was given.
/// - **Logged real targets** (`_etchLoggedReal`): the target keeps its behaviour. A clone's code becomes a 45-byte head
///   (GAS; jump to a tail placed after its arguments), its own arguments unchanged at offset 45 (so the implementation
///   still reads them with `EXTCODECOPY(address(), 45 + offset)`), 33 zero bytes, and the tail: if the selector is the
///   poke's, LOG0 the gas the CALL gave (the GAS opcode's value; given = logged + 2), then DELEGATECALL the original
///   implementation with every other byte unchanged. A full contract (FIT's executor) keeps a copy of its code at a fresh
///   address and gets GAS plus the same tail. Static calls (views) are not logged, so they keep working.
/// - **Hostile targets** (`_etchHostile`): GAS, LOG0, then revert, burn every unit of gas, return 1 MB or revert with
///   1 MB. They answer every call that way (a view call to one reverts).
/// - **Re-entering targets** (`_etchReenter`): the logged head and tail forwarding to `AuditU2ClaudeReenterer`.
/// These are stand-ins by design (plan § 1 "World": the property is how the coordinator treats a callee that reverts,
/// re-enters, uses all its gas or returns a large buffer); nothing in `src` is replaced except the code at the four
/// poke addresses, and only in the tests that say so.
abstract contract AuditU2ClaudeBase is AuditPhases {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    uint256 internal constant POKE_GAS = 2_600_000;
    /// @dev BoxCoordinator `_POKE_GAS_REQUIRED` (`BoxCoordinator.sol:121`): POKE_GAS + POKE_GAS / 63 + 10,000.
    uint256 internal constant POKE_FLOOR = POKE_GAS + POKE_GAS / 63 + 10_000;
    /// @dev EIP-7825's transaction gas cap.
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    /// @dev The runbook's graduation gas (docs/runbooks/sepolia-core-v1.md:595, "Keep 15000000").
    uint256 internal constant RUNBOOK_GRADUATE_GAS = 15_000_000;
    uint256 internal constant PIPS = 1_000_000;

    bytes internal constant CLONE_PREFIX = hex"363d3d373d3d3d363d73";
    /// GAS; PUSH0; MSTORE; PUSH1 32; PUSH0; LOG0 (logs the gas left after GAS).
    bytes internal constant LOG_GAS = hex"5a5f5260205fa0";

    enum HostileMode {
        Revert,
        BurnAll,
        ReturnBomb,
        RevertBomb
    }

    AuditU2ClaudeClaimGifter internal gifter;
    /// The four poke targets in the coordinator's order (BoxCoordinator.sol:287-291).
    address[4] internal pokeTargets;
    bytes4[4] internal pokeSelectors;
    /// Set once any target answers every call with its hostile behaviour: its views are not read any more.
    bool internal hostileTargets;

    function setUp() public virtual override {
        super.setUp();
        _setUpU2();
    }

    /// @notice What this unit adds to the world (also called by a test that builds the world itself).
    function _setUpU2() internal {
        gifter = new AuditU2ClaudeClaimGifter(pm);
        _ghostAddOutside(address(gifter));
        pokeTargets = [a.receiver, a.tickets, a.executor, a.itemStream];
        pokeSelectors = [
            IBoxReceiver.onGraduation.selector,
            IBoxTickets.requestGraduationWord.selector,
            IBoxPriceAverage.poke.selector,
            IBoxItemStream.onGraduation.selector
        ];
    }

    // ================================================================================================ the router

    /// @notice A launch-router buy of `qIn` by `payer`, T to `recipient`, measured (see `AuditU2ClaudeBuy`) and booked
    /// in the ghost ledger. Never reverts: a refused buy comes back with `ok` false and its revert data.
    function _measuredBuy(address payer, uint256 qIn, address recipient) internal returns (AuditU2ClaudeBuy memory b) {
        b.qIn = qIn;
        b.closedBefore = hook.closed();
        _fund(payer, qIn);
        uint256[5] memory w; // payer ETH, router ETH, PoolManager ETH, recipient T, payer T (when not the recipient)
        w[0] = payer.balance;
        w[1] = a.launchRouter.balance;
        w[2] = address(pm).balance;
        w[3] = token.balanceOf(recipient);
        w[4] = recipient == payer ? 0 : token.balanceOf(payer);
        vm.recordLogs();
        _buyCall(b, payer, recipient);
        _readTaxedBuy(b, vm.getRecordedLogs());
        b.spent = address(pm).balance - w[2];
        b.tax = a.launchRouter.balance - w[1];
        b.refund = payer.balance + qIn - w[0];
        b.tDelivered = token.balanceOf(recipient) - w[3];
        b.closedAfter = hook.closed();
        if (b.ok) {
            b.step = (vm.getBlockTimestamp() - launchRouter.openAt()) / 12;
            b.pips = launchRouter.taxPips(b.step);
            _noteEthIn(EthIn.WindowBuy, qIn);
            if (b.refund != 0) _noteEthOut(EthOut.Refund, b.refund);
            if (_ghostIsOutside[recipient]) _noteTOut(TOut.Buy, b.tDelivered);
            if (recipient != payer) require(token.balanceOf(payer) == w[4], "base: the payer's T moved");
        } else {
            _noteEthChange(w[0], payer.balance, EthIn.Other, EthOut.Other);
        }
    }

    function _buyCall(AuditU2ClaudeBuy memory b, address payer, address recipient) private {
        uint256 qIn = b.qIn;
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(payer);
        try launchRouter.buy{value: qIn}(qIn, 1, recipient, deadline) returns (uint256 out) {
            b.ok = true;
            b.tokensOut = out;
        } catch (bytes memory err) {
            b.err = err;
        }
    }

    function _readTaxedBuy(AuditU2ClaudeBuy memory b, VmSafe.Log[] memory logs) private view {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != a.launchRouter || logs[i].topics[0] != IBoxLaunchRouter.TaxedBuy.selector) continue;
            (uint256 step, uint256 qIn_, uint256 tax, uint256 out, uint256 refund) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256));
            require(qIn_ == b.qIn && out == b.tokensOut, "base: the TaxedBuy event's amounts");
            (b.eventStep, b.eventTax, b.eventRefund) = (step, tax, refund);
        }
    }

    /// @notice The tax a buy of `qIn` keeps at `pips` without a partial close: ceil(qIn × pips / 10^6).
    function _taxFull(uint256 qIn, uint256 pips) internal pure returns (uint256) {
        return (qIn * pips + PIPS - 1) / PIPS;
    }

    /// @notice The tax on `spent` at a partial close: ceil(spent × pips / (10^6 − pips)).
    function _taxPartial(uint256 spent, uint256 pips) internal pure returns (uint256) {
        return (spent * pips + (PIPS - pips) - 1) / (PIPS - pips);
    }

    /// @notice Log-uniform amount in [lo, hi] from a seed.
    function _logAmount(uint256 seed, uint256 lo, uint256 hi) internal pure returns (uint256) {
        uint256 bitsLo = _bits(lo);
        uint256 bitsHi = _bits(hi);
        uint256 b = bitsLo + (seed % (bitsHi - bitsLo + 1));
        uint256 top = b >= 255 ? type(uint256).max : (uint256(1) << (b + 1)) - 1;
        uint256 bottom = b == 0 ? 0 : uint256(1) << b;
        uint256 x = bottom + ((seed >> 8) % (top - bottom + 1));
        if (x < lo) x = lo;
        if (x > hi) x = hi;
        return x;
    }

    function _bits(uint256 x) internal pure returns (uint256 n) {
        while (x > 1) {
            x >>= 1;
            ++n;
        }
    }

    /// @notice The pool's √price now.
    function _sqrtP() internal view returns (uint160 p) {
        (p,,,) = pm.getSlot0(poolKey.toId());
    }

    /// @notice A third party (`gifter`) hands `amount` ETH claims to `to`.
    function _giftEthClaims(address to, uint256 amount) internal {
        vm.deal(address(gifter), address(gifter).balance + amount);
        gifter.giftEthClaims{value: amount}(to);
        _noteEthIn(EthIn.Other, amount);
    }

    /// @notice `who` hands `amount` of its T to the gifter, which settles it and mints T claims to `to`.
    function _giftTokenClaims(address who, address to, uint256 amount) internal {
        vm.prank(who);
        require(token.transfer(address(gifter), amount), "base: T to the gifter");
        uint256 g0 = token.balanceOf(address(gifter));
        gifter.giftTokenClaims(a.token, to, amount);
        _noteTIn(TIn.Direct, g0 - token.balanceOf(address(gifter)));
    }

    /// @notice `graduate()` by `caller` (all the gas the test frame has), its events read; reverts if it reverts.
    function _graduateRecorded(address caller) internal returns (AuditU2ClaudeGraduation memory g) {
        vm.recordLogs();
        vm.prank(caller);
        g.reward = coordinator.graduate();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            bytes32 t0 = logs[i].topics[0];
            address e = logs[i].emitter;
            if (e == a.hook && t0 == IBoxHook.Migrated.selector) {
                _readMigrated(g, logs[i].data);
            } else if (e == a.coordinator && t0 == IBoxCoordinator.Graduated.selector) {
                (, g.poolShare, g.dustBurned,) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            } else if (e == a.coordinator && t0 == keccak256("ClaimsForwarded(address,uint256)")) {
                g.forwarded = abi.decode(logs[i].data, (uint256));
            } else if (e == a.coordinator && t0 == IBoxCoordinator.PokeFailed.selector) {
                ++g.pokeFailures;
            }
        }
    }

    function _readMigrated(AuditU2ClaudeGraduation memory g, bytes memory data) private pure {
        (uint256 q, uint256 t, uint128 ask, uint128 bid, uint128 sentinel,,) =
            abi.decode(data, (uint256, uint256, uint128, uint128, uint128, uint256, uint256));
        (g.qFromCurve, g.tFromCurve, g.askLiquidity, g.bidLiquidity, g.sentinelLiquidity) = (q, t, ask, bid, sentinel);
        (,,,,, uint256 pulled, uint256 dust) =
            abi.decode(data, (uint256, uint256, uint128, uint128, uint128, uint256, uint256));
        (g.tokenPulled, g.qDust) = (pulled, dust);
    }

    // ================================================================================================ poke targets

    /// @notice The code `target` runs now, its implementation (a clone's, read from its EIP-1167 bytes) and its
    /// arguments; a full contract gets a copy of its code at a fresh address as its "implementation".
    function _split(address target) internal returns (address impl, bytes memory args, bool isClone) {
        bytes memory code = target.code;
        isClone = code.length > 45 && bytes10(code) == bytes10(CLONE_PREFIX);
        if (isClone) {
            assembly ("memory-safe") {
                impl := shr(96, mload(add(add(code, 0x20), 10)))
            }
            args = new bytes(code.length - 45);
            for (uint256 i; i < args.length; ++i) {
                args[i] = code[45 + i];
            }
        } else {
            impl = address(uint160(uint256(keccak256(abi.encode("audit.u2.claude.copy", target)))));
            vm.etch(impl, code);
        }
    }

    /// @notice The tail at code offset `t`: JUMPDEST; if the selector is `sel`, LOG0 the GAS value on the stack; then
    /// DELEGATECALL `to` with the calldata and return or revert with its data (72 bytes).
    function _tail(uint256 t, address to, bytes4 sel) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"5b5f3560e01c63",
            sel,
            hex"141561",
            uint16(t + 24),
            hex"575f5260205fa05f5b50365f5f375f5f365f73",
            to,
            hex"5af43d5f5f3e61",
            uint16(t + 68),
            hex"573d5ffd5b3d5ff3"
        );
    }

    /// @notice `target`'s code with the gas logger in front and every call forwarded to `to` (its own implementation for
    /// a logged real target, the re-enterer otherwise), arguments kept at offset 45 for a clone.
    function _loggedCode(address target, address to, bytes4 sel) internal returns (bytes memory code) {
        (address impl, bytes memory args, bool isClone) = _split(target);
        if (to == address(0)) to = impl;
        if (isClone) {
            uint256 t = 45 + args.length + 33;
            code = bytes.concat(abi.encodePacked(hex"5a61", uint16(t), hex"56", new bytes(40)), args, new bytes(33));
            code = bytes.concat(code, _tail(t, to, sel));
        } else {
            code = bytes.concat(hex"5a", _tail(1, to, sel));
        }
    }

    /// @notice Poke target `i` keeps its behaviour and logs the gas its poke was given.
    function _etchLoggedReal(uint256 i) internal {
        vm.etch(pokeTargets[i], _loggedCode(pokeTargets[i], address(0), pokeSelectors[i]));
    }

    /// @notice Poke target `i` logs its gas, re-enters (graduate, claimReward, collect, sweep), then runs its real poke.
    function _etchReenter(uint256 i) internal {
        (address impl,,) = _split(pokeTargets[i]);
        AuditU2ClaudeReenterer r = new AuditU2ClaudeReenterer(
            IBoxCoordinator(a.coordinator),
            IBoxReceiver(a.receiver),
            IBoxLaunchRouter(a.launchRouter),
            impl,
            pokeSelectors[i]
        );
        vm.etch(pokeTargets[i], _loggedCode(pokeTargets[i], address(r), pokeSelectors[i]));
    }

    /// @notice Poke target `i` logs its gas and then misbehaves (`m`), for every call.
    function _etchHostile(uint256 i, HostileMode m) internal {
        bytes memory tail;
        if (m == HostileMode.Revert) tail = hex"5f5ffd";
        else if (m == HostileMode.BurnAll) tail = hex"5b600756";
        else if (m == HostileMode.ReturnBomb) tail = hex"621000005ff3";
        else tail = hex"621000005ffd";
        vm.etch(pokeTargets[i], bytes.concat(LOG_GAS, tail));
        hostileTargets = true;
    }

    // ================================================================================================ graduation probes

    /// @notice `graduate()` by `caller` with `gasLimit`, inside a snapshot rolled back afterwards: the outcome, the gas
    /// it used (this frame's view), what each logged target was given, the PokeFailed and re-entry events, and the
    /// state it left before the rollback.
    function _probe(address caller, uint256 gasLimit) internal returns (AuditU2ClaudeProbe memory p) {
        uint256 snap = vm.snapshotState();
        p = _graduateLogged(caller, gasLimit);
        vm.revertToState(snap);
    }

    /// @notice `graduate()` by `caller` with `gasLimit`, logs read (no rollback).
    function _graduateLogged(address caller, uint256 gasLimit) internal returns (AuditU2ClaudeProbe memory p) {
        vm.recordLogs();
        uint256 g0 = gasleft();
        vm.prank(caller);
        (bool ok, bytes memory ret) = a.coordinator.call{gas: gasLimit}(abi.encodeCall(IBoxCoordinator.graduate, ()));
        p.used = g0 - gasleft();
        p.ok = ok;
        if (!ok) p.err = ret;
        else p.reward = abi.decode(ret, (uint256));
        _readGraduationLogs(p, vm.getRecordedLogs());
        p.graduated = coordinator.graduated();
        if (!hostileTargets) {
            p.settled = receiver.graduationSettled();
            p.wordRequested = tickets.status().wordRequestedAt != 0;
            p.executorGraduated = executor.fitGraduated();
            p.streamStarted = stream.started();
        }
        p.digest = _graduationDigest();
        p.baselineBalance = coordinator.streamStartBalance();
        p.baselineClaims = coordinator.streamStartClaims();
        p.streamT = token.balanceOf(a.itemStream);
        p.receiverTClaims = pm.balanceOf(a.receiver, uint256(uint160(a.token)));
    }

    function _readGraduationLogs(AuditU2ClaudeProbe memory p, VmSafe.Log[] memory logs) private view {
        p.given = new uint256[](4);
        p.givenTo = new address[](4);
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            address e = logs[i].emitter;
            bytes32[] memory topics = logs[i].topics;
            if (topics.length == 0) {
                if (logs[i].data.length == 32 && _isPokeTarget(e) && !_seen(p.givenTo, n, e)) {
                    if (n < 4) {
                        p.given[n] = abi.decode(logs[i].data, (uint256)) + 2;
                        p.givenTo[n] = e;
                    }
                    ++n;
                }
                continue;
            }
            if (e == a.coordinator && topics[0] == IBoxCoordinator.PokeFailed.selector) ++p.pokeFailures;
            if (topics[0] == AuditU2ClaudeReenterer.AuditU2ClaudeReentry.selector && _isPokeTarget(e)) {
                ++p.reentries;
                (, bytes4 err) = abi.decode(logs[i].data, (bool, bytes4));
                bytes4 call = bytes4(topics[1]);
                bool lockCall =
                    call == IBoxCoordinator.graduate.selector || call == IBoxCoordinator.claimReward.selector;
                if (lockCall && err == bytes4(0xab143c06)) ++p.reentriesRefusedByLock;
            }
        }
    }

    function _isPokeTarget(address e) internal view returns (bool) {
        return e == pokeTargets[0] || e == pokeTargets[1] || e == pokeTargets[2] || e == pokeTargets[3];
    }

    function _seen(address[] memory list, uint256 n, address e) internal pure returns (bool) {
        uint256 m = n < list.length ? n : list.length;
        for (uint256 i; i < m; ++i) {
            if (list[i] == e) return true;
        }
        return false;
    }

    /// @notice The least gas with which `graduate()` by `caller` succeeds from this state, to the unit (binary search
    /// over [lo, hi], each probe in a snapshot).
    function _leastGraduateGas(address caller, uint256 lo, uint256 hi) internal returns (uint256) {
        require(_probe(caller, hi).ok, "base: graduate() fails at the search's upper bound");
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_probe(caller, mid).ok) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    }

    /// @notice A digest of every state `graduate()` writes or causes, to show a refused call changed nothing.
    function _graduationDigest() internal view returns (bytes32) {
        bytes32 h1 = keccak256(
            abi.encode(
                coordinator.graduated(),
                coordinator.graduatedAt(),
                hook.migratedAtBlock(),
                hook.reserveMinted(),
                vault.gateOpenedAt(),
                token.totalSupply(),
                token.balanceOf(a.coordinator)
            )
        );
        bytes32 h2 = keccak256(
            abi.encode(
                pm.balanceOf(a.coordinator, 0),
                pm.balanceOf(a.receiver, 0),
                pm.balanceOf(a.receiver, uint256(uint160(a.token))),
                coordinator.streamStartBalance(),
                coordinator.streamStartClaims(),
                _sqrtP()
            )
        );
        bytes32 h3 = keccak256(abi.encode(coordinator.rewardOf(keeper), pm.balanceOf(a.hook, 0)));
        if (!hostileTargets) {
            h3 = keccak256(
                abi.encode(
                    h3,
                    tickets.status().wordRequestedAt,
                    stream.started(),
                    receiver.graduationSettled(),
                    executor.fitGraduated()
                )
            );
        }
        return keccak256(abi.encode(h1, h2, h3));
    }

    /// @notice The closing buy of the world's `_toClosed`, by `who`, of `ethIn` limited at `limit` (P1 or beyond).
    function _closeWith(address who, uint256 ethIn, uint160 limit) internal {
        _buyTo(who, ethIn, limit);
        require(hook.closed(), "base: the curve closed");
    }

    /// @notice √P1, the curve's end (the launch router's price limit).
    function _p1() internal view returns (uint160) {
        return curve.sqrtPriceLowerX96;
    }

    function _minLimit() internal pure returns (uint160) {
        return TickMath.MIN_SQRT_PRICE + 1;
    }

    // ================================================================================================ forcing (BC-029)

    /// @notice The Q the curve position holds at the current price (`BoxHookCurve.t.sol`'s `_curveQ`): its Q side
    /// from the price up to P0.
    function _curveQ() internal view returns (uint256) {
        return SqrtPriceMath.getAmount0Delta(_sqrtP(), curve.sqrtPriceUpperX96, curve.liquidity, false);
    }

    /// @notice After the window: one stand-in buy by eoa[0] that stops where the curve holds `fillPpm` / 10^6 of R
    /// (`BoxHookCurve.t.sol`'s `_fillTo`).
    function _fillTo(uint256 fillPpm) internal {
        uint256 target = raise * fillPpm / 1e6;
        uint256 held = _curveQ();
        if (target <= held) return;
        uint160 limit = SqrtPriceMath.getNextSqrtPriceFromInput(_sqrtP(), curve.liquidity, target - held, true);
        _buyTo(eoa[0], 2 * raise, limit);
    }

    /// @notice One BC-029 round trip by `forcer` (see `AuditU2ClaudeForcing`), booked in the ghost ledger.
    function _force(address forcer, uint256 gift) internal returns (AuditU2ClaudeForcing memory f) {
        f.qBefore = _curveQ();
        uint256 ethIn = 3 * raise;
        uint256 e0 = forcer.balance;
        f.tBought = _buyTo(forcer, ethIn, _p1());
        require(hook.closed() && _sqrtP() == _p1(), "base: the forcer's buy closed the curve at P1");
        f.paid = e0 + ethIn - forcer.balance;
        f.gift = gift;
        if (gift != 0) _transferT(forcer, a.coordinator, gift);
        (f.reward,) = _graduate(forcer);
        f.received = _sell(forcer, token.balanceOf(forcer));
        f.cost = f.paid - f.received;
        (f.ask, f.bid, f.sentinel) = hook.graduatedLayout();
        f.poolQAfter = _graduatedQ(f.ask, f.bid, f.sentinel);
    }

    /// @notice The Q in box 0's three graduated positions at the current price (`BoxHookCurve.t.sol:403-407`): the bid
    /// [P1, max], the sentinel [P0, max] and the ask [min, P1], each counted from the price up.
    function _graduatedQ(uint128 ask, uint128 bid, uint128 sentinel) internal view returns (uint256) {
        uint160 s = _sqrtP();
        uint160 maxS = TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK);
        uint160 minS = TickMath.getSqrtPriceAtTick(BoxSpecV1.MIN_USABLE_TICK);
        return _q0Above(s, curve.sqrtPriceLowerX96, maxS, bid) + _q0Above(s, curve.sqrtPriceUpperX96, maxS, sentinel)
            + _q0Above(s, minS, curve.sqrtPriceLowerX96, ask);
    }

    function _q0Above(uint160 s, uint160 lo, uint160 hi, uint128 l) internal pure returns (uint256) {
        if (s >= hi || l == 0) return 0;
        return SqrtPriceMath.getAmount0Delta(s > lo ? s : lo, hi, l, false);
    }

    /// @notice The Q a sentinel of liquidity `l` holds at graduation (from P0 to the maximum price).
    function _sentinelQ(uint128 l) internal view returns (uint256) {
        return SqrtPriceMath.getAmount0Delta(
            curve.sqrtPriceUpperX96, TickMath.getSqrtPriceAtTick(BoxSpecV1.MAX_USABLE_TICK), l, false
        );
    }

    /// @notice Whether the test runs under Amsterdam, for the few figures that depend on the fork.
    function _isAmsterdam() internal pure returns (bool) {
        return keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
    }
}
