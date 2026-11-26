// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MockTetherUSD} from "../../src/testnet/MockTetherUSD.sol";

/// @notice Unit tests of the testnet mock USDT (SH-B2 Build B item 7): mainnet USDT's quirks (no return values,
/// approve-from-non-zero, uint256 decimals, max allowance, pause, sender blacklist, fee parameters, short payload) and
/// the public capped faucet. The mainnet-fork differential against the real USDT is in test/fork.
contract MockTetherUSDTest is Test {
    MockTetherUSD internal usdt;
    address internal issuer = makeAddr("issuer");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal spender = makeAddr("spender");

    function setUp() public {
        usdt = new MockTetherUSD(issuer);
        vm.warp(1_790_000_000);
    }

    function _faucet(address to, uint256 amount) internal {
        vm.prank(to);
        usdt.faucet(amount);
    }

    function _call(address from, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(from);
        (ok, ret) = address(usdt).call(data);
    }

    function test_metadata_isClearlyLabelledAndSixDecimalsAsUint256() public {
        assertEq(usdt.name(), "Test Tether USD (Square Hole mock)");
        assertEq(usdt.symbol(), "USDT-TEST");
        (bool ok, bytes memory ret) = address(usdt).staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok);
        assertEq(ret.length, 32);
        assertEq(abi.decode(ret, (uint256)), 6);
        assertEq(usdt.owner(), issuer);
        assertEq(usdt.totalSupply(), 0, "no premint: supply only from the faucet");
        vm.expectRevert(MockTetherUSD.ZeroAddress.selector);
        new MockTetherUSD(address(0));
    }

    function test_transferFunctions_returnNoData() public {
        _faucet(alice, 1_000e6);
        (bool ok, bytes memory ret) = _call(alice, abi.encodeWithSelector(0xa9059cbb, bob, 1e6));
        assertTrue(ok);
        assertEq(ret.length, 0, "transfer returns nothing");
        (ok, ret) = _call(alice, abi.encodeWithSelector(0x095ea7b3, spender, 5e6));
        assertTrue(ok);
        assertEq(ret.length, 0, "approve returns nothing");
        (ok, ret) = _call(spender, abi.encodeWithSelector(0x23b872dd, alice, bob, 2e6));
        assertTrue(ok);
        assertEq(ret.length, 0, "transferFrom returns nothing");
        assertEq(usdt.balanceOf(bob), 3e6);
        assertEq(usdt.allowance(alice, spender), 3e6);
    }

    function test_approve_fromNonZeroToNonZeroReverts() public {
        vm.startPrank(alice);
        usdt.approve(spender, 5e6);
        vm.expectRevert(MockTetherUSD.ApproveFromNonZero.selector);
        usdt.approve(spender, 6e6);
        usdt.approve(spender, 0);
        usdt.approve(spender, 6e6);
        vm.stopPrank();
        assertEq(usdt.allowance(alice, spender), 6e6);
    }

    function test_maxAllowance_isNeverReduced_finiteAllowanceIs() public {
        _faucet(alice, 100e6);
        vm.prank(alice);
        usdt.approve(spender, type(uint256).max);
        vm.prank(spender);
        usdt.transferFrom(alice, bob, 10e6);
        assertEq(usdt.allowance(alice, spender), type(uint256).max);
        vm.prank(alice);
        usdt.approve(spender, 0);
        vm.prank(alice);
        usdt.approve(spender, 15e6);
        vm.prank(spender);
        usdt.transferFrom(alice, bob, 10e6);
        assertEq(usdt.allowance(alice, spender), 5e6);
        vm.prank(spender);
        vm.expectRevert(MockTetherUSD.InsufficientAllowance.selector);
        usdt.transferFrom(alice, bob, 6e6);
    }

    function test_pause_blocksTransfersNotApprovals_ownerOnly() public {
        _faucet(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(MockTetherUSD.NotOwner.selector);
        usdt.pause();
        vm.prank(issuer);
        usdt.pause();
        vm.prank(alice);
        vm.expectRevert(MockTetherUSD.Paused.selector);
        usdt.transfer(bob, 1e6);
        vm.prank(alice);
        usdt.approve(spender, 1e6); // approve is not paused (mainnet)
        vm.prank(spender);
        vm.expectRevert(MockTetherUSD.Paused.selector);
        usdt.transferFrom(alice, bob, 1e6);
        vm.prank(issuer);
        usdt.unpause();
        vm.prank(spender);
        usdt.transferFrom(alice, bob, 1e6);
        assertEq(usdt.balanceOf(bob), 1e6);
    }

    /// Mainnet semantics: the blacklist blocks a blacklisted SENDER (transfer from it, transferFrom of its funds);
    /// receiving is not blocked. The issuer can destroy a blacklisted account's funds.
    function test_blacklist_blocksTheSenderOnly_andFundsCanBeDestroyed() public {
        _faucet(alice, 100e6);
        _faucet(bob, 100e6);
        vm.prank(alice);
        vm.expectRevert(MockTetherUSD.NotOwner.selector);
        usdt.addBlackList(bob);
        vm.prank(issuer);
        usdt.addBlackList(bob);
        assertTrue(usdt.getBlackListStatus(bob));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(MockTetherUSD.BlackListed.selector, bob));
        usdt.transfer(alice, 1e6);
        vm.prank(bob);
        usdt.approve(spender, 5e6);
        vm.prank(spender);
        vm.expectRevert(abi.encodeWithSelector(MockTetherUSD.BlackListed.selector, bob));
        usdt.transferFrom(bob, alice, 1e6);
        vm.prank(alice);
        usdt.transfer(bob, 1e6); // receiving is allowed
        assertEq(usdt.balanceOf(bob), 101e6);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(MockTetherUSD.NotBlackListed.selector, alice));
        usdt.destroyBlackFunds(alice);
        uint256 supply = usdt.totalSupply();
        vm.prank(issuer);
        usdt.destroyBlackFunds(bob);
        assertEq(usdt.balanceOf(bob), 0);
        assertEq(usdt.totalSupply(), supply - 101e6);
        vm.prank(issuer);
        usdt.removeBlackList(bob);
        assertFalse(usdt.isBlackListed(bob));
    }

    function test_feeParams_cappedAndPaidToTheOwner() public {
        vm.startPrank(issuer);
        vm.expectRevert(MockTetherUSD.FeeParamsTooHigh.selector);
        usdt.setParams(20, 10);
        vm.expectRevert(MockTetherUSD.FeeParamsTooHigh.selector);
        usdt.setParams(10, 50);
        usdt.setParams(19, 49);
        vm.stopPrank();
        assertEq(usdt.maximumFee(), 49e6);
        _faucet(alice, 10_000e6);
        vm.prank(alice);
        usdt.transfer(bob, 1_000e6); // fee 1.9 USDT
        assertEq(usdt.balanceOf(bob), 1_000e6 - 1.9e6);
        assertEq(usdt.balanceOf(issuer), 1.9e6);
        vm.prank(alice);
        usdt.transfer(bob, 8_000e6 - 1_000e6); // fee 13.3
        assertEq(usdt.balanceOf(issuer), 1.9e6 + 13.3e6);
        vm.prank(issuer);
        usdt.setParams(19, 1); // the cap binds
        vm.prank(bob);
        usdt.transfer(alice, 5_000e6);
        assertEq(usdt.balanceOf(issuer), 1.9e6 + 13.3e6 + 1e6);
    }

    /// Mainnet's `onlyPayloadSize`: short calldata reverts (Solidity 0.8's ABI decoder, empty revert data).
    function test_shortPayload_reverts() public {
        _faucet(alice, 100e6);
        bytes memory short = abi.encodePacked(bytes4(0xa9059cbb), bytes32(uint256(uint160(bob))), bytes16(0));
        (bool ok, bytes memory ret) = _call(alice, short);
        assertFalse(ok);
        assertEq(ret.length, 0);
        assertEq(usdt.balanceOf(bob), 0);
    }

    function test_faucet_capsCooldownAndLifetime() public {
        vm.expectRevert(abi.encodeWithSelector(MockTetherUSD.FaucetAmount.selector, 0));
        _faucet(alice, 0);
        vm.expectRevert(abi.encodeWithSelector(MockTetherUSD.FaucetAmount.selector, 10_000e6 + 1));
        _faucet(alice, 10_000e6 + 1);
        vm.expectEmit(address(usdt));
        emit MockTetherUSD.FaucetMint(alice, 10_000e6);
        _faucet(alice, 10_000e6);
        assertEq(usdt.balanceOf(alice), 10_000e6);
        vm.expectRevert(abi.encodeWithSelector(MockTetherUSD.FaucetCooldown.selector, block.timestamp + 1 hours));
        _faucet(alice, 1e6);
        vm.warp(block.timestamp + 1 hours);
        _faucet(alice, 1e6);
        assertEq(usdt.faucetMinted(), 10_001e6);
        vm.prank(issuer);
        usdt.addBlackList(bob);
        vm.expectRevert(abi.encodeWithSelector(MockTetherUSD.BlackListed.selector, bob));
        _faucet(bob, 1e6);
        // Lifetime cap: 100,000 addresses × 10,000 = 1e9 tokens exactly; the next raw unit is refused.
        vm.store(address(usdt), bytes32(uint256(2)), bytes32(usdt.FAUCET_TOTAL_CAP() - 5e6)); // faucetMinted slot
        assertEq(usdt.faucetMinted(), usdt.FAUCET_TOTAL_CAP() - 5e6, "slot layout");
        _faucet(makeAddr("late1"), 5e6);
        vm.expectRevert(MockTetherUSD.FaucetExhausted.selector);
        _faucet(makeAddr("late2"), 1);
    }

    function test_ownership_transfer() public {
        vm.prank(alice);
        vm.expectRevert(MockTetherUSD.NotOwner.selector);
        usdt.transferOwnership(alice);
        vm.prank(issuer);
        vm.expectRevert(MockTetherUSD.ZeroAddress.selector);
        usdt.transferOwnership(address(0));
        vm.prank(issuer);
        usdt.transferOwnership(alice);
        assertEq(usdt.owner(), alice);
        vm.prank(issuer);
        vm.expectRevert(MockTetherUSD.NotOwner.selector);
        usdt.pause();
    }

    function testFuzz_transfers_conserveSupply(uint256 a, uint256 b, uint256 bps, uint256 maxFee) public {
        bps = bound(bps, 0, 19);
        maxFee = bound(maxFee, 0, 49);
        vm.prank(issuer);
        usdt.setParams(bps, maxFee);
        _faucet(alice, 10_000e6);
        a = bound(a, 0, 10_000e6);
        vm.prank(alice);
        usdt.transfer(bob, a);
        b = bound(b, 0, usdt.balanceOf(bob));
        vm.prank(bob);
        usdt.approve(spender, b);
        vm.prank(spender);
        usdt.transferFrom(bob, alice, b);
        assertEq(usdt.balanceOf(alice) + usdt.balanceOf(bob) + usdt.balanceOf(issuer), usdt.totalSupply());
    }
}
