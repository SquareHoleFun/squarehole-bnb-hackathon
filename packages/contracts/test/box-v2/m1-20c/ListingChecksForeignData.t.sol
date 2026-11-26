// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IListingRegistry, ListingRefusal} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ListingChecks} from "../../../src/box-v2/libraries/ListingChecks.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {M1_20cBase} from "./M1_20cBase.sol";
import {IListingChecksProbe, ERC1820_REGISTRY} from "./M1_20cProbes.sol";
import {KitErc1820Registry, KitPlainToken} from "./M1_20cTokens.sol";
import {KitOneWayToken} from "./M1_20cFurtherTokens.sol";
import {
    KitDeltaToken,
    KitHugeBalanceToken,
    KitOddHost,
    KitShortAnswerToken,
    KitTwoFacedToken
} from "./M1_20cForeignParts.sol";

/// @title ListingChecksForeignDataTest
/// @notice TEST ONLY (M1-20-c, review round 1, finding 1). Admission reads the probe's revert data, so every answer
/// the library did not write itself must read as a refusal, never as `NONE`: a delta left in the PoolManager, a
/// Panic, a starved frame, a probe that returns, a reason out of range, and short answers. Cases: BC-155 (exact
/// transfers both ways); the ticket's Sepolia line ("a hostile token ... refused or isolated", `core-v2-m1-tickets.md`
/// § 5).
contract ListingChecksForeignDataTest is M1_20cBase {
    /// The starved runs: every gas limit from `SWEEP_FROM` up in `SWEEP_STEP`s, past the whole check's need [P].
    uint256 private constant SWEEP_FROM = 5000;
    uint256 private constant SWEEP_TO = 260_000;
    uint256 private constant SWEEP_STEP = 250;

    function setUp() public {
        _deployPoolManager();
        vm.etch(ERC1820_REGISTRY, address(new KitErc1820Registry()).code);
    }

    /// A token's callback leaves a debt in the PoolManager, so `unlock` reverts `CurrencyNotSettled()`: foreign data
    /// inside the probe, `TRANSFER_NOT_EXACT`. Unarmed, the same token passes.
    function test_aDeltaLeftInThePoolManagerIsNotExact() public {
        KitDeltaToken t = new KitDeltaToken(pm);
        _assertAdmitted(address(t), 18);
        t.arm(true);
        _assertRefused(address(t), ListingRefusal.TRANSFER_NOT_EXACT);
    }

    /// A balance of `type(uint256).max` overflows the probe's sum, a Panic: in the host's frame (the outer reading)
    /// and in the PoolManager's (the inner one), each `TRANSFER_NOT_EXACT`.
    function test_aPanicInTheProbeIsNotExact() public {
        IListingChecksProbe c = _checks();
        KitHugeBalanceToken atHost = new KitHugeBalanceToken();
        atHost.setHuge(address(c));
        _assertRefused(address(atHost), ListingRefusal.TRANSFER_NOT_EXACT);
        KitHugeBalanceToken atPoolManager = new KitHugeBalanceToken();
        atPoolManager.setHuge(address(pm));
        _assertRefused(address(atPoolManager), ListingRefusal.TRANSFER_NOT_EXACT);
    }

    /// [P] A token that tells the PoolManager other balances than the host: `sync` reverts, or `settle` pays twice
    /// the amount. Each `TRANSFER_NOT_EXACT` (the defensive reads; the balance checks back them).
    function test_aPoolManagerThatCannotSyncOrSettleExactlyIsRefused() public {
        _assertRefused(address(new KitTwoFacedToken(address(pm), true)), ListingRefusal.TRANSFER_NOT_EXACT);
        _assertRefused(address(new KitTwoFacedToken(address(pm), false)), ListingRefusal.TRANSFER_NOT_EXACT);
    }

    /// [P] ERC-20's rule: 1 to 31 bytes is neither no answer nor a word, `ALLOWLIST_ONLY`.
    function test_aShortTransferAnswerIsRefused() public {
        _assertRefused(address(new KitShortAnswerToken(address(pm), 1)), ListingRefusal.ALLOWLIST_ONLY);
        _assertRefused(address(new KitShortAnswerToken(address(pm), 31)), ListingRefusal.ALLOWLIST_ONLY);
    }

    /// Every answer of `probeTransfers` but `ProbeOutcome(reason)` in exactly 36 bytes reads as `TRANSFER_NOT_EXACT`:
    /// a probe that returns, no data (a frame out of gas), another error, a reason out of range, 35 or 68 bytes.
    /// `ProbeOutcome(NONE)` passes and `ProbeOutcome(ALLOWLIST_ONLY)` is that reason (the controls).
    function test_everyForeignProbeAnswerIsNotExact() public {
        KitOddHost host = new KitOddHost();
        KitPlainToken t = new KitPlainToken("Plain", "PLAIN", 18);
        t.mint(lister, FUNDS);
        vm.prank(lister);
        t.approve(address(host), type(uint256).max);
        bytes4 outcome = ListingChecks.ProbeOutcome.selector;
        _assertHostReads(host, t, true, "", ListingRefusal.TRANSFER_NOT_EXACT);
        _assertHostReads(host, t, false, "", ListingRefusal.TRANSFER_NOT_EXACT);
        _assertHostReads(host, t, false, abi.encodeWithSignature("Other(uint8)", 0), ListingRefusal.TRANSFER_NOT_EXACT);
        uint256 max = uint256(type(ListingRefusal).max);
        _assertHostReads(host, t, false, abi.encodePacked(outcome, max + 1), ListingRefusal.TRANSFER_NOT_EXACT);
        _assertHostReads(
            host, t, false, abi.encodePacked(outcome, uint256(1) << 255), ListingRefusal.TRANSFER_NOT_EXACT
        );
        _assertHostReads(host, t, false, abi.encodePacked(outcome, bytes31(0)), ListingRefusal.TRANSFER_NOT_EXACT);
        _assertHostReads(
            host, t, false, abi.encodePacked(outcome, uint256(0), uint256(0)), ListingRefusal.TRANSFER_NOT_EXACT
        );
        _assertHostReads(
            host,
            t,
            false,
            abi.encodeWithSelector(outcome, ListingRefusal.ALLOWLIST_ONLY),
            ListingRefusal.ALLOWLIST_ONLY
        );
        host.setAnswer(false, abi.encodeWithSelector(outcome, ListingRefusal.NONE));
        host.checkTransfers(address(t), lister);
    }

    /// A fee-on-transfer token (1% on the pull) and one taxed only on the way out of the PoolManager (1 bps), checked
    /// with every gas limit up to past the whole check's need: never admitted. A starved frame reads as a refusal
    /// (any reason a starved read fails closed to), or the check itself runs out.
    function test_aStarvedCheckIsNeverAdmitted() public {
        HostileToken pulled = new HostileToken("Fee", "FEE", 18);
        pulled.setFeeBps(100);
        KitOneWayToken exit = new KitOneWayToken();
        exit.setTaxed(address(pm), 1);
        (uint256 refusedPulled, uint256 outPulled) = _sweep(address(pulled));
        (uint256 refusedExit, uint256 outExit) = _sweep(address(exit));
        emit log_named_uint("fee on the pull: refused", refusedPulled);
        emit log_named_uint("fee on the pull: out of gas", outPulled);
        emit log_named_uint("fee on the way out: refused", refusedExit);
        emit log_named_uint("fee on the way out: out of gas", outExit);
        assertGt(refusedPulled, 0, "starved runs reach a refusal (pull)");
        assertGt(refusedExit, 0, "starved runs reach a refusal (way out)");
        _assertRefused(address(pulled), ListingRefusal.TRANSFER_NOT_EXACT);
        _assertRefused(address(exit), ListingRefusal.TRANSFER_NOT_EXACT);
    }

    // ============================================================================================ helpers

    function _assertHostReads(
        KitOddHost host,
        KitPlainToken t,
        bool returnsNormally,
        bytes memory revertData,
        ListingRefusal reason
    ) private {
        host.setAnswer(returnsNormally, revertData);
        vm.expectRevert(_refusal(reason));
        host.checkTransfers(address(t), lister);
    }

    /// Runs the check on `token` (funded) at each gas limit of the sweep; counts refusals and runs out of gas.
    function _sweep(address token) private returns (uint256 refused, uint256 outOfGas) {
        IListingChecksProbe c = _checks();
        _fund(c, token);
        bytes memory data = abi.encodeCall(IListingChecksProbe.checkToken, (token, lister));
        for (uint256 g = SWEEP_FROM; g <= SWEEP_TO; g += SWEEP_STEP) {
            (bool ok, bytes memory ret) = address(c).call{gas: g}(data);
            assertFalse(ok, "never admitted, at any gas");
            if (ret.length == 0) {
                ++outOfGas;
                continue;
            }
            assertEq(ret.length, 36, "a refusal, else nothing");
            assertEq(bytes4(ret), IListingRegistry.ListingRefused.selector, "a refusal, else nothing");
            uint256 r;
            assembly ("memory-safe") {
                r := mload(add(ret, 36))
            }
            assertTrue(_failsClosedTo(ListingRefusal(r)), "a reason a starved read fails closed to");
            ++refused;
        }
    }

    /// The reasons a starved read reads as: decimals, the ERC-1820 registry, a move, an exact balance.
    function _failsClosedTo(ListingRefusal r) private pure returns (bool) {
        return r == ListingRefusal.TRANSFER_NOT_EXACT || r == ListingRefusal.ALLOWLIST_ONLY
            || r == ListingRefusal.DECIMALS_OUT_OF_RANGE || r == ListingRefusal.ERC777_HOOKS;
    }
}
