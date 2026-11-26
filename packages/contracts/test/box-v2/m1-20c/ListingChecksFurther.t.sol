// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ListingRefusal} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ListingChecks} from "../../../src/box-v2/libraries/ListingChecks.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {M1_20cBase} from "./M1_20cBase.sol";
import {ListingChecksProbe} from "./M1_20cHarness.sol";
import {IListingChecksProbe, ERC1820_REGISTRY} from "./M1_20cProbes.sol";
import {KitErc1820Registry, KitPlainToken} from "./M1_20cTokens.sol";
import {
    KitCounter,
    KitFalseToken,
    KitNoReturnToken,
    KitOddDecimalsToken,
    KitOneWayToken,
    KitRevertingRegistry
} from "./M1_20cFurtherTokens.sol";

/// @title ListingChecksFurtherTest
/// @notice TEST ONLY. The M1-20-c implementer's further tests for `ListingChecks`, beside the red tests: the choices
/// the library makes where ADR-0017 § 3 names no shape ([P] in its notes), each pinned. Cases: BC-155 (exact transfers
/// both ways; ERC-777); the ticket's Sepolia line ("a hostile token (pause, blocklist, fee, re-entry, allowlist-only)
/// refused or isolated", `core-v2-m1-tickets.md` § 5).
contract ListingChecksFurtherTest is M1_20cBase {
    function setUp() public {
        _deployPoolManager();
        vm.etch(ERC1820_REGISTRY, address(new KitErc1820Registry()).code);
    }

    /// [P] The funder must hold and approve `PROBE_AMOUNT`; otherwise the lister's own error, never a refusal.
    function test_anUnfundedProbeNamesTheFunderAndTheAmount() public {
        IListingChecksProbe c = _checks();
        HostileToken t = new HostileToken("Plain", "PLAIN", 18);
        bytes memory unfunded = abi.encodeWithSelector(
            ListingChecks.ProbeUnfunded.selector, address(t), lister, ListingChecks.PROBE_AMOUNT
        );
        t.mint(lister, ListingChecks.PROBE_AMOUNT);
        vm.expectRevert(unfunded);
        c.checkToken(address(t), lister);
        vm.prank(lister);
        t.approve(address(c), ListingChecks.PROBE_AMOUNT - 1);
        vm.expectRevert(unfunded);
        c.checkToken(address(t), lister);
        vm.prank(lister);
        t.approve(address(c), ListingChecks.PROBE_AMOUNT);
        assertEq(c.checkToken(address(t), lister), 18, "exactly the amount, approved, is enough");
        assertEq(t.balanceOf(lister), ListingChecks.PROBE_AMOUNT, "and stays the funder's");
    }

    /// Sepolia line ("pause"), [P the reason]: a paused token moves for nobody.
    function test_aPausedTokenIsRefused() public {
        HostileToken t = new HostileToken("Paused", "PAUSED", 18);
        t.setPaused(true);
        _assertRefused(address(t), ListingRefusal.ALLOWLIST_ONLY);
    }

    /// [P] ERC-20's rule: a move that answers nothing passes (USDT's shape); one that answers false is refused.
    function test_noAnswerPassesAndFalseIsRefused() public {
        _assertAdmitted(address(new KitNoReturnToken()), 6);
        _assertRefused(address(new KitFalseToken()), ListingRefusal.ALLOWLIST_ONLY);
    }

    /// ADR-0017 § 3 ("into and out of the v4 PoolManager"): a token the PoolManager can take but not send is refused,
    /// and so is one that charges a fee only on the way out of it.
    function test_theWayOutOfThePoolManagerIsChecked() public {
        KitOneWayToken stuck = new KitOneWayToken();
        stuck.setStuck(address(pm));
        _assertRefused(address(stuck), ListingRefusal.ALLOWLIST_ONLY);
        KitOneWayToken taxed = new KitOneWayToken();
        taxed.setTaxed(address(pm), 1);
        _assertRefused(address(taxed), ListingRefusal.TRANSFER_NOT_EXACT);
    }

    /// Sepolia line ("re-entry ... refused or isolated"): a callback during the probe runs inside its reverting frame,
    /// so what it wrote is gone afterwards; a callback into the probe's own entry is refused.
    function test_aCallbackDuringTheProbeLeavesNothing() public {
        IListingChecksProbe c = _checks();
        KitCounter counter = new KitCounter();
        HostileToken calling = new HostileToken("Calls Back", "CALL", 18);
        calling.armReentry(address(counter), abi.encodeCall(KitCounter.bump, ()));
        _assertAdmitted(address(calling), 18);
        assertEq(counter.count(), 0, "the callback's write was rolled back");
        assertEq(calling.reenterTarget(), address(counter), "and the token's own disarm too");
        HostileToken reentering = new HostileToken("Re-enters", "REIN", 18);
        reentering.armReentry(
            address(c), abi.encodeCall(ListingChecksProbe.probeTransfers, (address(reentering), lister))
        );
        _assertRefused(address(reentering), ListingRefusal.ALLOWLIST_ONLY);
    }

    /// [P] The two host entries take only the host itself and the PoolManager.
    function test_theProbeEntriesRefuseEveryOtherCaller() public {
        ListingChecksProbe c = ListingChecksProbe(address(_checks()));
        address t = address(new KitPlainToken("Plain", "PLAIN", 18));
        vm.expectRevert(abi.encodeWithSelector(ListingChecks.NotSelf.selector, address(this)));
        c.probeTransfers(t, lister);
        vm.expectRevert(abi.encodeWithSelector(ListingChecks.NotPoolManager.selector, address(this)));
        c.unlockCallback(abi.encode(t, lister));
    }

    /// [P] fail closed: an ERC-1820 registry with code that does not answer reads as a registration.
    function test_aRegistryThatDoesNotAnswerReadsAsARegistration() public {
        vm.etch(ERC1820_REGISTRY, address(new KitRevertingRegistry()).code);
        _assertRefused(address(new KitPlainToken("Plain", "PLAIN", 18)), ListingRefusal.ERC777_HOOKS);
    }

    /// [P] `decimals()` must answer one word that fits ERC-20's `uint8`.
    function test_decimalsAnsweredOutsideOneByteAreRefused() public {
        _assertRefused(address(new KitOddDecimalsToken(false)), ListingRefusal.DECIMALS_OUT_OF_RANGE);
        _assertRefused(address(new KitOddDecimalsToken(true)), ListingRefusal.DECIMALS_OUT_OF_RANGE);
    }

    /// ADR-0017 § 3 ("about 1-2M gas" a listing): the whole check on an exact token, measured under `amsterdam`.
    function test_theCheckGasUnderAmsterdam() public {
        IListingChecksProbe c = _checks();
        HostileToken t = new HostileToken("Gas", "GAS", 18);
        _fund(c, address(t));
        (uint256 used,) =
            _gasAtAmsterdam(address(c), 0, abi.encodeCall(IListingChecksProbe.checkToken, (address(t), lister)));
        emit log_named_uint("ListingChecks.checkToken gas (amsterdam, cold token)", used);
        assertLt(used, 400_000, "the check is a small part of a listing");
    }
}
