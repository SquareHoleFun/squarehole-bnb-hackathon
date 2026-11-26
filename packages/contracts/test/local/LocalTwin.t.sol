// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {LocalTwin} from "../../script/local/LocalTwin.sol";

/// @notice S10a step 4: the local core v1 scripts (script/local/DeployCoreV1Local.s.sol, CoreV1LocalLife.s.sol) refuse
/// every chain id but Sepolia's twin 11155111 and every node that is not anvil.
contract LocalTwinTest is Test {
    function check(uint256 chainId, string memory client) external pure {
        LocalTwin.check(chainId, client);
    }

    function test_acceptsAnvilWithSepoliasChainId() public view {
        this.check(11_155_111, "anvil/v1.8.3");
    }

    function test_refusesEveryOtherChainId() public {
        uint256[4] memory ids = [uint256(1), 31_337, 17_000, 11_155_112];
        for (uint256 i; i < ids.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(LocalTwin.NotLocalTwin.selector, ids[i]));
            this.check(ids[i], "anvil/v1.8.3");
        }
    }

    function test_refusesANodeThatIsNotAnvil() public {
        string[4] memory clients = ["Geth/v1.16.0", "erigon/3.0", "anvi", ""];
        for (uint256 i; i < clients.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(LocalTwin.NotAnvil.selector, clients[i]));
            this.check(11_155_111, clients[i]);
        }
    }
}
