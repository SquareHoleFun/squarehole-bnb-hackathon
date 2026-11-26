// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RailShopFactory} from "../src/RailShopFactory.sol";

/// @notice SH-288: deploys the card shop factory on the BNB test network (chain 97), accepting exactly the chain's two
/// DEX routers and our four test card collections (packages/contracts/deployments/bnb-testnet/97-cards.json), and
/// writes its address to `deployments/97-rail-shop.json` (RAIL_SHOP_FILE overrides, as a rehearsal does). Without `--broadcast` it only simulates. Reads no key: the
/// orchestrator signs with `--account <keystore> --password-file <path>`.
///   forge script script/DeployRailShopFactory.s.sol --rpc-url https://bsc-testnet-rpc.publicnode.com \
///     --sender <deploy wallet> [--account <keystore> --password-file <path> --broadcast] --legacy --with-gas-price 100000000
contract DeployRailShopFactory is Script {
    /// Flap's DEX router on chain 97 (bounties/flap/script/DeployRules.s.sol) and PancakeSwap's V2 router.
    address constant FLAP_ROUTER = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;
    address constant PANCAKE_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    /// Our four test card collections on chain 97 (97-cards.json): Common, Uncommon, Rare, Legendary.
    address constant COMMON = 0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174;
    address constant UNCOMMON = 0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577;
    address constant RARE = 0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC;
    address constant LEGENDARY = 0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143;

    function run() external returns (RailShopFactory factory) {
        require(block.chainid == 97, "chain 97 only");
        address[] memory routers = new address[](2);
        (routers[0], routers[1]) = (FLAP_ROUTER, PANCAKE_ROUTER);
        address[] memory cards = new address[](4);
        (cards[0], cards[1], cards[2], cards[3]) = (COMMON, UNCOMMON, RARE, LEGENDARY);
        vm.startBroadcast();
        factory = new RailShopFactory(routers, cards);
        vm.stopBroadcast();
        require(factory.acceptedRouters().length == 2 && factory.acceptedCollections().length == 4, "the factory's sets");
        console.log(string.concat("RAILSHOP|factory|", vm.toString(address(factory))));
        string memory k = "railShop";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number); // a page reads events from here (at most the real block)
        vm.serializeAddress(k, "routers", routers);
        vm.serializeAddress(k, "collections", cards);
        string memory json = vm.serializeAddress(k, "factory", address(factory));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", vm.envOr("RAIL_SHOP_FILE", string("deployments/97-rail-shop.json"))));
    }
}
