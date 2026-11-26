// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {ShopLimitsV2 as L} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";

/// TEST ONLY stipend double. Walk opcodes (never matching PUSH payloads), pinning each PUSH3 count.
/// Preserves all real shop accounting, authentication, immutables and nested calls; no source file changes.
/// Measured caps are integrated in production. Half-cap executions prove strict-case 2x headroom.
abstract contract M260CapDouble is Test {
    uint256 internal constant LIQUID = 1_250_000;
    uint256 internal constant CLAIMS = 2_500_000;
    uint256 internal constant RETURN = 800_000;

    function _replaceCap(bytes memory code, uint256 oldCap, uint256 newCap, uint256 expected) internal pure returns (bytes memory) {
        uint256 count;
        for (uint256 i; i < code.length; ++i) {
            uint8 op = uint8(code[i]);
            if (op == 0x62 && i + 3 < code.length) {
                uint256 value = (uint256(uint8(code[i+1])) << 16) | (uint256(uint8(code[i+2])) << 8) | uint8(code[i+3]);
                if (value == oldCap) {
                    code[i+1] = bytes1(uint8(newCap >> 16)); code[i+2] = bytes1(uint8(newCap >> 8));
                    code[i+3] = bytes1(uint8(newCap)); ++count;
                }
            }
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
        }
        require(count == expected, "stipend double instruction count changed");
        return code;
    }
    function _shopCaps(address implementation, bool half) internal {
        uint256 divisor = half ? 2 : 1;
        // FINAL2-GAS decouples each measured shop allowance from the shared hook burn cap.
        assertEq(CLAIMS, 2 * LIQUID);
        assertEq(RETURN, L.NFT_RETURN_GAS);
        bytes memory code = _replaceCap(implementation.code, LIQUID, LIQUID / divisor, 1);
        code = _replaceCap(code, CLAIMS, CLAIMS / divisor, 1);
        code = _replaceCap(code, L.NFT_RETURN_GAS, L.NFT_RETURN_GAS / divisor, 1);
        vm.etch(implementation, code);
    }
}
