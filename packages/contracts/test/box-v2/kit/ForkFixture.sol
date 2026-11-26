// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

interface IKitV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function liquidity() external view returns (uint128);
    /// sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, feeProtocol, unlocked
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
    /// Anyone may raise a pool's oracle buffer (Uniswap v3 `UniswapV3Pool.sol`).
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

interface IKitV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
}

interface IKitErc4626 {
    function asset() external view returns (address);
    function convertToAssets(uint256 shares) external view returns (uint256);
}

/// Sky's UsdsPsmWrapper: USDS against USDC through the LitePSM, `tin`/`tout` its fees.
interface IKitPsmWrapper {
    function usds() external view returns (address);
    function gem() external view returns (address);
    function tin() external view returns (uint256);
    function tout() external view returns (uint256);
    function pocket() external view returns (address);
}

/// @title ForkFixture
/// @notice TEST ONLY (M1-03): a mainnet fork pinned at one block, with the representative routes M1-23 simulates
/// (`core-v2-m1-tickets.md:443-444`): a deep and a thin v3 pool, a v3 pool whose oracle cannot cover the hour, the v2
/// PAXG/WETH pair, NVDAon's two-hop stock route through USDC, and sUSDS through Sky's vault and PSM (a `FIXED_RATE`
/// hop, ADR-0017 § 3, with both proxies' EIP-1967 implementation slots pinned). Every address and figure below was
/// read at `FORK_BLOCK` (`docs/evidence/SH-V2-M1-03.md`). Opt-in, as the repository's fork tests
/// (`foundry.toml:1-3`): `SH_FORK_MAINNET=true`; `MAINNET_FORK_RPC_URL` overrides the keyless default. Without the
/// opt-in, or when no RPC answers, a test calling `_selectMainnetFork()` is skipped with its reason. Box pools are
/// local (`BoxV2TestBase`), not forked. Fork tests cannot run in the lane sandbox.
abstract contract ForkFixture is Test {
    /// 2026-09-25 UTC; the block of ADR-0006's AU-03 read-only check (`test/fork/ForkTests.t.sol:235`).
    uint256 internal constant FORK_BLOCK = 26_055_260;
    uint256 internal constant FORK_TIME = 1_790_348_891;
    /// A keyless archive RPC that serves this block (as `test/fork/ForkTests.t.sol:236`).
    string internal constant DEFAULT_RPC = "https://eth.drpc.org";
    bytes32 internal constant EIP1967_IMPLEMENTATION_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    address internal constant V4_POOL_MANAGER = 0x000000000004444c5dc75cB358380D2e3dE08A90;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant PAXG = 0x45804880De22913dAFE09f4980848ECE6EcbAf78;
    /// Ondo Global Markets' NVIDIA token (18 decimals).
    address internal constant NVDAON = 0x2D1F7226Bd1F780AF6B9A49DCC0aE00E8Df4bDEE;
    address internal constant USDS = 0xdC035D45d973E3EC169d2276DDab16f1e407384F;
    address internal constant SUSDS = 0xa3931d71877C0E7a3148CB7Eb4463524FEc27fbD;

    /// Deep v3: USDC/WETH 0.05% (liquidity 2.997e18, an oracle of 723 slots).
    address internal constant V3_USDC_WETH_DEEP = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
    /// Thin v3: USDC/WETH 1% (liquidity 1.356e16, 51 slots). Its buffer already exceeds CQ8's two-slot
    /// floor; listing admission must still check its depth.
    address internal constant V3_USDC_WETH_THIN = 0x7BeA39867e4169DBe237d55C8242a8f2fcDcc387;
    /// A v3 pool whose oracle cannot cover the hour: PAXG/WETH 1%, one slot.
    address internal constant V3_PAXG_WETH_NO_HOUR = 0xcb1Abb2731a48D8819f03808013C0a0E48D9B3d9;
    /// The v2 PAXG/WETH pair (PAXG's transfer fee can be switched on, F83 G1).
    address internal constant V2_PAXG_WETH = 0x9C4Fe5FFD9A9fC5678cFBd93Aa2D4FD684b67C4C;
    /// NVDAon's first hop: NVDAon/USDC 1% (its 0.3% pool held no active liquidity); then `V3_USDC_WETH_DEEP`. Its
    /// buffer (48) already exceeds the two-slot floor.
    address internal constant V3_NVDAON_USDC = 0xf5294094BCe435bFbd0eC488be5C462aAF32Bc7A;
    /// Sky's UsdsPsmWrapper and the LitePSM pocket holding its USDC.
    address internal constant USDS_PSM_WRAPPER = 0xA188EEC8F81263234dA3622A406892F3D630f98c;
    address internal constant LITE_PSM_POCKET = 0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341;
    bytes32 internal constant SUSDS_IMPLEMENTATION =
        bytes32(uint256(uint160(0x4e7991e5C547ce825BdEb665EE14a3274f9F61e0)));
    bytes32 internal constant USDS_IMPLEMENTATION =
        bytes32(uint256(uint160(0x1923DfeE706A8E78157416C29cBCCFDe7cdF4102)));

    /// A v3 pool's `observationCardinalityNext`, the buffer `V3_ORACLE_BUFFER_FLOOR` reads.
    function _cardinalityNext(address pool) internal view returns (uint16 next) {
        (,,,, next,,) = IKitV3Pool(pool).slot0();
    }

    /// Legacy gas-measurement increment used by gas/RunGas.t.sol; not the listing readiness target.
    uint16 internal constant ORACLE_GROW_CHUNK = 100;

    /// Grow only when below the requested floor (CQ8: 2). Existing larger buffers need no call.
    /// This allocates capacity; later observations still require pool activity.
    function _growOracleBuffer(address pool, uint16 target) internal {
        if (_cardinalityNext(pool) < target) IKitV3Pool(pool).increaseObservationCardinalityNext(target);
    }

    /// Selects the pinned fork; false (and the test skipped, with its reason) without the opt-in or an RPC.
    function _selectMainnetFork() internal returns (bool) {
        if (!vm.envOr("SH_FORK_MAINNET", false)) {
            vm.skip(true, "mainnet fork is opt-in: SH_FORK_MAINNET=true");
            return false;
        }
        string memory rpc = vm.envOr("MAINNET_FORK_RPC_URL", string(DEFAULT_RPC));
        try vm.createSelectFork(rpc, FORK_BLOCK) returns (uint256) {
            return true;
        } catch {
            vm.skip(true, "no keyless mainnet RPC answered at FORK_BLOCK");
            return false;
        }
    }
}
