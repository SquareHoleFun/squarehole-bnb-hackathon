// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ICreatorEntitlementReceiverV2 {
    function q() external view returns (address);
    function claimCreator(address asset, address to) external returns (uint256);
    function creatorP() external view returns (uint256);
}

/// @notice Simulation code only, installed at the payee by an eth_call code override; never deployed or sent.
contract CreatorEntitlementV2 {
    /// @notice The indexer's read-only call runs as the rightful payee. No P payout or token callback occurs.
    /// @dev The frozen receiver reconciles and settles graduation BEFORE returning zero for a non-P asset.
    /// Thus its own accounting handles held royalties, fee carries and deficits, without reproducing that math.
    /// All simulated changes, including graduation, are discarded by eth_call.
    function quote(address receiver, address asset) external returns (uint256 amount) {
        ICreatorEntitlementReceiverV2 r = ICreatorEntitlementReceiverV2(receiver);
        require(r.q() == asset, "CreatorQuoteAsset");
        r.claimCreator(asset == address(0) ? address(1) : address(0), address(this));
        amount = r.creatorP();
        // BoxReceiverV2Base._payoutBatch: four positive int128 parts, not the entire accrued balance.
        uint256 cap = 4 * uint256(uint128(type(int128).max));
        if (amount > cap) amount = cap;
    }
}
