// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {LocalWETH9} from "../local/LocalQuoteMocks.sol";
import {DrandSource} from "../../src/box/randomness/DrandSource.sol";
import {BnbTestnet, BnbTestnetCustody} from "./BnbTestnet.sol";

/// @notice Step 1 of the BNB Chain test network deployment (chain 97): what the v2 release leans on.
/// The same contracts as the 31337 alpha's `CoreV2LocalGenesis.runAlpha`, for chain 97: a Uniswap v4 PoolManager built
/// from the pinned source (none answers on 97), the test network's WBNB when it has code (otherwise `LocalWETH9`), a
/// real `DrandSource`, the trade box's `PoolSwapTest` and the swapper, and two holding contracts owned by the deployer
/// as the release's two fee addresses. Signed by the configured Foundry sender; this file reads no key.
contract BnbTestnetGenesis is Script {
    struct Dependencies {
        address manager;
        address weth;
        address drand;
        address firstFee;
        address platform;
        address swapper;
        address poolSwapTest;
    }

    function run() external returns (Dependencies memory d) {
        BnbTestnet.check(block.chainid);
        d = _dependencies(msg.sender);
        console.log(string.concat("BNB|dependencies|", vm.toString(abi.encode(d))));
    }

    function _dependencies(address deployer) internal returns (Dependencies memory d) {
        // An official PoolManager at chain 56's address would change the plan: stop and decide, never guess.
        require(BnbTestnet.V4_POOL_MANAGER_56.code.length == 0, "a PoolManager answers at the chain-56 address: decide");
        bool wbnb = BnbTestnet.WBNB.code.length != 0;
        address[] memory owners = new address[](1);
        owners[0] = deployer;
        vm.startBroadcast(deployer);
        d.firstFee = address(new BnbTestnetCustody(owners));
        d.platform = address(new BnbTestnetCustody(owners));
        d.manager = vm.deployCode("PoolManager.sol:PoolManager", abi.encode(deployer));
        d.weth = wbnb ? BnbTestnet.WBNB : address(new LocalWETH9());
        d.drand = address(new DrandSource());
        d.swapper = address(new PriceLimitSwapper(IPoolManager(d.manager)));
        d.poolSwapTest = address(new PoolSwapTest(IPoolManager(d.manager)));
        vm.stopBroadcast();
    }
}
