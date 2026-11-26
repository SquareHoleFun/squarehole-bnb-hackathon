// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IListingRegistry, ListingRefusal} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {M1_20cBase} from "./M1_20cBase.sol";
import {IListingChecksProbe, ERC1820_REGISTRY, ERC777_TOKEN_HASH} from "./M1_20cProbes.sol";
import {
    KitErc1820Registry,
    KitErc677Token,
    KitNamelessToken,
    KitNoDecimalsToken,
    KitPlainToken,
    KitRebasingToken,
    KitRegisteredToken
} from "./M1_20cTokens.sol";

/// @title ListingChecksRedTest
/// @notice TEST ONLY. M1-20-c's red tests for `ListingChecks` (token behaviour), through `IListingChecksProbe`. Each
/// fails with `NotBuilt()` until `M1_20cDeployHook` deploys the probe. Sources: ADR-0017 § 3 ("On-chain checks at
/// listing"), § 4 (the address ceiling); the ticket's red list (`core-v2-m1-tickets.md` § 2, M1-20). Cases:
/// - BC-155 (admit by address; fake, fee-on-transfer, rebase, ERC-777, decimals 5 and 19 refused; ERC-677 alone no
///   ground): every test below;
/// - BC-036 (a fake copying a listed token's name, symbol and decimals): `test_aSameSymbolFakeIsJudgedByItsOwnTransfers`;
/// - the ticket's red list: decimals 6, 8 and 18; the stock-like token behind a blocklist; the allowlist; the top
///   1/65,536 of the address space and just below it.
contract ListingChecksRedTest is M1_20cBase {
    function setUp() public {
        _deployPoolManager();
        vm.etch(ERC1820_REGISTRY, address(new KitErc1820Registry()).code);
    }

    // ============================================================================================ admitted

    /// BC-155 (LINK by its behaviour), ticket: vectors at 6, 8 and 18 decimals (USDC, WBTC, LINK).
    function test_BC155_admitsExactTokensAt6And8And18Decimals() public {
        _assertAdmitted(address(new HostileToken("USD Coin", "USDC", 6)), 6);
        _assertAdmitted(address(new HostileToken("Wrapped BTC", "WBTC", 8)), 8);
        _assertAdmitted(address(new HostileToken("ChainLink Token", "LINK", 18)), 18);
    }

    /// BC-155: decimals 6 through 18 pass and every other value is refused (5 and 19 among them).
    function testFuzz_decimalsOutside6To18AreRefused(uint8 decimals) public {
        HostileToken t = new HostileToken("Any", "ANY", decimals);
        if (decimals >= 6 && decimals <= 18) _assertAdmitted(address(t), decimals);
        else _assertRefused(address(t), ListingRefusal.DECIMALS_OUT_OF_RANGE);
    }

    /// BC-155: "optional ERC-677 alone is not grounds for rejection".
    function test_erc677AloneIsNoGround() public {
        _assertAdmitted(address(new KitErc677Token()), 18);
    }

    /// BC-155: listing by address, not symbol: no check reads the name or the symbol.
    function test_readsNoNameOrSymbol() public {
        _assertAdmitted(address(new KitNamelessToken()), 18);
    }

    /// BC-155, BC-036: a fake copying LINK's name, symbol and decimals with a 1% fee is refused, and LINK, at its own
    /// address, still passes after it.
    function test_aSameSymbolFakeIsJudgedByItsOwnTransfers() public {
        HostileToken link = new HostileToken("ChainLink Token", "LINK", 18);
        HostileToken fake = new HostileToken("ChainLink Token", "LINK", 18);
        fake.setFeeBps(100);
        _assertAdmitted(address(link), 18);
        _assertRefused(address(fake), ListingRefusal.TRANSFER_NOT_EXACT);
        _assertAdmitted(address(link), 18);
    }

    /// BC-155 ("issuer powers are disclosed, not a blanket stock-token ban"), ticket ("a stock-like token behind a
    /// blocklist passes", class STOCK at `add()`), ADR-0017 § 3 (Ondo: a blocklist and the sanctions list).
    function test_aStockLikeTokenBehindABlocklistPasses() public {
        HostileToken ondo = new HostileToken("NVIDIA (Ondo Tokenized)", "NVDAon", 18);
        ondo.setBlocked(makeAddr("sanctioned"), true);
        ondo.setBlocked(bob, true);
        _assertAdmitted(address(ondo), 18);
    }

    // ============================================================================================ refused

    /// ADR-0017 § 3: code exists.
    function test_refusesAnAddressWithoutCode() public {
        _assertRefused(makeAddr("an EOA"), ListingRefusal.TOKEN_NOT_CONTRACT);
    }

    /// BC-155 decimals_5, decimals_19.
    function test_refusesDecimals5And19() public {
        _assertRefused(address(new HostileToken("Five", "FIVE", 5)), ListingRefusal.DECIMALS_OUT_OF_RANGE);
        _assertRefused(address(new HostileToken("Nineteen", "NINETEEN", 19)), ListingRefusal.DECIMALS_OUT_OF_RANGE);
    }

    /// BC-155 [P]: a failing `decimals()` reads as out of range.
    function test_refusesATokenWithoutDecimals() public {
        _assertRefused(address(new KitNoDecimalsToken()), ListingRefusal.DECIMALS_OUT_OF_RANGE);
    }

    /// BC-155 fee_on_transfer.
    function test_BC155_refusesAFeeOnTransfer() public {
        HostileToken t = new HostileToken("Fee", "FEE", 18);
        t.setFeeBps(100);
        _assertRefused(address(t), ListingRefusal.TRANSFER_NOT_EXACT);
    }

    /// BC-155 fee_on_transfer: any fee from 1 bps, so the probe moves at least 10,000 raw units [P].
    function testFuzz_refusesAnyFeeOnTransfer(uint16 bps) public {
        bps = uint16(bound(bps, 1, C.BPS));
        HostileToken t = new HostileToken("Fee", "FEE", 6);
        t.setFeeBps(bps);
        _assertRefused(address(t), ListingRefusal.TRANSFER_NOT_EXACT);
    }

    /// BC-155 rebase: a stETH-like share token moves 1 raw unit less than named.
    function test_BC155_refusesARebasingToken() public {
        _assertRefused(address(new KitRebasingToken()), ListingRefusal.TRANSFER_NOT_EXACT);
    }

    /// BC-155 ERC777: a token registered at ERC-1820 for `ERC777Token`.
    function test_refusesAnErc777RegisteredToken() public {
        _assertRefused(address(new KitRegisteredToken(ERC777_TOKEN_HASH)), ListingRefusal.ERC777_HOOKS);
    }

    /// BC-155 [P]: another ERC-1820 interface is no ground, and a chain without the registry reads as no
    /// registration (a plain call to an address without code would revert in Solidity; the lookup must not).
    function test_otherErc1820AnswersAreNoGround() public {
        _assertAdmitted(address(new KitRegisteredToken(keccak256("ERC20Token"))), 18);
        vm.etch(ERC1820_REGISTRY, "");
        _assertAdmitted(address(new KitPlainToken("Plain", "PLAIN", 18)), 18);
    }

    /// Ticket: "one only allowed wallets may hold is refused".
    function test_refusesAnAllowlistOnlyToken() public {
        HostileToken t = new HostileToken("Allowed Only", "ALLOW", 18);
        t.setAllowlistOnly(true);
        t.setAllowed(lister, true);
        _assertRefused(address(t), ListingRefusal.ALLOWLIST_ONLY);
    }

    /// Ticket, [P]: the issuer may allow the registry and the PoolManager in advance; a wallet nobody allowed still
    /// cannot hold the token, so it is refused.
    function test_anAllowlistNamingTheProbeAndThePoolManagerIsStillRefused() public {
        IListingChecksProbe c = _checks();
        HostileToken t = new HostileToken("Allowed Only", "ALLOW", 18);
        t.setAllowlistOnly(true);
        t.setAllowed(lister, true);
        t.setAllowed(address(c), true);
        t.setAllowed(address(pm), true);
        _assertRefused(address(t), ListingRefusal.ALLOWLIST_ONLY);
    }

    /// ADR-0017 § 3 [P]: a box's P lives in the PoolManager, so a token that cannot move into and out of it is refused
    /// (Ondo passes because those transfers "simulate true"); the reason is the implementer's (`ALLOWLIST_ONLY` or
    /// `TRANSFER_NOT_EXACT`), so any `ListingRefused` counts here.
    function test_aTokenThePoolManagerCannotHoldIsRefused() public {
        IListingChecksProbe c = _checks();
        HostileToken t = new HostileToken("Blocks the PoolManager", "NOPM", 18);
        t.setBlocked(address(pm), true);
        _fund(c, address(t));
        try c.checkToken(address(t), lister) returns (uint8) {
            fail("a token the PoolManager cannot hold passed");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), IListingRegistry.ListingRefused.selector, "refused as a listing");
        }
    }

    /// Ticket, ADR-0017 § 4: refused at `LISTED_TOKEN_CEILING` and at the top address, admitted one unit under it.
    function test_refusesTheTopOfTheAddressSpaceAndAdmitsJustBelowIt() public {
        _assertRefused(_tokenAt(C.LISTED_TOKEN_CEILING), ListingRefusal.ADDRESS_TOO_HIGH);
        _assertRefused(_tokenAt(type(uint160).max), ListingRefusal.ADDRESS_TOO_HIGH);
        _assertAdmitted(_tokenAt(C.LISTED_TOKEN_CEILING - 1), 18);
    }

    /// An exact 18-decimal kit token at `at` (its code etched there, its decimals set: an etch copies no storage).
    function _tokenAt(uint160 at) private returns (address token) {
        token = address(at);
        vm.etch(token, address(new HostileToken("High", "HIGH", 18)).code);
        HostileToken(token).setDecimals(18);
    }
}
