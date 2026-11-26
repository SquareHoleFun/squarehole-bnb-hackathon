// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {GasBudget} from "./GasBudget.sol";
import {M132aBase} from "../m1-32a/M132aBase.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";

contract CQ11WCreationGasTest is M132aBase {
    function test_plainOpenArtCreationUnderTenMillion() public {
        BoxSpec memory s = _collectionSpec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 value = factory.boxQParameters(0, s.raise).bootstrapQ;
        bytes memory data = abi.encodeCall(IBoxFactoryV2.createBox, (s, cs, hs));
        _coldRelease();
        vm.prank(CREATOR);
        uint256 start = gasleft();
        (bool ok, bytes memory ret) = address(factory).call{value: value}(data);
        uint256 used = GasBudget.transaction(start - gasleft(), data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        }
        emit log_named_uint("plain open-art creation gas", used);
        assertLt(used, 10_000_000);
        assertLe((used * 125 + 99) / 100, 12_500_000, "sender margin");
        assertEq(registry.boxCount(), 1);
    }
}
