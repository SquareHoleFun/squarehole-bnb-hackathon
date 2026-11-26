// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {RailShopFactory} from "../src/RailShopFactory.sol";

interface ISupply {
    function totalSupply() external view returns (uint256);
}

/// @notice SH-288: a card shop for a token that already exists (a Four.meme token on our OpenFour copy, or any token),
/// from the sender, with our four test card collections. Refuses, before anything is sent, a give price, a pick price
/// or a cap above the token's supply (`totalSupply()`), with the reason: a shop priced above the supply takes stock
/// nobody can ever pick. Settings from the environment: TOKEN (required); ASSET (default address(0): the native coin);
/// ROUTER (default PancakeSwap's V2 router); GIVE_COMMON, GIVE_UNCOMMON, GIVE_RARE, GIVE_LEGENDARY in whole tokens
/// (defaults 1,000, 2,000, 4,000, 8,000); PICK_BPS (10000); CAP in whole tokens (100,000). RAIL_SHOP_FILE names the
/// factory's deployment file (default deployments/97-rail-shop.json). Without `--broadcast` it only simulates; reads
/// no key.
///   TOKEN=<address> forge script script/CreateRailShop.s.sol --rpc-url <endpoint> --sender <creator> \
///     [--account <keystore> --password-file <path> --broadcast] --legacy --with-gas-price 100000000
contract CreateRailShop is Script {
    address constant PANCAKE_ROUTER = 0xD99D1c33F9fC3444f8101754aBC46c52416550D1;
    address constant COMMON = 0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174;
    address constant UNCOMMON = 0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577;
    address constant RARE = 0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC;
    address constant LEGENDARY = 0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143;

    function _env(string memory name, uint256 fallback_, uint256 max) internal view returns (uint256 v) {
        v = vm.envOr(name, fallback_);
        require(v <= max, string.concat(name, " does not fit its field"));
    }

    function run() external returns (address shop) {
        require(block.chainid == 97, "chain 97 only");
        address token = vm.envAddress("TOKEN");
        require(token.code.length != 0, "TOKEN has no code: for a token to come, use the launch script");
        address asset = vm.envOr("ASSET", address(0));
        address router = vm.envOr("ROUTER", PANCAKE_ROUTER);
        string memory dep = vm.readFile(
            string.concat(vm.projectRoot(), "/", vm.envOr("RAIL_SHOP_FILE", string("deployments/97-rail-shop.json")))
        );
        RailShopFactory shops = RailShopFactory(vm.parseJsonAddress(dep, ".factory"));
        address[] memory nfts = new address[](4);
        (nfts[0], nfts[1], nfts[2], nfts[3]) = (COMMON, UNCOMMON, RARE, LEGENDARY);
        uint256[] memory prices = new uint256[](4);
        prices[0] = _env("GIVE_COMMON", 1_000, 1e15) * 1 ether;
        prices[1] = _env("GIVE_UNCOMMON", 2_000, 1e15) * 1 ether;
        prices[2] = _env("GIVE_RARE", 4_000, 1e15) * 1 ether;
        prices[3] = _env("GIVE_LEGENDARY", 8_000, 1e15) * 1 ether;
        uint16 pickBps = uint16(_env("PICK_BPS", 10_000, 50_000));
        uint256 cap = _env("CAP", 100_000, 1e15) * 1 ether;

        uint256 supply = ISupply(token).totalSupply();
        require(cap <= supply, "CAP is above the token's supply: no period could ever use it");
        for (uint256 i; i < 4; ++i) {
            uint256 g = prices[i];
            require(g <= supply, "a give price is above the token's supply: the shop could never pay it");
            require(g + (g * pickBps + 9_999) / 10_000 <= supply,
                "a pick price is above the token's supply: a card given in could never be picked");
        }
        address predicted = shops.shopAddress(msg.sender, token, asset, router, nfts, prices, pickBps, cap);
        console.log(string.concat("shop (to come) ", vm.toString(predicted)));

        vm.startBroadcast();
        shop = shops.create(token, asset, router, nfts, prices, pickBps, cap);
        vm.stopBroadcast();

        require(shop == predicted && shops.isShop(shop), "the shop's address");
        console.log(string.concat("RAILSHOP|shop|", vm.toString(shop)));
        console.log(string.concat("shops of this creator for the token: ", vm.toString(shops.shopCountBy(token, msg.sender))));
    }
}
