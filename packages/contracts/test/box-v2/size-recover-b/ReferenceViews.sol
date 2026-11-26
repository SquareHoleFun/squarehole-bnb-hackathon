// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxReceiverV2Args as A} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// @notice Frozen arithmetic from BoxReceiverV2Base._buy at 49aa32cb, including refusal order.
contract ReferenceReceiverViews {
    function buyLimit(uint160 spot) external pure returns (uint160 limit) {
        limit = uint160(FullMath.mulDivRoundingUp(spot, TickMath.getSqrtPriceAtTick(-C.STEP_TICKS), 1 << 96));
        if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;
        require(limit < spot, "ReceiverNoSwapRoom");
    }

    function buyResult(BalanceDelta d, uint256 amount, uint160 limit, uint24 protocolFee)
        external
        pure
        returns (uint256 spent, uint256 bought)
    {
        require(d.amount0() < 0 && d.amount1() > 0, "ReceiverEmptySwap");
        spent = uint256(-int256(d.amount0()));
        bought = uint256(int256(d.amount1()));
        require(spent <= amount, "ReceiverOverspent");
        uint24 fee = ProtocolFeeLibrary.calculateSwapFee(ProtocolFeeLibrary.getZeroForOneFee(protocolFee), C.FEE_PIPS);
        uint256 net = FullMath.mulDiv(spent, 1_000_000 - fee, 1_000_000);
        uint256 minimum = net > 8 ? FullMath.mulDiv(FullMath.mulDiv(net - 8, limit, 1 << 96), limit, 1 << 96) : 0;
        minimum = minimum > 4 ? minimum - 4 : 0;
        require(bought >= minimum, "ReceiverSlippage");
    }
}

/// @notice Original v2 checks with explicit v2.1 T-ledger admissions; extended-argument choices need separate fixtures.
contract ReferenceReceiverConfig {
    error ZeroAddress();
    error InvalidChoice();
    error NOT_OFFERED();

    function checkConfig(address) external view returns (address payee) {
        if (
            A.addressAt(A.HOOK) == address(0) || A.addressAt(A.T) == address(0)
                || A.addressAt(A.LAUNCH_ROUTER) == address(0) || A.addressAt(A.REGISTRY) == address(0)
        ) revert ZeroAddress();
        if (uint160(A.addressAt(A.P)) >= uint160(A.addressAt(A.T))) revert InvalidChoice();
        uint256 b = A.uintAt(A.BUYERS_CHOICE, 1);
        uint256 s = A.uintAt(A.SELLERS_CHOICE, 1);
        _validateChoice(b);
        _validateChoice(s);
        uint256 royalty = A.uintAt(A.ROYALTY_DESTINATION, 1);
        if (royalty > uint256(RoyaltyDestination.PoolDepth)) revert InvalidChoice();
        payee = A.addressAt(A.CREATOR_PAYEE);
        if ((b == 1 || s == 1 || royalty == uint256(RoyaltyDestination.Creator)) && payee == address(0)) {
            revert ZeroAddress();
        }
        if (A.uintAt(A.BATCH_MIN_Q, 16) == 0 || A.uintAt(A.STEP_MIN_Q, 16) == 0) revert InvalidChoice();
    }

    function _validateChoice(uint256 choice) private view {
        if (choice == 0 || choice > 8 || choice == 6) revert InvalidChoice();
        if (
            ((choice == 4 || choice == 7) && A.addressAt(A.HOLDER_LEDGER) == address(0))
                || ((choice == 5 || choice == 8) && A.addressAt(A.ITEM_LEDGER) == address(0))
        ) revert InvalidChoice();
        // M3-23 admits Items here; its separate policy/role check is exercised by the receiver tests.
    }
}
