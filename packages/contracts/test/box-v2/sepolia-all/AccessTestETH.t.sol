// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestETH} from "../../../src/test-coins/TestETH.sol";

/// SH-ALPHA-TETH-af1: F157 (2), offline admission, ownership and exact authority boundary.
contract AccessTestETHTest is Test {
    address private constant OWNER = address(0xF030);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant ADMITTER = address(0xAD);
    TestETH private coin;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdmissionChanged(address indexed account, bool admitted);
    event OpenChanged(bool open);
    event AdmitterChanged(address indexed account, uint256 perDay);

    function setUp() public {
        vm.chainId(31337);
        vm.warp(10 days + 12 hours);
        coin = new TestETH(OWNER);
    }

    function testFuzz_deployClosedAndNobodyAdmitted(address account) public view {
        assertEq(coin.owner(), OWNER);
        assertEq(coin.pendingOwner(), address(0));
        assertFalse(coin.open());
        assertFalse(coin.admitted(account));
        assertFalse(coin.admitted(OWNER));
        assertFalse(coin.admitted(address(this)));
        assertEq(coin.admitter(), address(0));
        assertEq(coin.admitterPerDay(), 0);
    }

    /// SH-TETH-ADMITTER-1/2: bounded configuration, including a paused nonzero role.
    function test_admitterConfigurationBoundsClearAndEvents() public {
        assertEq(coin.MAX_ADMITTER_PER_DAY(), 50);
        _setAdmitter(ADMITTER, 50);
        vm.startPrank(OWNER);
        vm.expectRevert(TestETH.InvalidAdmitterLimit.selector);
        coin.setAdmitter(BOB, 51);
        vm.expectRevert(TestETH.InvalidAdmitterLimit.selector);
        coin.setAdmitter(BOB, type(uint256).max);
        vm.expectRevert(TestETH.InvalidAdmitterLimit.selector);
        coin.setAdmitter(address(0), 1);
        vm.stopPrank();
        assertEq(coin.admitter(), ADMITTER);
        assertEq(coin.admitterPerDay(), 50);
        _setAdmitter(ADMITTER, 0);
        _expectAdmissionCap(ADMITTER, ALICE);
        _setAdmitter(address(0), 0);
        _expectNotAdmitter(ADMITTER, ALICE);
        _expectNotAdmitter(OWNER, ALICE);
        _expectNotAdmitter(address(0), ALICE);
        assertFalse(coin.admitted(ALICE));
    }

    function testFuzz_onlyConfiguredAdmitterCanAdmitOne(address caller) public {
        vm.assume(caller != ADMITTER);
        _setAdmitter(ADMITTER, 1);
        _expectNotAdmitter(caller, ALICE);
        _expectNotAdmitter(caller, address(0));
        assertFalse(coin.admitted(ALICE));
        _admitOne(ADMITTER, ALICE);
        assertTrue(coin.admitted(ALICE));
    }

    function test_zeroAdmissionRevertsWithoutSpendingQuota() public {
        _setAdmitter(ADMITTER, 1);
        vm.prank(ADMITTER);
        vm.expectRevert(TestETH.ZeroAddress.selector);
        coin.admitOne(address(0));
        assertFalse(coin.admitted(address(0)));
        vm.expectEmit(true, false, false, true, address(coin));
        emit AdmissionChanged(ALICE, true);
        vm.recordLogs();
        _admitOne(ADMITTER, ALICE);
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(coin.balanceOf(ALICE), 0);
        assertEq(coin.nextDripAt(ALICE), 0);
        assertEq(coin.totalSupply(), 1_000_000e18);
        assertEq(coin.dailyRemaining(), 500e18);
        _expectAdmissionCap(ADMITTER, BOB);
    }

    function testFuzz_admitterQuotaResetsAtUtcMidnight(uint8 limit) public {
        uint256 cap = bound(uint256(limit), 1, 50);
        _setAdmitter(ADMITTER, cap);
        vm.warp(11 days - 1);
        for (uint160 i = 1; i <= cap; ++i) _admitOne(ADMITTER, address(i));
        _expectAdmissionCap(ADMITTER, ALICE);
        assertFalse(coin.admitted(ALICE));
        assertEq(coin.totalSupply(), 1_000_000e18);
        vm.warp(11 days);
        _admitOne(ADMITTER, ALICE);
        for (uint160 i = 1; i < cap; ++i) _admitOne(ADMITTER, address(i + 100));
        _expectAdmissionCap(ADMITTER, BOB);
        assertFalse(coin.admitted(BOB));
        vm.warp(14 days);
        _admitOne(ADMITTER, BOB);
        assertTrue(coin.admitted(BOB));
    }

    function test_dayZeroEnforcesQuota() public {
        vm.warp(0);
        _setAdmitter(ADMITTER, 1);
        _admitOne(ADMITTER, ALICE);
        _expectAdmissionCap(ADMITTER, BOB);
        vm.warp(1 days);
        _admitOne(ADMITTER, BOB);
    }

    function test_duplicateAdmissionsAreSilentAndFreeEvenAtCapOrZeroQuota() public {
        _setAdmitter(ADMITTER, 1);
        vm.prank(OWNER);
        coin.admit(_one(ALICE));
        vm.recordLogs();
        _admitOne(ADMITTER, ALICE);
        assertEq(vm.getRecordedLogs().length, 0);
        _admitOne(ADMITTER, BOB);
        vm.recordLogs();
        _admitOne(ADMITTER, ALICE);
        _admitOne(ADMITTER, BOB);
        assertEq(vm.getRecordedLogs().length, 0);
        _expectAdmissionCap(ADMITTER, OWNER);
        _setAdmitter(ADMITTER, 0);
        vm.recordLogs();
        _admitOne(ADMITTER, ALICE);
        assertEq(vm.getRecordedLogs().length, 0);
        _expectAdmissionCap(ADMITTER, OWNER);
        vm.warp(11 days);
        _setAdmitter(ADMITTER, 1);
        _admitOne(ADMITTER, ALICE);
        _admitOne(ADMITTER, OWNER);
        assertTrue(coin.admitted(OWNER));
    }

    function test_removeAndReadmitCostsQuotaButPreservesCoinsAndCooldown() public {
        _setAdmitter(ADMITTER, 2);
        _admitOne(ADMITTER, ALICE);
        _drip(ALICE);
        vm.prank(OWNER);
        coin.remove(_one(ALICE));
        _admitOne(ADMITTER, ALICE);
        _expectAdmissionCap(ADMITTER, BOB);
        assertEq(coin.balanceOf(ALICE), 1e18);
        assertEq(coin.nextDripAt(ALICE), block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(TestETH.CooldownActive.selector, block.timestamp + 1 days));
        _drip(ALICE);
        assertEq(coin.dailyRemaining(), 499e18);
    }

    function test_rotationClearingAndLimitChangesNeverResetSameDayUsage() public {
        _setAdmitter(ADMITTER, 2);
        _admitOne(ADMITTER, ALICE);
        _setAdmitter(ADMITTER, 2);
        _setAdmitter(address(0), 0);
        _setAdmitter(BOB, 1);
        _expectNotAdmitter(ADMITTER, OWNER);
        _expectAdmissionCap(BOB, OWNER);
        _setAdmitter(BOB, 2);
        _admitOne(BOB, OWNER);
        _expectAdmissionCap(BOB, ADMITTER);
        _setAdmitter(BOB, 1);
        _expectAdmissionCap(BOB, ADMITTER);
        vm.warp(11 days);
        _admitOne(BOB, ADMITTER);
        _expectAdmissionCap(BOB, BOB);
    }

    /// SH-TETH-ADMITTER-3: the role adds no owner power, faucet bypass or third-party spending.
    function test_admitterCannotManageOrActOnOthersBehalf() public {
        _setAdmitter(ADMITTER, 1);
        _expectManagementDenied(ADMITTER);
        _expectAcceptDenied(ADMITTER);
        _expectNotAdmitted(ADMITTER);
        vm.startPrank(ADMITTER);
        vm.expectRevert(abi.encodeWithSignature("ERC20InsufficientAllowance(address,uint256,uint256)", ADMITTER, 0, 1));
        coin.transferFrom(OWNER, ADMITTER, 1);
        (bool ok,) = address(coin).call(abi.encodeWithSignature("drip(address)", ALICE));
        assertFalse(ok);
        vm.stopPrank();
        assertEq(coin.balanceOf(OWNER), 1_000_000e18);
        _admitOne(ADMITTER, ADMITTER);
        _drip(ADMITTER);
        vm.expectRevert(abi.encodeWithSelector(TestETH.CooldownActive.selector, block.timestamp + 1 days));
        _drip(ADMITTER);
        assertEq(coin.balanceOf(ALICE), 0);
    }

    /// SH-TETH-ADMITTER-4: accepting (not merely proposing) ownership revokes the role.
    function test_acceptOwnershipClearsAdmitterAndPreservesDailyUsage() public {
        _setAdmitter(ADMITTER, 2);
        vm.prank(OWNER);
        coin.transferOwnership(BOB);
        assertEq(coin.admitter(), ADMITTER);
        _admitOne(ADMITTER, ALICE);
        vm.expectEmit(true, false, false, true, address(coin));
        emit AdmitterChanged(address(0), 0);
        vm.expectEmit(true, true, false, true, address(coin));
        emit OwnershipTransferred(OWNER, BOB);
        vm.recordLogs();
        vm.prank(BOB);
        coin.acceptOwnership();
        assertEq(vm.getRecordedLogs().length, 2);
        assertEq(coin.admitter(), address(0));
        assertEq(coin.admitterPerDay(), 0);
        assertTrue(coin.admitted(ALICE));
        _expectNotAdmitter(ADMITTER, OWNER);
        _expectManagementDenied(OWNER);
        vm.prank(BOB);
        coin.setAdmitter(ADMITTER, 1);
        _expectAdmissionCap(ADMITTER, OWNER);
    }

    function test_acceptOwnershipClearsRoleWhenAdmitterIsNominatedOwner() public {
        _setAdmitter(ADMITTER, 1);
        vm.prank(OWNER);
        coin.transferOwnership(ADMITTER);
        _expectManagementDenied(ADMITTER);
        vm.prank(ADMITTER);
        coin.acceptOwnership();
        assertEq(coin.owner(), ADMITTER);
        assertEq(coin.admitter(), address(0));
        assertEq(coin.admitterPerDay(), 0);
        _expectNotAdmitter(ADMITTER, ALICE);
    }

    function test_admissionRemovalAndReadmissionPreserveCooldownAndCoins() public {
        _expectNotAdmitted(ALICE);
        vm.prank(OWNER);
        coin.admit(_one(ALICE));
        _drip(ALICE);
        uint256 next = block.timestamp + 1 days;
        vm.prank(OWNER);
        coin.remove(_one(ALICE));
        _expectNotAdmitted(ALICE); // Admission must be checked before cooldown.
        assertEq(coin.balanceOf(ALICE), 1e18);
        assertEq(coin.nextDripAt(ALICE), next);
        assertEq(coin.dailyRemaining(), 499e18);
        vm.prank(OWNER);
        coin.admit(_one(ALICE));
        vm.expectRevert(abi.encodeWithSelector(TestETH.CooldownActive.selector, next));
        _drip(ALICE);
        vm.warp(next);
        _drip(ALICE);
        vm.prank(OWNER);
        coin.remove(_one(ALICE));
        vm.warp(next + 1 days);
        _expectNotAdmitted(ALICE);
        assertEq(coin.balanceOf(ALICE), 2e18);
        assertEq(coin.totalSupply(), 1_000_002e18);
        assertEq(coin.dailyRemaining(), 500e18);
    }

    function test_openPhaseKeepsAdmissionsCooldownAndCapAccounting() public {
        vm.prank(OWNER);
        coin.admit(_one(ALICE));
        _expectNotAdmitted(BOB);
        _setOpen(true);
        _drip(BOB);
        _drip(ALICE);
        assertFalse(coin.admitted(BOB));
        assertTrue(coin.admitted(ALICE));
        _setOpen(false);
        _expectNotAdmitted(BOB);
        _setOpen(true);
        vm.expectRevert(abi.encodeWithSelector(TestETH.CooldownActive.selector, block.timestamp + 1 days));
        _drip(BOB);
        assertEq(coin.dailyRemaining(), 498e18);
        _setOpen(false);
        vm.warp(block.timestamp + 1 days);
        _expectNotAdmitted(BOB);
        _drip(ALICE);
        assertEq(coin.totalSupply(), 1_000_003e18);
    }

    function testFuzz_onlyOwnerCanManage(address caller) public {
        vm.assume(caller != OWNER);
        _expectManagementDenied(caller);
        assertFalse(coin.admitted(ALICE));
        assertFalse(coin.open());
        assertEq(coin.pendingOwner(), address(0));
        assertEq(coin.totalSupply(), 1_000_000e18);
    }

    function test_twoStepHandoverReplacementEventsAndOldOwnerLosesAuthority() public {
        vm.expectEmit(true, true, false, true, address(coin));
        emit OwnershipTransferStarted(OWNER, ALICE);
        vm.prank(OWNER);
        coin.transferOwnership(ALICE);
        assertEq(coin.owner(), OWNER);
        assertEq(coin.pendingOwner(), ALICE);
        _expectManagementDenied(ALICE);
        _expectAcceptDenied(OWNER);
        _expectAcceptDenied(BOB);
        vm.expectEmit(true, true, false, true, address(coin));
        emit OwnershipTransferStarted(OWNER, BOB);
        vm.prank(OWNER);
        coin.transferOwnership(BOB);
        _expectAcceptDenied(ALICE);
        vm.expectEmit(true, true, false, true, address(coin));
        emit OwnershipTransferred(OWNER, BOB);
        vm.prank(BOB);
        coin.acceptOwnership();
        assertEq(coin.owner(), BOB);
        assertEq(coin.pendingOwner(), address(0));
        _expectManagementDenied(OWNER);
        _expectAcceptDenied(OWNER);
        _expectAcceptDenied(BOB);
        vm.startPrank(BOB);
        coin.admit(_one(ALICE));
        assertTrue(coin.admitted(ALICE));
        coin.remove(_one(ALICE));
        assertFalse(coin.admitted(ALICE));
        coin.setOpen(true);
        assertTrue(coin.open());
        coin.transferOwnership(ALICE);
        vm.stopPrank();
        assertEq(coin.pendingOwner(), ALICE);
        assertEq(coin.balanceOf(OWNER), 1_000_000e18, "handover never moves supply");
        assertEq(coin.balanceOf(BOB), 0);
    }

    function test_zeroOwnerRejectedAndPendingHandoverUnchanged() public {
        _expectAcceptDenied(ALICE);
        vm.startPrank(OWNER);
        coin.transferOwnership(ALICE);
        vm.expectRevert(TestETH.ZeroAddress.selector);
        coin.transferOwnership(address(0));
        vm.stopPrank();
        assertEq(coin.owner(), OWNER);
        assertEq(coin.pendingOwner(), ALICE);
    }

    function test_batchLimit200And201RevertsBeforeAnyChange() public {
        address[] memory wave = new address[](201);
        for (uint160 i; i < 201; ++i) wave[i] = address(i + 1);
        vm.startPrank(OWNER);
        vm.expectRevert(TestETH.TooManyAddresses.selector);
        coin.admit(wave);
        for (uint256 i; i < 201; ++i) assertFalse(coin.admitted(wave[i]));
        address[] memory allowed = new address[](200);
        for (uint256 i; i < 200; ++i) allowed[i] = wave[i];
        vm.recordLogs();
        coin.admit(allowed);
        assertEq(vm.getRecordedLogs().length, 200);
        for (uint256 i; i < 200; ++i) assertTrue(coin.admitted(allowed[i]));
        vm.expectRevert(TestETH.TooManyAddresses.selector);
        coin.remove(wave);
        for (uint256 i; i < 200; ++i) assertTrue(coin.admitted(allowed[i]));
        vm.recordLogs();
        coin.remove(allowed);
        assertEq(vm.getRecordedLogs().length, 200);
        for (uint256 i; i < 200; ++i) assertFalse(coin.admitted(allowed[i]));
        vm.stopPrank();
    }

    function test_zeroAdmissionRevertsWholeBatch() public {
        address[] memory wave = new address[](3);
        wave[0] = ALICE;
        wave[2] = BOB;
        vm.prank(OWNER);
        vm.expectRevert(TestETH.ZeroAddress.selector);
        coin.admit(wave);
        assertFalse(coin.admitted(ALICE));
        assertFalse(coin.admitted(address(0)));
        assertFalse(coin.admitted(BOB));
        assertEq(coin.dailyRemaining(), 500e18);
    }

    function test_admissionEventsDuplicatesEmptyBatchesAndSwitchNoOps() public {
        address[] memory wave = new address[](3);
        wave[0] = ALICE;
        wave[1] = ALICE;
        wave[2] = BOB;
        vm.startPrank(OWNER);
        vm.expectEmit(true, false, false, true, address(coin));
        emit AdmissionChanged(ALICE, true);
        vm.expectEmit(true, false, false, true, address(coin));
        emit AdmissionChanged(BOB, true);
        vm.recordLogs();
        coin.admit(wave);
        assertEq(vm.getRecordedLogs().length, 2);
        vm.recordLogs();
        coin.admit(wave);
        assertEq(vm.getRecordedLogs().length, 0);
        vm.expectEmit(true, false, false, true, address(coin));
        emit AdmissionChanged(ALICE, false);
        vm.expectEmit(true, false, false, true, address(coin));
        emit AdmissionChanged(BOB, false);
        vm.recordLogs();
        coin.remove(wave);
        assertEq(vm.getRecordedLogs().length, 2);
        vm.recordLogs();
        coin.remove(wave);
        coin.remove(_one(address(0)));
        coin.admit(new address[](0));
        coin.remove(new address[](0));
        coin.setOpen(false);
        assertEq(vm.getRecordedLogs().length, 0);
        vm.stopPrank();
        _setOpen(true);
        vm.recordLogs();
        vm.prank(OWNER);
        coin.setOpen(true);
        assertEq(vm.getRecordedLogs().length, 0);
        _setOpen(false);
        assertFalse(coin.admitted(ALICE));
        assertFalse(coin.admitted(BOB));
        assertEq(coin.totalSupply(), 1_000_000e18);
        assertEq(coin.dailyRemaining(), 500e18);
    }

    function test_ownerHasNoDripBypassAndRemovalDoesNotRestrictTransfers() public {
        _expectNotAdmitted(OWNER);
        vm.prank(OWNER);
        coin.admit(_one(OWNER));
        _drip(OWNER);
        vm.expectRevert(abi.encodeWithSelector(TestETH.CooldownActive.selector, block.timestamp + 1 days));
        _drip(OWNER);
        vm.startPrank(OWNER);
        coin.transfer(ALICE, 3e18);
        coin.remove(_one(OWNER));
        vm.stopPrank();
        vm.prank(ALICE);
        coin.transfer(BOB, 1e18);
        vm.prank(ALICE);
        coin.approve(BOB, 1e18);
        vm.prank(BOB);
        coin.transferFrom(ALICE, BOB, 1e18);
        vm.prank(OWNER);
        vm.expectRevert();
        coin.transferFrom(BOB, OWNER, 1e18);
        assertEq(coin.balanceOf(BOB), 2e18);
        assertEq(coin.balanceOf(ALICE), 1e18);
        assertEq(coin.totalSupply(), 1_000_001e18);
        assertEq(coin.dailyRemaining(), 499e18);
    }

    function test_externalWriteInventoryIsExactlyERC20FaucetAndAdmissionAdministration() public view {
        string memory artifact = vm.readFile(vm.getArtifactPathByCode(type(TestETH).creationCode));
        string[11] memory expected = [
            "approve(address,uint256)", "transfer(address,uint256)", "transferFrom(address,address,uint256)",
            "drip()", "admit(address[])", "remove(address[])", "setOpen(bool)",
            "transferOwnership(address)", "acceptOwnership()", "setAdmitter(address,uint256)", "admitOne(address)"
        ];
        bool[11] memory seen;
        uint256 count;
        for (uint256 i; ; ++i) {
            string memory entry = string.concat(".abi[", vm.toString(i), "]");
            if (!vm.keyExistsJson(artifact, entry)) break;
            string memory kind = vm.parseJsonString(artifact, string.concat(entry, ".type"));
            assertTrue(keccak256(bytes(kind)) != keccak256("fallback"));
            assertTrue(keccak256(bytes(kind)) != keccak256("receive"));
            if (keccak256(bytes(kind)) != keccak256("function")) continue;
            string memory mutability = vm.parseJsonString(artifact, string.concat(entry, ".stateMutability"));
            if (keccak256(bytes(mutability)) == keccak256("view") ||
                keccak256(bytes(mutability)) == keccak256("pure")) continue;
            string memory signature = string.concat(vm.parseJsonString(artifact, string.concat(entry, ".name")), "(");
            for (uint256 j; ; ++j) {
                string memory input = string.concat(entry, ".inputs[", vm.toString(j), "]");
                if (!vm.keyExistsJson(artifact, input)) break;
                signature = string.concat(signature, j == 0 ? "" : ",", vm.parseJsonString(artifact, string.concat(input, ".type")));
            }
            signature = string.concat(signature, ")");
            bool found;
            for (uint256 j; j < expected.length; ++j) {
                if (keccak256(bytes(signature)) != keccak256(bytes(expected[j]))) continue;
                assertFalse(seen[j], "duplicate write entry");
                seen[j] = true;
                found = true;
                break;
            }
            assertTrue(found, signature);
            assertEq(mutability, "nonpayable");
            ++count;
        }
        assertEq(count, expected.length);
        for (uint256 i; i < seen.length; ++i) assertTrue(seen[i], expected[i]);
    }

    function _one(address account) private pure returns (address[] memory wave) {
        wave = new address[](1);
        wave[0] = account;
    }

    function _drip(address account) private {
        vm.prank(account);
        coin.drip();
    }

    function _expectNotAdmitted(address account) private {
        vm.prank(account);
        vm.expectRevert(TestETH.NotAdmitted.selector);
        coin.drip();
    }

    function _expectAcceptDenied(address account) private {
        vm.prank(account);
        vm.expectRevert(TestETH.NotPendingOwner.selector);
        coin.acceptOwnership();
    }

    function _expectManagementDenied(address account) private {
        vm.startPrank(account);
        vm.expectRevert(TestETH.NotOwner.selector);
        coin.admit(_one(ALICE));
        vm.expectRevert(TestETH.NotOwner.selector);
        coin.remove(_one(ALICE));
        vm.expectRevert(TestETH.NotOwner.selector);
        coin.setOpen(true);
        vm.expectRevert(TestETH.NotOwner.selector);
        coin.transferOwnership(ALICE);
        vm.expectRevert(TestETH.NotOwner.selector);
        coin.setAdmitter(account, 50);
        vm.stopPrank();
    }

    function _setAdmitter(address account, uint256 perDay) private {
        vm.expectEmit(true, false, false, true, address(coin));
        emit AdmitterChanged(account, perDay);
        vm.recordLogs();
        vm.prank(OWNER);
        coin.setAdmitter(account, perDay);
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(coin.admitter(), account);
        assertEq(coin.admitterPerDay(), perDay);
    }

    function _admitOne(address caller, address account) private {
        vm.prank(caller);
        coin.admitOne(account);
    }

    function _expectNotAdmitter(address caller, address account) private {
        vm.expectRevert(TestETH.NotAdmitter.selector);
        _admitOne(caller, account);
    }

    function _expectAdmissionCap(address caller, address account) private {
        vm.expectRevert(TestETH.AdmitterDailyCapReached.selector);
        _admitOne(caller, account);
        assertFalse(coin.admitted(account));
    }

    function _setOpen(bool value) private {
        vm.expectEmit(false, false, false, true, address(coin));
        emit OpenChanged(value);
        vm.recordLogs();
        vm.prank(OWNER);
        coin.setOpen(value);
        assertEq(vm.getRecordedLogs().length, 1);
        assertEq(coin.open(), value);
    }
}
