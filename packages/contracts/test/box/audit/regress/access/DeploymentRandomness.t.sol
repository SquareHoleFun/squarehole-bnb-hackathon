// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditRegressEventChecks} from "./EventChecks.sol";

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {DeployCoreV1} from "../../../../../script/DeployCoreV1.s.sol";
import {BoxSpecV1} from "../../../../../src/box/BoxSpecV1.sol";
import {DrandSource} from "../../../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../../../src/box/randomness/DrandSourcePins.sol";
import {IDrandSource} from "../../../../../src/box/interfaces/IDrandSource.sol";
import {PinnedDrandSource} from "../../../randomness/utils/PinnedDrandSource.sol";
import {BoxDrandVectors} from "../../../randomness/utils/BoxDrandVectors.sol";

contract AuditRegressReviewDeployHarness is DeployCoreV1 {
    function checkSpec(uint256 chain, BoxSpecV1.BoxSpec memory spec) external pure {
        _checkSpecForChain(chain, spec);
    }

    function checkFile(string memory file, uint256 chain) external view {
        _checkSpecFileChain(file, chain);
    }

    function checkOpen(uint256 at, uint256 now_) external pure {
        _checkOpenAt(at, now_);
    }

    function checkBroadcast(bool approved, address signer, address expected, bool fixture) external pure {
        _checkBroadcast(approved, signer, expected, fixture);
    }

    function planChain() external view {
        _planFor(address(this), address(1), address(this), "", false);
    }
}

contract AuditRegressDeploymentReviewTest is Test {
    AuditRegressReviewDeployHarness internal h;

    function setUp() public {
        h = new AuditRegressReviewDeployHarness();
    }

    function _synthetic() internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = h.fixtureSpec();
        // Not launch data: tests of the guard's scope, not evidence of a sealed mainnet edition.
        s.revealRoot = keccak256("access review synthetic root");
        s.generatorHash = keccak256("access review synthetic generator");
        s.metadataTable = hex"010000010141010142";
    }

    function test_AR07_allKnownTestRootsGeneratorsAndTablesAreRefusedOnMainnet() public {
        BoxSpecV1.BoxSpec memory s = _synthetic();
        h.checkSpec(1, s);
        bytes32[7] memory roots = [
            bytes32(0),
            bytes32(0xf983840bf08a7deb54c03a65382418390b9cdc259e2152a01d56d340ca3679ec),
            bytes32(0x3d88f4cc193a1debaa14062d0866edba43dd836564dcb36f2234517b98fa922d),
            bytes32(0x96ab1aa34dca451e37eb23c6f4010ae2c3d8546868120b79abbee6913654614a),
            bytes32(0xfe3ba00e7949b9bed0fb17f7af5e0e101b581ec6d328bf0dec0330bba08842fc),
            bytes32(0xdfc000d2ce029fc889fb15f05384153d543afc63a3a60a22e302ee11bcb0979f),
            bytes32(0xfdbae7713f2c54f1f75970cddee81cf4fb1ef9d17c69255b85b90fe34e6c26fc)
        ];
        for (uint256 i; i < roots.length; ++i) {
            s.revealRoot = roots[i];
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, roots[i]));
            h.checkSpec(1, s);
            h.checkSpec(11_155_111, s);
        }
        s = _synthetic();
        bytes32[4] memory generators = [
            bytes32(0xe95521689a770d6d7b423c18b6d84d6556192211000000000000000000000000),
            keccak256("sepolia-core-v1.box0-test-set/1: no generator (test data)"),
            keccak256("sepolia-full.test-set/1: no generator (test data)"),
            bytes32(bytes20(hex"31349e9b3d9338f711f34c6a3acebc4b758707c5"))
        ];
        for (uint256 i; i < generators.length; ++i) {
            s.generatorHash = generators[i];
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestGeneratorRefused.selector, generators[i]));
            h.checkSpec(1, s);
        }
        bytes[4] memory tables = [
            h.fixtureSpec().metadataTable,
            vm.parseJsonBytes(vm.readFile("test/vectors/box/sepolia-box0-test-set.json"), ".metadataTable"),
            vm.parseJsonBytes(vm.readFile("test/vectors/misfits-commitment.json"), ".metadataTable"),
            vm.parseJsonBytes(vm.readFile("test/vectors/sepolia-test-set.json"), ".metadataTable")
        ];
        s = _synthetic();
        for (uint256 i; i < tables.length; ++i) {
            uint256 start = 3 + (uint256(uint8(tables[i][1])) << 8) + uint8(tables[i][2]);
            bytes memory traits = new bytes(tables[i].length - start);
            for (uint256 j; j < traits.length; ++j) {
                traits[j] = tables[i][start + j];
            }
            s.metadataTable = bytes.concat(hex"010006", bytes("Launch"), traits);
            vm.expectRevert(DeployCoreV1.TestMetadataTableRefused.selector);
            h.checkSpec(1, s);
        }
    }

    function test_AR07_AR08_chainFilesAndBroadcastGuards() public {
        vm.chainId(31337);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.UnsupportedChain.selector, 31337));
        h.planChain();
        vm.chainId(1);
        string[3] memory paths = [
            "script/config/box0-spec.11155111.json",
            "script/config/box0-spec.11155111.safe.json",
            "script/config/box0-spec.11155111.rehearsal.json"
        ];
        for (uint256 i; i < paths.length; ++i) {
            vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.SpecFileForAnotherChain.selector, 11_155_111, 1));
            h.checkFile(paths[i], 1);
        }
        vm.expectRevert(DeployCoreV1.BroadcastNotApproved.selector);
        h.checkBroadcast(false, address(1), address(1), false);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.WrongDeployer.selector, address(1), address(2)));
        h.checkBroadcast(true, address(1), address(2), false);
        vm.expectRevert(DeployCoreV1.FixtureSpecRefused.selector);
        h.checkBroadcast(true, address(1), address(1), true);
        h.checkBroadcast(true, address(1), address(1), false);
    }

    function test_AR15_openTimePlanningBoundaries() public {
        uint256 now_ = 1_800_000_000;
        h.checkOpen(0, now_);
        h.checkOpen(now_ + 900, now_);
        h.checkOpen(now_ + 14 days, now_);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.OpenAtTooSoon.selector, now_ + 899, now_ + 900));
        h.checkOpen(now_ + 899, now_);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.OpenAtTooFar.selector, now_ + 14 days + 1, now_ + 14 days));
        h.checkOpen(now_ + 14 days + 1, now_);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditRegressRandomnessReviewTest is BoxDrandVectors, AuditRegressEventChecks {
    DrandSource internal source;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    function setUp() public {
        vm.chainId(1);
        _loadBoxDrand();
        source = PinnedDrandSource.deploy(vm);
    }

    function test_AR10_sourcePinsCheckAddressRuntimeAndSupportedChain() public {
        assertEq(keccak256(type(DrandSource).creationCode), DrandSourcePins.INIT_CODE_HASH);
        assertEq(address(source), PinnedDrandSource.predict());
        assertTrue(DrandSourcePins.isPinned(address(source)));
        vm.etch(BOB, address(source).code);
        assertFalse(DrandSourcePins.isPinned(BOB), "identical runtime at another address is insufficient");
        vm.chainId(11_155_111);
        assertTrue(DrandSourcePins.isPinned(address(source)));
        vm.chainId(31337);
        assertFalse(DrandSourcePins.isPinned(address(source)));
        vm.chainId(1);
        vm.etch(address(source), hex"ef01000000000000000000000000000000000000000001");
        assertFalse(DrandSourcePins.isPinned(address(source)), "delegation is not pinned runtime");
    }

    function test_AR11_realRoundCallerIsolationEventsAndImmutableWords() public {
        Round memory r = _boxDrand(_localFirst());
        vm.warp(r.time - 12);
        vm.deal(ALICE, 3 wei);
        vm.recordLogs();
        vm.prank(ALICE);
        assertEq(source.request{value: 3 wei}(17), r.round);
        vm.prank(BOB);
        source.request(17);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, ALICE, 17));
        vm.prank(ALICE);
        source.request(17);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundNotYet.selector, r.round, r.time));
        source.postRound(r.round, r.xy);
        vm.warp(r.time);
        vm.prank(BOB);
        assertEq(source.postRound(r.round, r.xy), r.randomness);
        (bytes32 a, uint64 at) = source.wordOf(ALICE, 17);
        (bytes32 b,) = source.wordOf(BOB, 17);
        assertTrue(a != b);
        assertEq(
            a,
            keccak256(
                abi.encode(
                    keccak256("squarehole.randomness.drand-quicknet"),
                    r.randomness,
                    keccak256(abi.encode(ALICE, uint256(17)))
                )
            )
        );
        assertEq(at, r.time);
        assertEq(source.owedTo(BOB), 3);
        vm.prank(ALICE);
        vm.expectRevert(IDrandSource.NothingOwed.selector);
        source.withdrawBounty(payable(ALICE));
        vm.prank(BOB);
        assertEq(source.withdrawBounty(payable(ALICE)), 3);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundKnown.selector, r.round));
        source.postRound(r.round, r.xy);
        (bytes32 again, uint64 atAgain) = source.wordOf(ALICE, 17);
        assertEq(again, a);
        assertEq(atAgain, at);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 aliceRequests;
        for (uint256 i; i < logs.length; ++i) {
            // Amsterdam also logs native transfers. Find the source event by emitter and signature.
            if (logs[i].emitter != address(source) || logs[i].topics.length != 3) continue;
            if (logs[i].topics[0] != keccak256("Requested(address,uint256,uint256,uint256)")) continue;
            if (logs[i].topics[1] != bytes32(uint256(uint160(ALICE)))) continue;
            ++aliceRequests;
            assertEq(logs[i].topics[2], bytes32(uint256(17)));
            assertEq(logs[i].data, abi.encode(r.round, uint256(3)));
        }
        assertEq(aliceRequests, 1);
    }

    function test_AR21_E73_E74_E75_roundPostingAndBountyEventFields() public {
        Round memory r = _boxDrand(_localFirst());
        vm.warp(r.time - 12);
        vm.deal(ALICE, 9);
        vm.recordLogs();
        vm.prank(ALICE);
        source.request{value: 2}(17);
        _event(
            vm.getRecordedLogs(),
            address(source),
            "Requested(address,uint256,uint256,uint256)",
            abi.encode(ALICE, uint256(17)),
            abi.encode(r.round, uint256(2))
        );
        vm.recordLogs();
        vm.prank(ALICE);
        source.addBounty{value: 7}(r.round);
        _event(
            vm.getRecordedLogs(),
            address(source),
            "BountyAdded(uint256,address,uint256)",
            abi.encode(r.round, ALICE),
            abi.encode(uint256(7))
        );
        assertEq(source.bountyOf(r.round), 9);
        vm.warp(r.time);
        vm.recordLogs();
        vm.prank(BOB);
        source.postRound(r.round, r.xy);
        _event(
            vm.getRecordedLogs(),
            address(source),
            "RoundPosted(uint256,bytes32,address,uint256)",
            abi.encode(r.round, BOB),
            abi.encode(r.randomness, uint256(9))
        );
        assertEq(source.owedTo(BOB), 9);
        vm.recordLogs();
        (bool ok,) = address(source).call(abi.encodeCall(DrandSource.postRound, (r.round, r.xy)));
        assertFalse(ok);
        _noEvent(vm.getRecordedLogs(), address(source), "RoundPosted(uint256,bytes32,address,uint256)");
    }

    function test_AR11_invalidSignatureAndLatePostCannotUndoSilence() public {
        Round memory r = _boxDrand(_localFirst());
        vm.warp(r.time - 12);
        vm.prank(ALICE);
        source.request(1);
        vm.warp(r.time);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidSignature.selector, r.round));
        source.postRound(r.round, new bytes(256));
        bytes memory wrongSignature = bytes.concat(r.xy);
        wrongSignature[0] ^= 0x01;
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.InvalidSignature.selector, r.round));
        source.postRound(r.round, wrongSignature);
        vm.warp(r.time - 12 + 7 days);
        assertFalse(source.isSilent(ALICE, 1));
        vm.warp(block.timestamp + 1);
        assertTrue(source.isSilent(ALICE, 1));
        source.postRound(r.round, r.xy);
        assertTrue(source.isSilent(ALICE, 1));
    }
}
