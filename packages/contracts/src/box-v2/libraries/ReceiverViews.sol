// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxReceiverV2Args as A} from "./BoxReceiverV2Args.sol";
import {IBoxReceiverV2} from "../interfaces/IBoxReceiverV2.sol";
import {IBoxCoordinatorV2} from "../interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../interfaces/IBoxHookV2.sol";
import {IShopVaultV2} from "../interfaces/IShopVaultV2.sol";
import {IPileVaultV2} from "../interfaces/IPileVaultV2.sol";
import {IItemLedgerV2} from "../interfaces/IItemLedgerV2.sol";
import {IBoxVaultV2} from "../interfaces/IBoxVaultV2.sol";
import {RoyaltyDestination} from "../../box/interfaces/BoxTypes.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {ProtocolFeeLibrary} from "v4-core/src/libraries/ProtocolFeeLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ReleaseConstantsV2 as C} from "../interfaces/ReleaseConstantsV2.sol";

/// @notice Fixed stateless receiver code part, deployed once per implementation and called with STATICCALL.
/// No storage, custody, approvals or callbacks; inputs describe the receiver's current operation.
contract ReceiverViews {
    /// @notice Anyone computes the existing 49-tick limit from live spot, rounded toward spot; no funds move.
    function buyLimit(uint160 spot) external pure returns (uint160 limit) {
        // Include the fractional tick; the factor is below Q96 and the rounding is toward spot.
        // forge-lint: disable-next-line(unsafe-typecast)
        limit = uint160(FullMath.mulDivRoundingUp(spot, TickMath.getSqrtPriceAtTick(-C.STEP_TICKS), 1 << 96));
        if (limit <= TickMath.MIN_SQRT_PRICE) limit = TickMath.MIN_SQRT_PRICE + 1;
        require(limit < spot, "ReceiverNoSwapRoom");
    }

    /// @notice Anyone checks swap deltas against input and minimum output; the receiver alone settles custody.
    function buyResult(BalanceDelta d, uint256 amount, uint160 limit, uint24 protocolFee)
        external
        pure
        returns (uint256 spent, uint256 bought)
    {
        require(d.amount0() < 0 && d.amount1() > 0, "ReceiverEmptySwap");
        // Signs are checked before widening; negate after widening to avoid int128.min overflow.
        // forge-lint: disable-start(unsafe-typecast)
        spent = uint256(-int256(d.amount0()));
        bought = uint256(int256(d.amount1()));
        // forge-lint: disable-end(unsafe-typecast)
        require(spent <= amount, "ReceiverOverspent");
        uint24 fee = ProtocolFeeLibrary.calculateSwapFee(ProtocolFeeLibrary.getZeroForOneFee(protocolFee), C.FEE_PIPS);
        uint256 net = FullMath.mulDiv(spent, 1_000_000 - fee, 1_000_000);
        // v4 rounds each crossed swap step: STEP_TICKS < spacing, at most two liquidity segments.
        uint256 minimum = net > 8 ? FullMath.mulDiv(FullMath.mulDiv(net - 8, limit, 1 << 96), limit, 1 << 96) : 0;
        minimum = minimum > 4 ? minimum - 4 : 0;
        require(bought >= minimum, "ReceiverSlippage");
    }

    /// @notice Anyone validates a receiver's immutable arguments and reads its initial payee; optional parts are authenticated by read-only calls.
    /// Authentication, initialization state and storage writes remain in the receiver.
    function checkConfig(address receiver) public view returns (address payee) {
        if (
            _addressAt(receiver, A.HOOK) == address(0) || _addressAt(receiver, A.T) == address(0)
                || _addressAt(receiver, A.LAUNCH_ROUTER) == address(0) || _addressAt(receiver, A.REGISTRY) == address(0)
        ) revert IBoxReceiverV2.ZeroAddress();
        if (uint160(_addressAt(receiver, A.P)) >= uint160(_addressAt(receiver, A.T))) {
            revert IBoxReceiverV2.InvalidChoice();
        }
        uint256 b = _uintAt(receiver, A.BUYERS_CHOICE, 1);
        uint256 s = _uintAt(receiver, A.SELLERS_CHOICE, 1);
        _validateChoice(receiver, b, true, b == 10 || s == 10);
        _validateChoice(receiver, s, false, b == 10 || s == 10);
        uint256 royalty = _uintAt(receiver, A.ROYALTY_DESTINATION, 1);
        if (royalty > uint256(RoyaltyDestination.PoolDepth)) revert IBoxReceiverV2.InvalidChoice();
        payee = _addressAt(receiver, A.CREATOR_PAYEE);
        if ((b == 1 || s == 1 || royalty == uint256(RoyaltyDestination.Creator)) && payee == address(0)) {
            revert IBoxReceiverV2.ZeroAddress();
        }
        if (_uintAt(receiver, A.BATCH_MIN_Q, 16) == 0 || _uintAt(receiver, A.STEP_MIN_Q, 16) == 0) {
            revert IBoxReceiverV2.InvalidChoice();
        }
    }

    function _validateChoice(address receiver, uint256 choice, bool buyers, bool custom) private view {
        if (custom && receiver.code.length != 45 + 391) revert IBoxReceiverV2.InvalidChoice();
        if (choice == 10) {
            uint256 offset = 287 + (buyers ? 0 : 52);
            address module = _addressAt(receiver, offset);
            if (module.code.length == 0 || module.codehash != bytes32(_uintAt(receiver, offset + 20, 32))) revert IBoxReceiverV2.InvalidChoice();
        }
        if (choice == 6) {
            uint256 selector = _uintAt(receiver, A.LENGTH, 4);
            if (!custom && receiver.code.length != 45 + A.LENGTH + 4 + ((_uintAt(receiver, A.BUYERS_CHOICE, 1) == 9 || _uintAt(receiver, A.SELLERS_CHOICE, 1) == 9) ? 20 : 0)
                || (selector != 0 && (selector != uint32(bytes4(keccak256("burn(uint256)")))
                    || _addressAt(receiver, A.P) == address(0)))) revert IBoxReceiverV2.InvalidChoice();
        }
        if (choice == 9) {
            address pile = _addressAt(receiver, A.LENGTH + 4);
            IBoxCoordinatorV2 c = IBoxCoordinatorV2(_addressAt(receiver, A.COORDINATOR));
            if ((!custom && receiver.code.length != 45 + A.LENGTH + 24) || pile == address(0)
                || c.vault() != pile || IPileVaultV2(pile).asset() != _addressAt(receiver, A.P)) {
                revert IBoxReceiverV2.InvalidChoice();
            }
        }
        if (choice == 11) {
            IBoxCoordinatorV2 c = IBoxCoordinatorV2(_addressAt(receiver, A.COORDINATOR));
            if (buyers || c.vault() == address(0) || IShopVaultV2(c.vault()).ceilingT() == 0)
                revert IBoxReceiverV2.InvalidChoice();
        }
        if (choice == 0 || choice > 11) revert IBoxReceiverV2.InvalidChoice();
        if (
            ((choice == 4 || choice == 7 || choice == 11) && _addressAt(receiver, A.HOLDER_LEDGER) == address(0))
                || ((choice == 5 || choice == 8) && _addressAt(receiver, A.ITEM_LEDGER) == address(0))
        ) revert IBoxReceiverV2.InvalidChoice();
    }

    /// @notice Anyone checks the fixed Items wiring and policies; initialization alone caches this result.
    /// No funds move. The release coordinator authenticates role 16; factory readbacks authenticate its code.
    function checkItems(address receiver) public view returns (address vault, uint32 n, uint16 policies) {
        uint256 buyersChoice = _uintAt(receiver, A.BUYERS_CHOICE, 1);
        bool buyers = buyersChoice == 5 || buyersChoice == 8;
        uint256 sellersChoice = _uintAt(receiver, A.SELLERS_CHOICE, 1);
        bool sellers = sellersChoice == 5 || sellersChoice == 8;
        if (!buyers && !sellers) return (address(0), 0, 0);
        address ledger = _addressAt(receiver, A.ITEM_LEDGER);
        IBoxCoordinatorV2 c = IBoxCoordinatorV2(_addressAt(receiver, A.COORDINATOR));
        if (ledger == address(0) || c.roleAddress(16) != ledger) revert IBoxReceiverV2.InvalidChoice();
        (uint8 b, uint8 s) = IItemLedgerV2(ledger).insidePolicies();
        if ((buyers ? b == 0 || b > 3 : b != 0) || (sellers ? s == 0 || s > 3 : s != 0)) {
            revert IBoxReceiverV2.InvalidChoice();
        }
        vault = c.vault();
        uint256 size = IBoxVaultV2(vault).collectionSize();
        // Items-only hooks must also produce the frozen source journal. Never reinterpret missing sales as gifts.
        if (size == 0 || size > type(uint32).max
            || IBoxHookV2(_addressAt(receiver, A.HOOK)).currentTradeBatch(true) == 0) {
            revert IBoxReceiverV2.InvalidChoice();
        }
        n = uint32(size);
        policies = uint16(b) | uint16(s) << 8;
    }

    /// @notice Anyone reads both validated initialization results; receiver alone caches them.
    function checkInitial(address receiver) external view returns (address payee, address vault, uint32 n, uint16 policies) {
        payee = checkConfig(receiver);
        (vault, n, policies) = checkItems(receiver);
    }

    function _addressAt(address receiver, uint256 offset) private view returns (address a) {
        assembly ("memory-safe") {
            extcodecopy(receiver, 0, add(45, offset), 20)
            a := shr(96, mload(0))
        }
    }

    function _uintAt(address receiver, uint256 offset, uint256 len) private view returns (uint256 v) {
        assembly ("memory-safe") {
            extcodecopy(receiver, 0, add(45, offset), len)
            v := shr(sub(256, mul(8, len)), mload(0))
        }
    }
}
