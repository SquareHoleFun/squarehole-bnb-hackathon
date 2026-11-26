// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {MockAllowance, MockSafe, MockToken} from "./AllowanceFixture.sol";

interface VmAgents {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
}

// Runs the stand-in semantics without a listener as well as through the JavaScript Anvil suite.
contract AllowanceFixtureTest {
    VmAgents private constant vm = VmAgents(address(uint160(uint256(keccak256("hevm cheat code")))));
    MockAllowance private module;
    MockSafe private safe;
    MockToken private token;
    address private constant manager = address(10);
    address private constant cleaner = address(11);
    function setUp() public {
        module = new MockAllowance(); safe = new MockSafe(address(module)); token = new MockToken();
        token.mint(address(safe), 1000000000);
        module.setAllowance(address(safe), manager, address(token), 300000000);
    }
    function pay(uint96 amount) private {
        vm.prank(manager);
        module.executeAllowanceTransfer(address(safe), address(token), cleaner, amount, address(0), 0, manager, "");
    }
    function testWeeklyCapAndReset() public {
        pay(300000000);
        require(token.balanceOf(cleaner) == 300000000);
        vm.expectRevert(); pay(1);
        vm.warp(block.timestamp + 7 days);
        pay(300000000);
        require(token.balanceOf(cleaner) == 600000000);
    }
    function testManagerCannotTransferDirectlyFromSafeOrImpersonateDelegate() public {
        vm.expectRevert(); vm.prank(manager);
        safe.transferFromModule(address(token), cleaner, 1);
        vm.expectRevert();
        module.executeAllowanceTransfer(address(safe), address(token), cleaner, 1, address(0), 0, manager, "");
    }
    function testFuzzCap(uint96 amount) public {
        if (amount > 300000000) { vm.expectRevert(); pay(amount); }
        else { pay(amount); require(token.balanceOf(cleaner) == amount); }
    }
}
