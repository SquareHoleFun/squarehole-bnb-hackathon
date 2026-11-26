// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {GasBudget} from "../gas/GasBudget.sol";

// G1-D1: exact per-shape transaction-gas pins on both EVMs, without rounding headroom.
// RC6-CC: the added receiver preview selector changes creation dispatch by 23 gas on both EVMs.
// RC6-INT part 2: every box now also creates its income inbox; the merged release is measured on both EVMs.
// RC6-CREATION-GAS rechecks these unchanged non-Shop pins; local/release suites measure the Shop recipes.
// RC7-INBOX-PAYLOAD: removing signedCoin(bytes) reverses rc6's dispatch cost: every creation is 44 gas cheaper on both EVMs.
// RC7-RECEIVER-QUOTA: the additive receiver selector changes creation-time dispatch; with the payload's change, measured on the merged tree (SH-V21-RC7-INT part 3).
contract FeeCreationGasTest is M363Base {
    function test_FM16_eatCreation() public { BoxSpec memory s = _spec(); s.buyers.a = Branch(1, 1, "", ""); _creation(s, "eat", 2_420_798, 7_528_670); }
    function test_FM16_holdersTCreation() public { BoxSpec memory s = _spec(); s.buyers.a = Branch(2, 6, "", abi.encode(uint8(2))); _creation(s, "holders T", 3_143_343, 10_832_411); }
    function test_FM16_itemsTCreation() public { BoxSpec memory s = _items(1, 1); s.buyers.a = Branch(2, 8, "", abi.encode(uint8(1))); _creation(s, "items T", 3_281_715, 11_402_579); }
    function test_IP18_itemsDepthTCreation() public { BoxSpec memory s = _items(1, 1); s.buyers.a = Branch(2, 8, "", abi.encode(uint8(3))); _creation(s, "Depth items T", 3_282_503, 11_403_367); }
    function test_FM16_pileCreation() public { BoxSpec memory s = _pile(address(0), 0); s.buyers.a = Branch(1, 7, "", ""); _creation(s, "pile", 2_566_999, 8_165_637); }
    function _creation(BoxSpec memory s, string memory label, uint256 original, uint256 originalAmsterdam) private {
        bytes memory init = hex"6104006000f3";
        uint256 probe = gasleft();
        assembly ("memory-safe") { pop(create(0, add(init, 32), mload(init))) }
        bool amsterdam = probe - gasleft() > 500_000;
        (bytes32 cs, bytes32 hs) = _salts(s);
        bytes memory data = abi.encodeCall(IBoxFactoryV2.createBox, (s, cs, hs));
        uint256 value = factory.boxQParameters(0, s.raise).bootstrapQ;
        _coldRelease();
        vm.prank(CREATOR);
        uint256 before_ = gasleft();
        (bool ok, bytes memory ret) = address(factory).call{value: value}(data);
        uint256 used = GasBudget.transaction(before_ - gasleft(), data);
        if (!ok) assembly ("memory-safe") { revert(add(ret, 32), mload(ret)) }
        emit log_named_uint(label, used);
        assertEq(used, amsterdam ? originalAmsterdam : original, "exact creation gas pin");
        assertLe(used, 16_660_680, "existing creation envelope");
    }
}
