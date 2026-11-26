// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {CoreV2GasRules} from "./CoreV2GasRules.sol";
import {JunkCollection} from "../../src/test-coins/JunkCollection.sol";

/// @notice Owner mints Bent Cans 3..12 to the creator Safe and 13/14 to a separate tester.
/// Odd ids use picture 1; even ids use picture 2. Ids 1/2 belong to the Junkyard starter set.
/// No keys or RPC calls. JUNK_BROADCAST only records address-sender transactions;
/// the founder supplies the signer and explicit Forge --broadcast separately.
contract BentCansMint is Script, CoreV2GasRules {
    event BentCanMint(address indexed collection, uint256 indexed id, address indexed recipient, uint8 picture);
    event BentCanTransactionGas(uint256 indexed id, uint256 total, uint256 stateGas);

    function run() external {
        mintSet(
            vm.envAddress("BENT_CANS_COLLECTION"),
            vm.envAddress("JUNK_DEPLOYER"),
            vm.envAddress("JUNK_SAFE"),
            vm.envAddress("BENT_CANS_TESTER"),
            vm.envOr("JUNK_BROADCAST", false)
        );
    }

    /// @dev Explicit inputs also let the same checks run offline and on a pinned Sepolia fork.
    function mintSet(address collectionAddress, address owner, address creatorSafe, address tester, bool recording) public {
        require(block.chainid == RULES_SEPOLIA || block.chainid == 31337, "testnet only");
        require(collectionAddress.code.length != 0, "collection required");
        JunkCollection collection = JunkCollection(collectionAddress);
        require(owner != address(0) && collection.owner() == owner, "collection owner");
        require(collection.kind() == 0, "Bent Cans required");
        require(creatorSafe != address(0) && creatorSafe.code.length != 0, "deployed creator Safe required");
        require(tester != address(0) && tester != creatorSafe, "separate tester required");
        if (recording) require(msg.sender == owner, "deployer");
        // Check the complete set before recording anything. Never silently overwrite or skip an occupied id.
        for (uint256 id = 3; id <= 14; ++id) {
            (bool exists, bytes memory reason) = collectionAddress.staticcall(abi.encodeCall(collection.ownerOf, (id)));
            require(!exists, "mint id already exists");
            require(
                keccak256(reason) == keccak256(abi.encodeWithSignature("ERC721NonexistentToken(uint256)", id)),
                "unexpected ownerOf failure"
            );
        }
        bool stateGas;
        if (block.chainid == RULES_SEPOLIA) {
            _checkGlamsterdamWindow(block.chainid, block.timestamp);
            (stateGas,) = _checkGlamsterdamSimulated(block.chainid, block.timestamp);
        } else stateGas = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN;

        if (recording) vm.startBroadcast(owner);
        else vm.startPrank(owner);
        for (uint256 id = 3; id <= 14; ++id) {
            address recipient = id <= 12 ? creatorSafe : tester;
            uint8 picture = id % 2 == 1 ? 1 : 2;
            uint256 beforeGas = gasleft();
            collection.mint(recipient, id, picture);
            uint256 total = beforeGas - gasleft() + 21_000 + 16 * 100;
            uint256 state = _frameStateGas();
            require(total * GAS_ESTIMATE_MULTIPLIER / 100 <= TX_GAS_CAP, "mint transaction cap");
            _checkGasStep(GasStep("Bent Cans mint", total, state, true), stateGas, block.gaslimit);
            emit BentCanTransactionGas(id, total, state);
            emit BentCanMint(collectionAddress, id, recipient, picture);
        }
        if (recording) vm.stopBroadcast();
        else vm.stopPrank();
    }
}
