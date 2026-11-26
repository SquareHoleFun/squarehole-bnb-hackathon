// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";

/// @notice TEST ONLY. EIP-2935's history contract as the chain has it: its runtime code byte for byte (read with
/// `cast code 0x0000F90827F1C53a10cb7A02335B175320002935` from a local `anvil --hardfork prague`, 2026-10-20; the
/// EIP's Prague code), put at its address, with a block's hash written where the system call writes it (slot
/// number % 8191). The real code serves a block only while `block.number - n <= 8191` and `n < block.number`, and
/// reverts otherwise, so the window the tests meet is the chain's, not a mock's.
library History2935 {
    address internal constant ADDRESS = 0x0000F90827F1C53a10cb7A02335B175320002935;
    uint256 internal constant SERVE_WINDOW = 8191;
    bytes internal constant CODE =
        hex"3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500";

    /// @notice Puts the code in place (once) and records `hash` as block `n`'s.
    function put(Vm vm, uint256 n, bytes32 hash) internal {
        if (ADDRESS.code.length == 0) vm.etch(ADDRESS, CODE);
        vm.store(ADDRESS, bytes32(n % SERVE_WINDOW), hash);
    }
}
