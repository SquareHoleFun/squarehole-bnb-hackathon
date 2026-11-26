// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MoneyFixture} from "../m1-61/MoneyFixture.sol";

/// @dev A vault shell whose failure entry runs one call. The coordinator calls `vault.enterFailure()` after it has
/// recorded the failure and before `receiver.enterFailure()`, so this call runs in the window where the coordinator is
/// failed and the receiver is not yet settled (as a hostile price coin or an item callback could).
contract WindowVault {
    uint256 public windowEnds;
    address public target;
    bytes public data;
    bool public called;
    bytes public result;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
    }

    function escrowSurplus() external pure returns (uint256, uint256) {
        return (0, 0);
    }

    function enterFailure() external {
        windowEnds = block.timestamp + 14 days;
        if (target == address(0)) return;
        (called, result) = target.call(data);
    }
}

/// @notice RC5 C supersedes the non-P lock: the receiver rejects foreign intake in every phase.
/// Router payee claims in every phase are exercised with real boxes in life/RoyaltyLife.t.sol.
contract FailedBoxRoyaltiesTest is MoneyFixture {
    function test_foreignRoyaltyRejectedAfterFailureAndYearsLater() public {
        _fail(100, 100); uint256 pot = _pot();
        _royaltyForeign(17);
        vm.warp(block.timestamp + 1000 days); _royaltyForeign(23);
        assertEq(foreignCoin.balanceOf(address(this)), 40);
        assertEq(foreignCoin.balanceOf(address(fees)), 0);
        assertEq(foreignCoin.balanceOf(CONVERSION), 0);
        assertEq(_pot(), pot);
    }
    function test_nonPriceEtherRejectedAfterFailure() public {
        _fail(100, 100); vm.deal(address(this), 19);
        vm.expectRevert(); fees.fundRoyalty{value: 19}(address(0), 19);
        assertEq(CONVERSION.balance, 0); assertEq(address(fees).balance, 0);
    }
    function test_rejectedBeforeFailureStillBelongsToSender() public {
        _royaltyForeign(23); _fail(100, 100); _royaltyForeign(2);
        assertEq(foreignCoin.balanceOf(address(this)), 25);
        assertEq(foreignCoin.balanceOf(CONVERSION), 0);
    }
    function test_noForeignIntakeWhileFailureIsBeingSettled() public {
        WindowVault window = WindowVault(address(vault));
        vm.etch(address(window), address(new WindowVault()).code);
        window.arm(address(fees), abi.encodeCall(fees.fundRoyalty, (address(foreignCoin), 0)));
        _fail(100, 100);
        assertFalse(window.called(), "foreign intake reverts in the failure window");
        assertGt(window.result().length, 0, "the attempted call returned a refusal");
        assertEq(foreignCoin.balanceOf(CONVERSION), 0);
    }
    function test_priceRoyaltiesAfterFailureJoinPot() public {
        _fail(100, 100); uint256 pot = _pot(); _royaltyP(13);
        assertEq(_pot(), pot + 13); assertEq(fees.fitOwed(), 0);
        assertEq(_claim(ALICE, 100, ALICE), pot + 13);
    }
}
