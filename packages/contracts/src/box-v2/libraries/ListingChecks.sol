// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IListingRegistry, ListingRefusal} from "../interfaces/IListingRegistry.sol";
import {ReleaseConstantsV2 as C} from "../interfaces/ReleaseConstantsV2.sol";
import {BoxTokenProof} from "./BoxTokenProof.sol";

/// @title IListingChecksHost
/// @notice The two entries a contract exposes when it runs `ListingChecks.checkTransfers` (M1-20-b's listing registry;
/// the M1-20-c probe in tests). Each is one line, and each refuses every caller but the one the library expects:
/// - `probeTransfers(token, funder)` is `ListingChecks.probe(token, funder, poolManager)`. Only the host itself may
///   call it (`NotSelf`). It always reverts, so nothing it moves stays moved.
/// - `unlockCallback(data)` is `return ListingChecks.onUnlock(poolManager, data)`. Only the PoolManager may call it
///   (`NotPoolManager`); the PoolManager calls it only inside the host's own `unlock`, which only the probe opens.
/// Neither entry may sit behind the host's re-entry lock: `add()` reaches both while it holds the lock.
interface IListingChecksHost is IUnlockCallback {
    function probeTransfers(address token, address funder) external;
}

/// @title ListingChecks (core v2 M1, ticket M1-20-c)
/// @notice The token-behaviour checks `add()` runs on a token the lister names (ADR-0017 § 3, "On-chain checks at
/// listing"; § 4, the address ceiling) [V]. Each failed check reverts `IListingRegistry.ListingRefused(reason)`:
/// - first, the token is no Square Hole box token (`BOX_TOKEN_BY_RULE`, `BoxTokenProof.isBoxToken`), so every box
///   token gets that reason whatever else holds: one priced in a token near the ceiling sits above it (§ 4) [I], and
///   the lister need hold none of it [P the order];
/// - the token has code that is no EIP-7702 delegation (`TOKEN_NOT_CONTRACT`) [P the delegation] and sits below
///   `LISTED_TOKEN_CEILING` (`ADDRESS_TOO_HIGH`);
/// - `decimals()` answers one word from 6 to 18; a revert or any other answer reads as out of range
///   (`DECIMALS_OUT_OF_RANGE`) [P the failing case];
/// - the ERC-1820 registry names no `ERC777Token` implementer for the token (`ERC777_HOOKS`). No registry code reads as
///   no registration; a registry with code that does not answer one word reads as a registration (fail closed) [P];
/// - exact transfers both ways, and a wallet nobody allowed can hold the token, shown by a probe that always reverts,
///   so no balance and no supply moves for good [P]. The probe pulls `PROBE_AMOUNT` from the funder, sends it into
///   the PoolManager and settles it, then takes it out of the PoolManager to a fresh wallet. Each move must change both
///   balances by exactly the amount (`TRANSFER_NOT_EXACT`). A move that reverts or returns false means a wallet a box
///   needs cannot take or send the token: an allowlist, a blocklist on the registry or the PoolManager, or a pause
///   (`ALLOWLIST_ONLY`) [P]. Anything else the probe meets reads as `TRANSFER_NOT_EXACT`.
/// Name and symbol are never read: listing is by address (BC-155) [V]. The library keeps no storage.
/// @dev The funder (in `add()`, the lister) must hold `PROBE_AMOUNT` and approve it for the host, or the check reverts
/// `ProbeUnfunded`: the lister's setup, not the token's behaviour [P]. The probe's pull always rolls back, so that
/// approval is never spent and stays. `checkToken` may also revert `BoxTokenProof.HolderReadGasShort` (too little gas
/// for the reverse proof); neither error is in `IListingRegistry`. Marks: [V] ADR-0017 or the ticket says it; [I]
/// inferred; [P] chosen here.
library ListingChecks {
    /// @notice The raw units each probe move carries [P]: at least 10,000, so a fee of 1 bps shows.
    uint256 internal constant PROBE_AMOUNT = 10_000;
    uint256 internal constant MIN_DECIMALS = 6;
    uint256 internal constant MAX_DECIMALS = 18;
    /// @notice The ERC-1820 registry, at the same address on every chain (EIP-1820) [V].
    address internal constant ERC1820_REGISTRY = 0x1820a4B7618BdE71Dce8cdc73aAB6C95905faD24;
    /// @notice The interface hash an ERC-777 token registers for itself (EIP-777) [V].
    bytes32 internal constant ERC777_TOKEN_HASH = keccak256("ERC777Token");

    /// @notice The probe's result, carried out of its reverting frame; `NONE` means every move was exact.
    error ProbeOutcome(ListingRefusal reason);
    /// @notice The funder does not hold `amount` of `token`, or has not approved the host for it.
    error ProbeUnfunded(address token, address funder, uint256 amount);
    error NotSelf(address caller);
    error NotPoolManager(address caller);

    // ============================================================================================ the checks

    /// @notice Every check `add()` runs on a token, in order: the reverse proof, the static checks, then the transfer
    /// probe, paid by `funder` (the lister). `boxRegistry` is this release's box registry.
    /// @return decimals the token's decimals, when it passes
    function checkToken(address token, address funder, address boxRegistry) internal returns (uint8 decimals) {
        if (BoxTokenProof.isBoxToken(boxRegistry, token)) _refuse(ListingRefusal.BOX_TOKEN_BY_RULE);
        decimals = checkStatic(token);
        checkTransfers(token, funder);
    }

    /// @notice The checks that move nothing: code, address, decimals, ERC-777.
    function checkStatic(address token) internal view returns (uint8 decimals) {
        if (token.code.length == 0 || _isDelegation(token)) _refuse(ListingRefusal.TOKEN_NOT_CONTRACT);
        if (uint160(token) >= C.LISTED_TOKEN_CEILING) _refuse(ListingRefusal.ADDRESS_TOO_HIGH);
        (bool ok, uint256 d) = _read(token, abi.encodeWithSignature("decimals()"), true);
        if (!ok || d < MIN_DECIMALS || d > MAX_DECIMALS) _refuse(ListingRefusal.DECIMALS_OUT_OF_RANGE);
        if (_registeredErc777(token)) _refuse(ListingRefusal.ERC777_HOOKS);
        // forge-lint: disable-next-line(unsafe-typecast)
        decimals = uint8(d);
    }

    /// @notice The transfer probe, run in a frame that always reverts (`probe`); `funder` must hold `PROBE_AMOUNT`
    /// and have approved this contract for it.
    function checkTransfers(address token, address funder) internal {
        (bool okHeld, uint256 held) = _read(token, abi.encodeCall(IERC20Minimal.balanceOf, (funder)), false);
        (bool okAllowed, uint256 allowed) =
            _read(token, abi.encodeCall(IERC20Minimal.allowance, (funder, address(this))), false);
        if (!okHeld || !okAllowed) _refuse(ListingRefusal.TRANSFER_NOT_EXACT);
        if (held < PROBE_AMOUNT || allowed < PROBE_AMOUNT) revert ProbeUnfunded(token, funder, PROBE_AMOUNT);
        (bool returned, bytes memory ret) =
            address(this).call(abi.encodeCall(IListingChecksHost.probeTransfers, (token, funder)));
        ListingRefusal reason = returned ? ListingRefusal.TRANSFER_NOT_EXACT : _outcomeOf(ret);
        if (reason != ListingRefusal.NONE) _refuse(reason);
    }

    // ============================================================================================ the probe

    /// @notice The body of the host's `probeTransfers`: the moves, then a revert that carries the outcome, always.
    function probe(address token, address funder, address poolManager) internal {
        if (msg.sender != address(this)) revert NotSelf(msg.sender);
        _moveExact(
            token,
            token,
            abi.encodeCall(IERC20Minimal.transferFrom, (funder, address(this), PROBE_AMOUNT)),
            funder,
            address(this)
        );
        address fresh = _freshWallet(token, funder);
        (bool ok, bytes memory ret) = poolManager.call(abi.encodeCall(IPoolManager.unlock, (abi.encode(token, fresh))));
        revert ProbeOutcome(ok ? ListingRefusal.NONE : _outcomeOf(ret));
    }

    /// @notice The body of the host's `unlockCallback`: into the PoolManager and settled, then out to a fresh wallet.
    /// Every delta is zero when it returns; a failed move reverts `ProbeOutcome(reason)`, which `unlock` passes on.
    function onUnlock(address poolManager, bytes calldata data) internal returns (bytes memory) {
        if (msg.sender != poolManager) revert NotPoolManager(msg.sender);
        (address token, address fresh) = abi.decode(data, (address, address));
        Currency currency = Currency.wrap(token);
        (bool synced,) = poolManager.call(abi.encodeCall(IPoolManager.sync, (currency)));
        if (!synced) _fail(ListingRefusal.TRANSFER_NOT_EXACT);
        _moveExact(
            token,
            token,
            abi.encodeCall(IERC20Minimal.transfer, (poolManager, PROBE_AMOUNT)),
            address(this),
            poolManager
        );
        (bool settled, bytes memory paid) = poolManager.call(abi.encodeCall(IPoolManager.settle, ()));
        if (!settled || paid.length != 32 || abi.decode(paid, (uint256)) != PROBE_AMOUNT) {
            _fail(ListingRefusal.TRANSFER_NOT_EXACT);
        }
        _moveExact(
            token, poolManager, abi.encodeCall(IPoolManager.take, (currency, fresh, PROBE_AMOUNT)), poolManager, fresh
        );
        return "";
    }

    // ============================================================================================ helpers

    /// One move of `PROBE_AMOUNT` by `data` sent to `target`. It must succeed by ERC-20's rule (no answer, or a true
    /// one), else `ALLOWLIST_ONLY`; and it must lower `from`'s balance and raise `to`'s by exactly the amount, else
    /// `TRANSFER_NOT_EXACT`.
    function _moveExact(address token, address target, bytes memory data, address from, address to) private {
        uint256 fromBefore = _balanceOf(token, from);
        uint256 toBefore = _balanceOf(token, to);
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok || (ret.length != 0 && (ret.length < 32 || abi.decode(ret, (uint256)) != 1))) {
            _fail(ListingRefusal.ALLOWLIST_ONLY);
        }
        if (_balanceOf(token, from) + PROBE_AMOUNT != fromBefore || _balanceOf(token, to) != toBefore + PROBE_AMOUNT) {
            _fail(ListingRefusal.TRANSFER_NOT_EXACT);
        }
    }

    function _balanceOf(address token, address account) private view returns (uint256 balance) {
        bool ok;
        (ok, balance) = _read(token, abi.encodeCall(IERC20Minimal.balanceOf, (account)), false);
        if (!ok) _fail(ListingRefusal.TRANSFER_NOT_EXACT);
    }

    /// One word read by `target.staticcall(data)`; `exact` asks for exactly 32 bytes, else at least 32.
    function _read(address target, bytes memory data, bool exact) private view returns (bool ok, uint256 word) {
        bytes memory ret;
        (ok, ret) = target.staticcall(data);
        ok = ok && (exact ? ret.length == 32 : ret.length >= 32);
        if (ok) word = abi.decode(ret, (uint256));
    }

    /// Whether the ERC-1820 registry names an `ERC777Token` implementer for `token`; a registry with code that does not
    /// answer one word counts as yes.
    function _registeredErc777(address token) private view returns (bool) {
        if (ERC1820_REGISTRY.code.length == 0) return false;
        (bool ok, uint256 implementer) = _read(
            ERC1820_REGISTRY,
            abi.encodeWithSignature("getInterfaceImplementer(address,bytes32)", token, ERC777_TOKEN_HASH),
            false
        );
        return !ok || implementer != 0;
    }

    /// Whether `account`'s code is an EIP-7702 delegation designator (`0xef0100` and an address, 23 bytes): its owner
    /// can point it at other code at any time, which ADR-0017 § 2 refuses for plug-ins [V there; P here].
    function _isDelegation(address account) private view returns (bool delegated) {
        if (account.code.length != 23) return false;
        assembly ("memory-safe") {
            extcodecopy(account, 0, 0, 3)
            delegated := eq(shr(232, mload(0)), 0xef0100)
        }
    }

    /// A wallet nobody could have allowed in advance [P]: from this contract, the token, the funder and the block.
    function _freshWallet(address token, address funder) private view returns (address) {
        // Not randomness for value: any wallet the issuer could not name before the block works.
        // forge-lint: disable-next-line(weak-prng)
        bytes32 seed = keccak256(abi.encode(address(this), token, funder, block.number, block.prevrandao));
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(uint256(seed)));
    }

    /// The reason a reverting probe carried, or `TRANSFER_NOT_EXACT` for any other revert data.
    function _outcomeOf(bytes memory ret) private pure returns (ListingRefusal) {
        // The first four bytes are the error's selector.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (ret.length != 36 || bytes4(ret) != ProbeOutcome.selector) return ListingRefusal.TRANSFER_NOT_EXACT;
        uint256 reason;
        assembly ("memory-safe") {
            reason := mload(add(ret, 36))
        }
        if (reason > uint256(type(ListingRefusal).max)) return ListingRefusal.TRANSFER_NOT_EXACT;
        return ListingRefusal(reason);
    }

    function _fail(ListingRefusal reason) private pure {
        revert ProbeOutcome(reason);
    }

    function _refuse(ListingRefusal reason) private pure {
        revert IListingRegistry.ListingRefused(reason);
    }
}
