// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdCheatsSafe} from "forge-std/StdCheats.sol";
import {DefaultArtifacts} from "./DefaultArtifacts.sol";

import {M332Base} from "../m3-32/Fixture.sol";

/// Production coordinator, factory, PM and M3 parts. Only the unowned S6 hook/checker
/// handoffs use M3-32's explicit doubles. The coordinator is never replaced or patched.
abstract contract M340Base is M332Base, DefaultArtifacts {

    function deployCode(string memory what, bytes memory args)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what, args); }

    function deployCode(string memory what)
        internal override(StdCheatsSafe, DefaultArtifacts) returns (address)
    { return DefaultArtifacts.deployCode(what); }

    function setUp() public virtual override {
        super.setUp();
        address checker = deployCode("BoxFactoryV2ChecksM332Double.sol:BoxFactoryV2ChecksM332Double");
        vm.etch(address(factory.checks()), checker.code);
    }

    function _hookCode() internal pure override returns (string memory) {
        return "BoxHookV2M332Double.sol:BoxHookV2M332Double";
    }

    function _extensionCode() internal pure override returns (string memory) {
        return "BoxHookV2ExtensionM332Double.sol:BoxHookV2ExtensionM332Double";
    }
}
