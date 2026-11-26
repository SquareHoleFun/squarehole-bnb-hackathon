// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

contract ClaimCycle {
    IPoolManager immutable pm;

    constructor(IPoolManager p) {
        pm = p;
    }

    function deposit(uint256 amount) external {
        pm.unlock(abi.encode(true, amount));
    }

    function withdraw(uint256 amount) external {
        pm.unlock(abi.encode(false, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (bool put, uint256 amount) = abi.decode(data, (bool, uint256));
        if (put) {
            pm.settle{value: amount}();
            pm.mint(address(this), 0, amount);
        } else {
            pm.burn(address(this), 0, amount);
            pm.take(Currency.wrap(address(0)), address(this), amount);
        }
        return "";
    }
    receive() external payable {}
}

/// Measures the next actual claim-credit write with zero versus one unit retained, with equally cold accounts.
/// This experiment does not pretend a sentinel is spendable or change the receiver's accounting policy.
contract SentinelGasTest is Test {
    function test_oneUnitClaimSentinelNextDeposit() public {
        IPoolManager pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        ClaimCycle empty = new ClaimCycle(pm);
        ClaimCycle kept = new ClaimCycle(pm);
        vm.deal(address(empty), 3 ether);
        vm.deal(address(kept), 3 ether);
        empty.deposit(1 ether);
        kept.deposit(1 ether);
        empty.withdraw(1 ether);
        kept.withdraw(1 ether - 1);
        vm.cool(address(pm));
        vm.cool(address(empty));
        uint256 before_ = gasleft();
        empty.deposit(1 ether);
        uint256 zero = before_ - gasleft();
        vm.cool(address(pm));
        vm.cool(address(kept));
        before_ = gasleft();
        kept.deposit(1 ether);
        uint256 one = before_ - gasleft();
        emit log_named_uint("claim deposit after zero", zero);
        emit log_named_uint("claim deposit after one", one);
        assertLt(one, zero);
        assertEq(pm.balanceOf(address(kept), 0), 1 ether + 1);
        assertEq(pm.balanceOf(address(empty), 0), 1 ether);
    }
}
