// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetSpecV2, SetValidationContext} from "./SetTypesV2.sol";
import {SetConstantsV2 as C, SetReason as R} from "./SetConstantsV2.sol";
import {SetSpecV2Codec} from "./SetSpecV2Codec.sol";

/// @notice Pure structural admission. E-02 supplies live collection probes; this does not certify NFT custody.
contract SetSpecV2Validator {
    /// @notice Anyone may check immutable terms against a trusted creation context. No funds or state change.
    /// @dev Refuse extensions even on the typed entry: Solidity's generated decoder normally accepts a suffix.
    function validate(SetSpecV2 calldata spec, SetValidationContext calldata context)
        external
        pure
        returns (uint16 reason, uint16 field)
    {
        if (keccak256(msg.data) != keccak256(abi.encodeWithSelector(this.validate.selector, spec, context))) {
            return (R.NONCANONICAL_ABI, R.GLOBAL);
        }
        return _validate(spec, context);
    }

    /// @notice Check untrusted encoded spec bytes; malformed/noncanonical ABI produces a stable refusal.
    function validateEncoded(bytes calldata encoded, SetValidationContext calldata context)
        external
        view
        returns (uint16 reason, uint16 field)
    {
        if (keccak256(msg.data) != keccak256(abi.encodeWithSelector(this.validateEncoded.selector, encoded, context))) {
            return (R.NONCANONICAL_ABI, R.GLOBAL);
        }
        try this.decodeCanonical(encoded) returns (SetSpecV2 memory spec) {
            return _validate(spec, context);
        } catch {
            return (R.NONCANONICAL_ABI, R.GLOBAL);
        }
    }

    /// @notice Codec boundary used by validateEncoded to catch decoder failures. No state or funds change.
    function decodeCanonical(bytes calldata encoded) external pure returns (SetSpecV2 memory) {
        return SetSpecV2Codec.decode(encoded);
    }

    function _validate(SetSpecV2 memory s, SetValidationContext memory ctx) private pure returns (uint16, uint16) {
        if (s.format != C.FORMAT) return (R.UNSUPPORTED_VERSION, 0);
        if (s.schema != C.SCHEMA) return (R.UNSUPPORTED_VERSION, 1);
        if (s.release != C.RELEASE) return (R.UNSUPPORTED_VERSION, 2);
        uint16 reason = _text(bytes(s.tokenName), 1, 32);
        if (reason != 0) return (reason, 3);
        reason = _text(bytes(s.tokenSymbol), 1, 11);
        if (reason != 0) return (reason, 4);
        if (ctx.listing.kind == 0 || ctx.listing.id != s.pricing.listingId) return (R.LISTING_UNKNOWN, 5);
        if (ctx.listing.token != s.pricing.token || (s.pricing.listingId == 0) != (s.pricing.token == address(0))) {
            return (R.LISTING_MISMATCH, 5);
        }
        if (s.raise == 0 || s.raise != ctx.listing.raise) return (R.RAISE_NOT_A_PRESET, 6);
        if (
            s.openAt != 0
                && (s.openAt < C.MIN_OPEN_AT
                    || (s.openAt > ctx.timestamp && s.openAt - ctx.timestamp > C.MAX_OPEN_AHEAD))
        ) {
            return (R.OUT_OF_RANGE, 7);
        }
        if (s.deadlineDays != 30 && s.deadlineDays != 60 && s.deadlineDays != 90 && s.deadlineDays != 180) {
            return (R.DEADLINE_RULE, 8);
        }
        if (s.creatorBuy >= s.raise) return (R.OUT_OF_RANGE, 9);
        if (s.collection == address(0)) return (R.ZERO_VALUE, 10);
        if (s.count < C.MIN_COUNT || s.count > C.MAX_COUNT) return (R.OUT_OF_RANGE, 11);
        if (s.setHash == bytes32(0)) return (R.ZERO_VALUE, 12);
        if (s.pickFeeBps != 100 && s.pickFeeBps != 500 && s.pickFeeBps != 2500) return (R.NOT_A_MEMBER, 13);
        reason = _text(bytes(s.description), 0, 1024);
        if (reason != 0) return (reason, 14);
        if (s.logoSha256 == bytes32(0)) return (R.ZERO_VALUE, 15);
        return (R.OK, 0);
    }

    // Same printable JSON-text alphabet and byte limits as the release's existing token/description fields.
    function _text(bytes memory value, uint256 min, uint256 max) private pure returns (uint16) {
        if (value.length < min || value.length > max) return R.LENGTH_OUT_OF_RANGE;
        for (uint256 i; i < value.length; ++i) {
            uint8 c = uint8(value[i]);
            if (c < 32 || c > 126 || c == 34 || c == 92) return R.BAD_CHARACTER;
        }
        return R.OK;
    }
}
