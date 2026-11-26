// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AlphaDrainSetup} from "./AlphaDrain.t.sol";
import {AlphaRehearsalSetup} from "../../../script/local/AlphaRehearsalSetup.s.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {TestETH} from "../../../src/test-coins/TestETH.sol";
import {TestPairLiquidity} from "../../../src/test-coins/TestPairLiquidity.sol";
import {IERC20} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {CoinVectors} from "./fixtures/CoinVectors.sol";

/// Real 31337 alpha assets/pools, captured storage and execution as independent TypeScript quote oracle.
contract AlphaCoinCallsTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    address private constant W = address(0xA11FA);
    address private constant A = address(0xA11CE);
    AlphaRehearsalSetup.Assets private a;
    IPoolManager private manager;
    PoolSwapTest private swapper;

    function setUp() public {
        vm.chainId(31337); vm.warp(1_790_000_000); vm.roll(16); vm.deal(W, 100 ether);
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(W)));
        swapper = new PoolSwapTest(manager);
        a = new AlphaDrainSetup().seed(address(manager), W);
        vm.prank(W); TestETH(a.teth).setAdmitter(address(0xAD), 1);
        vm.prank(address(0xAD)); TestETH(a.teth).admitOne(A);
    }
    function _case(uint256 id) private view returns (PoolKey memory key, address input, address output, uint256 amount) {
        address coin = id / 2 == 0 ? a.usdc : id / 2 == 1 ? a.nvda : id / 2 == 2 ? a.gold : a.pepe;
        bool forward = id % 2 == 0;
        input = forward ? a.teth : coin; output = forward ? coin : a.teth;
        amount = forward ? (id == 6 ? 10 ether : 100 ether)
            : id == 1 ? 100e6 : id == 3 ? 100 ether : id == 5 ? 1 ether : 1_000_000 ether;
        key = TestPairLiquidity(a.pairs).key(input, output);
    }
    function _fund(address coin, uint256 amount) private { vm.prank(W); IERC20(coin).transfer(A, amount); }
    function _call(address target, bytes memory data, uint256 gasLimit) private returns (bytes memory out) {
        vm.prank(A); (bool ok, bytes memory answer) = target.call{gas: gasLimit}(data);
        assertTrue(ok, "prepared bytes execute"); return answer;
    }
    function test_preparedFaucetBytesFitGasFloor() public {
        bytes memory data = CoinVectors.drip();
        assertEq(data, abi.encodeCall(TestETH.drip, ()));
        _call(a.teth, data, 480_000);
        assertEq(IERC20(a.teth).balanceOf(A), 1 ether);
        assertEq(TestETH(a.teth).nextDripAt(A), block.timestamp + 1 days);
    }
    function test_preparedEightPairVectorsExactApprovalSwapRevoke() public {
        for (uint256 id; id < 8; ++id) {
            uint256 snap = vm.snapshotState();
            (PoolKey memory key, address input, address output, uint256 amount) = _case(id);
            _fund(input, amount);
            bytes memory approve = CoinVectors.approval(id, address(swapper), false);
            assertEq(approve, abi.encodeCall(IERC20.approve, (address(swapper), amount)));
            _call(input, approve, 300_000);
            (bytes memory data, uint256 expected, uint160 price) = CoinVectors.swap(id, key);
            assertGt(data.length, 0, "generated swap required");
            BalanceDelta delta = BalanceDelta.wrap(abi.decode(_call(address(swapper), data, 4_000_000), (int256)));
            assertEq(IERC20(input).balanceOf(A), 0, "whole input spent");
            assertEq(uint256(-int256(input < output ? delta.amount0() : delta.amount1())), amount);
            assertEq(IERC20(output).balanceOf(A), expected, "exact raw output");
            (uint160 actual,,,) = manager.getSlot0(key.toId()); assertEq(actual, price, "exact post price");
            _call(input, CoinVectors.approval(id, address(swapper), true), 300_000);
            assertEq(IERC20(input).allowance(A, address(swapper)), 0);
            vm.revertToState(snap);
        }
    }
    function test_competingTradeLeavesPartialInputToRevoke() public {
        (PoolKey memory key, address input, address output, uint256 amount) = _case(0);
        _fund(input, amount);
        (bytes memory data,,) = CoinVectors.swap(0, key);
        assertGt(data.length, 0, "generated swap required");
        bool z = input < output;
        vm.startPrank(W);
        IERC20(input).approve(address(swapper), 20 ether);
        swapper.swap(key, SwapParams(z, -int256(20 ether), z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        IERC20(input).approve(address(swapper), 0); vm.stopPrank();
        _call(input, CoinVectors.approval(0, address(swapper), false), 300_000);
        _call(address(swapper), data, 4_000_000);
        uint256 left = IERC20(input).balanceOf(A);
        assertGt(left, 0); assertLt(left, amount); assertGt(IERC20(output).balanceOf(A), 0);
        assertEq(IERC20(input).allowance(A, address(swapper)), left);
        _call(input, CoinVectors.approval(0, address(swapper), true), 300_000);
        assertEq(IERC20(input).allowance(A, address(swapper)), 0);
    }
    function test_captureIndependentPoolStateAndResults() public {
        for (uint256 id; id < 8; ++id) {
            uint256 snap = vm.snapshotState(); _capture(id); vm.revertToState(snap);
        }
    }
    function _capture(uint256 id) private {
        (PoolKey memory key, address input, address output, uint256 amount) = _case(id);
        bytes32 base = keccak256(abi.encode(key.toId(), uint256(6)));
        string memory name = vm.toString(id);
        vm.serializeString(name, "name", name);
        vm.serializeString(name, "teth", vm.toString(a.teth));
        vm.serializeString(name, "coin", vm.toString(id % 2 == 0 ? output : input));
        vm.serializeString(name, "base", vm.toString(base));
        vm.serializeString(name, "amount", vm.toString(amount));
        vm.serializeString(name, "storage", _storage(base, name));
        _fund(input, amount);
        vm.startPrank(A); IERC20(input).approve(address(swapper), amount);
        bool z = input < output;
        BalanceDelta delta = swapper.swap(key, SwapParams(z, -int256(amount), z ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1), PoolSwapTest.TestSettings(false, false), "");
        vm.stopPrank();
        (uint160 price,,,) = manager.getSlot0(key.toId());
        vm.serializeString(name, "input", vm.toString(uint256(-int256(z ? delta.amount0() : delta.amount1()))));
        vm.serializeString(name, "output", vm.toString(uint256(int256(z ? delta.amount1() : delta.amount0()))));
        emit log_string(string.concat("COIN ", vm.serializeString(name, "afterPrice", vm.toString(price))));
    }
    function _storage(bytes32 base, string memory name) private returns (string memory json) {
        string memory s = string.concat("state", name);
        vm.serializeString(s, vm.toString(base), vm.toString(uint256(vm.load(address(manager), base))));
        json = vm.serializeString(s, vm.toString(bytes32(uint256(base) + 3)), vm.toString(uint256(vm.load(address(manager), bytes32(uint256(base) + 3)))));
        for (int256 word = -58; word <= 57; ++word) {
            bytes32 slot = keccak256(abi.encode(word, uint256(base) + 5));
            uint256 bitmap = uint256(vm.load(address(manager), slot));
            json = vm.serializeString(s, vm.toString(slot), vm.toString(bitmap));
            for (uint256 bit; bit < 256 && bitmap != 0; ++bit) {
                if (bitmap & (uint256(1) << bit) == 0) continue;
                bytes32 ts = keccak256(abi.encode((word * 256 + int256(bit)) * 60, uint256(base) + 4));
                json = vm.serializeString(s, vm.toString(ts), vm.toString(uint256(vm.load(address(manager), ts))));
                bitmap &= ~(uint256(1) << bit);
            }
        }
    }
    function test_actualFaucetAndTokenErrors() public {
        _error("not_admitted", address(0xBAD), a.teth, abi.encodeCall(TestETH.drip, ()));
        _call(a.teth, abi.encodeCall(TestETH.drip, ()), 480_000);
        _error("cooldown_active", A, a.teth, abi.encodeCall(TestETH.drip, ()));
        _error("insufficient_allowance", A, a.usdc, abi.encodeCall(IERC20.transferFrom, (W, A, 1)));
        _error("insufficient_balance", A, a.usdc, abi.encodeCall(IERC20.transfer, (W, 1)));
        vm.prank(W); TestETH(a.teth).setOpen(true);
        for (uint160 i = 1; i < 500; ++i) { vm.prank(address(i)); TestETH(a.teth).drip(); }
        _error("daily_cap_reached", address(0xBAD), a.teth, abi.encodeCall(TestETH.drip, ()));
        // Zero-balance implementation isolates the real box token's two-argument failures.
        BoxTokenV2 token = new BoxTokenV2(address(0xC00));
        _error("insufficient_allowance", A, address(token), abi.encodeCall(IERC20.transferFrom, (W, A, 1)));
        _error("insufficient_balance", A, address(token), abi.encodeCall(BoxTokenV2.burn, (1)));
    }
    function _error(string memory reason, address from, address target, bytes memory data) private {
        vm.prank(from); (bool ok, bytes memory out) = target.call(data);
        assertFalse(ok); emit log_string(string.concat("COIN_ERROR|", reason, "|", vm.toString(out)));
    }
}
