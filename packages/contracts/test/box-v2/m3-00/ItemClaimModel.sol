// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ItemModel} from "./ItemModel.sol";
import {ItemHistoryModel} from "./ItemHistoryModel.sol";
import {HostileToken} from "../kit/HostileToken.sol";

/// @dev Payout transport oracle using real native/ERC-20 transfers in place of production PM unlock/burn/take.
/// Test supplies exactly the journal's transferred backing. These caps bound this transport only.
contract ItemClaimModel is ItemModel {
    uint256 public constant CLAIM_GAS = 250_000;
    address public immutable p;
    bool private locked;
    constructor(ItemHistoryModel h,address asset) ItemModel(h) {
        p = asset;
    }
    modifier lock() { require(!locked,"reentry"); locked = true; _; locked = false; }
    function _owner(uint256[] calldata ids) private view returns (address who) {
        _ready(); require(ids.length == 1,"batch"); who = history.ownerOf(ids[0]);
        require(who != address(0) && who != address(history),"vault");
    }
    /// @notice Owner only, no threshold or tip; failed exact transfer reverts the debit for retry.
    function claim(uint256[] calldata ids,address to) external override lock returns (uint256 amount) {
        require(_owner(ids) == msg.sender,"owner"); require(to != address(0) && to != address(history),"recipient");
        amount = _take(ids[0]); paid += amount; require(_pay(to,amount,CLAIM_GAS),"payout");
    }
    function _pay(address to,uint256 amount,uint256 cap) private returns (bool ok) {
        if (amount == 0) return true;
        // Keep enough gas for bookkeeping after a cap-burning transport. Low gas reverts the whole claim.
        require(gasleft() >= cap+cap/63+120_000,"gas floor");
        bytes memory data = abi.encodeCall(this.transferP,(to,amount));
        assembly ("memory-safe") { ok := call(cap,address(),0,add(data,32),mload(data),0,0) }
    }
    /// @notice Only this locked claim may enter the isolated transfer frame. No arbitrary external withdrawal.
    function transferP(address to,uint256 amount) external {
        require(msg.sender == address(this) && locked,"self");
        if (p == address(0)) { (bool ok,) = to.call{value:amount}(""); require(ok,"native"); }
        else {
            HostileToken token = HostileToken(p);
            uint256 beforeSelf = token.balanceOf(address(this)); uint256 beforeTo = token.balanceOf(to);
            require(token.transfer(to,amount),"transfer");
            require(token.balanceOf(address(this))+amount == beforeSelf && token.balanceOf(to) == beforeTo+amount,"exact");
        }
    }
}
