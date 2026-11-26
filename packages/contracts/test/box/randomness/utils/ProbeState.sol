// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";

/// @notice TEST ONLY (rc8 open item 78, part 2b review). BC-053's source probes post committed quicknet rounds and
/// request from labelled addresses inside a snapshot, and the deployed verifier runs them on a fork of the live chain,
/// where anyone may have posted those public rounds or requested from those addresses first (`makeAddr` keys are
/// public). That state is no fault of the code under test, so before a probe these reset it on the snapshot only:
/// each first proves the storage layout against the source's own view, writes zeros, and checks the view is clear.
/// With nothing there (every local run, and a live chain nobody touched) they write nothing.
/// Layouts (`forge inspect … storage-layout`): DrandSource `_requests` slot 0 ({uint64 requestedAt, uint64 round}),
/// `_rounds` slot 1 ({bytes32 randomness} then {uint64 postedAt, uint128 pot}); BoxBackedSource `_backups` slot 0
/// ({uint64 startedAt, uint64 targetBlock, uint64 fixedAt}), `_mixes` slot 1.
library ProbeState {
    /// @notice `round` unposted (and its pot empty) on `drand`.
    function freshRound(Vm vm, IDrandSource drand, uint256 round) internal {
        (bytes32 randomness, uint64 postedAt) = drand.beaconOf(round);
        uint256 pot = drand.bountyOf(round);
        if (postedAt == 0 && pot == 0) return;
        bytes32 slot = keccak256(abi.encode(round, uint256(1)));
        bytes32 next = bytes32(uint256(slot) + 1);
        uint256 packed = uint256(vm.load(address(drand), next));
        require(vm.load(address(drand), slot) == randomness, "ProbeState: DrandSource round layout");
        require(uint64(packed) == postedAt && uint128(packed >> 64) == pot, "ProbeState: DrandSource round layout");
        vm.store(address(drand), slot, bytes32(0));
        vm.store(address(drand), next, bytes32(0));
        (randomness, postedAt) = drand.beaconOf(round);
        require(randomness == 0 && postedAt == 0 && drand.bountyOf(round) == 0, "ProbeState: round not cleared");
    }

    /// @notice No request of (`consumer`, `key`) on `drand`.
    function freshRequest(Vm vm, IDrandSource drand, address consumer, uint256 key) internal {
        (uint64 requestedAt, uint64 round) = drand.requestOf(consumer, key);
        if (requestedAt == 0 && round == 0) return;
        bytes32 slot = keccak256(abi.encode(keccak256(abi.encode(consumer, key)), uint256(0)));
        uint256 packed = uint256(vm.load(address(drand), slot));
        require(
            uint64(packed) == requestedAt && uint64(packed >> 64) == round, "ProbeState: DrandSource request layout"
        );
        vm.store(address(drand), slot, bytes32(0));
        (requestedAt, round) = drand.requestOf(consumer, key);
        require(requestedAt == 0 && round == 0, "ProbeState: request not cleared");
    }

    /// @notice No request of (`consumer`, `key`) through `src` (held on its DrandSource for `src` and the pair's id).
    function freshBackedRequest(Vm vm, BoxBackedSource src, address consumer, uint256 key) internal {
        freshRequest(vm, src.DRAND(), address(src), uint256(keccak256(abi.encode(consumer, key))));
        (uint64 requestedAt, uint64 round) = src.requestOf(consumer, key);
        require(requestedAt == 0 && round == 0, "ProbeState: backed request not cleared");
    }

    /// @notice No backup for `round` on `src`.
    function freshBackup(Vm vm, BoxBackedSource src, uint256 round) internal {
        (uint64 startedAt, uint64 targetBlock, uint64 fixedAt, bytes32 mix) = src.backupOf(round);
        if (startedAt == 0 && targetBlock == 0 && fixedAt == 0 && mix == 0) return;
        bytes32 slot = keccak256(abi.encode(round, uint256(0)));
        bytes32 mixSlot = keccak256(abi.encode(round, uint256(1)));
        uint256 packed = uint256(vm.load(address(src), slot));
        require(
            uint64(packed) == startedAt && uint64(packed >> 64) == targetBlock && uint64(packed >> 128) == fixedAt
                && vm.load(address(src), mixSlot) == mix,
            "ProbeState: BoxBackedSource backup layout"
        );
        vm.store(address(src), slot, bytes32(0));
        vm.store(address(src), mixSlot, bytes32(0));
        (startedAt, targetBlock, fixedAt, mix) = src.backupOf(round);
        require(startedAt == 0 && targetBlock == 0 && fixedAt == 0 && mix == 0, "ProbeState: backup not cleared");
    }

    /// @notice `round` as a probe needs it on box 0's source: unposted on its DrandSource and with no backup.
    function freshBackedRound(Vm vm, BoxBackedSource src, uint256 round) internal {
        freshRound(vm, src.DRAND(), round);
        freshBackup(vm, src, round);
    }
}
