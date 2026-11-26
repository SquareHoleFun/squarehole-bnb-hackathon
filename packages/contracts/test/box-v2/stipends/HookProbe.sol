// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {BoxHookV2} from "../../../src/box-v2/BoxHookV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/// Test-only entry retaining the production extension, guarded unlock and token path.
contract HookStipendProbe is BoxHookV2 {
    constructor(IPoolManager pm, address c, address ext) BoxHookV2(pm, c, ext) {}

    function measureBurn(uint256 claims, uint256 amount, uint256 cap) external nonReentrant returns (uint256 used) {
        uint256 start = gasleft();
        require(_tryUnlock(_ACT_BURN, abi.encode(claims, amount), cap), "hook burn refused");
        used = start - gasleft();
    }
    function measureTip(address to, uint256 amount, uint256 cap) external nonReentrant returns (uint256 used) {
        uint256 start = gasleft();
        require(_tryUnlock(_ACT_TIP, abi.encode(to, amount), cap), "hook tip refused");
        used = start - gasleft();
    }
}
