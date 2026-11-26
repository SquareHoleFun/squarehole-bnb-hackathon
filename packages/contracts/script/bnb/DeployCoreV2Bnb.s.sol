// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {RoyaltyCowConfig} from "../../src/box-v2/interfaces/IRoyaltyCow.sol";
import {CowOffline} from "../../test/box-v2/kit/RoyaltyRelease.sol";
import {DeployCoreV2Local} from "../local/DeployCoreV2Local.s.sol";
import {BnbTestnet} from "./BnbTestnet.sol";

/// @notice Step 2 of the BNB Chain test network deployment (chain 97): the v2 release, exactly as the 31337 alpha's
/// `DeployCoreV2Local.runAlpha` deploys it (`_deployLocalCoreV2`: the same contracts in the same order, the fee-module
/// directory with its four release modules, no older registry, the offline order-book stand-in). Only the chain guard
/// differs: 97 instead of 31337 (the local guards stay as they are). The factory's address is predicted from the
/// sender's nonce (nonce + 29 when the release starts) and checked after its CREATE.
contract DeployCoreV2Bnb is DeployCoreV2Local {
    function run(address manager, address weth, address drand, address firstFee, address platform)
        external returns (address factory)
    {
        BnbTestnet.check(block.chainid);
        _measureLocalGas();
        vm.startBroadcast(msg.sender);
        address cow = address(new CowOffline());
        Config memory c = Config(msg.sender, manager, weth, drand, address(0), firstFee, platform,
            RoyaltyCowConfig(cow, cow, 0.05 ether));
        factory = _deployLocalCoreV2(c).factory;
        vm.stopBroadcast();
        console.log(string.concat("BNB|factory|", vm.toString(factory)));
    }
}
