// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IListingRegistry, ListingRecord, ListingClass, ListingKind, QParameters} from "../../../../src/box-v2/interfaces/IListingRegistry.sol";
/// @notice TEST ONLY manual one-row registry. Omits token admission probes/layout checks and QParameters scaling.
contract MockListingRegistry {
    address public immutable lister = msg.sender;
    uint32 public listingCount = 1;
    mapping(uint32 => ListingRecord) private rows;
    mapping(address => uint32) private ids;
    constructor() { rows[0] = ListingRecord(0,address(0),18,ListingClass.NATIVE,ListingKind.LISTED,0,1e6,QParameters(0,0,0,0)); }
    function listing(uint32 id) external view returns (ListingRecord memory) {
        if (id >= listingCount) revert IListingRegistry.UnknownListing(id);
        return rows[id];
    }
    function newestListingOf(address token) external view returns (bool,uint32) { return (token==address(0) || ids[token]!=0,ids[token]); }
    function add(address token,ListingClass class,uint256 raise) external returns (uint32 id) {
        if (msg.sender!=lister) revert IListingRegistry.NotLister(msg.sender);
        if (token==address(0) || ids[token]!=0) revert IListingRegistry.AlreadyListed(token,ids[token]);
        require(raise>=1e6 && raise<=type(uint128).max);
        id=listingCount++; ids[token]=id;
        rows[id]=ListingRecord(id,token,18,class,ListingKind.LISTED,0,raise,QParameters(0,0,0,0));
        emit IListingRegistry.ListingAdded(id,token,class,ListingKind.LISTED,raise);
    }
    function updateRaise(uint32 id,uint256 raise) external {
        if (msg.sender!=lister) revert IListingRegistry.NotLister(msg.sender);
        if (id>=listingCount) revert IListingRegistry.UnknownListing(id);
        require(raise>=1e6 && raise<=type(uint128).max);
        uint256 old=rows[id].raise; rows[id].raise=raise;
        emit IListingRegistry.RaiseUpdated(id,old,raise);
    }
}
