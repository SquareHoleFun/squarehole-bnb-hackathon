// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M332Base, LifeCustody} from "../m3-32/Fixture.sol";
import {DefaultArtifacts} from "../m3-40/DefaultArtifacts.sol";
import {StdCheatsSafe} from "forge-std/StdCheats.sol";

/// Production release artifacts only; no hook, extension, checker or coordinator substitution.
abstract contract M363Base is M332Base, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }
    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
