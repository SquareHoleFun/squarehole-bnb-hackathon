// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
// CQ11-B: non-P forwarding is atomic even if the token lies, burns gas or reenters.
import {ReceiverFixture} from "../cq11-b/ReceiverFixture.sol";

contract RoyaltyToxicToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public mode;
    address public safe;
    address public reenter;

    function script(uint8 m, address s, address r) external {
        mode = m;
        safe = s;
        reenter = r;
    }

    function mint(address to, uint256 n) external {
        balanceOf[to] += n;
    }

    function approve(address to, uint256 n) external returns (bool) {
        allowance[msg.sender][to] = n;
        return true;
    }

    function transferFrom(address from, address to, uint256 n) external returns (bool) {
        allowance[from][msg.sender] -= n;
        balanceOf[from] -= n;
        balanceOf[to] += n;
        return true;
    }

    function transfer(address to, uint256 n) external returns (bool) {
        if (to == safe) {
            if (mode == 1) {
                assembly { for {} 1 {} {} }
            }
            if (mode == 2) return false;
            if (mode == 3) return true;
            if (mode == 4) {
                (bool ok,) = reenter.call(abi.encodeWithSignature("claimInKind(address)", address(this)));
                require(ok, "reentered");
            }
            if (mode == 5) {
                assembly { return(0, 1000000) }
            }
        }
        balanceOf[msg.sender] -= n;
        balanceOf[to] += n;
        return true;
    }
}

contract ReceiverForwardTest is ReceiverFixture {
    function test_RC5_foreignRoyaltyRejectedBeforeCustody() public {
        uint256 beforeBalance = address(r).balance;
        (bool ok,) = address(r).call(abi.encodeWithSignature("fundRoyalty(address,uint256)", address(0xDEAD), 1));
        assertFalse(ok, "RC5: receiver accepts only P");
        assertEq(address(r).balance, beforeBalance);
    }


}
