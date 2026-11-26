// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// TEST ONLY caller double at the hook identity; real ledger/token bytes and authentication remain intact.
/// Any test caller may probe a fraction of the production cap. Failures return false, never returndata.
contract M260NoticeCaller {
    function notice(address ledger, bytes calldata data, uint256 cap) external returns (bool ok) {
        if (gasleft() < cap + cap / 63 + C.HOLDER_NOTICE_RESERVE_GAS + C.POKE_OVERHEAD_GAS) return false;
        bytes memory input = data;
        assembly ("memory-safe") { ok := call(cap, ledger, 0, add(input, 32), mload(input), 0, 0) }
    }
}
