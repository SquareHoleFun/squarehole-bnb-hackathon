// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../src/box/BoxFactoryV1Planner.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxHookExtension} from "../../../src/box/BoxHookExtension.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxPriceSampler} from "../../../src/box/BoxPriceSampler.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxReceiverExtension} from "../../../src/box/BoxReceiverExtension.sol";
import {BoxRoyaltyRouter} from "../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxVault} from "../../../src/box/BoxVault.sol";
import {IBoxFactoryV1} from "../../../src/box/interfaces/IBoxFactoryV1.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {DeployCoreV1} from "../../../script/DeployCoreV1.s.sol";
import {DeployCoreV1Harness} from "../s7/BoxFactoryV1Deploy.t.sol";

/// @notice F78 (DECISION-LOG, 2026-10-04): the build profiles of core v1. One source, two builds: the default
/// (mainnet) build and the rehearsal build (FOUNDRY_PROFILE=rehearsal), whose raise and six fixed ETH amounts are 1/10.
/// Runs under both profiles and checks each build's own facts:
/// - the scaled values are the profile's (BoxBuildV1), read by BoxSpecV1 and its version contexts, exactly mainnet's
///   × 1/10 in the rehearsal build and the reviewed values in the mainnet build (the creator-fee cap's presets too,
///   version 2 only); every other ETH figure is a share;
/// - box 0's curve for the build's raise (BoxLayoutV1 computes it from R): inside Uniswap's usable ticks, the version's
///   span and spacing, the values packages/box-spec/src/layout.ts computes (0.42 ETH: ticks 200,220 to 227,100);
///   box 0's fixture with the build's raise is template 0 (validate() and the planner's rules) and the other build's
///   raise is refused (RAISE_NOT_A_PRESET);
/// - the rehearsal build can never run on chain id 1: the factory's, the planner's and every implementation's
///   constructor reverts there (RehearsalBuildRefusesChain(1)), the deploy script refuses the build on mainnet, and a
///   spec file runs only under the build it names (`.build`); the mainnet build has no such guard;
/// - the pinned DrandSource is the same code in both builds (its CREATE2 address and code hash are pinned).
contract RehearsalBuildTest is Test {
    /// @dev The reviewed (mainnet) values: packages/box-spec/box-spec.v1.json and the version contexts' raise.
    uint256 internal constant MAINNET_RAISE = 4_206_980_085_000_000_000;
    uint256 internal constant MAINNET_BOOTSTRAP_ETH = 0.0015 ether;
    uint256 internal constant MAINNET_FEE_BATCH_MIN_ETH = 0.005 ether;
    uint256 internal constant MAINNET_FEE_BATCH_TIP_MAX_ETH = 0.0005 ether;
    uint256 internal constant MAINNET_SWAP_STEP_MIN_Q = 0.005 ether;
    uint256 internal constant MAINNET_DEPTH_CONVERT_MIN_Q = 0.005 ether;
    uint256 internal constant MAINNET_PLATFORM_CAP_WEI = 32 ether;
    uint256 internal constant SEPOLIA = 11_155_111;
    address internal constant TESTNET_DEPLOYER = 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE;
    string internal constant DEFAULT_FILE = "script/config/box0-spec.11155111.json";
    string internal constant REHEARSAL_FILE = "script/config/box0-spec.11155111.rehearsal.json";
    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";
    /// @dev BoxBuildGuard's error in the rehearsal build (absent from the mainnet build's sources, so by its signature).
    bytes4 internal constant REFUSES = bytes4(keccak256("RehearsalBuildRefusesChain(uint256)"));

    function _rehearsal() internal pure returns (bool) {
        return BoxBuildV1.REHEARSAL;
    }

    function _scaled(uint256 mainnetWei) internal pure returns (uint256) {
        return mainnetWei * BoxBuildV1.SCALE_NUMERATOR / BoxBuildV1.SCALE_DENOMINATOR;
    }

    function _fixtureForBuild() internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = abi.decode(vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        assertEq(s.raise, MAINNET_RAISE, "box 0's fixture carries the reviewed raise");
        s.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
    }

    // ------------------------------------------------------------------------------------------------ the values

    /// The raise and the six fixed ETH amounts are the profile's: the reviewed values in the mainnet build, exactly
    /// 1/10 of them in the rehearsal build; BoxSpecV1 and both version contexts read them from BoxBuildV1.
    function test_F78_theScaledValuesAreTheProfiles() public pure {
        if (_rehearsal()) {
            assertEq(keccak256(bytes(BoxBuildV1.PROFILE)), keccak256("rehearsal"));
            assertEq(BoxBuildV1.REFUSED_CHAIN_ID, 1, "the rehearsal refuses chain id 1");
            assertEq(BoxBuildV1.SCALE_NUMERATOR * 10, BoxBuildV1.SCALE_DENOMINATOR, "1/10");
            assertEq(BoxBuildV1.RAISE, 0.4206980085 ether);
            assertEq(BoxSpecV1.BOOTSTRAP_ETH, 0.00015 ether);
            assertEq(BoxSpecV1.FEE_BATCH_MIN_ETH, 0.0005 ether);
            assertEq(BoxSpecV1.FEE_BATCH_TIP_MAX_ETH, 0.00005 ether);
            assertEq(BoxSpecV1.SWAP_STEP_MIN_Q, 0.0005 ether);
            assertEq(BoxSpecV1.DEPTH_CONVERT_MIN_Q, 0.0005 ether);
            assertEq(BoxSpecV1.PLATFORM_CAP_WEI, 3.2 ether);
        } else {
            assertEq(keccak256(bytes(BoxBuildV1.PROFILE)), keccak256("mainnet"));
            assertEq(BoxBuildV1.REFUSED_CHAIN_ID, 0, "the mainnet build refuses no chain");
            assertEq(BoxBuildV1.SCALE_NUMERATOR, 1);
            assertEq(BoxBuildV1.SCALE_DENOMINATOR, 1);
        }
        assertEq(BoxBuildV1.RAISE, _scaled(MAINNET_RAISE), "R");
        assertEq(BoxSpecV1.BOOTSTRAP_ETH, _scaled(MAINNET_BOOTSTRAP_ETH), "BOOTSTRAP_ETH");
        assertEq(BoxSpecV1.FEE_BATCH_MIN_ETH, _scaled(MAINNET_FEE_BATCH_MIN_ETH), "FEE_BATCH_MIN_ETH");
        assertEq(BoxSpecV1.FEE_BATCH_TIP_MAX_ETH, _scaled(MAINNET_FEE_BATCH_TIP_MAX_ETH), "FEE_BATCH_TIP_MAX_ETH");
        assertEq(BoxSpecV1.SWAP_STEP_MIN_Q, _scaled(MAINNET_SWAP_STEP_MIN_Q), "SWAP_STEP_MIN_Q");
        assertEq(BoxSpecV1.DEPTH_CONVERT_MIN_Q, _scaled(MAINNET_DEPTH_CONVERT_MIN_Q), "DEPTH_CONVERT_MIN_Q");
        assertEq(BoxSpecV1.PLATFORM_CAP_WEI, _scaled(MAINNET_PLATFORM_CAP_WEI), "PLATFORM_CAP_WEI");
        // Each scaled exactly (no rounding): scaling back gives the reviewed value.
        assertEq(BoxBuildV1.RAISE * BoxBuildV1.SCALE_DENOMINATOR / BoxBuildV1.SCALE_NUMERATOR, MAINNET_RAISE);
        assertEq(BoxSpecV1.BOOTSTRAP_ETH, BoxBuildV1.BOOTSTRAP_ETH);
        assertEq(BoxSpecV1.FEE_BATCH_MIN_ETH, BoxBuildV1.FEE_BATCH_MIN_ETH);
        assertEq(BoxSpecV1.FEE_BATCH_TIP_MAX_ETH, BoxBuildV1.FEE_BATCH_TIP_MAX_ETH);
        assertEq(BoxSpecV1.SWAP_STEP_MIN_Q, BoxBuildV1.SWAP_STEP_MIN_Q);
        assertEq(BoxSpecV1.DEPTH_CONVERT_MIN_Q, BoxBuildV1.DEPTH_CONVERT_MIN_Q);
        assertEq(BoxSpecV1.PLATFORM_CAP_WEI, BoxBuildV1.PLATFORM_CAP_WEI);
        // The one raise of both version contexts (F74 U5).
        assertEq(BoxSpecV1.qListV1()[0].raisePresets.length, 1);
        assertEq(BoxSpecV1.qListV1()[0].raisePresets[0], BoxBuildV1.RAISE, "v1's raise");
        assertEq(BoxSpecV1.qListV2()[0].raisePresets[0], BoxBuildV1.RAISE, "v2's raise");
        // In both builds the three minimums stay one figure (scripts/core-v1-life.py reads DEPTH_CONVERT_MIN_Q as
        // the receiver's batchMin()).
        assertEq(BoxSpecV1.DEPTH_CONVERT_MIN_Q, BoxSpecV1.FEE_BATCH_MIN_ETH);
        assertEq(BoxSpecV1.SWAP_STEP_MIN_Q, BoxSpecV1.FEE_BATCH_MIN_ETH);
        // What is a share of R scales by itself: the graduation reward (0.1%) and MIN_ADD (0.5%).
        assertEq(BoxBuildV1.RAISE * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / 10_000, _scaled(4_206_980_085_000_000));
        assertEq(
            BoxBuildV1.RAISE * BoxSpecV1.DEPTH_MIN_ADD_BPS_OF_RAISE / 10_000, _scaled(21_034_900_425_000_000), "MIN_ADD"
        );
    }

    /// The creator-fee cap's five presets (add-on 5, version 2 only: factory v1 cannot create such a box) are fixed ETH
    /// amounts too, scaled the same way: the demo token-only box (version 2, the cap add-on) with the build's raise
    /// passes validate() with each of the build's presets and is refused (NOT_A_MEMBER) with the other build's.
    function test_F78_theCreatorFeeCapPresetsAreTheBuilds() public view {
        uint256[5] memory mainnet = [uint256(1 ether), 4 ether, 8 ether, 16 ether, 32 ether];
        uint256[5] memory presets = [
            BoxBuildV1.CREATOR_FEE_CAP_PRESET_0,
            BoxBuildV1.CREATOR_FEE_CAP_PRESET_1,
            BoxBuildV1.CREATOR_FEE_CAP_PRESET_2,
            BoxBuildV1.CREATOR_FEE_CAP_PRESET_3,
            BoxBuildV1.CREATOR_FEE_CAP_PRESET_4
        ];
        string memory json = vm.readFile(BOX_SPEC_VECTORS);
        // The demo fixture's vector, found by its hash (the index moves when cases are added before it: F80's openAt).
        bytes32 demo = vm.parseJsonBytes32(json, ".fixtures.demo-token-only");
        bytes32[] memory hashes = vm.parseJsonBytes32Array(json, ".columns.specHash");
        uint256 at = type(uint256).max;
        for (uint256 i; i < hashes.length && at == type(uint256).max; ++i) {
            if (hashes[i] == demo) at = i;
        }
        bytes memory encoded = vm.parseJsonBytes(json, string.concat(".columns.encoded[", vm.toString(at), "]"));
        assertEq(keccak256(encoded), demo, "the demo token-only vector");
        BoxSpecV1.BoxSpec memory s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        s.raise = BoxBuildV1.RAISE;
        uint256 k = type(uint256).max;
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_CREATOR_FEE_CAP) k = i;
        }
        assertLt(k, s.addOns.length, "the demo carries the creator-fee cap");
        (, uint8 excess) = abi.decode(s.addOns[k].params, (uint256, uint8));
        uint16 reason;
        uint16 field;
        for (uint256 i; i < 5; ++i) {
            assertEq(presets[i], _scaled(mainnet[i]), "the build's preset");
            s.addOns[k].params = abi.encode(presets[i], excess);
            (reason, field) = BoxSpecV1.validate(s, BoxSpecV1.contextV2());
            assertEq(reason, BoxSpecV1.REASON_OK, string.concat("field ", vm.toString(field)));
            s.addOns[k].params = abi.encode(_rehearsal() ? mainnet[i] : mainnet[i] / 10, excess);
            (reason, field) = BoxSpecV1.validate(s, BoxSpecV1.contextV2());
            assertEq(reason, BoxSpecV1.REASON_NOT_A_MEMBER, "the other build's preset");
            assertEq(field, BoxSpecV1.FIELD_ADD_ON_CREATOR_FEE_CAP_CAP_PER_EPOCH);
        }
    }

    // ------------------------------------------------------------------------------------------------ the curve

    /// Box 0's curve for the build's raise: BoxLayoutV1 computes it from R (the factory's constructor does, from
    /// version 1's preset); inside Uniswap's usable ticks, on the version's spacing and span, and exactly what the
    /// TypeScript mirror (packages/box-spec/src/layout.ts) computes for both raises.
    function test_F78_box0sCurveForTheBuildsRaise() public pure {
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(BoxSpecV1.qListV1()[0].raisePresets[0], false);
        assertEq(c.raise, BoxBuildV1.RAISE);
        assertGe(c.tickLower, BoxSpecV1.MIN_USABLE_TICK, "inside the usable ticks");
        assertLe(c.tickUpper, BoxSpecV1.MAX_USABLE_TICK, "inside the usable ticks");
        assertGt(c.sqrtPriceLowerX96, TickMath.MIN_SQRT_PRICE);
        assertLt(c.sqrtPriceUpperX96, TickMath.MAX_SQRT_PRICE);
        assertEq(c.tickUpper - c.tickLower, BoxSpecV1.CURVE_SPAN_TICKS, "the version's span");
        assertEq(c.sqrtPriceLowerX96, TickMath.getSqrtPriceAtTick(c.tickLower), "P1 is the price at the lower tick");
        assertEq(c.tickLower % BoxSpecV1.TICK_SPACING, 0, "on spacing");
        assertEq(c.curveT + c.poolShare, BoxSpecV1.ISSUANCE);
        if (_rehearsal()) {
            // 0.4206980085 ETH: the centre 213,660 (tick 213,670 rounded to 60), ten times the T per ETH.
            assertEq(c.tickLower, 200_220);
            assertEq(c.tickUpper, 227_100);
            // P1, the curve's end (a buy lowers the tick: ETH is currency0): the runbook's price limit (F3, F4).
            assertEq(c.sqrtPriceLowerX96, 1_763_535_759_953_844_042_750_390_480_595_831, "P1");
            assertEq(c.liquidity, 12_668_456_461_943_539_859_622);
            assertEq(c.curveT, 799_175_995_383_221_790_176_134_102);
            assertEq(c.poolShare, 200_824_004_616_778_209_823_865_898);
        } else {
            // FitLaunchShape's (BC-002).
            assertEq(c.tickLower, 177_180);
            assertEq(c.tickUpper, 204_060);
            assertEq(c.sqrtPriceLowerX96, 557_316_679_617_586_024_814_736_431_134_799, "P1");
            assertEq(c.liquidity, 40_035_151_265_858_715_901_343);
            assertEq(c.curveT, 798_137_969_320_803_416_571_965_883);
        }
        // The graduated layout at P1 for a full curve (qHeld R, the pool share and nothing of the curve's T left).
        BoxLayoutV1.Graduated memory g =
            BoxLayoutV1.graduated(c, BoxSpecV1.GRAD_LAYOUT_ASK_FULL_BID_SENTINEL, c.raise, c.poolShare);
        assertGt(g.ask.liquidity, 0, "the ask");
        assertGt(g.bid.liquidity, 0, "the bid");
        assertLe(g.bid.amount + g.sentinel.amount, c.raise, "the bids hold at most R");
        assertGe(g.ask.tickLower, BoxSpecV1.MIN_USABLE_TICK);
        assertLe(g.bid.tickUpper, BoxSpecV1.MAX_USABLE_TICK);
        console.log("F78|build", BoxBuildV1.PROFILE);
        console.log("F78|curve ticks (lower, upper)", vm.toString(c.tickLower), vm.toString(c.tickUpper));
        console.log("F78|curve liquidity, curve T", c.liquidity, c.curveT);
        console.log("F78|pool share, graduated ask liquidity", c.poolShare, g.ask.liquidity);
    }

    /// Box 0's fixture with the build's raise is template 0 in this build (validate() and the planner's rules), and the
    /// other build's raise is refused (RAISE_NOT_A_PRESET): a spec runs on its own build only.
    function test_F78_box0WithTheBuildsRaiseIsTemplate0AndTheOtherRaiseIsRefused() public {
        BoxFactoryV1Planner planner = new BoxFactoryV1Planner();
        BoxSpecV1.BoxSpec memory s = _fixtureForBuild();
        (uint16 reason, uint16 field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK, string.concat("field ", vm.toString(field)));
        assertEq(planner.refusal(s, BoxSpecV1.PLATFORM_SAFE_MAINNET).length, 0, "template 0");
        s.raise = _rehearsal() ? MAINNET_RAISE : MAINNET_RAISE / 10;
        (reason, field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_RAISE_NOT_A_PRESET, "the other build's raise");
        assertEq(field, BoxSpecV1.FIELD_RAISE);
        assertEq(
            planner.refusal(s, BoxSpecV1.PLATFORM_SAFE_MAINNET),
            abi.encodeWithSelector(
                IBoxFactoryV1.InvalidSpec.selector, BoxSpecV1.REASON_RAISE_NOT_A_PRESET, BoxSpecV1.FIELD_RAISE
            )
        );
    }

    // ------------------------------------------------------------------------------------------------ chain id 1

    /// The rehearsal build's factory, planner and every implementation refuse chain id 1 in their constructors (the
    /// first thing each runs: BoxBuildGuard is their most basic contract), so no contract of it, and so no box, can
    /// exist on mainnet; on any other chain the guard passes. The mainnet build has no guard (it is the reviewed code).
    function test_F78_theRehearsalBuildsConstructorsRefuseChainId1() public {
        (string[] memory names, bytes[] memory inits) = _guardedInitCodes();
        vm.chainId(1);
        for (uint256 i; i < inits.length; ++i) {
            bytes memory reason = _tryCreate(inits[i]);
            bool refused = keccak256(reason) == keccak256(abi.encodeWithSelector(REFUSES, uint256(1)));
            assertEq(refused, _rehearsal(), names[i]);
        }
        vm.chainId(SEPOLIA);
        for (uint256 i; i < inits.length; ++i) {
            bytes memory reason = _tryCreate(inits[i]);
            assertTrue(reason.length < 4 || bytes4(reason) != REFUSES, string.concat(names[i], " on Sepolia"));
        }
    }

    /// The pinned DrandSource (DrandSourcePins: the same CREATE2 address and code hash on chains 1 and 11155111) is
    /// the same code in both builds: the rehearsal build deploys, or finds, the very source mainnet's build pins.
    function test_F78_thePinnedSourceIsTheSameInBothBuilds() public pure {
        assertEq(keccak256(type(DrandSource).creationCode), DrandSourcePins.INIT_CODE_HASH, "the pinned init code");
    }

    // ------------------------------------------------------------------------------------------------ the script

    /// The deploy script refuses the rehearsal build on mainnet whatever the spec, and runs a spec file only under the
    /// build its `.build` names: the rehearsal file needs the rehearsal build, the full-size files the mainnet build
    /// (which may still be deployed on Sepolia). The rehearsal file is Sepolia's only (chain-checked like the others).
    function test_F78_theScriptRunsEachFileOnlyOnItsBuildAndTheRehearsalNeverOnMainnet() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        vm.warp(1_791_200_000); // before Sepolia's Glamsterdam guard window
        vm.chainId(SEPOLIA);
        if (_rehearsal()) {
            DeployCoreV1.Plan memory p =
                h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, REHEARSAL_FILE, false);
            assertEq(p.spec.raise, BoxBuildV1.RAISE, "the rehearsal file carries the rehearsal raise");
            assertEq(keccak256(abi.encode(p.spec)), _fileHash(REHEARSAL_FILE));
            vm.expectRevert(
                abi.encodeWithSelector(DeployCoreV1.SpecFileForAnotherBuild.selector, "mainnet", "rehearsal")
            );
            h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        } else {
            DeployCoreV1.Plan memory p =
                h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, false);
            assertEq(p.spec.raise, MAINNET_RAISE, "the mainnet build on Sepolia: the full-size file");
            vm.expectRevert(
                abi.encodeWithSelector(DeployCoreV1.SpecFileForAnotherBuild.selector, "rehearsal", "mainnet")
            );
            h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, REHEARSAL_FILE, false);
        }
        // The fixture (dry runs without a file) carries the build's raise.
        assertEq(h.fixtureSpec().raise, BoxBuildV1.RAISE);
        vm.chainId(1);
        if (_rehearsal()) {
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.RehearsalBuildOnMainnet.selector, "rehearsal"));
            h.planFor(TESTNET_DEPLOYER, BoxSpecV1.PLATFORM_SAFE_MAINNET, TESTNET_DEPLOYER, "", false);
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.RehearsalBuildOnMainnet.selector, "rehearsal"));
            h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, REHEARSAL_FILE, false);
        } else {
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.SpecFileForAnotherChain.selector, SEPOLIA, 1));
            h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, REHEARSAL_FILE, false);
        }
    }

    /// The rehearsal file: box0-spec.11155111.json with the rehearsal raise only, its hash its `.specHash`.
    function test_F78_theRehearsalFileIsTheSepoliaFileWithTheRehearsalRaise() public view {
        string memory json = vm.readFile(REHEARSAL_FILE);
        bytes memory encoded = vm.parseJsonBytes(json, ".encoded");
        BoxSpecV1.BoxSpec memory r = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        BoxSpecV1.BoxSpec memory d =
            abi.decode(vm.parseJsonBytes(vm.readFile(DEFAULT_FILE), ".encoded"), (BoxSpecV1.BoxSpec));
        assertEq(keccak256(encoded), vm.parseJsonBytes32(json, ".specHash"), "the file's spec hash");
        assertEq(keccak256(abi.encode(r)), keccak256(encoded), "canonical ABI encoding");
        assertEq(vm.parseJsonUint(json, ".chainId"), SEPOLIA);
        assertEq(keccak256(bytes(vm.parseJsonString(json, ".build"))), keccak256("rehearsal"));
        assertEq(vm.parseJsonAddress(json, ".platform"), TESTNET_DEPLOYER, "Z3 default: the testnet deployer");
        assertEq(r.raise, MAINNET_RAISE / 10, "0.4206980085 ETH");
        assertEq(d.raise, MAINNET_RAISE);
        d.raise = r.raise;
        assertEq(
            keccak256(abi.encode(d)), keccak256(encoded), "the Sepolia file with the rehearsal raise, nothing else"
        );
        console.log("F78|rehearsal spec hash", vm.toString(keccak256(encoded)));
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _fileHash(string memory path) internal view returns (bytes32) {
        return vm.parseJsonBytes32(vm.readFile(path), ".specHash");
    }

    /// @dev CREATE `init`; the revert data ("" when it was created).
    function _tryCreate(bytes memory init) internal returns (bytes memory reason) {
        address a;
        assembly ("memory-safe") {
            a := create(0, add(init, 0x20), mload(init))
        }
        if (a != address(0)) return "";
        assembly ("memory-safe") {
            reason := mload(0x40)
            mstore(reason, returndatasize())
            returndatacopy(add(reason, 0x20), 0, returndatasize())
            mstore(0x40, add(add(reason, 0x20), returndatasize()))
        }
        if (reason.length == 0) reason = hex"00";
    }

    /// @dev Every contract BoxBuildGuard covers, with stand-in constructor arguments (the guard runs before them).
    function _guardedInitCodes() internal returns (string[] memory names, bytes[] memory inits) {
        IPoolManager pm = IPoolManager(makeAddr("f78.pm"));
        address impl = makeAddr("f78.coordinatorImplementation");
        address ext = makeAddr("f78.extension");
        names = new string[](15);
        inits = new bytes[](15);
        (names[0], inits[0]) =
        ("BoxCoordinator", abi.encodePacked(type(BoxCoordinator).creationCode, abi.encode(pm, makeAddr("f78.f"))));
        (names[1], inits[1]) =
        ("BoxHookExtension", abi.encodePacked(type(BoxHookExtension).creationCode, abi.encode(pm)));
        (names[2], inits[2]) = ("BoxHook", abi.encodePacked(type(BoxHook).creationCode, abi.encode(pm, impl, ext)));
        (names[3], inits[3]) =
        ("BoxLaunchRouter", abi.encodePacked(type(BoxLaunchRouter).creationCode, abi.encode(pm, impl)));
        (names[4], inits[4]) =
        ("BoxReceiverExtension", abi.encodePacked(type(BoxReceiverExtension).creationCode, abi.encode(impl)));
        (names[5], inits[5]) =
        ("BoxReceiver", abi.encodePacked(type(BoxReceiver).creationCode, abi.encode(pm, impl, ext)));
        (names[6], inits[6]) = ("BoxCollection", abi.encodePacked(type(BoxCollection).creationCode, abi.encode(impl)));
        (names[7], inits[7]) = ("BoxVault", abi.encodePacked(type(BoxVault).creationCode, abi.encode(impl)));
        (names[8], inits[8]) = ("BoxTickets", abi.encodePacked(type(BoxTickets).creationCode, abi.encode(impl)));
        (names[9], inits[9]) = ("BoxRoyaltyRouter", type(BoxRoyaltyRouter).creationCode);
        (names[10], inits[10]) =
        ("BoxItemStream", abi.encodePacked(type(BoxItemStream).creationCode, abi.encode(pm, impl)));
        (names[11], inits[11]) = ("BoxSwapModule", abi.encodePacked(type(BoxSwapModule).creationCode, abi.encode(pm)));
        (names[12], inits[12]) =
        ("BoxPriceSampler", abi.encodePacked(type(BoxPriceSampler).creationCode, abi.encode(pm)));
        (names[13], inits[13]) = ("BoxFactoryV1Planner", type(BoxFactoryV1Planner).creationCode);
        IBoxFactoryV1.Implementations memory impls;
        (names[14], inits[14]) =
        (
            "BoxFactoryV1",
            abi.encodePacked(
                type(BoxFactoryV1).creationCode,
                abi.encode(pm, impls, address(0), address(0), address(0), address(1), address(1), bytes32(uint256(1)))
            )
        );
    }
}
