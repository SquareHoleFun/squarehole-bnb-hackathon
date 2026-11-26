// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {BoxEncoding} from "../box/libraries/BoxEncoding.sol";
import {JunkCollectionCatalog} from "./JunkCollectionCatalog.sol";

/// @notice Public test shop stock. The fixed owner may mint more; no seizure, metadata setter, burn or upgrade.
/// Art has no issuer affiliation. Deployable only on Sepolia and the local test chain.
contract JunkCollection is ERC721 {
    address public immutable owner;
    uint8 public immutable kind;
    mapping(uint256 => uint8) private _pictures;

    constructor(address owner_, uint8 kind_)
        ERC721(JunkCollectionCatalog.name(kind_), JunkCollectionCatalog.symbol(kind_))
    {
        require(block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
        require(owner_ != address(0), "owner required");
        owner = owner_;
        kind = kind_;
    }

    /// @notice Only owner mints a positive id with one of the collection's two immutable public pictures.
    function mint(address to, uint256 id, uint8 picture) external {
        require(msg.sender == owner, "owner");
        require(id != 0 && (picture == 1 || picture == 2), "id and picture");
        _pictures[id] = picture;
        _safeMint(to, id); // a refusal, including duplicate ids, rolls the picture assignment back
    }

    function imageURI(uint256 id) public view returns (string memory) {
        _requireOwned(id);
        return string.concat("ipfs://", BoxEncoding.rawCidV1(JunkCollectionCatalog.digest(kind, _pictures[id])));
    }

    /// @notice JSON is embedded, so the public gateway only needs to serve raw PNGs, never metadata files.
    function metadataJSON(uint256 id) public view returns (string memory) {
        return string.concat('{"name":"', name(), ' #', BoxEncoding.toString(id),
            '","description":"Public test junk for the Sepolia shop. Owner-minted test stand-in; no issuer affiliation.","image":"',
            imageURI(id), '"}');
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        return string.concat("data:application/json;base64,", BoxEncoding.base64(bytes(metadataJSON(id))));
    }
}
