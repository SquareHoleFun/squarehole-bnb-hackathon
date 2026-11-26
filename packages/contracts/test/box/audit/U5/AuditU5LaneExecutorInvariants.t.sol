// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {AuditU5LaneBase} from "./AuditU5LaneBase.sol";
import {AuditU5LaneForceEther} from "./AuditU5LaneExecutor.t.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";

contract AuditU5LaneExecutorHandler is Test {
    using StateLibrary for IPoolManager;
    CoreBox0Kit internal kit;
    CoreBoxAddresses internal a;
    FitBuybackExecutor internal e;
    uint256 public incoming;
    uint256 public spent;
    uint256 public failures;
    uint256 public buys;
    uint256 public lastBuyBlock;
    uint256 public calls;

    constructor(CoreBox0Kit kit_) {
        kit = kit_;
        a = kit.addresses();
        e = FitBuybackExecutor(payable(a.executor));
        incoming = e.budget();
    }

    function fund(uint96 raw, uint160 caller) external {
        ++calls;
        uint256 amount = bound(raw, 0, 5 ether);
        address who = address(uint160(uint256(caller) % (type(uint160).max - 0x10000) + 0x10000));
        vm.deal(who, amount);
        vm.prank(who);
        e.fundBudget{value: amount}();
        incoming += amount;
    }

    function unrequested(uint96 raw, bool force) external {
        ++calls;
        uint256 amount = bound(raw, 0, 5 ether);
        vm.deal(address(this), amount);
        if (force) {
            new AuditU5LaneForceEther{value: amount}(payable(a.executor));
        } else {
            (bool ok,) = a.executor.call{value: amount}("");
            if (!ok) ++failures;
        }
        incoming += amount;
    }

    function advance(uint16 secs, uint8 blocks_) external {
        ++calls;
        vm.warp(block.timestamp + bound(secs, 0, 3600));
        vm.roll(block.number + blocks_);
    }

    function poke() external {
        ++calls;
        FitBuybackExecutor.Oracle memory old = e.oracle();
        e.poke();
        FitBuybackExecutor.Oracle memory now_ = e.oracle();
        int256 delta = int256(old.tick) - now_.tick;
        if (uint256(delta < 0 ? -delta : delta) > 100) ++failures;
        if (old.time == block.timestamp && keccak256(abi.encode(old)) != keccak256(abi.encode(now_))) ++failures;
    }

    function price(uint96 raw, bool buy) external {
        ++calls;
        address trader = address(0xB001);
        if (buy) {
            try kit.buy(trader, bound(raw, 1, 3 ether), 0) {} catch {}
        } else {
            uint256 balance = BoxToken(a.token).balanceOf(trader);
            if (balance != 0) {
                try kit.sell(trader, bound(raw, 1, balance)) {} catch {}
            }
        }
    }

    function execute(uint8 maxChunks, uint160 caller) external {
        ++calls;
        address who = address(uint160(uint256(caller) % (type(uint160).max - 0x10000) + 0x10000));
        uint256 callerETH = who.balance;
        uint256 poolETH = a.poolManager.balance;
        uint256 supply = BoxToken(a.token).totalSupply();
        (uint160 beforePrice,,,) = IPoolManager(a.poolManager).getSlot0(BoxHook(a.hook).poolId());
        vm.prank(who);
        try e.execute(maxChunks) returns (uint256 chunks, uint256 used, uint256 burned) {
            spent += used;
            if (who.balance != callerETH || a.poolManager.balance != poolETH + used) ++failures;
            if (BoxToken(a.token).totalSupply() + burned != supply || BoxToken(a.token).balanceOf(a.executor) != 0) {
                ++failures;
            }
            if (chunks > 1 || (chunks != 0 && lastBuyBlock == block.number)) ++failures;
            if (chunks != 0) {
                ++buys;
                lastBuyBlock = block.number;
                (uint160 afterPrice,,,) = IPoolManager(a.poolManager).getSlot0(BoxHook(a.hook).poolId());
                (, int24 avg,) = e.twap();
                uint160 impact =
                    uint160(FullMath.mulDivRoundingUp(beforePrice, TickMath.getSqrtPriceAtTick(-49), 1 << 96));
                if (afterPrice < impact || afterPrice < TickMath.getSqrtPriceAtTick(avg - 99)) ++failures;
            }
        } catch {
            ++failures;
        }
    }

    function budget() external view returns (uint256) {
        return e.budget();
    }

    function executorBalance() external view returns (uint256) {
        return a.executor.balance;
    }

    function heldT() external view returns (uint256) {
        return BoxToken(a.token).balanceOf(a.executor);
    }
}

/// @notice U5.1/6/9/11 on real factory box 0. Callee-floor refusal is covered separately by proof 51.
/// forge-config: default.evm_version = "osaka"
contract AuditU5LaneExecutorInvariants is AuditU5LaneBase {
    AuditU5LaneExecutorHandler internal handler;

    function setUp() public override {
        super.setUp();
        _graduateReady();
        handler = new AuditU5LaneExecutorHandler(b);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.fund.selector;
        selectors[1] = handler.unrequested.selector;
        selectors[2] = handler.advance.selector;
        selectors[3] = handler.poke.selector;
        selectors[4] = handler.price.selector;
        selectors[5] = handler.execute.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
    }

    function invariant_AUDIT_U5_budgetBurnAndBoundedExecution() public view {
        assertEq(handler.failures(), 0);
        assertEq(handler.budget(), handler.executorBalance());
        assertEq(handler.budget() + handler.spent(), handler.incoming());
        assertEq(handler.heldT(), 0);
    }

    function testProperty_AUDIT_U5_handlerCanBuy() public {
        handler.fund(1 ether, uint160(bob));
        handler.execute(1, uint160(carol));
        assertEq(handler.buys(), 1);
        invariant_AUDIT_U5_budgetBurnAndBoundedExecution();
    }
}
