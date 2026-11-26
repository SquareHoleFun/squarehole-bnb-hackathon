// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IPairedVaultFactory: what a launcher factory reads from the vault factory it is paired with
/// @notice Each of our vault factories serves exactly one launcher factory, fixed at its construction (Flap's
/// pre-audit R3, after Flap's own `CrowdVaultFactory.launcherFactory`): its `newVault` refuses a launch whose caller the
/// Portal did not record as created by that launcher factory. The launcher factory checks, in its own constructor,
/// that the vault factory names it, so a pair that does not match cannot be deployed.
interface IPairedVaultFactory {
    function hub() external view returns (address);
    function pairedLauncherFactory() external view returns (address);
}
