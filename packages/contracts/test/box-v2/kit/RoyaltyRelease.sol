// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Vm} from "forge-std/Vm.sol";
import {CowOrder, ConditionalOrderParams, CowSignaturePayload, RoyaltyCowConfig, IConditionalOrderGenerator} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";

import {BoxRoyaltyRouterV2Args} from "../../../src/box-v2/libraries/BoxRoyaltyRouterV2Args.sol";
import {RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
contract InboxListingOffline {
    mapping(address => uint256) public lots;
    function set(address coin, uint256 lot) external { lots[coin] = lot; }
    function sellableLotAt(address coin, uint256) external view returns (uint256) { return lots[coin]; }
}

/// @notice Offline wiring only; actual protocol integration belongs to ForkCow.t.sol.
contract CowOffline {
    mapping(address => uint256) public registrations;
    function vaultRelayer() external view returns (address) { return address(this); }
    function domainSeparator() external view returns (bytes32) { return keccak256(abi.encode(block.chainid, address(this))); }
    function create(ConditionalOrderParams calldata, bool) external { ++registrations[msg.sender]; }
    function getTradeableOrderWithSignature(address owner, ConditionalOrderParams calldata p, bytes calldata input,
        bytes32[] calldata proof) external view returns (CowOrder memory order, bytes memory signature) {
        order = IConditionalOrderGenerator(p.handler).getTradeableOrder(owner, msg.sender, bytes32(0), p.staticInput, input);
        signature = abi.encode(order, CowSignaturePayload(proof, p, input));
    }
}
library RoyaltyRelease {
    function args(address c, address r, address w, RoyaltyDestination d, address p) internal returns (bytes memory) {
        InboxListingOffline listings = new InboxListingOffline();
        listings.set(w, 0.05 ether);
        Vm vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
        vm.mockCall(c, abi.encodeWithSignature("listingRegistry()"), abi.encode(address(listings)));
        vm.mockCall(c, abi.encodeWithSignature("token()"), abi.encode(address(0)));
        vm.mockCall(c, abi.encodeWithSignature("receiver()"), abi.encode(r));
        vm.mockCall(c, abi.encodeWithSignature("q()"), abi.encode(p));
        vm.mockCall(c, abi.encodeWithSignature("creditInbox(uint256)"), "");
        return BoxRoyaltyRouterV2Args.withSnapshot(BoxRoyaltyRouterV2Args.encode(c, w, d), 1);
    }
    function config() internal returns (RoyaltyCowConfig memory) {
        address cow = address(new CowOffline());
        return RoyaltyCowConfig(cow, cow, 0.01 ether);
    }
}
