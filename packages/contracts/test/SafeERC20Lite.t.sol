// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SafeERC20Lite} from "../src/libraries/SafeERC20Lite.sol";
import {MockERC20, NoReturnERC20, FalseReturnERC20} from "./utils/MockTokens.sol";

contract SafeERC20LiteCaller {
    function transfer(address token, address to, uint256 amount) external {
        SafeERC20Lite.safeTransfer(token, to, amount);
    }

    function approve(address token, address spender, uint256 amount) external {
        SafeERC20Lite.safeApprove(token, spender, amount);
    }
}

/// @notice Returns 64 bytes from transfer: neither "no value" nor an ABI bool.
contract LongReturnToken {
    function transfer(address, uint256) external pure returns (uint256, uint256) {
        return (1, 1);
    }
}

/// @notice Returns an ABI word that is not 0/1.
contract WeirdBoolToken {
    function transfer(address, uint256) external pure returns (uint256) {
        return 2;
    }
}

contract SafeERC20LiteTest is Test {
    SafeERC20LiteCaller internal caller = new SafeERC20LiteCaller();

    function test_standardAndNoReturnTokensWork() public {
        MockERC20 std = new MockERC20("S", "S");
        NoReturnERC20 nr = new NoReturnERC20();
        std.mint(address(caller), 10);
        nr.mint(address(caller), 10);
        caller.transfer(address(std), address(1), 4);
        caller.transfer(address(nr), address(1), 4);
        caller.approve(address(nr), address(2), 5);
        assertEq(std.balanceOf(address(1)), 4);
        assertEq(nr.balanceOf(address(1)), 4);
        assertEq(nr.allowance(address(caller), address(2)), 5);
    }

    function test_rejectsTargetWithoutCode() public {
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(SafeERC20Lite.TokenCallFailed.selector, eoa, bytes4(0xa9059cbb)));
        caller.transfer(eoa, address(1), 1);
    }

    function test_rejectsFalseOddOrNonBoolReturns() public {
        address[3] memory bad =
            [address(new FalseReturnERC20()), address(new LongReturnToken()), address(new WeirdBoolToken())];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(SafeERC20Lite.TokenCallFailed.selector, bad[i], bytes4(0xa9059cbb)));
            caller.transfer(bad[i], address(1), 1);
        }
    }

    function test_rejectsRevertingTransfer() public {
        MockERC20 std = new MockERC20("S", "S"); // caller has no balance: the token reverts
        vm.expectRevert(
            abi.encodeWithSelector(SafeERC20Lite.TokenCallFailed.selector, address(std), bytes4(0xa9059cbb))
        );
        caller.transfer(address(std), address(1), 1);
    }
}
