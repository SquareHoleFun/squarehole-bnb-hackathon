// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M332Base} from "../../m3-32/Fixture.sol";
import {DefaultArtifacts} from "../../m3-40/DefaultArtifacts.sol";
import {StdCheatsSafe} from "forge-std/StdCheats.sol";
import {GasBudget} from "../GasBudget.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxFactoryV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

/// Production-only control: no S6 hook/checker or cap substitution in the plain open-art gate.
contract M360PlainCreationTest is M332Base, DefaultArtifacts {
    function deployCode(string memory name, bytes memory args)
        internal
        override(StdCheatsSafe, DefaultArtifacts)
        returns (address)
    {
        return DefaultArtifacts.deployCode(name, args);
    }

    function deployCode(string memory name) internal override(StdCheatsSafe, DefaultArtifacts) returns (address) {
        return DefaultArtifacts.deployCode(name);
    }

    function test_productionPlainOpenArtBelow10M() public {
        BoxSpec memory s = _collectionSpec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 value = factory.boxQParameters(0, s.raise).bootstrapQ;
        bytes memory data = abi.encodeCall(IBoxFactoryV2.createBox, (s, cs, hs));
        _coldRelease();
        vm.prank(CREATOR);
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory ret) =
            address(factory).call{value: value, gas: 10_000_000 - GasBudget.intrinsic(data)}(data);
        uint256 used = GasBudget.transaction(beforeGas - gasleft(), data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        }
        emit log_named_uint("production plain open art", used);
        assertLt(used, 10_000_000);
        assertEq(registry.boxCount(), 1);
    }
}
