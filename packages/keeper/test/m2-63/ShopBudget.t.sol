// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M244Base} from "test/box-v2/m2-44/Fixture.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract M263ShopBudgetTest is M244Base {
    // Pinned to transactionGas(shopBurn, 30000) by offchain.test.ts. A no-op succeeds at low gas,
    // so an RPC estimate need not include either optional burn. The transaction floor must activate them.
    uint256 constant KEEPER_FLOOR = 5_000_000;

    function _failedShop() private {
        _createShop(0, 1000 ether, false, false);
        vm.prank(CREATOR); token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        assertEq(shop.failedT(), 1100 ether);
    }

    function test_OC03_keeperEnvelopeMustAdvanceAvailableBurn() public {
        _failedShop();
        (bool ok, bytes memory result) = address(shop).call{gas: KEEPER_FLOOR}(abi.encodeCall(shop.burnFailedT, ()));
        assertTrue(ok, "call succeeds even when optional work is skipped");
        assertEq(abi.decode(result, (uint256)), 1100 ether, "keeper must burn available excluded T");
    }

    function test_OC03_localFiveMillionEnvelopeCompletesSameBurn() public {
        _failedShop();
        (, uint256 left) = box.claimState();
        uint256 supply = token.totalSupply();
        (bool ok, bytes memory result) = address(shop).call{gas: 5_000_000}(abi.encodeCall(shop.burnFailedT, ()));
        assertTrue(ok); assertEq(abi.decode(result, (uint256)), 1100 ether);
        assertEq(shop.failedT(), 0); assertEq(token.totalSupply(), supply - 1100 ether);
        (, uint256 afterLeft) = box.claimState(); assertEq(afterLeft, left);
        assertEq(shop.burnFailedT(), 0, "retry cannot burn twice");
    }
}
