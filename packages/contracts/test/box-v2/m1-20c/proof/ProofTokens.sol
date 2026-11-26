// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {KitBaseToken} from "../M1_20cFurtherTokens.sol";

// TEST ONLY. Supplements the kit's HostileToken without changing the kit.
contract ProofReturnToken is KitBaseToken {
    uint256 public answer = 1;
    uint256 public length = 32;
    address public badSender;

    function setAnswer(address sender, uint256 word, uint256 size) external {
        (badSender, answer, length) = (sender, word, size);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return _answer(msg.sender);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _spend(from, amount);
        _move(from, to, amount);
        return _answer(from);
    }

    function _answer(address from) private view returns (bool) {
        if (from != badSender) return true;
        uint256 word = answer;
        uint256 size = length;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, word)
            mstore(add(p, 32), 0)
            return(p, size)
        }
    }
}

/// An elastic balance factor can change between blocks while each probe transfer is exact.
contract ProofElasticToken {
    uint8 public constant decimals = 18;
    uint256 public factor = 1;
    uint256 public shares;
    mapping(address => uint256) public sharesOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function rebase(uint256 next) external {
        factor = next;
    }

    function balanceOf(address who) external view returns (uint256) {
        return sharesOf[who] * factor;
    }

    function totalSupply() external view returns (uint256) {
        return shares * factor;
    }

    function mint(address who, uint256 amount) external {
        sharesOf[who] += amount / factor;
        shares += amount / factor;
    }

    function approve(address who, uint256 amount) external returns (bool) {
        allowance[msg.sender][who] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        sharesOf[from] -= amount / factor;
        sharesOf[to] += amount / factor;
    }
}

/// TEST ONLY: an unpinned, freely upgradeable proxy whose ERC-20 implementation can pass the probe.
contract ProofUpgradeableProxy {
    bytes32 private constant SLOT = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);

    constructor(address implementation) {
        upgrade(implementation);
    }

    function upgrade(address implementation) public {
        bytes32 slot = SLOT;
        assembly ("memory-safe") { sstore(slot, implementation) }
    }

    fallback() external {
        bytes32 slot = SLOT;
        assembly ("memory-safe") {
            let p := mload(0x40)
            calldatacopy(p, 0, calldatasize())
            let ok := delegatecall(gas(), sload(slot), p, calldatasize(), 0, 0)
            returndatacopy(p, 0, returndatasize())
            if iszero(ok) { revert(p, returndatasize()) }
            return(p, returndatasize())
        }
    }
}
