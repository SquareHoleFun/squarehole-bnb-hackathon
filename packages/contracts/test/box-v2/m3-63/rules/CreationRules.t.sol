// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M332BoundariesTest} from "../../m3-32/Boundaries.t.sol";
import {M340CreationTest} from "../../m3-40/Creation.t.sol";
import {M340BoundariesTest} from "../../m3-40/Boundaries.t.sol";
import {DefaultArtifacts} from "../../m3-40/DefaultArtifacts.sol";
import {StdCheatsSafe} from "forge-std/StdCheats.sol";

// Production provenance tests use the untouched hook/checker. Successful lifecycle tests below use
// M340Base's named hook/checker handoffs; the real coordinator is never replaced.
contract RulesCloneIdentityTest is M332BoundariesTest, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }
    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }
}
contract RulesCreationTest is M340CreationTest {}
contract RulesRoleAliasTest is M340BoundariesTest {}
