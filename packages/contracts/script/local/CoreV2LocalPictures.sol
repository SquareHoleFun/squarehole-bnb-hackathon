// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CoreV2LocalActions} from "./CoreV2LocalActions.sol";
import {LocalBoxArt} from "./LocalBoxArt.sol";

/// @notice The local stack's recipe (SH-TA-33): CoreV2LocalLife and its offline tests. The local every-item box
/// commits catalogue PNGs the local art gateway already serves as its items' pictures (items 1-9: the nine local
/// logos, item 10: the items cover), so the box page shows hash-checked item pictures on the local stack.
/// PrepareCoreV2Box and SepoliaAllRehearsal inherit CoreV2LocalActions without this, so their item tree stays
/// `bytes32(id)` (XR-SH-TA-33 F1).
abstract contract CoreV2LocalPictures is CoreV2LocalActions {
    function _localItemImage(uint256 id) internal pure override returns (bytes32) {
        // casting to 'uint8' is safe because id - 1 is below 9 on this branch
        // forge-lint: disable-next-line(unsafe-typecast)
        return id <= 9 ? LocalBoxArt.logo(uint8(id - 1)) : LocalBoxArt.ITEMS_COVER;
    }
}
