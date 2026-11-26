// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditU8LaneBase, AuditU8LaneHeaders, DrandSource, BoxBackedSource, IDrandSource} from "./AuditU8LaneBase.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";

/// @notice Adversarial bounty recipient only; actual DrandSource and its precompiles are unchanged.
contract AuditU8LaneRecipient {
    DrandSource internal immutable source;
    uint256 internal mode;
    uint256 internal round;
    bytes internal sig;
    uint256 public received;
    uint256 public creditOnEntry;
    bool public callbackSucceeded;
    bool public duplicateSucceeded;

    constructor(DrandSource s) {
        source = s;
    }

    function post(uint256 r, bytes calldata signature) external {
        source.postRound(r, signature);
    }

    function withdraw(uint256 m, uint256 r, bytes calldata signature) external {
        mode = m;
        round = r;
        sig = signature;
        source.withdrawBounty(payable(address(this)));
    }

    receive() external payable {
        received += msg.value;
        creditOnEntry = source.owedTo(address(this));
        if (mode == 0) {
            (callbackSucceeded,) = address(source).call(abi.encodeCall(source.withdrawBounty, (payable(address(this)))));
        }
        if (mode == 1) (callbackSucceeded,) = address(source).call(abi.encodeCall(source.postRound, (round, sig)));
        if (mode == 2) {
            (callbackSucceeded,) = address(source).call(abi.encodeCall(source.request, (77)));
            (duplicateSucceeded,) = address(source).call(abi.encodeCall(source.request, (77)));
        }
    }
}

/// @notice BC-053, BC-101; F54, F61 R4, F143; IDrandSource uniqueness, accounting and time invariants.
/// forge-config: default.evm_version = "osaka"
contract AuditU8LanePropertiesTest is AuditU8LaneBase {
    function testProperty_AUDIT_U8_reentrantReceiptsClearCreditFirst() public {
        for (uint256 mode; mode < 3; ++mode) {
            uint256 snap = vm.snapshotState();
            AuditU8LaneRecipient receiver = new AuditU8LaneRecipient(drand);
            drand.addBounty{value: 2 ether}(first);
            // The callback can post another round, but only receives its original credit in this withdrawal.
            drand.addBounty{value: 1 ether}(first + 1);
            vm.warp(drand.roundTime(first + 1));
            receiver.post(first, _localSig(0));
            receiver.withdraw(mode, first + 1, _localSig(1));
            assertEq(receiver.creditOnEntry(), 0);
            assertEq(receiver.received(), 2 ether);
            assertEq(address(receiver).balance, 2 ether);
            assertEq(drand.owedTo(address(receiver)), mode == 1 ? 1 ether : 0);
            assertEq(receiver.callbackSucceeded(), mode != 0);
            assertFalse(receiver.duplicateSucceeded());
            assertEq(address(drand).balance, 1 ether);
            assertTrue(vm.revertToState(snap));
        }
    }

    function testFuzz_AUDIT_U8_exactForwardingAndUniquePairs(address a, uint256 ka, address b, uint256 kb) public {
        // Pranked EOAs model consumers; no code substitutes for either source.
        vm.assume(a != b || ka != kb);
        bytes32 ia = keccak256(abi.encode(a, ka));
        bytes32 ib = keccak256(abi.encode(b, kb));
        assertNotEq(ia, ib);
        assertEq(_request(true, a, ka, 0), first);
        assertEq(_request(true, b, kb, 0), first);
        (uint64 at, uint64 round) = drand.requestOf(address(backed), uint256(ia));
        assertEq(at, block.timestamp);
        assertEq(round, first);
        (uint64 atB,) = drand.requestOf(address(backed), uint256(ib));
        assertEq(atB, at);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, address(backed), uint256(ia)));
        backed.request(ka);
        vm.warp(drand.roundTime(first));
        drand.postRound(first, _localSig(0));
        (bytes32 randomness,) = drand.beaconOf(first);
        (bytes32 wa,) = backed.wordOf(a, ka);
        (bytes32 wb,) = backed.wordOf(b, kb);
        assertEq(wa, keccak256(abi.encode(backed.DRAND_TAG(), randomness, ia)));
        assertEq(wb, keccak256(abi.encode(backed.DRAND_TAG(), randomness, ib)));
        assertNotEq(wa, wb);
        (bytes32 forwarded,) = drand.wordOf(address(backed), uint256(ia));
        assertEq(
            forwarded,
            keccak256(abi.encode(drand.WORD_TAG(), randomness, keccak256(abi.encode(address(backed), uint256(ia)))))
        );
        assertNotEq(wa, forwarded);
        assertEq(address(backed).balance, 0);
    }

    function testProperty_AUDIT_U8_requestNoCallbackAndDuplicateRefused() public {
        // DrandSource.request makes no untrusted call. Record even an explicit expectation of zero consumer calls.
        address consumer = address(0x12345);
        vm.expectCall(consumer, bytes(""), uint64(0));
        _request(false, consumer, 99, 1 ether);
        vm.prank(consumer);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.AlreadyRequested.selector, consumer, uint256(99)));
        drand.request(99);
        assertEq(drand.bountyOf(first), 1 ether);
    }

    function testProperty_AUDIT_U8_postOnlyFromTimeAndOnce() public {
        bytes memory sig = _localSig(0);
        uint256 t = drand.roundTime(first);
        vm.warp(t - 1);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundNotYet.selector, first, t));
        drand.postRound(first, sig);
        vm.warp(t);
        drand.postRound(first, sig);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundKnown.selector, first));
        drand.postRound(first, sig);
        vm.warp(t + 5 days + 1);
        bytes memory h = AuditU8LaneHeaders.header(block.number - 1, bytes32(uint256(1)), 4);
        vm.setBlockhash(block.number - 1, keccak256(h));
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.RoundAlreadyPosted.selector, first));
        backed.startBackup(first, block.number - 1, h);
    }

    function testProperty_AUDIT_U8_startWindowEdgesAndOneTarget() public {
        uint256 t = drand.roundTime(first);
        uint256[5] memory offsets = [uint256(5 days - 1), 5 days, 5 days + 1, 5 days + 18 hours, 5 days + 18 hours + 1];
        bytes memory h = AuditU8LaneHeaders.header(block.number - 1, bytes32(uint256(1)), 4);
        vm.setBlockhash(block.number - 1, keccak256(h));
        for (uint256 i; i < offsets.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.warp(t + offsets[i]);
            if (i < 2) {
                vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupTooEarly.selector, first, t + 5 days));
                backed.startBackup(first, block.number - 1, h);
            } else if (i == 4) {
                vm.expectRevert(
                    abi.encodeWithSelector(BoxBackedSource.BackupTooLate.selector, first, t + 5 days + 18 hours)
                );
                backed.startBackup(first, block.number - 1, h);
            } else {
                uint256 target = backed.startBackup(first, block.number - 1, h);
                assertEq(target, block.number + 256);
                vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyStarted.selector, first));
                backed.startBackup(first, block.number - 1, h);
            }
            assertTrue(vm.revertToState(snap));
        }
    }

    function testFuzz_AUDIT_U8_backupDependsOnlyOnMixAndId(bytes32 mix, uint256 key) public {
        address c = address(0xB0);
        _request(true, c, key, 1 ether);
        vm.warp(drand.roundTime(first) + 5 days + 1);
        uint256 target = _start(first);
        uint256 snap = vm.snapshotState();
        drand.postRound(first, _localSig(0));
        {
            (bytes32 pending,) = backed.wordOf(c, key);
            assertEq(pending, bytes32(0));
        }
        vm.roll(target + 1);
        _fix(first, target, mix);
        bytes32 expected = keccak256(abi.encode(backed.BACKUP_TAG(), mix, keccak256(abi.encode(c, key))));
        {
            (bytes32 w,) = backed.wordOf(c, key);
            assertEq(w, expected);
        }
        assertTrue(vm.revertToState(snap));
        vm.roll(target + 257);
        vm.warp(block.timestamp + 257 * 12);
        _fix(first, target, mix);
        drand.postRound(first, _localSig(0));
        (,, uint64 fixedAt,) = backed.backupOf(first);
        vm.warp(block.timestamp + 8 days);
        {
            (bytes32 w, uint64 at) = backed.wordOf(c, key);
            assertEq(w, expected);
            assertEq(at, fixedAt);
            (, uint64 targetAfter,,) = backed.backupOf(first);
            assertEq(targetAfter, target);
        }
        bytes memory h = AuditU8LaneHeaders.header(target, mix, 4);
        vm.expectRevert(abi.encodeWithSelector(BoxBackedSource.BackupAlreadyFixed.selector, first));
        backed.fixBackup(first, h);
        assertEq(address(backed).balance, 0);
    }

    function testFuzz_AUDIT_U8_roundArithmeticFullUint64(uint64 timestamp) public {
        uint256 t = timestamp;
        uint256 genesis = 1_692_803_367;
        uint256 r = drand.roundAt(t);
        assertEq(r, t <= genesis ? 1 : (t - genesis + 2) / 3 + 1);
        assertEq(drand.roundTime(r), genesis + (r - 1) * 3);
        assertGe(drand.roundTime(r), t);
        if (r > 1) assertLt(drand.roundTime(r - 1), t);
        vm.warp(t == 0 ? 1 : t);
        uint256 requestedRound = drand.request(0);
        assertGe(drand.roundTime(requestedRound), block.timestamp + 12);
        if (block.timestamp + 12 >= genesis) assertLe(drand.roundTime(requestedRound), block.timestamp + 14);
        (uint64 at, uint64 storedRound) = drand.requestOf(address(this), 0);
        assertEq(at, block.timestamp);
        assertEq(storedRound, requestedRound);
        assertEq(backed.roundAt(t), r);
        assertEq(backed.roundTime(r), drand.roundTime(r));
    }

    function testProperty_AUDIT_U8_genesisAndUint64Edges() public {
        uint256 g = drand.GENESIS_TIME();
        for (uint256 t = g - 1; t <= g + 7; ++t) {
            uint256 r = drand.roundAt(t);
            assertEq(r, t <= g ? 1 : (t - g + 2) / 3 + 1);
            assertEq(drand.roundTime(r), g + (r - 1) * 3);
        }
        for (uint256 offset; offset <= 16; ++offset) {
            vm.warp(uint256(type(uint64).max) - offset);
            uint256 r = drand.request(offset);
            (uint64 at, uint64 stored) = drand.requestOf(address(this), offset);
            assertEq(at, block.timestamp);
            assertEq(stored, r);
            assertGe(drand.roundTime(r), block.timestamp + 12);
            assertLe(drand.roundTime(r), block.timestamp + 14);
        }
    }

    function testProperty_AUDIT_U8_timelineAtTwelveAndSixSeconds() public view {
        assertEq(backed.LATEST_START(), BoxSpecV1.BACKUP_LATEST_START_SECONDS);
        assertEq(backed.BACKUP_AFTER(), BoxSpecV1.BACKUP_AFTER_SECONDS);
        assertEq(backed.TARGET_BLOCKS(), BoxSpecV1.BACKUP_TARGET_BLOCKS);
        assertEq(backed.RECENT_BLOCKS(), BoxSpecV1.BACKUP_RECENT_BLOCKS);
        assertEq(drand.MARGIN(), BoxSpecV1.DRAND_MARGIN_SECONDS);
        assertEq(drand.SILENCE(), BoxSpecV1.DRAND_SILENCE_SECONDS);
        assertEq(uint256(8191) * 12, 98_292); // latest fix after target: 27h18m12s
        assertEq(uint256(8191) * 6, 49_146); // 13h39m6s
        assertEq(uint256(256 + 8191) * 12, 101_364);
        assertEq(uint256(256 + 8191) * 6, 50_682);
        assertEq(7 days - (15 + backed.LATEST_START() + (256 + 8191) * 12), 6_621);
        assertEq(7 days - (15 + backed.LATEST_START() + (256 + 8191) * 6), 57_303);
        // Integer-second request-to-round gap is 12..14 s; the documented 15 s uses a conservative extra second.
    }

    function testProperty_AUDIT_U8_create2PinsCompiledCodeBothChains() public {
        assertEq(keccak256(type(DrandSource).creationCode), DrandSourcePins.INIT_CODE_HASH);
        assertEq(keccak256(type(BoxBackedSource).creationCode), BackedSourcePins.INIT_CODE_HASH);
        address predictedD = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            DrandSourcePins.DEPLOYER,
                            DrandSourcePins.SALT,
                            keccak256(type(DrandSource).creationCode)
                        )
                    )
                )
            )
        );
        address predictedB = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            BackedSourcePins.DEPLOYER,
                            BackedSourcePins.SALT,
                            keccak256(type(BoxBackedSource).creationCode)
                        )
                    )
                )
            )
        );
        for (uint256 i; i < 2; ++i) {
            uint256 chain = i == 0 ? 1 : 11_155_111;
            vm.chainId(chain);
            (address d, bytes32 dh) = DrandSourcePins.pinned(chain);
            (address b, bytes32 bh) = BackedSourcePins.pinned(chain);
            assertEq(d, predictedD);
            assertEq(b, predictedB);
            assertEq(dh, address(drand).codehash);
            assertEq(bh, address(backed).codehash);
            assertTrue(DrandSourcePins.isPinned(d));
            assertTrue(BackedSourcePins.isPinned(b));
            assertEq(address(backed.DRAND()), d);
        }
    }

    function testFuzz_AUDIT_U8_otherChainsHaveNoPin(uint256 chain) public {
        vm.assume(chain != 1 && chain != 11_155_111);
        if (chain <= type(uint64).max) vm.chainId(chain);
        else vm.chainId(31337);
        (address d, bytes32 dh) = DrandSourcePins.pinned(chain);
        (address b, bytes32 bh) = BackedSourcePins.pinned(chain);
        assertEq(d, address(0));
        assertEq(b, address(0));
        assertEq(dh, bytes32(0));
        assertEq(bh, bytes32(0));
        assertFalse(DrandSourcePins.isPinned(address(drand)));
        assertFalse(BackedSourcePins.isPinned(address(backed)));
    }
}
