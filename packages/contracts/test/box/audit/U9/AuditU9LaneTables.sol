// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

library AuditU9LaneTables {
    function table(uint256 desc, uint256 types, uint256 values, uint256 nameLength, uint256 valueLength)
        internal
        pure
        returns (bytes memory t)
    {
        uint256 length = 4 + desc + types * (2 + nameLength + values * (1 + valueLength));
        require(length <= 24_576 && desc <= type(uint16).max && types <= 17 && values <= 255);
        t = new bytes(length);
        t[0] = 0x01;
        t[1] = bytes1(uint8(desc >> 8));
        t[2] = bytes1(uint8(desc));
        uint256 p = 3;
        for (uint256 i; i < desc; ++i) {
            t[p++] = "D";
        }
        t[p++] = bytes1(uint8(types));
        for (uint256 i; i < types; ++i) {
            t[p++] = bytes1(uint8(nameLength));
            for (uint256 k; k < nameLength; ++k) {
                t[p++] = bytes1(uint8(65 + i));
            }
            t[p++] = bytes1(uint8(values));
            for (uint256 v; v < values; ++v) {
                t[p++] = bytes1(uint8(valueLength));
                for (uint256 k; k < valueLength; ++k) {
                    t[p++] = bytes1(uint8(65 + v % 26));
                }
            }
        }
        assert(p == length);
    }

    /// Three tables at the exact EIP-170 data limit: longest description, most values, widest rendered attributes.
    function maximum(uint256 shape) internal pure returns (bytes memory) {
        if (shape == 0) return table(24_571, 0, 0, 0, 0);
        if (shape == 1) return table(12_299, 16, 255, 255, 1);
        return table(16_363, 16, 1, 255, 255);
    }
}
