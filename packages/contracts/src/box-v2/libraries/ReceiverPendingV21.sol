// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverShopV21 as Shop} from "./ReceiverShopV21.sol";
import {IBoxReceiverV2} from "../interfaces/IBoxReceiverV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IFeeModulesV21} from "../interfaces/IFeeModulesV21.sol";
import {BoxReceiverV2Args as A} from "./BoxReceiverV2Args.sol";
import {IBoxReceiverEatV21} from "../interfaces/IBoxReceiverEatV21.sol";
import {IBoxReceiverPileV21} from "../interfaces/IBoxReceiverPileV21.sol";

/// @notice Fixed core accounting code, linked for the release. Not an admissible fee-action module.
/// Keeps the receiver's pending/cumulative slots, original unlock action and exact gas admission.
library ReceiverPendingV21 {
    // Optional additive action view. Old generic version-1 actions retain their existing int128 budget bound.
    // Alchemist also enforces its immutable cap inside execute, so a failed read never enlarges its exposure.
    uint256 private constant MODULE_CAP_GAS = 30_000;
    bytes4 private constant INPUT_CAP = bytes4(keccak256("inputCap()"));
    uint256 private constant MODULE_TRIGGER_GAS = 30_000;
    bytes4 private constant CONVERSION_TRIGGER = bytes4(keccak256("conversionTrigger()"));
    bytes32 private constant CONVERSION_CLOCK = keccak256("squarehole.receiver.v21.conversion-clock");
    uint256 private constant FALLBACK_WAIT = 7 days;
    error ConversionTriggerOnly();

    /// @notice Core booking, graduation settlement or completed execution only, in receiver storage.
    /// Starts/restarts this side's wait; no external call or fund movement. Booking calls this only on a
    /// zero-to-positive receipt; graduateIfDue restarts each nonempty module side when graduation settles.
    function startWait(bool sellers) internal {
        uint256 slot = uint256(CONVERSION_CLOCK) + (sellers ? 1 : 0);
        uint256 since = block.timestamp + 1;
        assembly ("memory-safe") { sstore(slot, since) }
    }
    /// @dev Core run only: checks the original caller against the authenticated module's immutable trigger.
    function _authorize(address module, bool sellers) private view returns (bool gated) {
        bytes memory data = abi.encodeWithSelector(CONVERSION_TRIGGER);
        bool ok; uint256 size; uint256 trigger;
        // Optional immutable getter; old actions without it keep their caller policy. Bounded return copy.
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(MODULE_TRIGGER_GAS, module, add(data, 32), mload(data), out, 32)
            size := returndatasize()
            trigger := mload(out)
        }
        if (!ok || size != 32) return false;
        if (trigger == 0 || trigger > type(uint160).max) revert ConversionTriggerOnly();
        if (msg.sender == address(uint160(trigger))) return true;
        uint256 slot = uint256(CONVERSION_CLOCK) + (sellers ? 1 : 0);
        uint256 since;
        assembly ("memory-safe") { since := sload(slot) }
        // Plus-one encoding distinguishes a receipt at timestamp zero from an unstarted clock.
        if (since == 0 || block.timestamp < since - 1 + FALLBACK_WAIT) revert ConversionTriggerOnly();
        return true;
    }
    /// @notice Locked, prepared receiver only via its fixed library link; moves one bounded pending portion.
    /// Caller supplies its compiler-derived storage slot. Refusal restores debt atomically; no admin entry.
    function move(IPoolManager pm, bool pile, address asset, address to, uint256 slot, bool burned,
        uint256 cap, uint256 reserve) external returns (uint256 amount)
    {
        assembly ("memory-safe") { amount := sload(slot) }
        if (amount > uint256(uint128(type(int128).max))) amount = uint256(uint128(type(int128).max));
        if (amount == 0) return 0;
        require(gasleft() >= cap + cap / 63 + reserve, "ReceiverGasTooLow");
        assembly ("memory-safe") { sstore(slot, sub(sload(slot), amount)) }
        bytes32 armed = keccak256("squarehole.receiver.v2.unlock");
        uint256 action = pile ? 10 : 7;
        assembly ("memory-safe") { tstore(armed, action) }
        bool ok;
        try pm.unlock{gas: cap}(abi.encode(action, asset, to, amount)) { ok = true; } catch {}
        assembly ("memory-safe") { tstore(armed, 0) }
        if (!ok) {
            assembly ("memory-safe") { sstore(slot, add(sload(slot), amount)) }
            return 0;
        }
        uint256 total;
        assembly ("memory-safe") { total := sload(add(slot, 1)) }
        total += amount;
        assembly ("memory-safe") { sstore(add(slot, 1), total) }
        if (pile) emit IBoxReceiverPileV21.PileFeesMoved(to, asset, amount, total);
        else emit IBoxReceiverEatV21.PriceCoinEaten(asset, amount, total, burned);
    }
    /// @notice Locked graduated receiver only; preserves the original executeModule caller under delegatecall.
    /// Alchemist accepts its immutable trigger, or anyone after this side waits seven days without progress.
    /// Other actions retain their caller policy. Graduation settlement restarts each waiting module side's clock;
    /// after settlement only a completed conversion/dust exit restarts it, never a refused attempt.
    /// @dev A capped action receives full caps until at most two remain, then the larger half and the rest.
    /// This maximizes the smaller final clip without exceeding the cap. With steady admitting routes, including
    /// their defined zero-minimum exit, P drains in ceil(P / inputCap) calls; no addition/ceiling can overflow.
    function run(IPoolManager pm, bool sellers, uint256 slot, uint256 cap, uint256 reserve) external returns (uint256 amount) {
        uint256 choice = A.uintAt(sellers ? A.SELLERS_CHOICE : A.BUYERS_CHOICE, 1);
        if (choice == 11) return Shop.run(pm, slot);
        if (choice != 10) revert IBoxReceiverV2.InvalidChoice();
        assembly ("memory-safe") { amount := sload(slot) }
        if (amount == 0) return 0;
        bool gated;
        (amount, gated) = _moduleCap(sellers, amount);
        if (amount == 0) return 0;
        require(gasleft() >= cap + cap / 63 + reserve, "ReceiverGasTooLow");
        assembly ("memory-safe") { sstore(slot, sub(sload(slot), amount)) }
        bytes32 armed = keccak256("squarehole.receiver.v2.unlock");
        uint256 action = sellers ? 13 : 12;
        assembly ("memory-safe") { tstore(armed, action) }
        bool ok;
        try pm.unlock{gas: cap}(abi.encode(action, A.addressAt(A.P), address(0), amount)) { ok = true; } catch {}
        assembly ("memory-safe") { tstore(armed, 0) }
        if (!ok) { assembly ("memory-safe") { sstore(slot, add(sload(slot), amount)) } return 0; }
        if (gated) startWait(sellers);
        emit IFeeModulesV21.ModuleExecuted(sellers, A.addressAt(sellers ? 339 : 287), amount);
    }
    function _moduleCap(bool sellers, uint256 amount) private view returns (uint256, bool) {
        uint256 offset = sellers ? 339 : 287;
        address module = A.addressAt(offset);
        if (module.codehash != bytes32(A.uintAt(offset + 20, 32))) return (0, false);
        bool gated = _authorize(module, sellers);
        bytes memory data = abi.encodeWithSelector(INPUT_CAP);
        bool ok; uint256 size; uint256 limit;
        // Copy only one word, including for a hostile return-data bomb; no action can exhaust restoration gas.
        assembly ("memory-safe") {
            let out := mload(0x40)
            ok := staticcall(MODULE_CAP_GAS, module, add(data, 32), mload(data), out, 32)
            size := returndatasize()
            limit := mload(out)
        }
        uint256 max = uint256(uint128(type(int128).max));
        if (!ok || size != 32) return (amount > max ? max : amount, gated);
        if (limit > max) limit = max;
        if (amount <= limit) return (amount, gated);
        // Subtraction is safe here and avoids both 2 * limit and pending + cap overflow.
        return (amount - limit < limit ? amount / 2 + amount % 2 : limit, gated);
    }
}
