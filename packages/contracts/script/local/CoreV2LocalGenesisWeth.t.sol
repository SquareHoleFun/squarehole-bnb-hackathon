// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoreV2LocalGenesis} from "./CoreV2LocalGenesis.s.sol";

/// @dev WETH9's surface as the income inbox and CoW's VaultRelayer use it.
interface ILocalWeth9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

contract LocalGenesisBootHarness is CoreV2LocalGenesis {
    function boot(address deployer, address actor, address backup) external {
        _bootstrap(deployer, actor, backup);
    }
}

/// SH-RC7 open item 14 (SH-V21-RC6-INT P3.6, P3.10 item 6): the local stack's genesis WETH is an ERC-20 like WETH9, so
/// an inbox's `refreshOrder(WETH)` can read and set its VaultRelayer allowance. Before, `MockWETH` had no `approve` or
/// `allowance` and the refresh reverted `TokenUnreadable`. Runs the genesis's own bootstrap, as `rehearse()` does.
contract CoreV2LocalGenesisWethTest is Test {
    address private constant DEPLOYER = address(0xDE0107);

    function test_RC7_ITEM14_localGenesisWethIsAnErc20Weth9() public {
        vm.chainId(11_155_111);
        vm.warp(1_790_000_000);
        vm.roll(16);
        vm.deal(DEPLOYER, 100 ether);
        new LocalGenesisBootHarness().boot(DEPLOYER, address(0xA11CE), address(0xB0B));
        // The genesis's fifth CREATE (after the FIT, conversion and platform custodies and the PoolManager): the WETH the
        // local core v1 and the v2 release name, at the same address as before.
        ILocalWeth9 weth = ILocalWeth9(vm.computeCreateAddress(DEPLOYER, 4));
        assertGt(address(weth).code.length, 0, "genesis WETH");

        address inbox = makeAddr("inbox");
        address relayer = makeAddr("relayer");
        address buyer = makeAddr("buyer");
        vm.deal(inbox, 1 ether);
        vm.startPrank(inbox);
        weth.deposit{value: 0.06 ether}();
        // What refreshOrder reads and sets: the VaultRelayer's allowance, by approve.
        assertTrue(weth.approve(relayer, 0.05 ether));
        vm.stopPrank();
        assertEq(weth.allowance(inbox, relayer), 0.05 ether);

        vm.prank(relayer);
        assertTrue(weth.transferFrom(inbox, buyer, 0.05 ether));
        assertEq(weth.allowance(inbox, relayer), 0);
        assertEq(weth.balanceOf(buyer), 0.05 ether);
        assertEq(weth.balanceOf(inbox), 0.01 ether);
        vm.prank(relayer);
        vm.expectRevert();
        weth.transferFrom(inbox, buyer, 1);

        vm.prank(buyer);
        weth.withdraw(0.05 ether);
        assertEq(buyer.balance, 0.05 ether);
        assertEq(weth.balanceOf(buyer), 0);
        // Plain ETH wraps, as WETH9's receive does; and its metadata reads as WETH9's.
        vm.prank(inbox);
        (bool sent,) = address(weth).call{value: 0.01 ether}("");
        assertTrue(sent, "receive wraps ETH");
        assertEq(weth.balanceOf(inbox), 0.02 ether);
        assertEq(weth.decimals(), 18);
        assertEq(weth.symbol(), "WETH");
    }
}
