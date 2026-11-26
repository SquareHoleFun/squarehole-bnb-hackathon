// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxToken} from "../../box/interfaces/IBoxToken.sol";

// Core v2 M1, frozen by ticket M1-00 (integrator, second review; F102, change queue 1): the v2 box token T is a
// non-upgradeable EIP-1167 clone of the release's one T implementation, never an upgradeable proxy (ADR-0017 § 6).

/// @title IBoxTokenV2 (M1-30 builds the T implementation; M1-32's factory has the coordinator create the clones)
/// @notice v1's box token (`IBoxToken`, kept whole: copy, never edit, ADR-0017 § 10) as a clone. What changes:
/// - **The form** (F102, R22D): T's runtime is exactly the standard 45-byte EIP-1167 proxy of the release's T
///   implementation followed by `BoxTokenV2Args` (`BoxClones.runtime`, arguments from byte 45, ADR-0016 § 2). No
///   EIP-1967 slot, no beacon, no admin, no setter: the implementation address is part of the clone's code. The
///   implementation has no DELEGATECALL, CALLCODE or SELFDESTRUCT, and marks itself initialised in its constructor, so
///   it is inert alone (`AlreadyInitialised` on its own `initialize`).
/// - **Where it is created**: by the box's coordinator with CREATE at its token nonce, as v1's coordinator creates T,
///   so T's mined address follows from the coordinator's address (`IBoxFactoryV2.createBox`, ADR-0017 § 4) and never
///   from T's code; the coordinator salt and `predictBox` are unchanged by F102.
/// - **`initialize()`**: the clone's `initialHolder()` only (its coordinator, which the factory made a clone of the
///   release's coordinator implementation: ADR-0016 § 4's check), once, inside the coordinator's deploy (`NotCoordinator`,
///   `AlreadyInitialised`): mints the one issuance (`BoxTokenV2Args.SUPPLY`) to it, with v1's `Transfer` event. Before it,
///   every balance is 0 and every transfer reverts on its balance check. It mints as a standard `_mint` does:
///   `totalSupply += SUPPLY; balanceOf[HOLDER] += SUPPLY; emit Transfer(address(0), HOLDER, SUPPLY)`, never by direct
///   assignment (`totalSupply = ...; balanceOf[holder] = ...`), which is the pattern GoPlus flags as
///   `owner_change_balance` (Halcyon's tokens; `docs/research/clone-scanner-check.md` Part 2, rule 1) [P: the trigger is
///   inferred by elimination there]. The coordinator-only check stays (change queue 3; the research's rule 5 to drop it
///   is unproven, and M1-64's Sepolia scan of the real clone re-checks it): the coordinator creates and initialises T in
///   one call either way.
/// - **Every other clause is v1's** (BC-055 restated for v2 by change queue 1): full amounts and standard events for
///   `transfer`, `approve` and `transferFrom`; no pause, blocklist or fee; sends to the vault (unless the vault pulls) and
///   to T itself refused; `burn` lowers supply by the amount above the vault's floor, as v1's (`BoxToken.sol:122-135`).
///   A token-only box has no vault (`vault()` address(0)): nothing is refused for it and no floor is read.
/// - **M2's ledger variant** (boxes with `Holders`, ADR-0017 § 12) is a second T implementation cloned with the same
///   arguments, `LEDGER` naming the box's holder ledger (role 17); M1 writes `LEDGER` as address(0), so M2 adds an
///   implementation and reshapes no M1 encoder.
/// - **Gas** (F102): a trade that moves T pays the clone's cold DELEGATECALL into the implementation, about 2,600 gas
///   [I]; M1-30 measures it under `amsterdam`, and every gas cap measured over a T transfer (the
///   hook's `HOLDER_NOTICE_GAS`, M1-60's runs) is measured with T in this form.
/// @dev No owner, admin, pause, upgrade, setter or rescue.
interface IBoxTokenV2 is IBoxToken {
    /// @notice A second `initialize`, or one on the implementation itself.
    error AlreadyInitialised();
    /// @notice `initialize` from anyone but the clone's `initialHolder()`.
    error NotCoordinator(address caller);

    /// @notice The box's coordinator only, once, inside its deploy: mints the issuance to it (see the notes above).
    function initialize() external;
    /// @notice M2's holder ledger (registry role 17) the ledger variant settles every transfer with; address(0) in M1.
    /// @dev Anyone may read ledger; no funds move.
    function ledger() external view returns (address);
}

/// @title BoxTokenV2Args (the frozen order of T's clone arguments; F102, change queue 1)
/// @notice Packed (`abi.encodePacked`), read by the implementation with EXTCODECOPY from byte 45 of the clone's code
/// (`BoxClones.ARGS_OFFSET`) plus each offset below. M1-32's planner encodes them with `encode`; M1-30's implementation
/// reads them; M1-52's discovery decodes them from the code. Fixed size, so no offset depends on the texts.
library BoxTokenV2Args {
    /// @notice A name longer than 32 bytes, a symbol longer than 11, or either empty (v1's lengths,
    /// `BoxToken.sol:31-32`; the spec's text rule is `validate()`'s).
    error TokenTextLength(uint256 length, uint256 max);

    /// @dev address: `initialHolder()`, the box's coordinator.
    /// @dev Encoders/readers use HOLDER as data; no funds move.
    uint256 internal constant HOLDER = 0;
    /// @dev address: `vault()`, the box's vault (registry role 3), or address(0) for a token-only box.
    /// @dev Encoders/readers use VAULT as data; no funds move.
    uint256 internal constant VAULT = 20;
    /// @dev address: `ledger()`, M2's holder ledger for the ledger variant; address(0) in M1.
    /// @dev Encoders/readers use LEDGER as data; no funds move.
    uint256 internal constant LEDGER = 40;
    /// @dev uint256: the one issuance (`initialSupply()`, `ISSUANCE()`).
    /// @dev Encoders/readers use SUPPLY as data; no funds move.
    uint256 internal constant SUPPLY = 60;
    /// @dev bytes32: the name, left-aligned, zero-padded.
    /// @dev Encoders/readers use NAME as data; no funds move.
    uint256 internal constant NAME = 92;
    /// @dev uint8: the name's length in bytes (1-32).
    /// @dev Encoders/readers use NAME_LENGTH as data; no funds move.
    uint256 internal constant NAME_LENGTH = 124;
    /// @dev bytes11: the symbol, left-aligned, zero-padded.
    /// @dev Encoders/readers use SYMBOL as data; no funds move.
    uint256 internal constant SYMBOL = 125;
    /// @dev uint8: the symbol's length in bytes (1-11).
    /// @dev Encoders/readers use SYMBOL_LENGTH as data; no funds move.
    uint256 internal constant SYMBOL_LENGTH = 136;
    /// @dev The arguments' length: a clone's runtime is 45 + 137 = 182 bytes.
    /// @dev Encoders/readers use LENGTH as data; no funds move.
    uint256 internal constant LENGTH = 137;

    /// @dev Encoders/readers use MAX_NAME_BYTES as data; no funds move.
    uint256 internal constant MAX_NAME_BYTES = 32;
    /// @dev Encoders/readers use MAX_SYMBOL_BYTES as data; no funds move.
    uint256 internal constant MAX_SYMBOL_BYTES = 11;

    /// @notice The arguments in the frozen order.
    /// @dev Internal callers may read encode; no funds move.
    function encode(
        address holder,
        address vault,
        address ledger,
        uint256 supply,
        string memory name,
        string memory symbol
    ) internal pure returns (bytes memory) {
        /// @dev Encoders/readers use n as data; no funds move.
        bytes memory n = bytes(name);
        /// @dev Encoders/readers use s as data; no funds move.
        bytes memory s = bytes(symbol);
        if (n.length == 0 || n.length > MAX_NAME_BYTES) revert TokenTextLength(n.length, MAX_NAME_BYTES);
        if (s.length == 0 || s.length > MAX_SYMBOL_BYTES) revert TokenTextLength(s.length, MAX_SYMBOL_BYTES);
        // casting to 'uint8' is safe because both lengths were checked above (at most 32)
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(holder, vault, ledger, supply, bytes32(n), uint8(n.length), bytes11(s), uint8(s.length));
    }
}
