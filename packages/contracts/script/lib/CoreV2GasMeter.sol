// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IVmFrameGasV2 {
    struct Gas {
        uint64 gasLimit;
        uint64 gasTotalUsed;
        uint64 gasMemoryUsed;
        int64 gasRefunded;
        uint64 gasRemaining;
        int64 gasStateUsed;
    }

    function lastFrameGas() external view returns (Gas memory gas);
}
