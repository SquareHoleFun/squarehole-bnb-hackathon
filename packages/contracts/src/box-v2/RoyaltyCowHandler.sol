// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CowOrder, IConditionalOrder, IConditionalOrderGenerator, IRoyaltyCowOwner, RoyaltyCowHash} from "./interfaces/IRoyaltyCow.sol";

/// @notice One stateless generator per release. No caller-selected tokens, amounts, receiver or signing authority.
contract RoyaltyCowHandler is IConditionalOrderGenerator {
    error InvalidInput();
    error PollTryAtEpoch(uint256 epoch, string reason);
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == type(IConditionalOrder).interfaceId
            || id == type(IConditionalOrderGenerator).interfaceId;
    }
    function verify(address owner, address sender, bytes32 hash, bytes32 domainSeparator, bytes32 context,
        bytes calldata staticInput, bytes calldata offchainInput, CowOrder calldata) external view {
        if (hash != RoyaltyCowHash.digest(getTradeableOrder(owner, sender, context, staticInput, offchainInput), domainSeparator))
            revert InvalidInput();
    }
    function getTradeableOrder(address owner, address, bytes32, bytes calldata staticInput, bytes calldata offchainInput)
        public view returns (CowOrder memory)
    {
        if (staticInput.length != 32 || offchainInput.length != 0
            || IRoyaltyCowOwner(owner).cowHandler() != address(this)) revert InvalidInput();
        address coin = abi.decode(staticInput, (address));
        try IRoyaltyCowOwner(owner).cowOrder(coin) returns (CowOrder memory order) { return order; }
        catch { revert PollTryAtEpoch((block.timestamp / 1 hours + 1) * 1 hours, "No income due"); }
    }
}
