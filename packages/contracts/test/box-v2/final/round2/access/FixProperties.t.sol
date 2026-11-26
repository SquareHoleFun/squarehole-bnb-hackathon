// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Run the merged fixes as cold regression properties, including one-gas admission boundaries,
// actual recipient/balance checks, exact rollback and half-cap controls. Source fixtures retain
// their documented real-part/double scope; no production cap is replaced by these wrappers.
import {LinkedPayoutGasTest} from "../../../payout-gas/Linked.t.sol";
import {MultipartPayoutGasTest} from "../../../payout-gas/Multipart.t.sol";
import {LinkedItemClaimGasTest} from "../../../item-claim-gas/LinkedClaims.t.sol";
import {ShopFloorTest} from "../../../shop-floor/Floor.t.sol";
import {M263SafeClaimsTest} from "../../../m2-63/money/SafeClaims.t.sol";
import {M263SafePayoutRetryTest} from "../../../m2-63/rules/LocalGuard.t.sol";

contract Round2SafeGasProperties is LinkedPayoutGasTest {}
contract Round2MultipartProperties is MultipartPayoutGasTest {}
contract Round2ItemGasProperties is LinkedItemClaimGasTest {}
contract Round2ShopFloorProperties is ShopFloorTest {}
contract Round2SafeCallerProperties is M263SafeClaimsTest {}
contract Round2NativeSafeRetryProperties is M263SafePayoutRetryTest {}
