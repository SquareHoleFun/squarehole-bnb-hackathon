// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditRegressMoneyGasSink} from "./MoneyFixture.sol";
import {BoxDrandVectors} from "../../../randomness/utils/BoxDrandVectors.sol";
import {DrandSource} from "../../../../../src/box/randomness/DrandSource.sol";
import {IDrandSource} from "../../../../../src/box/interfaces/IDrandSource.sol";

/// Real committed quicknet signatures and source code. No cryptographic stand-in.
/// forge-config: default.evm_version = "osaka"
contract AuditRegressMoneyBountyTest is BoxDrandVectors {
    DrandSource internal source;
    uint256 internal round;
    address internal poster = makeAddr("money.poster");
    address internal payee = makeAddr("money.bountyPayee");

    function setUp() public {
        _loadBoxDrand();
        round = _localFirst();
        source = new DrandSource();
        vm.warp(source.roundTime(round) - 12);
    }

    function _fundPostAndWithdraw() internal {
        vm.deal(address(this), 8 ether);
        assertEq(source.request{value: 1 ether}(1), round);
        assertEq(source.request{value: 2 ether}(2), round);
        source.addBounty{value: 5 ether}(round);
        assertEq(source.bountyOf(round), 8 ether);
        assertEq(address(source).balance, 8 ether);
        vm.warp(source.roundTime(round));
        vm.prank(poster);
        source.postRound(round, _localSig(0));
        assertEq(source.bountyOf(round), 0);
        assertEq(source.owedTo(poster), 8 ether);
        AuditRegressMoneyGasSink sink = new AuditRegressMoneyGasSink();
        vm.prank(poster);
        vm.expectRevert(IDrandSource.WithdrawFailed.selector);
        source.withdrawBounty{gas: 1_000_000}(payable(address(sink)));
        assertEq(source.owedTo(poster), 8 ether);
        assertEq(address(source).balance, 8 ether);
        vm.prank(poster);
        source.withdrawBounty(payable(payee));
        assertEq(payee.balance, 8 ether);
        assertEq(source.owedTo(poster), 0);
        assertEq(address(source).balance, 0);
    }

    function test_M26_postedBountiesConserveAndRefusedWithdrawalIsAtomic() public {
        _fundPostAndWithdraw();
    }
}
