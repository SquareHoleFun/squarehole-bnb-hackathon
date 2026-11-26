// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IERC20Metadata} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {TestPairLiquidity} from "../../src/test-coins/TestPairLiquidity.sol";
import {TestPoolLiquidity} from "../../src/test-coins/TestPoolLiquidity.sol";
import {CoreV2GasRules} from "./CoreV2GasRules.sol";

/// @notice SH-ALPHA-PAIRS: deploy and seed the four F156 pairs, or separately remove unused native pools.
/// tETH is run(address)'s input; coin addresses use TEST_GOLD/USDC/NVDA/PEPE (cleanup also LINK/FROG).
/// CORE_V2_DEPLOYER and TEST_POOL_DEADLINE are required. CORE_V2_BROADCAST defaults to false (local rehearsal).
/// Recording unsigned transactions requires CORE_V2_BROADCAST=true and the matching --sender;
/// only an explicit founder --broadcast signs/sends. This script loads no key and makes no RPC calls.
contract SepoliaTestPairPools is Script, CoreV2GasRules {
    using PoolIdLibrary for *;
    using StateLibrary for IPoolManager;

    address public constant SEPOLIA_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    event PairHelper(address indexed helper, address indexed owner);
    event OldPoolRemoved(address indexed helper, address indexed coin, uint128 liquidity);

    function run(address tETH) external returns (address deployed) {
        _chain();
        address sender = vm.envAddress("CORE_V2_DEPLOYER");
        uint256 deadline = vm.envUint("TEST_POOL_DEADLINE");
        require(sender != address(0) && deadline >= block.timestamp, "sender or deadline");
        address[4] memory coins = [vm.envAddress("TEST_GOLD"), vm.envAddress("TEST_USDC"),
            vm.envAddress("TEST_NVDA"), vm.envAddress("TEST_PEPE")];
        uint256[4] memory budgets = [uint256(1000e18), 100_000e6, 100_000e18, 200_000_000e18];
        _coin(tETH, 18, sender, 3200e18);
        for (uint256 i; i < 4; ++i) {
            require(coins[i] != tETH, "distinct coins");
            for (uint256 j; j < i; ++j) require(coins[i] != coins[j], "distinct coins");
            _coin(coins[i], i == 1 ? 6 : 18, sender, budgets[i]);
        }
        bool stateGas = _gasRules();
        bool recording = _start(sender);
        uint256 beforeGas = gasleft();
        TestPairLiquidity helper = new TestPairLiquidity(IPoolManager(SEPOLIA_MANAGER), sender);
        _checkGasStep(GasStep("TestPairLiquidity",
            beforeGas - gasleft() + 21_000 + 40 * (type(TestPairLiquidity).creationCode.length + 64),
            _frameStateGas(), false), stateGas, block.gaslimit);
        for (uint256 i; i < 4; ++i) {
            _seed(helper, tETH, coins[i], i == 3 ? 200e18 : 1000e18, budgets[i], deadline, stateGas);
        }
        _stop(recording);
        deployed = address(helper);
        emit PairHelper(deployed, sender);
    }

    /// @notice Remove only USDC/NVDA/LINK/FROG, in that order. Minima use raw native/coin units.
    /// TEST_POOL_HELPER is the existing native helper. Range envs match SepoliaTestPools.s.sol's defaults.
    /// GOLD and PEPE are never removal targets; their Alchemist route stays funded.
    function removeUnusedPools(uint256[4] calldata minimumETH, uint256[4] calldata minimumCoin) external {
        _chain();
        TestPoolLiquidity helper = TestPoolLiquidity(vm.envAddress("TEST_POOL_HELPER"));
        address sender = vm.envAddress("CORE_V2_DEPLOYER");
        require(sender != address(0) && helper.owner() == sender, "helper owner");
        require(address(helper.manager()) == SEPOLIA_MANAGER, "Sepolia manager");
        (TestPoolLiquidity.Seed[4] memory seeds, uint128[4] memory held) = _removals(helper);
        bool stateGas = _gasRules();
        bool recording = _start(sender);
        for (uint256 i; i < 4; ++i) {
            uint256 beforeGas = gasleft();
            helper.remove(seeds[i], held[i], minimumETH[i], minimumCoin[i]);
            _checkCall("remove native pool", beforeGas, stateGas);
            emit OldPoolRemoved(address(helper), seeds[i].coin, held[i]);
        }
        _stop(recording);
    }

    function _removals(TestPoolLiquidity helper)
        private view returns (TestPoolLiquidity.Seed[4] memory seeds, uint128[4] memory held)
    {
        uint256 deadline = vm.envUint("TEST_POOL_DEADLINE");
        require(deadline >= block.timestamp, "deadline");
        int256 lo = vm.envOr("TEST_POOL_TICK_LOWER", int256(-887220));
        int256 hi = vm.envOr("TEST_POOL_TICK_UPPER", int256(887220));
        require(lo >= -887220 && hi <= 887220 && lo < hi && lo % 60 == 0 && hi % 60 == 0, "ticks");
        address[4] memory coins = [vm.envAddress("TEST_USDC"), vm.envAddress("TEST_NVDA"),
            vm.envAddress("TEST_LINK"), vm.envAddress("TEST_FROG")];
        for (uint256 i; i < 4; ++i) {
            require(coins[i] != vm.envAddress("TEST_GOLD") && coins[i] != vm.envAddress("TEST_PEPE"), "route coin");
            for (uint256 j; j < i; ++j) require(coins[i] != coins[j], "distinct coins");
            // The existing helper is the source of truth for native/coin, 3000, 60, no-hook keys.
            (held[i],,) = helper.manager().getPositionInfo(helper.key(coins[i]).toId(),
                address(helper), int24(lo), int24(hi), bytes32(0));
            require(held[i] > 0, "no liquidity");
            seeds[i] = TestPoolLiquidity.Seed(coins[i], 0, int24(lo), int24(hi), 0, 0, deadline);
        }
    }

    function _seed(TestPairLiquidity helper, address eth, address coin, uint256 amountETH, uint256 amountCoin,
        uint256 deadline, bool stateGas) private
    {
        _approve(eth, address(helper), amountETH, stateGas);
        _approve(coin, address(helper), amountCoin, stateGas);
        uint256 beforeGas = gasleft();
        helper.seed(TestPairLiquidity.Seed(eth, coin, amountETH, amountCoin, deadline));
        _checkCall("seed pair", beforeGas, stateGas);
        _approve(eth, address(helper), 0, stateGas);
        _approve(coin, address(helper), 0, stateGas);
    }

    function _approve(address coin, address helper, uint256 amount, bool stateGas) private {
        uint256 beforeGas = gasleft();
        require(IERC20Metadata(coin).approve(helper, amount), "approve");
        _checkCall("approve", beforeGas, stateGas);
    }

    function _coin(address coin, uint8 decimals_, address sender, uint256 amount) private view {
        require(coin.code.length > 0, "coin code");
        require(IERC20Metadata(coin).decimals() == decimals_, "decimals");
        require(IERC20Metadata(coin).balanceOf(sender) >= amount, "balance");
    }

    function _checkCall(string memory label, uint256 beforeGas, bool stateGas) private view {
        _checkGasStep(GasStep(label, beforeGas - gasleft() + 21_000, _frameStateGas(), true),
            stateGas, block.gaslimit);
    }

    function _gasRules() private returns (bool stateGas) {
        if (block.chainid == RULES_SEPOLIA) {
            _checkGlamsterdamWindow(block.chainid, block.timestamp);
            (stateGas,) = _checkGlamsterdamSimulated(block.chainid, block.timestamp);
        } else stateGas = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN;
    }

    function _start(address sender) private returns (bool recording) {
        recording = vm.envOr("CORE_V2_BROADCAST", false);
        if (recording) {
            require(msg.sender == sender, "deployer");
            vm.startBroadcast(sender);
        } else vm.startPrank(sender);
    }

    function _stop(bool recording) private {
        if (recording) vm.stopBroadcast();
        else vm.stopPrank();
    }

    function _chain() private view {
        require(block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
    }
}
