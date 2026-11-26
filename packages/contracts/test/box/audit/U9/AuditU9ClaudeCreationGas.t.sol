// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {AuditBox0World} from "../common/AuditBox0World.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";
import {AuditU9ClaudeLargestSpec} from "./AuditU9ClaudeSpecGas.t.sol";

/// @title AuditU9ClaudeCreationGasTest (SH-AUDIT-B0-U9, Claude; P9.4 / BC-068 context; lens L5)
/// @notice The factory's box 0 created from the largest spec validate() accepts (AuditU9ClaudeLargestSpec: every text
/// at its limit, the 24,575-byte table with 4,080 texts, eight add-ons, N 10,000) instead of the world's: the
/// creation's execution gas (`CoreBox0Kit.create`, measured around `createBox`) plus the transaction's intrinsic and
/// calldata cost (EIP-2028, and EIP-7623's floor), against EIP-7825's 16,777,216. S7 finding 1 recorded 16,334,111 for
/// "the largest box data" (validate() 3.36M of it); this measures the case with the most texts. Box 0's real spec is
/// far below (the world's own creation, 903,780 execution gas in R0-A's smoke run, is not this one).
/// forge-config: default.evm_version = "osaka"
contract AuditU9ClaudeCreationGasTest is AuditBox0World {
    uint256 internal constant EIP7825_CAP = 16_777_216;

    function _auditN() internal pure override returns (uint256) {
        return 10_000;
    }

    function _auditSpec() internal view override returns (BoxSpecV1.BoxSpec memory s) {
        s = AuditU9ClaudeLargestSpec.largest();
        s.revealRoot = AuditRevealSet.root(10_000);
        // casting to 'uint32' is safe because the world's clock is a 2026 time
        // forge-lint: disable-next-line(unsafe-typecast)
        s.openAt = uint32(vm.getBlockTimestamp() + AUDIT_OPEN_DELAY);
    }

    /// @dev EIP-2028 calldata gas (4 a zero byte, 16 another) and EIP-7623's token count (zero 1, other 4).
    function _calldata(bytes memory data) internal pure returns (uint256 cost, uint256 tokens) {
        for (uint256 i; i < data.length; ++i) {
            if (data[i] == 0) {
                cost += 4;
                tokens += 1;
            } else {
                cost += 16;
                tokens += 4;
            }
        }
    }

    function testProperty_AUDIT_U9_largestSpecCreationGas() public {
        BoxSpecV1.BoxSpec memory s = kit.spec();
        assertEq(s.metadataTable.length, 24_575, "box 0 was created from the largest spec");
        assertEq(collection.collectionSize(), 10_000);
        uint256 execution = kit.creationGas();
        bytes memory data =
            abi.encodeCall(BoxFactoryV1.createBox, (s, kit.hookSalt(), type(FitBuybackExecutor).creationCode));
        (uint256 calldataGas, uint256 tokens) = _calldata(data);
        uint256 standard = 21_000 + calldataGas + execution;
        uint256 floor = 21_000 + 10 * tokens;
        uint256 txGas = standard > floor ? standard : floor;
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint("createBox calldata bytes", data.length);
        emit log_named_uint("createBox execution gas (CoreBox0Kit.create)", execution);
        emit log_named_uint("intrinsic + calldata (EIP-2028)", 21_000 + calldataGas);
        emit log_named_uint("the transaction's gas", txGas);
        emit log_named_uint("EIP-7825 cap", EIP7825_CAP);
        _pin(txGas);
    }

    /// @dev Osaka (today's mainnet schedule): the measured transaction gas, pinned (see the evidence).
    function _pin(uint256 txGas) internal virtual {
        assertGt(txGas, EIP7825_CAP, "the largest accepted spec cannot be created inside EIP-7825's cap");
        assertLt(txGas, 21_500_000, "measured 20,888,874 (execution 20,127,142)");
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU9ClaudeCreationGasAmsterdamTest is AuditU9ClaudeCreationGasTest {
    function _pin(uint256 txGas) internal pure override {
        assertGt(txGas, EIP7825_CAP, "far beyond the cap after Glamsterdam's creation pricing");
    }
}
