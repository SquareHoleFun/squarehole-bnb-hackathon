// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU5LaneBase} from "./AuditU5LaneBase.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {IBoxPriceAverage} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxVaultObserver} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {ItemReveal, VaultAction, DepthKind, DeepenSkip} from "../../../../src/box/interfaces/BoxTypes.sol";
import {OpenTime} from "../../utils/OpenTime.sol";

/// @notice BC-065; F87/F90. Replays every cold observer branch with N=4269 under both gas schedules.
/// Inherited isolated callback probes mock ticketInFlight only and add its separately measured cold code cost.
/// The complete production paths and real BLS verification are exercised by the life and invariant suites.
/// forge-config: default.evm_version = "osaka"
contract AuditU5LaneGas is AuditU5LaneBase {
    using StateLibrary for IPoolManager;

    function testProperty_AUDIT_U5_observerAndNoticeOsaka() public {
        (uint256 observer, uint256 notice) = _observerPaths(false);
        assertLt(observer, 460000);
        assertLt(notice, 200000);
    }

    function testProperty_AUDIT_U5_observerAndNoticeAmsterdam() public {
        (uint256 observer, uint256 notice) = _observerPaths(true);
        assertLt(observer, 460000);
        assertLt(notice, 200000);
    }

    function testProperty_AUDIT_U5_claimSlopeOsaka() public {
        _claimSlope(false);
    }

    function testProperty_AUDIT_U5_claimSlopeAmsterdam() public {
        _claimSlope(true);
    }

    function testProperty_AUDIT_U5_fourPositionsColdOsaka() public {
        _fourPositions(false);
    }

    function testProperty_AUDIT_U5_fourPositionsColdAmsterdam() public {
        _fourPositions(true);
    }

    function _fourPositions(bool amsterdam) internal {
        _life();
        for (uint256 i; i < 4; ++i) {
            uint256 bought = b.buy(dave, 10 ether, 0);
            b.sell(dave, bought);
        }
        _collect();
        _catchUp();
        (DepthKind kind, DeepenSkip skip,,,) = BoxHook(a.hook).deepen(keeper);
        if (kind == DepthKind.Convert) {
            _catchUp();
            (kind, skip,,,) = BoxHook(a.hook).deepen(keeper);
        }
        assertEq(uint256(skip), uint256(DeepenSkip.None));
        assertEq(uint256(kind), uint256(DepthKind.Pair));
        assertGt(BoxHook(a.hook).pairedLiquidity(), 0);
        _trade(2);
        assertEq(st.streamValue(), _referenceValue(), "four-position extsload parity");
        // Next request writes a fresh draw checkpoint, the worst cold observer branch. Only the isolated
        // request ordinal is staged as in the read-only gas fixture; pool, positions, fees and X are real.
        vm.store(a.tickets, bytes32(uint256(5)), bytes32(uint256(vm.load(a.tickets, bytes32(uint256(5)))) + (1 << 192)));
        uint256 worst = _frame(
            "four positions: fresh draw",
            amsterdam,
            a.vault,
            abi.encodeCall(
                IBoxVaultObserver.onVaultAction, (VaultAction.TicketsOpened, a.tickets, 1, BoxVault(a.vault).inside())
            )
        );
        uint256 notice = _noticeFrame(amsterdam);
        emit log_named_uint("four-position observer", worst);
        emit log_named_uint("four-position notice", notice);
        assertLt(worst, 460000);
        assertLt(notice, 200000);
    }

    function _catchUp() internal {
        uint256 steady;
        for (uint256 i; i < 3000 && steady < 320; ++i) {
            vm.roll(block.number + 1);
            vm.warp(block.timestamp + 12);
            int24 sample = IBoxPriceAverage(a.executor).poke();
            (, int24 spot,,) = IPoolManager(a.poolManager).getSlot0(BoxHook(a.hook).poolId());
            steady = sample == spot ? steady + 1 : 0;
        }
        assertEq(steady, 320);
    }

    function _claimSlope(bool amsterdam) internal {
        b.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        b.buy(alice, 2 ether, 0);
        _take(alice, 32);
        b.buy(carol, 3 * BoxCoordinator(a.coordinator).raise(), b.curve().sqrtPriceLowerX96);
        vm.warp(src.roundTime(r0) - 12);
        BoxCoordinator(a.coordinator).graduate();
        vm.warp(src.roundTime(r0));
        src.postRound(r0, _localSig(0));
        tix.acceptGraduationWord();
        vm.warp(block.timestamp + 31 days);
        uint256[] memory all = new uint256[](32);
        ItemReveal memory none;
        for (uint256 i; i < 32; ++i) {
            vm.prank(alice);
            all[i] = tix.open(i + 1, none);
        }
        _trade(2);
        _collect();
        uint256 snap = vm.snapshotState();
        uint256[6] memory gasUsed;
        for (uint256 k; k < 6; ++k) {
            uint256 count = uint256(1) << k;
            uint256[] memory ids = new uint256[](count);
            for (uint256 i; i < count; ++i) {
                ids[i] = all[i];
            }
            bytes memory data = abi.encodeCall(IBoxItemStream.claim, (ids, alice));
            _coolAll();
            vm.setEvmVersion(amsterdam ? "amsterdam" : "osaka");
            vm.prank(alice);
            uint256 start = gasleft();
            (bool ok,) = a.itemStream.call(data);
            gasUsed[k] = start - gasleft();
            vm.setEvmVersion("osaka");
            assertTrue(ok);
            vm.revertToState(snap);
        }
        uint256 slope = gasUsed[1] - gasUsed[0];
        emit log_named_uint(amsterdam ? "claim slope Amsterdam gas/id" : "claim slope Osaka gas/id", slope);
        emit log_named_uint("claim gas 1 id", gasUsed[0]);
        emit log_named_uint("claim gas 32 ids", gasUsed[5]);
        for (uint256 k; k < 6; ++k) {
            uint256 count = uint256(1) << k;
            // ABI/memory expansion adds a few gas; no nested per-id scan exists.
            assertApproxEqAbs(gasUsed[k], gasUsed[0] + slope * (count - 1), 128 * count);
        }
        assertLt(slope, 25000);
    }
}
