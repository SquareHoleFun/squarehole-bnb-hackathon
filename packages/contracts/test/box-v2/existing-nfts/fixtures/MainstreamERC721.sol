// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    ERC721 as OZ4
} from "../../../../lib/v4-periphery/lib/permit2/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {
    ERC721Enumerable as OZ4Enumerable
} from "../../../../lib/v4-periphery/lib/permit2/lib/openzeppelin-contracts/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {ERC721 as OZ5} from "../../../../lib/v4-core/lib/openzeppelin-contracts/contracts/token/ERC721/ERC721.sol";
import {
    ERC721Enumerable as OZ5Enumerable
} from "../../../../lib/v4-core/lib/openzeppelin-contracts/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {
    EnumerableSet
} from "../../../../lib/v4-core/lib/openzeppelin-contracts/contracts/utils/structs/EnumerableSet.sol";
import {ERC721TokenReceiver} from "solmate/src/tokens/ERC721.sol";

contract OZ4PlainFixture is OZ4 {
    constructor() OZ4("OZ4", "OZ4") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract OZ4EnumerableFixture is OZ4Enumerable {
    constructor() OZ4("OZ4Enumerable", "OZ4E") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract OZ5PlainFixture is OZ5 {
    constructor() OZ5("OZ5", "OZ5") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

contract OZ5EnumerableFixture is OZ5Enumerable {
    constructor() OZ5("OZ5Enumerable", "OZ5E") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// Storage-layout model of OZ 3.4's holder EnumerableSet. No separate balance slot:
/// length, values[0] and indexes[id] are all fresh on the first incoming nonzero id.
/// Global owner enumeration is omitted: transfer changes an existing value there, represented by owners[id].
contract OZ3HolderFixture {
    using EnumerableSet for EnumerableSet.UintSet;
    mapping(address => EnumerableSet.UintSet) private held;
    mapping(uint256 => address) private owners;
    mapping(uint256 => address) private approvals;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    event Transfer(address indexed from, address indexed to, uint256 indexed id);

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f || id == 0x780e9d63;
    }

    function mint(address to, uint256 id) external {
        require(owners[id] == address(0));
        owners[id] = to;
        held[to].add(id);
        emit Transfer(address(0), to, id);
    }

    function ownerOf(uint256 id) public view returns (address) {
        require(owners[id] != address(0));
        return owners[id];
    }

    function balanceOf(address owner) external view returns (uint256) {
        return held[owner].length();
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(ownerOf(id) == from && to != address(0));
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || approvals[id] == msg.sender);
        delete approvals[id];
        held[from].remove(id);
        held[to].add(id);
        owners[id] = to;
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        require(to.code.length == 0 || ERC721TokenReceiver(to).onERC721Received(msg.sender, from, id, "") == 0x150b7a02);
    }
}

/// ERC721A v4.3 sequential ownership/storage algorithm, transcribed for offline tests (not a full library).
/// Includes packed address data, timestamp, burned/next-initialized flags, backward cold SLOAD walk,
/// approval clearing, and next-slot initialization. Mint starts at 3 to avoid zero-value slot shortcuts.
contract ERC721ALayoutFixture {
    uint256 private constant START = 3;
    uint256 private constant BURNED = 1 << 224;
    uint256 private constant NEXT_INITIALIZED = 1 << 225;
    uint256 private currentIndex = START;
    mapping(uint256 => uint256) private ownerships;
    mapping(address => uint256) private addressData;
    mapping(uint256 => address) private approvals;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    event Transfer(address indexed from, address indexed to, uint256 indexed id);

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x80ac58cd || id == 0x5b5e139f;
    }

    function mintBatch(address to, uint256 quantity) external {
        require(quantity != 0 && to != address(0));
        uint256 start = currentIndex;
        addressData[to] += quantity * ((1 << 64) | 1);
        ownerships[start] = uint160(to) | (block.timestamp << 160) | (quantity == 1 ? NEXT_INITIALIZED : 0);
        currentIndex += quantity;
        for (uint256 id = start; id < currentIndex; ++id) {
            emit Transfer(address(0), to, id);
        }
    }

    function _packedOwnershipOf(uint256 id) private view returns (uint256 packed) {
        require(id >= START && id < currentIndex);
        packed = ownerships[id];
        require(packed & BURNED == 0);
        while (packed == 0) packed = ownerships[--id];
    }

    function ownerOf(uint256 id) public view returns (address) {
        return address(uint160(_packedOwnershipOf(id)));
    }

    function balanceOf(address owner) external view returns (uint256) {
        return uint64(addressData[owner]);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
    }

    function transferFrom(address from, address to, uint256 id) public {
        uint256 previous = _packedOwnershipOf(id);
        require(address(uint160(previous)) == from && to != address(0));
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || approvals[id] == msg.sender);
        if (approvals[id] != address(0)) delete approvals[id];
        --addressData[from];
        ++addressData[to];
        ownerships[id] = uint160(to) | (block.timestamp << 160) | NEXT_INITIALIZED;
        if (previous & NEXT_INITIALIZED == 0) {
            uint256 next = id + 1;
            if (ownerships[next] == 0 && next != currentIndex) ownerships[next] = previous;
        }
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        transferFrom(from, to, id);
        require(to.code.length == 0 || ERC721TokenReceiver(to).onERC721Received(msg.sender, from, id, "") == 0x150b7a02);
    }
}
