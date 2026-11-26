// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CoreBox0BackupBase} from "../../backup/CoreBox0BackupBase.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {TicketPhase} from "../../../../src/box/interfaces/BoxTypes.sol";

/// @notice BC-053 / BC-101 / F143: actual mainnet factory box 0 accepts the backed graduation word.
/// CoreBox0Kit deploys production implementations and clones; only local chain headers/history are seeded.
/// forge-config: default.evm_version = "osaka"
contract AuditU8LaneBox0Test is CoreBox0BackupBase {
    function testProperty_AUDIT_U8_factoryBox0UsesPinnedBackup() public {
        assertEq(tickets.source(), BackedSourcePins.ADDRESS_MAINNET);
        uint256 requestedAt = _graduate();
        vm.warp(src.roundTime(r0) + src.LATEST_START());
        uint256 target = _start(r0, address(0xB001));
        drand.postRound(r0, _localSig(0)); // post after start has no say in the graduation word
        (bytes32 pending,) = src.wordOf(a.tickets, 0);
        assertEq(pending, bytes32(0));
        _advance(256 + 8191);
        bytes32 mix = keccak256("last provable block");
        src.fixBackup(r0, _mine(target, mix));
        (bytes32 w, uint64 ready) = src.wordOf(a.tickets, 0);
        assertEq(w, keccak256(abi.encode(src.BACKUP_TAG(), mix, keccak256(abi.encode(a.tickets, uint256(0))))));
        assertEq(requestedAt + 7 days - ready, 6624);
        tickets.acceptGraduationWord();
        assertEq(uint8(tickets.phase()), uint8(TicketPhase.Drawing));
        assertEq(address(src).balance, 0);
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU8LaneBox0AmsterdamTest is AuditU8LaneBox0Test {}
