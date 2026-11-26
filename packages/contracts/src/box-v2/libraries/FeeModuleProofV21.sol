// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IFeeModulesV21} from "../interfaces/IFeeModulesV21.sol";
import {FeeModuleDirectoryV21} from "../FeeModuleDirectoryV21.sol";

/// @notice Fixed read-only creation proofs; no runtime action depends on directory availability.
library FeeModuleProofV21 {
    error Miswired(uint256 check);
    /// @notice Factory/readers authenticate selected action addresses and codehashes on the completed clone.
    function creation(address directory, address receiver, uint8 buyers, uint8 sellers, uint32 buyersId, uint32 sellersId) external view {
        if (buyers == 10) _custom(receiver, directory, buyersId, false);
        if (sellers == 10) _custom(receiver, directory, sellersId, true);
    }
    function _custom(address receiver, address directory, uint32 id, bool sellers) private view {
        (address module, bytes32 hash) = FeeModuleDirectoryV21(directory).resolve(id);
        (address actual, bytes32 actualHash) = IFeeModulesV21(receiver).sideModule(sellers);
        if (module != actual || hash != actualHash || actual.codehash != hash) revert Miswired(205);
    }
}
