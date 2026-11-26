// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditBox0World} from "../common/AuditBox0World.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {S6ClaimsMinter} from "../../s6/BoxS6Mocks.sol";
import {Vm} from "forge-std/Vm.sol";

/// @notice Factory-created mainnet box 0. No substituted production contract in this base.
abstract contract AuditU2LaneBase is AuditBox0World {
    using StateLibrary for IPoolManager;

    function _allWritesReverted(Vm.AccountAccess[] memory changes) internal pure {
        for (uint256 i; i < changes.length; ++i) {
            for (uint256 j; j < changes[i].storageAccesses.length; ++j) {
                Vm.StorageAccess memory s = changes[i].storageAccesses[j];
                if (s.isWrite) assertTrue(s.reverted, "every attempted storage write rolled back");
            }
        }
    }

    function _closeLane() internal {
        _warpTo(hook.openAt() + 384);
        _buyTo(eoa[0], 2 * raise, curve.sqrtPriceLowerX96);
        assertTrue(hook.closed());
    }

    function _priceLane() internal view returns (uint160 p) {
        (p,,,) = pm.getSlot0(poolKey.toId());
    }

    /// @dev A normal third-party ERC-6909 mint, backed by real ETH settlement, then transfer to the coordinator.
    function _giftClaimsLane(uint256 amount) internal {
        S6ClaimsMinter minter = new S6ClaimsMinter(pm);
        vm.deal(address(this), address(this).balance + amount);
        minter.mintTo{value: amount}(eoa[1]);
        vm.prank(eoa[1]);
        pm.transfer(a.coordinator, 0, amount);
    }
}
