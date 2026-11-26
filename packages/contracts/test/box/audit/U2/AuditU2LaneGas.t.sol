// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {AuditU2LaneBase} from "./AuditU2LaneBase.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice TEST ONLY: hostile poke behavior. The real receiver clone bytecode is retained for collect callbacks;
/// delegatecall preserves its original account, storage and immutable arguments. Migration's hook, T, vault and PM stay real.
contract AuditU2LanePokeBehavior {
    BoxCoordinator internal immutable coord;
    address internal immutable receiver;
    address internal immutable originalReceiver;
    uint256 internal immutable mode;
    event Attempt(uint256 mode, bool ok, bytes4 reason);
    event Baseline(uint256 balance, uint256 claims);

    constructor(BoxCoordinator c, address r, address original, uint256 m) {
        coord = c;
        receiver = r;
        originalReceiver = original;
        mode = m;
    }

    fallback() external {
        if (msg.sig == IBoxReceiver.collect.selector) {
            address original = originalReceiver;
            assembly ("memory-safe") {
                calldatacopy(0, 0, calldatasize())
                let ok := delegatecall(gas(), original, 0, calldatasize(), 0, 0)
                returndatacopy(0, 0, returndatasize())
                if iszero(ok) { revert(0, returndatasize()) }
                return(0, returndatasize())
            }
        }
        if (address(this) == receiver) {
            uint256 balance = coord.streamStartBalance();
            uint256 claims = coord.streamStartClaims();
            require(balance == IBoxToken(coord.token()).balanceOf(coord.itemStream()), "baseline T before poke");
            require(
                claims == IPoolManager(coord.poolManager()).balanceOf(receiver, uint256(uint160(coord.token()))),
                "baseline claims before poke"
            );
            require(balance != 0, "positive baseline control");
            emit Baseline(balance, claims);
        }
        bool ok;
        bytes memory ret;
        if (mode == 3) (ok, ret) = address(coord).call(abi.encodeCall(coord.graduate, ()));
        if (mode == 4) (ok, ret) = receiver.call(abi.encodeCall(IBoxReceiver.collect, (address(this))));
        if (mode == 5) (ok, ret) = address(coord).call(abi.encodeCall(coord.claimReward, (address(this))));
        emit Attempt(mode, ok, bytes4(ret));
    }
}

/// @notice BC-098, F95 R19M, F126: hostile optional pokes only; real coordinator, hook, T, vault and PoolManager.
/// forge-config: default.evm_version = "osaka"
contract AuditU2LaneGas is AuditU2LaneBase {
    uint256 internal constant POKE = 2_600_000;
    uint256 internal constant FLOOR = POKE + POKE / 63 + 10_000;
    uint256 internal constant CAP = 16_777_216;
    // First instruction GAS: records entry gas minus 2, then the selector, with LOG0.
    bytes internal constant LOGGER = hex"5a60005260003560205260406000a0";

    function _forkName() internal pure virtual returns (string memory) {
        return "osaka";
    }

    function _readyGas() internal {
        _readyGasWith(false, false);
    }

    function _readyGasWith(bool overshoot, bool gifts) internal {
        if (overshoot) {
            _warpTo(hook.openAt() + 384);
            _buyTo(eoa[0], 2 * raise, TickMath.MIN_SQRT_PRICE + 1);
        } else {
            _closeLane();
        }
        if (gifts) {
            _giftClaimsLane(raise);
            vm.prank(eoa[0]);
            token.transfer(a.coordinator, 1 ether);
            _forceEth(a.coordinator, 1 ether);
        }
        vm.prank(eoa[0]);
        token.transfer(a.itemStream, 123456789);
        vm.setEvmVersion(_forkName());
    }

    function _targets() internal view returns (address[4] memory) {
        return [a.receiver, a.tickets, a.executor, a.itemStream];
    }

    function _selectors() internal pure returns (bytes4[4] memory) {
        return [
            IBoxReceiver.onGraduation.selector,
            IBoxTickets.requestGraduationWord.selector,
            IBoxPriceAverage.poke.selector,
            IBoxItemStream.onGraduation.selector
        ];
    }

    function _install(uint256 mode) internal {
        address copy = address(0xA0D172);
        vm.etch(copy, a.receiver.code);
        bytes memory tail;
        if (mode == 0) tail = hex"00";
        if (mode == 1) tail = hex"60006000fd";
        // Expanding memory to 4 GiB exhausts the entire stipend, without millions of irrelevant loop steps.
        if (mode == 2) tail = hex"63ffffffff5100";
        // 1 MiB return: the coordinator must not copy it.
        if (mode == 6) tail = hex"621000006000f3";
        if (mode >= 3 && mode <= 5) {
            AuditU2LanePokeBehavior behavior = new AuditU2LanePokeBehavior(coordinator, a.receiver, copy, mode);
            // Copy calldata and delegate to behavior without copying return data.
            // Required Attempt/Baseline events make any unexpected behavior failure fail the test.
            tail = abi.encodePacked(hex"3660006000376000600036600073", address(behavior), hex"5af45000");
        }
        address[4] memory targets = _targets();
        for (uint256 i; i < 4; ++i) {
            vm.etch(targets[i], bytes.concat(LOGGER, tail));
        }
    }

    function _cool() internal {
        CoreImpls memory impl = kit.impls();
        address[24] memory list = [
            a.coordinator,
            a.token,
            a.vault,
            a.hook,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.itemStream,
            a.executor,
            a.collection,
            address(pm),
            address(src),
            address(drand),
            a.royaltyRouter,
            impl.coordinator,
            impl.hook,
            impl.hookExtension,
            impl.receiver,
            impl.receiverExtension,
            impl.launchRouter,
            impl.tickets,
            impl.itemStream,
            impl.vault,
            impl.collection
        ];
        for (uint256 i; i < list.length; ++i) {
            vm.cool(list[i]);
        }
    }

    /// @dev Every try starts from identical cold state and restores it afterwards. Recorder includes reverted logs;
    /// only successful transactions are required to have four complete poke entries.
    function probeLane(uint256 gasLimit, uint256 mode) external returns (bool ok, uint256 used) {
        uint256 snap = vm.snapshotState();
        uint256 share = token.balanceOf(a.coordinator);
        uint256 pmEth = address(pm).balance;
        uint256 supply = token.totalSupply();
        _cool();
        vm.recordLogs();
        vm.startStateDiffRecording();
        vm.prank(keeper);
        uint256 g0 = gasleft();
        bytes memory ret;
        (ok, ret) = a.coordinator.call{gas: gasLimit}(abi.encodeCall(coordinator.graduate, ()));
        used = g0 - gasleft();
        Vm.AccountAccess[] memory changes = vm.stopAndReturnStateDiff();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            _allWritesReverted(changes);
            assertFalse(coordinator.graduated());
            assertEq(hook.migratedAtBlock(), 0);
            assertEq(vault.gateOpenedAt(), 0);
            assertEq(coordinator.rewardOf(keeper), 0);
            assertEq(coordinator.streamStartBalance(), 0);
            assertEq(coordinator.streamStartClaims(), 0);
            assertEq(token.balanceOf(a.coordinator), share);
            assertEq(token.totalSupply(), supply);
            assertEq(address(pm).balance, pmEth);
            assertTrue(ret.length == 0 || bytes4(ret) == IBoxCoordinator.GasTooLow.selector);
        } else {
            assertTrue(coordinator.graduated());
            assertGt(vault.gateOpenedAt(), 0);
            assertEq(token.balanceOf(a.coordinator), 0);
            assertEq(coordinator.rewardOf(keeper), coordinator.rewardCap());
            _pokeLogs(logs, mode);
        }
        vm.revertToState(snap);
    }

    function _pokeLogs(Vm.Log[] memory logs, uint256 mode) internal {
        address[4] memory targets = _targets();
        bytes4[4] memory selectors = _selectors();
        uint256 n;
        uint256 failures;
        uint256 attempts;
        uint256 baselines;
        uint256 successfulCollects;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory l = logs[i];
            if (l.topics.length == 0 && l.data.length == 64) {
                (uint256 gasAtEntry, bytes32 sel) = abi.decode(l.data, (uint256, bytes32));
                if (bytes4(sel) == IBoxReceiver.collect.selector) continue;
                assertLt(n, 4);
                assertEq(l.emitter, targets[n]);
                assertEq(bytes4(sel), selectors[n]);
                assertEq(gasAtEntry + 2, POKE, "exact CALL stipend, including failing callees");
                ++n;
            } else if (l.topics.length > 0) {
                if (l.topics[0] == IBoxCoordinator.PokeFailed.selector) ++failures;
                if (l.topics[0] == AuditU2LanePokeBehavior.Attempt.selector) {
                    (uint256 m, bool success, bytes4 reason) = abi.decode(l.data, (uint256, bool, bytes4));
                    assertEq(m, mode);
                    if (mode == 3 || mode == 5) {
                        assertFalse(success);
                        assertEq(reason, TransientReentrancyGuard.Reentrancy.selector);
                    }
                    if (mode == 4 && success) ++successfulCollects;
                    ++attempts;
                }
                if (l.topics[0] == AuditU2LanePokeBehavior.Baseline.selector) ++baselines;
            }
        }
        assertEq(n, 4, "all four pokes reached in order");
        assertEq(failures, mode == 1 || mode == 2 ? 4 : 0);
        if (mode >= 3 && mode <= 5) {
            assertEq(attempts, 4);
            assertEq(baselines, 1);
        }
        if (mode == 4) assertGt(successfulCollects, 0, "a real reentrant collect exercised");
    }

    /// @dev 100k steps across the entire requested range; binary search then every gas unit ±8 at each boundary.
    /// Includes ample-gas success even when all-burn cannot finish inside floor + 3 stipends.
    function testProperty_AUDIT_U2_gasGridStop() public {
        _grid(0);
    }

    function testProperty_AUDIT_U2_gasGridRevert() public {
        _grid(1);
    }

    function testProperty_AUDIT_U2_gasGridExhaust() public {
        _grid(2);
    }

    function testProperty_AUDIT_U2_gasGridReenterGraduate() public {
        _grid(3);
    }

    function testProperty_AUDIT_U2_gasGridReenterCollect() public {
        _grid(4);
    }

    function testProperty_AUDIT_U2_gasGridReenterClaim() public {
        _grid(5);
    }

    function testProperty_AUDIT_U2_gasGridReturnBomb() public {
        _grid(6);
    }

    function testFuzz_AUDIT_U2_arbitraryCallerGas(uint32 raw, uint8 behavior) public {
        _readyGas();
        uint256 mode = uint256(behavior) % 7;
        _install(mode);
        this.probeLane(bound(raw, FLOOR, FLOOR + 3 * POKE), mode);
    }

    function _grid(uint256 mode) internal {
        _readyGas();
        _install(mode);
        for (uint256 gasLimit = FLOOR; gasLimit <= FLOOR + 3 * POKE; gasLimit += 100_000) {
            this.probeLane(gasLimit, mode);
        }
        this.probeLane(FLOOR + 3 * POKE, mode);
        uint256 lo = FLOOR;
        uint256 hi = CAP - 21_064;
        (bool ample,) = this.probeLane(hi, mode);
        assertTrue(ample);
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            (bool ok,) = this.probeLane(mid, mode);
            if (ok) hi = mid;
            else lo = mid;
        }
        for (uint256 gasLimit = hi - 8; gasLimit <= hi + 8; ++gasLimit) {
            (bool ok,) = this.probeLane(gasLimit, mode);
            assertEq(ok, gasLimit >= hi, "one-gas boundary");
        }
        emit log_named_uint(string.concat(_forkName(), " mode ", vm.toString(mode), " minimum call gas"), hi);
    }

    function testProperty_AUDIT_U2_allFullStipendsBelowTransactionCap() public {
        uint256 initial = vm.snapshotState();
        uint256 worst;
        for (uint256 scenario; scenario < 4; ++scenario) {
            vm.revertToState(initial);
            _readyGasWith(scenario & 1 != 0, scenario & 2 != 0);
            _install(2);
            (bool ok, uint256 used) = this.probeLane(15_000_000, 2);
            assertTrue(ok);
            assertGe(used, 4 * POKE);
            if (used > worst) worst = used;
        }
        // Caller overhead is included; no refund discount. For Amsterdam this also includes state gas, stricter
        // than its execution-only transaction cap. Four nonzero selector bytes add 64 intrinsic calldata gas.
        uint256 total = worst + 21_064;
        assertLt(total, CAP);
        emit log_named_uint(string.concat(_forkName(), " all-burn gross gas including intrinsic"), total);
        emit log_named_uint(string.concat(_forkName(), " EIP-7825 conservative margin"), CAP - total);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU2LaneGasAmsterdam is AuditU2LaneGas {
    function _forkName() internal pure override returns (string memory) {
        return "amsterdam";
    }
}
