// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {CoreV2GasRules} from "./CoreV2GasRules.sol";
import {JunkCollection} from "../../src/test-coins/JunkCollection.sol";

/// @notice Five CREATEs and ten safe mints. No key, RPC, signer, listing or box mutation.
/// Defaults to local simulation. JUNK_BROADCAST enables address-only transaction recording;
/// only the founder supplies a signer and --broadcast to actually send. Never deploy this script as a helper.
contract JunkCollections is Script, CoreV2GasRules {
    event JunkDeployment(uint8 indexed kind, address indexed collection, address owner, address safe, bytes32 codeHash);
    event JunkStarter(address indexed collection, uint256 id, uint8 picture, address indexed safe);
    event JunkTransactionGas(string operation, uint256 total, uint256 stateGas);

    function run() external returns (address[5] memory collections) {
        require(block.chainid == RULES_SEPOLIA || block.chainid == 31337, "testnet only");
        address sender = vm.envAddress("JUNK_DEPLOYER");
        address safe = vm.envAddress("JUNK_SAFE");
        require(sender != address(0) && safe != address(0) && safe.code.length != 0, "sender and deployed Safe required");
        bool recording = vm.envOr("JUNK_BROADCAST", false);
        if (recording) require(msg.sender == sender, "deployer");
        bool stateGas;
        if (block.chainid == RULES_SEPOLIA) {
            _checkGlamsterdamWindow(block.chainid, block.timestamp);
            (stateGas,) = _checkGlamsterdamSimulated(block.chainid, block.timestamp);
        } else stateGas = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN;

        if (recording) vm.startBroadcast(sender);
        else vm.startPrank(sender);
        for (uint8 kind; kind < 5; ++kind) {
            uint256 beforeGas = gasleft();
            JunkCollection collection = new JunkCollection(sender, kind);
            _checkTransaction("deploy", beforeGas - gasleft() + 21_000 + 40 * (type(JunkCollection).creationCode.length + 64), stateGas, false);
            collections[kind] = address(collection);
            emit JunkDeployment(kind, address(collection), sender, safe, address(collection).codehash);
            for (uint8 picture = 1; picture <= 2; ++picture) {
                beforeGas = gasleft();
                collection.mint(safe, picture, picture);
                _checkTransaction("mint", beforeGas - gasleft() + 21_000 + 16 * 100, stateGas, true);
                emit JunkStarter(address(collection), picture, picture, safe);
            }
        }
        if (recording) vm.stopBroadcast();
        else vm.stopPrank();
    }

    function _checkTransaction(string memory operation, uint256 total, bool stateGas, bool viaCall) private {
        uint256 state = _frameStateGas();
        require(total * GAS_ESTIMATE_MULTIPLIER / 100 <= TX_GAS_CAP, "junk transaction cap");
        _checkGasStep(GasStep(operation, total, state, viaCall), stateGas, block.gaslimit);
        emit JunkTransactionGas(operation, total, state);
    }
}
