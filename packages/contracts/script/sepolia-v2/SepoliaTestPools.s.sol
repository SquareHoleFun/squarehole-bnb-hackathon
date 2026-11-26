// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {TestPoolLiquidity} from "../../src/test-coins/TestPoolLiquidity.sol";
import {CoreV2GasRules} from "./CoreV2GasRules.sol";

/// @notice TA-30 unsigned calls. run() never broadcasts, signs, approves, initializes or moves money.
/// The founder deploys one helper, then sends each reviewed approve/seed/clear triple from its owner.
contract SepoliaTestPools is Script, CoreV2GasRules {
    address public constant SEPOLIA_MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    struct UnsignedCall { address to; uint256 value; bytes data; }
    event PoolCall(uint256 indexed index, address to, uint256 value, bytes data);
    event LiquidityHelper(address helper, address owner, bytes32 codeHash, uint256 measuredGas);

    /// @notice Separate founder-only deployment rehearsal; --broadcast is an explicit founder CLI decision.
    function deployHelper() external returns (address deployed) {
        _chain();
        bool stateGas;
        if (block.chainid == RULES_SEPOLIA) {
            _checkGlamsterdamWindow(block.chainid, block.timestamp);
            (stateGas,) = _checkGlamsterdamSimulated(block.chainid, block.timestamp);
        } else stateGas = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN;
        address sender = vm.envAddress("CORE_V2_DEPLOYER");
        require(sender != address(0), "sender");
        bool recording = vm.envOr("CORE_V2_BROADCAST", false);
        if (recording) {
            require(msg.sender == sender, "deployer");
            vm.startBroadcast(sender);
        } else vm.startPrank(sender);
        uint256 beforeGas = gasleft();
        deployed = address(new TestPoolLiquidity(IPoolManager(SEPOLIA_MANAGER), sender));
        uint256 measured = beforeGas - gasleft() + 21_000 + 40 * (type(TestPoolLiquidity).creationCode.length + 64);
        uint256 state = _frameStateGas();
        _checkGasStep(GasStep("TestPoolLiquidity", measured, state, false), stateGas, block.gaslimit);
        if (recording) vm.stopBroadcast();
        else vm.stopPrank();
        emit LiquidityHelper(deployed, sender, deployed.codehash, measured);
    }

    /// @notice Reads explicit env flags. Raw price and budgets are integers, never displayed decimal prices.
    function run() external returns (UnsignedCall[3] memory calls) {
        address helper = vm.envAddress("TEST_POOL_HELPER");
        require(TestPoolLiquidity(helper).owner() == vm.envAddress("CORE_V2_DEPLOYER"), "helper owner");
        uint256 price = vm.envUint("TEST_POOL_SQRT_PRICE_X96");
        require(price <= type(uint160).max, "price overflow");
        int256 lo = vm.envOr("TEST_POOL_TICK_LOWER", int256(-887220));
        int256 hi = vm.envOr("TEST_POOL_TICK_UPPER", int256(887220));
        require(lo >= -887220 && hi <= 887220 && lo < hi, "tick overflow");
        TestPoolLiquidity.Seed memory s = TestPoolLiquidity.Seed(
            vm.envAddress("TEST_POOL_COIN"), uint160(price), int24(lo), int24(hi),
            vm.envUint("TEST_POOL_ETH_MAX"), vm.envUint("TEST_POOL_COIN_MAX"), vm.envUint("TEST_POOL_DEADLINE")
        );
        calls = plan(helper, s);
        for (uint256 i; i < calls.length; ++i) emit PoolCall(i, calls[i].to, calls[i].value, calls[i].data);
    }

    function plan(address helper, TestPoolLiquidity.Seed memory s) public view returns (UnsignedCall[3] memory calls) {
        _chain();
        TestPoolLiquidity lp = TestPoolLiquidity(helper);
        require(block.chainid != 11_155_111 || address(lp.manager()) == SEPOLIA_MANAGER, "Sepolia manager");
        lp.quote(s);
        calls[0] = UnsignedCall(s.coin, 0, abi.encodeCall(IERC20.approve, (helper, s.amount1Max)));
        calls[1] = UnsignedCall(helper, s.amount0Max, abi.encodeCall(lp.seed, (s)));
        calls[2] = UnsignedCall(s.coin, 0, abi.encodeCall(IERC20.approve, (helper, 0)));
    }

    function _chain() private view {
        require(block.chainid == 11_155_111 || block.chainid == 31337, "testnet only");
    }
}
