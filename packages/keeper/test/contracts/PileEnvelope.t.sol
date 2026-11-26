// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {PileGasTest} from "test/box-v2/pile-fees/Gas.t.sol";
import {IBoxReceiverPileV21} from "src/box-v2/interfaces/IBoxReceiverPileV21.sol";

/// Complete production call with cold shared action code at the unchanged signed keeper floor.
contract KeeperPileModuleEnvelopeTest is PileGasTest {
    function test_FM22_firstLedgerRecipientAtKeeperFloor() public { _floor(true); }
    function test_FM22_existingLedgerRecipientAtKeeperFloor() public { _floor(false); }
    function _floor(bool first) private {
        _linkedPile(first); _fill(); box.graduate(); receiver.collect(address(0));
        uint256 pending = pileFees.pilePendingP();
        uint256 before_ = price.balanceOf(box.vault());
        uint256 supply = price.totalSupply();
        _cold(release.implementations[5]);
        (bool ok, bytes memory result) = address(pileFees).call{gas: 3_500_000 - 21_064}(abi.encodeCall(IBoxReceiverPileV21.moveToPile, ()));
        assertTrue(ok); assertEq(abi.decode(result, (uint256)), pending);
        assertEq(pileFees.pilePendingP(), 0); assertEq(pileFees.pileMovedP(), pending);
        assertEq(price.balanceOf(box.vault()) - before_, pending); assertEq(price.totalSupply(), supply);
        _booked();
    }
}
