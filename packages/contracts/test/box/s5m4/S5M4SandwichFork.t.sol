// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {S5M4Sandwich} from "./S5M4Sandwich.sol";

/// @notice S5.M4's sandwich campaign (BC-129) on a **read-only mainnet fork**: the canonical Uniswap v4 PoolManager
/// (`0x0000…4444…8A90`, the pinned source's runtime, MainnetForkTest) and WETH9 at the block the other mainnet fork suites
/// pin, the version deployed inside the fork by `CoreV1Deployment` (the pinned DrandSource put at its pin by the chain's
/// real CREATE2 deployer), box 0 created by factory v1 and the kit's Standard boxes beside it. Nothing is broadcast and
/// no key is used. Opt-in: `SH_FORK_MAINNET=true forge test --match-contract S5M4SandwichMainnetForkTest
/// --disable-block-gas-limit` (the kit's own CREATE exceeds the fork block's gas limit), reading `MAINNET_FORK_RPC_URL`
/// (default: the keyless archive gateway the other mainnet suites use) through Foundry's RPC cache.
contract S5M4SandwichMainnetForkTest is S5M4Sandwich {
    address internal constant PM = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant WETH9 = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    /// @dev ADR-0006's AU-03 block, as MainnetForkTest and the hook-gas research.
    uint256 internal constant FORK_BLOCK = 26_055_260;
    string internal constant DEFAULT_RPC = "https://eth.drpc.org";

    function _world() internal override {
        if (!vm.envOr("SH_FORK_MAINNET", false)) return;
        vm.createSelectFork(vm.envOr("MAINNET_FORK_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);
        assertEq(block.chainid, 1);
        _setUpOn(IPoolManager(PM), WETH9);
        _ready = true;
    }

    function test_BC129_forkEveryStepTypeTradesAfterASmallPushAndWaitsPastTheBand() public {
        _everyTypeTradesAndWaits();
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_BC129_forkSandwichNeverPays_buyBurn(uint256 ticks, bool sampledFirst) public {
        _round(BUY_BURN, ticks, sampledFirst);
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_BC129_forkSandwichNeverPays_sellForFit(uint256 ticks, bool sampledFirst) public {
        _round(SELL_FOR_FIT, ticks, sampledFirst);
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_BC129_forkSandwichNeverPays_buyForCreator(uint256 ticks, bool sampledFirst) public {
        _round(BUY_FOR_CREATOR, ticks, sampledFirst);
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_BC129_forkSandwichNeverPays_sellForCreator(uint256 ticks, bool sampledFirst) public {
        _round(SELL_FOR_CREATOR, ticks, sampledFirst);
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_BC129_forkSandwichNeverPays_standardConversion(uint256 ticks, bool sampledFirst) public {
        _round(CONVERT_STANDARD, ticks, sampledFirst);
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_BC129_forkSandwichNeverPays_box0Conversion(uint256 ticks, bool sampledFirst) public {
        _round(CONVERT_BOX0, ticks, sampledFirst);
    }

    /// forge-config: default.fuzz.runs = 128
    function testFuzz_BC129_forkSandwichNeverPays_fitExecutor(uint256 ticks, bool sampledFirst) public {
        _round(FIT_EXECUTOR, ticks, sampledFirst);
    }
}

/// @notice The same campaign on a **read-only Sepolia fork** (the canonical Sepolia PoolManager and WETH9 at the block
/// SepoliaForkTest pins, before Sepolia's Glamsterdam fork). Opt-in: `SH_FORK_SEPOLIA=true forge test --match-contract
/// S5M4SandwichSepoliaForkTest --disable-block-gas-limit`, reading `SEPOLIA_FORK_RPC_URL` (default: the keyless gateway that serves historical
/// state).
contract S5M4SandwichSepoliaForkTest is S5M4Sandwich {
    address internal constant PM = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address internal constant WETH9 = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
    uint256 internal constant FORK_BLOCK = 11_780_483;
    string internal constant DEFAULT_RPC = "https://sepolia.gateway.tenderly.co";

    function _world() internal override {
        if (!vm.envOr("SH_FORK_SEPOLIA", false)) return;
        vm.createSelectFork(vm.envOr("SEPOLIA_FORK_RPC_URL", string(DEFAULT_RPC)), FORK_BLOCK);
        assertEq(block.chainid, 11_155_111);
        _setUpOn(IPoolManager(PM), WETH9);
        _ready = true;
    }

    function test_BC129_sepoliaForkEveryStepTypeTradesAfterASmallPushAndWaitsPastTheBand() public {
        _everyTypeTradesAndWaits();
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_BC129_sepoliaForkSandwichNeverPays_buyBurn(uint256 ticks, bool sampledFirst) public {
        _round(BUY_BURN, ticks, sampledFirst);
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_BC129_sepoliaForkSandwichNeverPays_sellForCreator(uint256 ticks, bool sampledFirst) public {
        _round(SELL_FOR_CREATOR, ticks, sampledFirst);
    }

    /// forge-config: default.fuzz.runs = 64
    function testFuzz_BC129_sepoliaForkSandwichNeverPays_box0Conversion(uint256 ticks, bool sampledFirst) public {
        _round(CONVERT_BOX0, ticks, sampledFirst);
    }
}
