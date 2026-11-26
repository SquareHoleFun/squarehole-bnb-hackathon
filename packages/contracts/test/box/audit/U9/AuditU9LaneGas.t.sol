// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU9LaneBase} from "./AuditU9LaneBase.sol";
import {AuditU9LaneTables} from "./AuditU9LaneTables.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";

/// @notice BC-001/008; F55/F75 W1; EIP-7825 (2^24). Pins accepted maximum-data behaviour, not a new S7 finding.
contract AuditU9LaneGas is AuditU9LaneBase {
    function _largest() internal pure returns (BoxSpecV1.BoxSpec memory s) {
        s = _spec();
        s.n = 10_000;
        s.tokenName = _text(32, "A");
        s.tokenSymbol = _text(11, "A");
        s.collectionName = _text(32, "A");
        s.collectionSymbol = _text(11, "A");
        s.description = _text(1024, "D");
        s.artMode = 2;
        s.revealListId = 0;
        s.addOns = new BoxSpecV1.AddOn[](8);
        s.addOns[0] = BoxSpecV1.AddOn(
            1, abi.encode(_text(32, "A"), _text(11, "A"), _text(1024, "D"), _text(1024, "H"), _text(4096, "S"))
        );
        for (uint256 i = 1; i < 7; ++i) {
            s.addOns[i] = BoxSpecV1.AddOn(3, abi.encode(_text(32, "E"), uint32(10_000)));
        }
        bytes32[] memory teasers = new bytes32[](4);
        for (uint256 i; i < 4; ++i) {
            teasers[i] = bytes32(i + 1);
        }
        s.addOns[7] =
            BoxSpecV1.AddOn(6, abi.encode(bytes32(uint256(1)), teasers, string.concat("https://", _text(120, "a"))));
    }

    function measuredValidate(BoxSpecV1.BoxSpec memory s) external view returns (uint16 r, uint16 f, uint256 used) {
        BoxSpecV1.VersionContext memory ctx = BoxSpecV1.contextV1();
        uint256 before = gasleft();
        (r, f) = BoxSpecV1.validate(s, ctx);
        used = before - gasleft();
    }

    function _measure(string memory fork) internal {
        vm.setEvmVersion(fork);
        BoxSpecV1.BoxSpec memory s = _largest();
        for (uint256 shape; shape < 3; ++shape) {
            s.metadataTable = AuditU9LaneTables.maximum(shape);
            assertEq(s.metadataTable.length, 24_575);
            bytes memory callData = abi.encodeCall(this.measuredValidate, (s));
            uint256 intrinsic = 21_000;
            for (uint256 j; j < callData.length; ++j) {
                intrinsic += callData[j] == 0 ? 4 : 16;
            }
            uint256 before = gasleft();
            (uint16 r, uint16 f, uint256 used) = this.measuredValidate(s);
            uint256 externalUsed = before - gasleft();
            assertEq(r, 0);
            assertEq(f, 0);
            // Gross charge (including cold standalone calldata intrinsic) is a conservative transaction estimate.
            uint256 gross = externalUsed + intrinsic;
            emit log_named_string("fork", fork);
            emit log_named_uint("table shape", shape);
            emit log_named_uint("encoded spec bytes", abi.encode(s).length);
            emit log_named_uint("validate body gas", used);
            emit log_named_uint("validate call plus intrinsic", gross);
            emit log_named_uint("EIP-7825 remaining gas", (1 << 24) - gross);
            assertLt(gross, 1 << 24);
            assertLt(used, 5_500_000, "measured maximum-data validation bound");
            assertLt(gross, 6_200_000, "call and intrinsic bound");
        }
    }

    function testProperty_AUDIT_U9_largestSpecGasOsaka() public {
        _measure("osaka");
    }

    function testProperty_AUDIT_U9_largestSpecGasAmsterdam() public {
        _measure("amsterdam");
    }
}
