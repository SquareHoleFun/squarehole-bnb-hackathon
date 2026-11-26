// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditU6LaneBase} from "./AuditU6LaneBase.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";

/// @notice U6.13 / BC-069: caller-frame execution gas, excluding intrinsic gas and test-data construction.
/// Cold contract/storage access is reset before each sample; production compiler settings are unchanged.
/// forge-config: default.evm_version = "osaka"
contract AuditU6LaneGas is AuditU6LaneBase {
    function _cool() internal {
        vm.cool(a.tickets);
        vm.cool(a.vault);
        vm.cool(a.token);
        vm.cool(a.collection);
        vm.cool(a.itemStream);
        vm.cool(address(src));
        vm.cool(address(drand));
    }

    function testProperty_AUDIT_U6_settleLinearSlopeDrawOpenBoundsAndSize() public {
        _ready();
        uint256 maxDrawGas;
        for (uint256 i; i < 32; ++i) {
            _cool();
            vm.prank(alice);
            uint256 start = gasleft();
            tickets.draw(type(uint256).max, block.timestamp);
            uint256 used = start - gasleft();
            if (used > maxDrawGas) maxDrawGas = used;
        }
        _postRound(4);
        uint256 snap = vm.snapshotState();
        uint256 previous;
        uint256 previousK;
        uint256 minSlope = type(uint256).max;
        uint256 maxSlope;
        for (uint256 k = 1; k <= 32; k *= 2) {
            vm.revertToState(snap);
            _cool();
            uint256 start = gasleft();
            uint256 settled = tickets.settle(k);
            uint256 used = start - gasleft();
            assertEq(settled, k);
            emit log_named_uint("settle k", k);
            emit log_named_uint("settle gas", used);
            if (previousK != 0) {
                uint256 slope = (used - previous) / (k - previousK);
                if (slope < minSlope) minSlope = slope;
                if (slope > maxSlope) maxSlope = slope;
                bool amsterdam = keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
                assertGt(slope, amsterdam ? 130_000 : 40_000);
                assertLt(slope, amsterdam ? 150_000 : 46_000);
            }
            assertLt(used, 150_000 + 150_000 * k, "linear upper envelope");
            previous = used;
            previousK = k;
        }
        assertLt(maxSlope - minSlope, 30_000, "bounded per-draw slope variation");
        ItemReveal memory r = art.reveal(tickets.drawTicket(32).itemId);
        _cool();
        vm.prank(alice);
        uint256 start = gasleft();
        tickets.openDraw(32, bob, r);
        uint256 openGas = start - gasleft();
        emit log_named_uint("settle min slope", minSlope);
        emit log_named_uint("settle max slope", maxSlope);
        emit log_named_uint("max draw gas", maxDrawGas);
        emit log_named_uint("open settled draw gas", openGas);
        assertLt(maxDrawGas, 1_000_000);
        assertLt(openGas, 1_500_000);
        uint256 size = b.impls().tickets.code.length;
        emit log_named_uint("tickets implementation bytes", size);
        assertLe(size, 24_576 - 1_000);
        _empty();
    }

    /// Opening a requested draw includes its FIFO predecessors. The bound explicitly includes that work.
    function testProperty_AUDIT_U6_openDrawImplicitSettlementBound() public {
        _ready();
        for (uint256 i; i < 16; ++i) {
            _draw(alice, 0);
        }
        _postRound(4);
        uint256 snap = vm.snapshotState();
        tickets.settle(16);
        ItemReveal memory r = art.reveal(tickets.drawTicket(16).itemId);
        vm.revertToState(snap);
        _cool();
        vm.prank(alice);
        uint256 start = gasleft();
        tickets.openDraw(16, bob, r);
        uint256 used = start - gasleft();
        emit log_named_uint("open draw including 16 settlements", used);
        assertLt(used, 3_200_000);
        assertEq(tickets.status().drawsSettled, 16);
        _empty();
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU6LaneGasAmsterdam is AuditU6LaneGas {}
