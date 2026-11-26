// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M332Base} from "../../m3-32/Fixture.sol";
import {DefaultArtifacts} from "../../m3-40/DefaultArtifacts.sol";
import {StdCheatsSafe} from "forge-std/StdCheats.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";

/// No hook/checker substitution: these are production admission requirements, not expected refusals.
contract RulesCreationFindingsTest is M332Base, DefaultArtifacts {
    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }
    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }

    function test_R01_itemsOnlyMustCreateWithSourceJournal() public {
        box = _create(_items(1, 0));
        assertTrue(box.roleAddress(16) != address(0));
    }

    function test_R02_mixedItemsMustPassProductionReadbacks() public {
        BoxSpec memory s = _items(1, 0);
        s.sellers.a.leg = 1;
        s.sellers.a.dest = 6;
        s.sellers.a.destParams = abi.encode(uint8(1));
        box = _create(s);
        assertTrue(box.roleAddress(16) != address(0));
        assertTrue(box.roleAddress(17) != address(0));
    }

    function test_R02_seededPileMustPassProductionReadbacks() public {
        box = _create(_pile(address(0), 1 ether));
        assertEq(box.roleAddress(19), box.vault());
    }

    function test_R02_zeroSeedPileMustPassProductionReadbacks() public {
        box = _create(_pile(address(0), 0));
        assertEq(box.roleAddress(19), address(0));
    }
}
