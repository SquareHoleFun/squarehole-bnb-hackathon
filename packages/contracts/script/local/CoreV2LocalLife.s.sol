// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CoreV2LocalPictures} from "./CoreV2LocalPictures.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxCoordinatorV2} from "../../src/box-v2/BoxCoordinatorV2.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {HostileCollection} from "../../test/box-v2/kit/m2/ShopDoubles.sol";
import {LocalTwin} from "./LocalTwin.sol";

/// @notice Local transaction recipes. Time/block advancement belongs to the loopback anvil orchestrator.
contract CoreV2LocalLife is Script, CoreV2LocalPictures {
    /// @notice Anvil unlocked actor only. action 0 creates the menu; 1 trades, 2 fills, 3 gives/picks a shop item, 4 withdraws item 1.
    function runLocal(uint8 action, address factory, address swapper, address nft, address coordinator) external {
        LocalTwin.check(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        localFactory = BoxFactoryV2(factory); localSwapper = PriceLimitSwapper(payable(swapper));
        localNft = HostileCollection(nft); localActor = msg.sender;
        vm.startBroadcast(msg.sender);
        if (action == 0) {
            string[9] memory names = ["plain", "holders", "shop", "failure", "everyItem", "coinPile", "usdc", "stock", "gold"];
            for (uint8 i; i < names.length; ++i) {
                BoxCoordinatorV2 b = _createLocal(i);
                if (i == 2) _loadLocalShop(b);
                if (i == 4 || i == 5) _loadLocalM3(b, i);
                console.log(string.concat("LOCALV2|", names[i], "|", vm.toString(address(b))));
            }
        } else if (action == 1) _tradeLocal(BoxCoordinatorV2(coordinator));
        else if (action == 2) _fillLocal(BoxCoordinatorV2(coordinator));
        else if (action == 3) _givePickLocal(BoxCoordinatorV2(coordinator));
        else if (action == 4) _withdrawLocalItem(BoxCoordinatorV2(coordinator));
        else revert("unknown local action");
        vm.stopBroadcast();
    }
}
