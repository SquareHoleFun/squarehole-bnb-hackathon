// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CoreV2GasRules} from "./CoreV2GasRules.sol";
import {Script} from "forge-std/Script.sol";
import {SepoliaTestToken, SepoliaTestCollection} from "./SepoliaV2TestSet.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TestCoin, TestLINK, TestUSDC, TestNVDA, TestGold, TestPEPE, TestFrog} from "../../src/test-coins/TestCoins.sol";
import {TestETH} from "../../src/test-coins/TestETH.sol";
import {ReleaseConstantsV2 as C} from "../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// @notice Optional labelled test assets. Never lists a coin; the platform Safe makes that separate decision.
contract DeploySepoliaV2TestSet is Script, CoreV2GasRules {
    bool private stateGas;
    event TestDeploymentGas(string artifact, uint256 total, uint256 stateGas);
    event TestAsset(address token, uint8 decimals, address owner, bytes32 codeHash);
    event TestHelper(address helper, string purpose, bytes32 codeHash);

    error TokenAddressTooHigh(address predicted);

    /// @notice SH-ALPHA-TETH: the deployer receives the initial tETH supply. Listing remains a separate Safe action.
    /// Check the deployer's next CREATE address before recording any unsigned broadcast transaction.
    function runTestETH() external returns (address asset) {
        require(block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
        _rules();
        address sender = vm.envAddress("CORE_V2_DEPLOYER");
        require(sender != address(0), "sender");
        address predicted = vm.computeCreateAddress(sender, vm.getNonce(sender));
        if (uint160(predicted) >= C.LISTED_TOKEN_CEILING) revert TokenAddressTooHigh(predicted);
        bool recording = vm.envOr("CORE_V2_BROADCAST", false);
        if (recording) {
            require(msg.sender == sender, "deployer");
            vm.startBroadcast(sender);
        } else vm.startPrank(sender);
        asset = _checkedCreate("tETH", bytes.concat(type(TestETH).creationCode, abi.encode(sender)));
        if (recording) vm.stopBroadcast();
        else vm.stopPrank();
        require(asset == predicted, "unexpected token address");
        emit TestAsset(asset, TestETH(asset).decimals(), sender, asset.codehash);
    }

    /// @notice TA-30: six one-time issuances to TEST_COIN_RECIPIENT. Default run() keeps the older 6/8/18 rehearsal.
    /// No key is read. CORE_V2_BROADCAST records unsigned transactions; only founder's --broadcast sends them.
    function runTestCoins() external returns (address[6] memory assets) {
        require(block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
        _rules();
        address sender = vm.envAddress("CORE_V2_DEPLOYER");
        address recipient = vm.envAddress("TEST_COIN_RECIPIENT");
        require(sender != address(0) && recipient != address(0), "sender and recipient");
        bool recording = vm.envOr("CORE_V2_BROADCAST", false);
        if (recording) {
            require(msg.sender == sender, "deployer");
            vm.startBroadcast(sender);
        } else vm.startPrank(sender);
        assets[0] = _checkedCreate("tLINK", bytes.concat(type(TestLINK).creationCode,
            abi.encode(recipient, vm.envOr("TEST_LINK_SUPPLY_RAW", uint256(1_000_000e18)))));
        assets[1] = _checkedCreate("tUSDC", bytes.concat(type(TestUSDC).creationCode,
            abi.encode(recipient, vm.envOr("TEST_USDC_SUPPLY_RAW", uint256(1_000_000e6)))));
        assets[2] = _checkedCreate("tNVDA", bytes.concat(type(TestNVDA).creationCode,
            abi.encode(recipient, vm.envOr("TEST_NVDA_SUPPLY_RAW", uint256(1_000_000e18)))));
        assets[3] = _checkedCreate("tGOLD", bytes.concat(type(TestGold).creationCode,
            abi.encode(recipient, vm.envOr("TEST_GOLD_SUPPLY_RAW", uint256(1_000_000e18)))));
        assets[4] = _checkedCreate("tPEPE", bytes.concat(type(TestPEPE).creationCode,
            abi.encode(recipient, vm.envOr("TEST_PEPE_SUPPLY_RAW", uint256(1_000_000_000e18)))));
        assets[5] = _checkedCreate("tFROG", bytes.concat(type(TestFrog).creationCode,
            abi.encode(recipient, vm.envOr("TEST_FROG_SUPPLY_RAW", uint256(1_000_000_000e18)))));
        if (recording) vm.stopBroadcast();
        else vm.stopPrank();
        for (uint256 i; i < assets.length; ++i) {
            emit TestAsset(assets[i], TestCoin(assets[i]).decimals(), recipient, assets[i].codehash);
        }
    }

    /// @notice Named founder optionally records a stock collection and the bounded-approval research swapper.
    function runHelpers() external {
        require(block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
        _rules();
        address owner = vm.envAddress("CORE_V2_DEPLOYER");
        bool sending = vm.envOr("CORE_V2_BROADCAST", false);
        if (sending) {
            require(msg.sender == owner, "deployer");
            vm.startBroadcast(owner);
        } else {
            vm.startPrank(owner);
        }
        address stock = _checkedCreate(
            "SepoliaTestCollection", bytes.concat(type(SepoliaTestCollection).creationCode, abi.encode(owner))
        );
        address swapper = _checkedCreate(
            "PriceLimitSwapper",
            bytes.concat(
                type(PriceLimitSwapper).creationCode, abi.encode(IPoolManager(vm.envAddress("CORE_V2_POOL_MANAGER")))
            )
        );
        if (sending) vm.stopBroadcast();
        else vm.stopPrank();
        emit TestHelper(stock, "synthetic shop stock", stock.codehash);
        emit TestHelper(swapper, "research-only price-limit swapper", swapper.codehash);
    }

    /// @notice Anyone may simulate; only the named founder sender may opt into Foundry's broadcast recording.
    function run() external returns (address[3] memory assets) {
        require(block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
        _rules();
        address owner = vm.envAddress("CORE_V2_DEPLOYER");
        bool sending = vm.envOr("CORE_V2_BROADCAST", false);
        if (sending) {
            require(msg.sender == owner, "deployer");
            vm.startBroadcast(owner);
        } else {
            vm.startPrank(owner);
        }
        assets[0] = _checkedCreate(
            "tUSD",
            bytes.concat(type(SepoliaTestToken).creationCode, abi.encode("Rehearsal USD", "tUSD", uint8(6), owner))
        );
        assets[1] = _checkedCreate(
            "tBTC",
            bytes.concat(type(SepoliaTestToken).creationCode, abi.encode("Rehearsal BTC", "tBTC", uint8(8), owner))
        );
        assets[2] = _checkedCreate(
            "tLINK",
            bytes.concat(type(SepoliaTestToken).creationCode, abi.encode("Rehearsal LINK", "tLINK", uint8(18), owner))
        );
        if (sending) vm.stopBroadcast();
        else vm.stopPrank();
        for (uint256 i; i < 3; ++i) {
            emit TestAsset(assets[i], SepoliaTestToken(assets[i]).decimals(), owner, assets[i].codehash);
        }
    }

    function _rules() private {
        if (block.chainid == RULES_SEPOLIA) {
            _checkGlamsterdamWindow(block.chainid, block.timestamp);
            (stateGas,) = _checkGlamsterdamSimulated(block.chainid, block.timestamp);
        } else {
            stateGas = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN;
        }
    }

    /// @dev Every CREATE is its own broadcast transaction. Nothing batches deployment through a helper contract.
    function _checkedCreate(string memory label, bytes memory code) private returns (address part) {
        uint256 beforeGas = gasleft();
        assembly ("memory-safe") { part := create(0, add(code, 32), mload(code)) }
        uint256 total = beforeGas - gasleft() + 21_000 + 40 * code.length;
        uint256 state = _frameStateGas();
        require(part != address(0), "test asset CREATE failed");
        // These small optional helpers also fit the stricter total cap, before any state-gas separation.
        require(total * GAS_ESTIMATE_MULTIPLIER / 100 <= TX_GAS_CAP, "test asset transaction cap");
        _checkGasStep(GasStep(label, total, state, false), stateGas, block.gaslimit);
        emit TestDeploymentGas(label, total, state);
    }
}
