// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../../src/box/interfaces/IDrandSource.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSourceConformance} from "../../randomness/DrandSourceConformance.sol";
import {PinnedBackedSource} from "../../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../../randomness/utils/PinnedDrandSource.sol";
import {BackedSourceConformance} from "./BackedSourceConformance.sol";

/// @notice rc8 open item 78 (part 2b review): the deployed verifier runs BC-053's source probes on a fork of the live
/// chain, where anyone may already have touched the state those probes use. This provider runs both suites (S9's
/// DrandSource checks and F143's backed-source checks) on the pinned deployments after a stranger has:
/// - posted every committed quicknet round the probes post (the local first round, +3, +6 and +9; public rounds and a
///   permissionless `postRound`; rehearsal B's life posted two of them);
/// - requested, from each labelled probe consumer, the key its probe requests (`makeAddr` derives each address from
///   its label's hash, so the private key is public), directly on the DrandSource and through the backed source;
/// - forced ETH into the backed source (SELFDESTRUCT's transfer or a block's fee recipient need no `receive`).
/// None of that is a fault of either source's code, so every BC-053 check must still pass. `BC053ProbeRoundsPostedTest`
/// has only the posted rounds (what rehearsal B's first run met: 54 passed, 3 failed at the end).
abstract contract BC053ProbeGriefProvider is DrandSourceConformance, BackedSourceConformance {
    IDrandSource internal drand;
    BoxBackedSource internal backed;

    function setUp() public {
        vm.chainId(1);
        vm.roll(100_000); // the probes prove headers up to 9 blocks old, as on a live chain
        _loadBoxDrand();
        drand = IDrandSource(address(PinnedDrandSource.deploy(vm)));
        backed = PinnedBackedSource.deploy(vm);
        require(address(backed.DRAND()) == address(drand), "the backed source names the pinned DrandSource");
        uint256 first = _localFirst();
        // The labelled consumers request before the probe rounds' times, as a stranger holding their keys could.
        uint256 early = drand.roundTime(first) - 1 hours;
        vm.warp(early);
        if (_everything()) {
            _requestAs("bc053.instance.a", 0, false);
            _requestAs("bc053.instance.b", 0, false);
            _requestAs("bc053.instance.silent", 5, false);
            _requestAs("bc053.backed.box", 1, true);
            _requestAs("bc053.backed.box", 3, true);
            _requestAs("bc053.backed.box", 9, true);
            _requestAs("bc053.backed.once", 0, true);
        }
        for (uint256 i; i <= 9; i += 3) {
            vm.warp(drand.roundTime(first + i));
            drand.postRound(first + i, _localSig(i));
        }
        if (_everything()) vm.deal(address(backed), 1 wei);
        vm.warp(early);
    }

    /// @dev The requests and the forced ETH too, or only the posted rounds.
    function _everything() internal pure virtual returns (bool);

    function _requestAs(string memory label, uint256 key, bool throughBacked) internal {
        vm.prank(makeAddr(label));
        if (throughBacked) backed.request(key);
        else drand.request(key);
    }

    function _source() internal view override returns (IDrandSource) {
        return drand;
    }

    function _backedSource() internal view override returns (BoxBackedSource) {
        return backed;
    }

    /// The stranger's state is there before every check (positive control for this provider).
    function test_griefStateIsThere() public {
        uint256 first = _localFirst();
        for (uint256 i; i <= 9; i += 3) {
            (, uint64 postedAt) = drand.beaconOf(first + i);
            assertGt(postedAt, 0, "probe round posted by a stranger");
        }
        if (!_everything()) return;
        (uint64 requestedAt,) = drand.requestOf(makeAddr("bc053.instance.a"), 0);
        assertGt(requestedAt, 0, "probe consumer's key requested by a stranger");
        (requestedAt,) = backed.requestOf(makeAddr("bc053.backed.box"), 1);
        assertGt(requestedAt, 0, "backed probe consumer's key requested by a stranger");
        assertEq(address(backed).balance, 1, "ETH forced into the backed source");
    }
}

/// @notice Every stranger's touch above.
/// forge-config: default.evm_version = "osaka"
contract BC053ProbeGriefTest is BC053ProbeGriefProvider {
    function _everything() internal pure override returns (bool) {
        return true;
    }
}

/// @notice Only the probe rounds posted (rehearsal B's first run).
/// forge-config: default.evm_version = "osaka"
contract BC053ProbeRoundsPostedTest is BC053ProbeGriefProvider {
    function _everything() internal pure override returns (bool) {
        return false;
    }
}
