// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721TokenReceiver} from "./interfaces/IBoxCollection.sol";
import {IBoxTickets} from "./interfaces/IBoxTickets.sol";

/// @title BoxPlaceholderToken
/// @notice The ERC-721 surface of the tickets add-on's placeholder (`BoxTickets`): owners, balances, approvals,
/// transfers and the freeze. A copy of PlaceholderToken (src/v2/PlaceholderToken.sol:19-175 at 46a030f6) without its
/// compile-time name, symbol and URI (BoxTickets reads them from its clone arguments); its events and errors are
/// IBoxTickets' (the same ones). Minting and burning belong to BoxTickets; this file holds no T, no ETH and no power.
///
/// - **Three eras** (`_era`): the curve (1); graduation until the graduation word is stored (2: transfers frozen); the
///   numbers known, or never coming because terminal mode began without them (3).
/// - **An approval counts only in the era it was given in, and never in era 2**: a listing signed before anyone could
///   see a placeholder's number can never be filled after (PlaceholderToken.sol:12-16).
/// @dev Written for Square Hole (MIT, no third-party code).
abstract contract BoxPlaceholderToken is IBoxTickets {
    struct Token {
        address owner;
        uint32 slot;
    }

    /// @dev One slot: the approved address and the era it was given in.
    struct TokenApproval {
        address to;
        uint8 era;
    }

    uint8 internal constant _ERA_CURVE = 1;
    uint8 internal constant _ERA_FROZEN = 2;
    uint8 internal constant _ERA_KNOWN = 3;

    mapping(uint256 => Token) internal _tokens;
    mapping(address => uint256) internal _balances;
    mapping(uint256 => TokenApproval) private _approvals;
    /// @dev owner → operator → the era the approval was given in (0: none).
    mapping(address => mapping(address => uint8)) private _operators;

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balances[owner];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        return _tokenOf(tokenId).owner;
    }

    /// @notice The approved address, if its approval still counts (see the contract notes); zero otherwise.
    function getApproved(uint256 tokenId) external view returns (address) {
        ownerOf(tokenId);
        TokenApproval memory a = _approvals[tokenId];
        return _counts(a.era, _era()) ? a.to : address(0);
    }

    /// @notice Whether `operator` may act for `owner` now (an approval from an earlier era does not count).
    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return _counts(_operators[owner][operator], _era());
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        uint8 era = _era();
        if (msg.sender != owner && !_counts(_operators[owner][msg.sender], era)) {
            revert NotAuthorized(msg.sender, tokenId);
        }
        _approvals[tokenId] = TokenApproval({to: to, era: era});
        emit Approval(owner, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        _requireLive();
        _operators[msg.sender][operator] = approved ? _era() : 0;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /// @notice Refused to address zero, this contract and the system contracts (`_isSystem`: the vault, the collection,
    /// T; F25 (3)), and while frozen (graduation until the word is stored). It checks no receiver: a placeholder sent
    /// with it to a contract that cannot move it, box 0's other contracts included, has no exit (it is never opened or
    /// handed back; its item stays hidden and reserved, its ticket pending, its stream slot open: an accepted no-exit
    /// class, box 0's own review W3-U7-1, R66-LOST, F147).
    function transferFrom(address from, address to, uint256 tokenId) public {
        address owner = ownerOf(tokenId);
        if (from != owner) revert WrongFrom(from, owner);
        if (to == address(0) || to == address(this) || _isSystem(to)) revert DirectSendRefused(to);
        uint8 era = _era();
        if (msg.sender != owner && !_mayAct(owner, tokenId, era)) revert NotAuthorized(msg.sender, tokenId);
        if (era == _ERA_FROZEN) revert Frozen();
        if (_approvals[tokenId].to != address(0)) delete _approvals[tokenId];
        _tokens[tokenId].owner = to;
        unchecked {
            --_balances[from];
            ++_balances[to];
        }
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length == 0) return;
        try IERC721TokenReceiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 ret) {
            if (ret != IERC721TokenReceiver.onERC721Received.selector) revert UnsafeRecipient(to);
        } catch (bytes memory reason) {
            if (reason.length == 0) revert UnsafeRecipient(to);
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // For BoxTickets

    /// @dev The era now: 1 the curve, 2 frozen, 3 the numbers known or never coming.
    function _era() internal view virtual returns (uint8);

    /// @dev Addresses a placeholder may never be sent to, beyond zero and this contract.
    function _isSystem(address to) internal view virtual returns (bool);

    /// @dev Reverts on an uninitialised clone (`setApprovalForAll` is the one write that touches no existing token).
    function _requireLive() internal view virtual;

    function _tokenOf(uint256 tokenId) internal view returns (Token memory t) {
        t = _tokens[tokenId];
        if (t.owner == address(0)) revert NonexistentToken(tokenId);
    }

    /// @dev Whether the caller is `owner`'s operator or `tokenId`'s approved address in era `era`.
    function _mayAct(address owner, uint256 tokenId, uint8 era) internal view returns (bool) {
        if (_counts(_operators[owner][msg.sender], era)) return true;
        TokenApproval memory a = _approvals[tokenId];
        return a.to == msg.sender && _counts(a.era, era);
    }

    /// @dev A stale approval of a burned token is harmless: token ids are never minted again, and `getApproved`
    /// reverts for a token that does not exist.
    function _burn(uint256 tokenId, address owner) internal {
        delete _tokens[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    /// @dev An approval given in era `given` counts in era `now_` only if it is the same era, and never while frozen.
    function _counts(uint8 given, uint8 now_) private pure returns (bool) {
        return given == now_ && given != _ERA_FROZEN;
    }
}
