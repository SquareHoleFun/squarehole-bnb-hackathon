// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
// The rehearsal profile's real values (FOUNDRY_PROFILE=rehearsal maps sh-box-build/ to this file). This default-profile
// test reads them directly so the refusal is pinned against the exact 1/10 build, not a hand-copied number.
import {BoxBuildV1 as RehearsalBuildV1} from "../../../src/box/build/rehearsal/BoxBuildV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {ReleaseConstantsV2} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {ListingClass, ListingKind, ListingRecord, QParameters} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ListingRaises} from "../../../src/box-v2/ListingRegistry.sol";
import {CoreV2ReleaseBuild} from "../../../script/lib/CoreV2ReleaseBuild.sol";
import {DeployCoreV2} from "../../../script/DeployCoreV2.s.sol";
import {VerifyCoreV2} from "../../../script/sepolia-v2/VerifyCoreV2.s.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {FixtureDeployCoreV2, CQ11WDeploymentFixture} from "../m1-64/CQ11WDeployment.t.sol";
import {Test} from "forge-std/Test.sol";

/// The production script with only its build constants replaced (and the fixture's environment namespace).
contract BuildDeployCoreV2 is FixtureDeployCoreV2 {
    BuildConstants private _build;

    constructor(string memory prefix, BuildConstants memory b) FixtureDeployCoreV2(prefix) {
        _build = b;
    }

    function _buildConstants() internal view override returns (BuildConstants memory) {
        return _build;
    }
}

/// Exposes the shared checks without running a deployment.
contract ReleaseBuildProbe is CoreV2ReleaseBuild {
    function compiledBuild() external pure returns (BuildConstants memory) {
        return _compiledBuild();
    }

    function requireReleaseBuild(BuildConstants memory b) external pure {
        _requireReleaseBuild(b);
    }

    function requireReleaseListing(address registry) external view {
        _requireReleaseListing(registry);
    }

    function requireReleaseRaiseConstant(address registry) external view {
        _requireReleaseRaiseConstant(registry);
    }
}

/// A listing registry stand-in whose native row and constant are chosen by the test.
contract StandInListings {
    uint256 public RAISE_ETH;
    ListingRecord private _row;

    constructor(uint256 constantRaise, ListingRecord memory row) {
        RAISE_ETH = constantRaise;
        _row = row;
    }

    function listing(uint32 id) external view returns (ListingRecord memory) {
        require(id == 0);
        return _row;
    }
}

/// SH-SEP-DEPLOY-GUARD: DeployCoreV2 refuses a build whose release constants are not the release's
/// (FOUNDRY_PROFILE=rehearsal's 1/10 raise) before planning any CREATE, and re-reads the deployed native row.
contract SepDeployGuardTest is CQ11WDeploymentFixture {
    function _release() private pure returns (CoreV2ReleaseBuild.BuildConstants memory b) {
        b = CoreV2ReleaseBuild.BuildConstants(
            "mainnet", false, 4_206_980_085_000_000_000, 1_500_000_000_000_000, 5_000_000_000_000_000,
            500_000_000_000_000, 5_000_000_000_000_000
        );
    }

    function _rehearsal() private pure returns (CoreV2ReleaseBuild.BuildConstants memory b) {
        b = CoreV2ReleaseBuild.BuildConstants(
            RehearsalBuildV1.PROFILE, RehearsalBuildV1.REHEARSAL, RehearsalBuildV1.RAISE,
            RehearsalBuildV1.BOOTSTRAP_ETH, RehearsalBuildV1.FEE_BATCH_MIN_ETH, RehearsalBuildV1.FEE_BATCH_TIP_MAX_ETH,
            RehearsalBuildV1.SWAP_STEP_MIN_Q
        );
    }

    function _prefix() private view returns (string memory) {
        return string.concat(_environmentNamespace(), "_");
    }

    function _nativeRow(uint256 raise) private pure returns (ListingRecord memory row) {
        row = ListingRecord(0, address(0), 18, ListingClass.NATIVE, ListingKind.LISTED, 1, raise, ListingRaises.parameters(raise));
    }

    function test_releasePinsAreThisDefaultBuildsValues() public {
        ReleaseBuildProbe probe = new ReleaseBuildProbe();
        CoreV2ReleaseBuild.BuildConstants memory b = probe.compiledBuild();
        assertEq(b.profile, "mainnet");
        assertEq(b.profile, BoxBuildV1.PROFILE);
        assertFalse(b.rehearsal);
        assertEq(b.raiseEth, ReleaseConstantsV2.RAISE_ETH);
        assertEq(b.bootstrapEth, BoxSpecV1.BOOTSTRAP_ETH);
        assertEq(b.feeBatchMinEth, BoxSpecV1.FEE_BATCH_MIN_ETH);
        assertEq(b.feeBatchTipMaxEth, BoxSpecV1.FEE_BATCH_TIP_MAX_ETH);
        assertEq(b.swapStepMinQ, BoxSpecV1.SWAP_STEP_MIN_Q);
        assertEq(keccak256(abi.encode(b)), keccak256(abi.encode(_release())), "the reviewed release literals");
        probe.requireReleaseBuild(b);
    }

    function test_runRefusesTheRehearsalBuildBeforeAnyCreate() public {
        CoreV2ReleaseBuild.BuildConstants memory b = _rehearsal();
        assertEq(b.raiseEth, 420_698_008_500_000_000, "the real 1/10 rehearsal raise");
        script = new BuildDeployCoreV2(_prefix(), b);
        uint64 nonce = vm.getNonce(DEPLOYER);
        vm.expectRevert(
            abi.encodeWithSelector(
                CoreV2ReleaseBuild.NotReleaseBuild.selector, "rehearsal", uint256(420_698_008_500_000_000),
                uint256(4_206_980_085_000_000_000)
            )
        );
        script.run();
        assertEq(vm.getNonce(DEPLOYER), nonce, "no CREATE planned");
    }

    function test_runRefusesTheRehearsalBuildEvenWithoutInputs() public {
        // The first check of run(): a stray FOUNDRY_PROFILE fails on the build, before any input or RPC read.
        DeployCoreV2 bare = new BuildDeployCoreV2("SH_SEP_DEPLOY_GUARD_UNSET_", _rehearsal());
        vm.expectRevert(
            abi.encodeWithSelector(
                CoreV2ReleaseBuild.NotReleaseBuild.selector, "rehearsal", uint256(420_698_008_500_000_000),
                uint256(4_206_980_085_000_000_000)
            )
        );
        bare.run();
    }

    function test_everySingleNonReleaseConstantIsRefused() public {
        ReleaseBuildProbe probe = new ReleaseBuildProbe();
        probe.requireReleaseBuild(_release());
        for (uint256 field; field < 7; ++field) {
            CoreV2ReleaseBuild.BuildConstants memory b = _release();
            if (field == 0) b.profile = "sepolia";
            else if (field == 1) b.rehearsal = true;
            else if (field == 2) b.raiseEth -= 1;
            else if (field == 3) b.bootstrapEth /= 10;
            else if (field == 4) b.feeBatchMinEth /= 10;
            else if (field == 5) b.feeBatchTipMaxEth /= 10;
            else b.swapStepMinQ /= 10;
            vm.expectRevert(
                abi.encodeWithSelector(
                    CoreV2ReleaseBuild.NotReleaseBuild.selector, b.profile, b.raiseEth, uint256(4_206_980_085_000_000_000)
                )
            );
            probe.requireReleaseBuild(b);
        }
    }

    function test_deployedNativeRowMustCarryTheReleaseRaise() public {
        ReleaseBuildProbe probe = new ReleaseBuildProbe();
        uint256 release = 4_206_980_085_000_000_000;
        uint256 tenth = 420_698_008_500_000_000;
        probe.requireReleaseListing(address(new StandInListings(release, _nativeRow(release))));
        // A registry from another build (its constant and its native row at 1/10).
        address other = address(new StandInListings(tenth, _nativeRow(tenth)));
        vm.expectRevert(abi.encodeWithSelector(CoreV2ReleaseBuild.NotReleaseListing.selector, other, tenth, release));
        probe.requireReleaseListing(other);
        // The constant alone, or the row alone, differing is refused too.
        other = address(new StandInListings(tenth, _nativeRow(release)));
        vm.expectRevert(abi.encodeWithSelector(CoreV2ReleaseBuild.NotReleaseListing.selector, other, tenth, release));
        probe.requireReleaseListing(other);
        other = address(new StandInListings(release, _nativeRow(tenth)));
        vm.expectRevert(abi.encodeWithSelector(CoreV2ReleaseBuild.NotReleaseListing.selector, other, tenth, release));
        probe.requireReleaseListing(other);
        // Same raise, but a row that is not the native one or not derived from it.
        ListingRecord memory row = _nativeRow(release);
        row.class = ListingClass.STANDARD;
        other = address(new StandInListings(release, row));
        vm.expectRevert(abi.encodeWithSelector(CoreV2ReleaseBuild.NotReleaseListing.selector, other, release, release));
        probe.requireReleaseListing(other);
        row = _nativeRow(release);
        row.q.bootstrapQ += 1;
        other = address(new StandInListings(release, row));
        vm.expectRevert(abi.encodeWithSelector(CoreV2ReleaseBuild.NotReleaseListing.selector, other, release, release));
        probe.requireReleaseListing(other);
    }

    function test_raiseConstantCheckIgnoresALaterRowUpdateButNotTheConstant() public {
        ReleaseBuildProbe probe = new ReleaseBuildProbe();
        uint256 release = 4_206_980_085_000_000_000;
        uint256 tenth = 420_698_008_500_000_000;
        // The runbook's default lowers the native row with updateRaise after deployment; the code stays the release's.
        probe.requireReleaseRaiseConstant(address(new StandInListings(release, _nativeRow(tenth))));
        address other = address(new StandInListings(tenth, _nativeRow(tenth)));
        vm.expectRevert(abi.encodeWithSelector(CoreV2ReleaseBuild.NotReleaseListing.selector, other, tenth, release));
        probe.requireReleaseRaiseConstant(other);
    }

    function test_verifierRefusesAManifestWhoseRegistryIsAnotherBuilds() public {
        (BoxFactoryV2 f, string memory manifest) = _run();
        VerifyCoreV2 checker = new VerifyCoreV2();
        assertEq(checker.verify(manifest), address(f));
        // Model a deploy from another build whose manifest is self-consistent: the registry's runtime and its saved
        // hash both change, so only the release-constant check can tell.
        address registry = f.listingRegistry();
        bytes32 before_ = registry.codehash;
        uint256 tenth = 420_698_008_500_000_000;
        vm.etch(registry, address(new StandInListings(tenth, _nativeRow(tenth))).code);
        vm.store(registry, bytes32(0), bytes32(tenth));
        string memory forged = vm.replace(manifest, vm.toString(before_), vm.toString(registry.codehash));
        vm.expectRevert(
            abi.encodeWithSelector(
                CoreV2ReleaseBuild.NotReleaseListing.selector, registry, tenth, uint256(4_206_980_085_000_000_000)
            )
        );
        checker.verify(forged);
    }

    function test_runReadsTheDeployedRegistryBackBeforeItCanSend() public {
        // Pins the second check inside run() itself (the probe tests above pin only the helper). The listing registry
        // is the deployer's second CREATE (DeployCoreV2._deployM2CoreV2); test_releaseBuildStillDeploysAndItsNativeRowPasses
        // pins that prediction. One run only: two full runs exceed the default profile's gas on Amsterdam.
        address registry = vm.computeCreateAddress(DEPLOYER, uint256(vm.getNonce(DEPLOYER)) + 1);
        uint256 tenth = 420_698_008_500_000_000;
        // Nothing in the deployment calls RAISE_ETH() on the registry; only the readback does. mockCall gives a
        // codeless target a placeholder byte; clear it so the real CREATE lands there unchanged (the mock stays).
        vm.mockCall(registry, abi.encodeWithSignature("RAISE_ETH()"), abi.encode(tenth));
        vm.etch(registry, "");
        vm.expectRevert(
            abi.encodeWithSelector(
                CoreV2ReleaseBuild.NotReleaseListing.selector, registry, tenth, uint256(4_206_980_085_000_000_000)
            )
        );
        _run();
    }

    function test_releaseBuildStillDeploysAndItsNativeRowPasses() public {
        script = new BuildDeployCoreV2(_prefix(), _release());
        address predicted = vm.computeCreateAddress(DEPLOYER, uint256(vm.getNonce(DEPLOYER)) + 1);
        (BoxFactoryV2 f, string memory manifest) = _run();
        assertEq(f.listingRegistry(), predicted, "the listing registry is the deployer's second CREATE");
        assertEq(vm.parseJsonString(manifest, ".listings.0.raise"), "4206980085000000000");
        assertEq(vm.parseJsonString(manifest, ".listings.0.bootstrapQ"), "1500000000000000");
    }
}
