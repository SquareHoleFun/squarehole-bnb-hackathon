// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxLayoutV2} from "./BoxLayoutV2.sol";

/// @dev Contract ABI used deliberately: a typed call emits STATICCALL, never library DELEGATECALL.
interface IFactoryChecksCurve {
    /// @notice Anyone may compute the P-first launch curve; no state, callbacks or funds are involved.
    function curve(uint256 raise) external pure returns (BoxLayoutV2.Curve memory);
}

/// @notice Fixed, separately linked code for factory curve checks. No storage, custody or caller privileges.
/// @dev Deploy once per release and link its address into the checks and factory artifacts together.
library FactoryChecksCurve {
    /// @notice Anyone may compute the P-first launch curve, with the original rounding and refusals.
    /// @dev Called through IFactoryChecksCurve by STATICCALL; never executes in a caller's storage context.
    function curve(uint256 raise) external pure returns (BoxLayoutV2.Curve memory) {
        return BoxLayoutV2.curve(raise, false);
    }
}
