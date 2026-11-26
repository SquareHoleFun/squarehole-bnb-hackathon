// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockBoxHookV2} from "./MockBox.sol";
import {FeeBatchV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
/// @notice TEST ONLY CQ11 one-part receiver stand-in; M1-03 adds real claim booking in lane 2.
contract MockBoxReceiverV2 {
    MockBoxHookV2 public immutable hook;
    address public immutable FIT_SAFE;
    address public immutable PLATFORM_SAFE;
    address public immutable CONVERSION_SAFE;
    constructor(MockBoxHookV2 h, address fit, address platform, address conversion) {
        hook=h; FIT_SAFE=fit; PLATFORM_SAFE=platform; CONVERSION_SAFE=conversion;
    }
    function collect(address) external returns (FeeBatchV2 memory batch) {
        (batch.buyersP, batch.sellersP, batch.qToReserve) = hook.harvest();
    }
}
