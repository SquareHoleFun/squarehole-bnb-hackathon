// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M263LifecycleTest} from "../../m2-63/money/Lifecycle.t.sol";
import {DefaultArtifacts} from "../../m3-40/DefaultArtifacts.sol";
import {StdCheatsSafe} from "forge-std/StdCheats.sol";

/// Recheck all twelve failure routes/decimal combinations with default production artifacts.
contract FinalMoneyShopFailureLifecycleTest is M263LifecycleTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }
    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
