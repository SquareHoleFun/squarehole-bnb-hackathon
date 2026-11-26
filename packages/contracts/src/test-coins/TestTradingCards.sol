// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {BoxEncoding} from "../box/libraries/BoxEncoding.sol";
import {TestTradingCardsCatalog as Catalog} from "./TestTradingCardsCatalog.sol";

/// @notice Public test trading cards of one rarity tier (0 Common to 3 Legendary), the card shop's stand-in stock.
/// The fixed owner may mint more; no seizure, metadata setter, burn or upgrade. Own art; no issuer affiliation.
/// Deployable only on the BNB Chain test network (97), Sepolia and the local test chain.
contract TestTradingCards is ERC721 {
    address public immutable owner;
    uint8 public immutable tier;

    constructor(address owner_, uint8 tier_) ERC721(Catalog.name(tier_), Catalog.symbol(tier_)) {
        require(block.chainid == 97 || block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
        require(owner_ != address(0), "owner required");
        owner = owner_;
        tier = tier_;
    }

    /// @notice The catalog's fixed rule: id n shows picture (n - 1) mod 4 + 1, so ids 1 to 4 are the four cards of the
    /// tier and ids 5 to 8 (and every later run of four) their next editions. Anyone reads it; no money moves.
    function pictureFor(uint256 id) public pure returns (uint8) {
        require(id != 0, "id");
        return uint8((id - 1) % Catalog.PICTURES + 1);
    }

    /// @notice Only owner mints a positive id; `picture` must be the one the catalog's rule fixes for that id.
    function mint(address to, uint256 id, uint8 picture) external {
        require(msg.sender == owner, "owner");
        require(id != 0 && picture == pictureFor(id), "id and picture");
        _safeMint(to, id); // a refusal, including a duplicate id, mints nothing
    }

    /// @notice Anyone reads a minted card's picture number (1 to 4); no money moves.
    function pictureOf(uint256 id) public view returns (uint8) {
        _requireOwned(id);
        return pictureFor(id);
    }

    function imageURI(uint256 id) public view returns (string memory) {
        return string.concat("ipfs://", BoxEncoding.rawCidV1(Catalog.digest(tier, pictureOf(id))));
    }

    /// @notice JSON is embedded, so the public gateway only needs to serve raw PNGs, never metadata files.
    function metadataJSON(uint256 id) public view returns (string memory) {
        uint8 picture = pictureOf(id);
        return string.concat('{"name":"', Catalog.cardName(tier, picture), ' #', BoxEncoding.toString(id),
            '","description":"Public test trading card for the test network shop. Owner-minted test stand-in; no issuer affiliation.","image":"',
            imageURI(id), '","attributes":[{"trait_type":"Rarity","value":"', Catalog.rarity(tier),
            '"},{"trait_type":"Card","value":"', Catalog.cardName(tier, picture),
            '"},{"trait_type":"Number","value":"', Catalog.number(tier, picture), '"}]}');
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        return string.concat("data:application/json;base64,", BoxEncoding.base64(bytes(metadataJSON(id))));
    }
}
