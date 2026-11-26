// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TestETH} from "../../../src/test-coins/TestETH.sol";
import {ListingRegistry, ListingRaises} from "../../../src/box-v2/ListingRegistry.sol";
import {ListingClass, ListingRecord} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {ListingChecks} from "../../../src/box-v2/libraries/ListingChecks.sol";

contract TestETHEmptyBoxRegistry {
    function boxIdOf(address) external pure returns (bool, uint256) { return (false, 0); }
}

/// SH-ALPHA-TETH-1/4: all balances and times are exercised offline against the real coin and listing probe.
contract TestETHTest is Test {
    address private constant RECIPIENT = address(0xF030);
    address private constant ALICE = address(0xA11CE);
    TestETH private coin;

    event Drip(address indexed recipient, uint256 amount);

    function setUp() public {
        vm.chainId(31337);
        vm.warp(10 days + 12 hours);
        coin = new TestETH(RECIPIENT);
    }

    function test_unadmittedCannotDrip() public {
        vm.expectRevert(abi.encodeWithSignature("NotAdmitted()"));
        _drip(ALICE);
    }

    /// SH-TETH-ADMITTER-5: compare the actual drip call with cold storage on both sides of the change.
    function test_dripGasAndCodeEvidence() public {
        _admit(ALICE);
        _admit(address(0xB0B));
        vm.cool(address(coin));
        _drip(ALICE);
        emit log_named_uint("drip first of day", vm.lastCallGas().gasTotalUsed);
        vm.cool(address(coin));
        _drip(address(0xB0B));
        emit log_named_uint("drip later same day", vm.lastCallGas().gasTotalUsed);
        vm.warp(block.timestamp + 1 days);
        vm.cool(address(coin));
        _drip(ALICE);
        emit log_named_uint("drip returning next day", vm.lastCallGas().gasTotalUsed);
        assertEq(coin.balanceOf(ALICE), 2e18);
        assertEq(coin.balanceOf(address(0xB0B)), 1e18);
        assertEq(coin.totalSupply(), 1_000_003e18);
        assertEq(coin.dailyRemaining(), 499e18);
        emit log_named_uint("runtime bytes", address(coin).code.length);
        emit log_named_bytes32("runtime code hash", address(coin).codehash);
    }

    function test_initialSupplyMetadataAndLimits() public view {
        assertEq(coin.name(), "Test ETH");
        assertEq(coin.symbol(), "tETH");
        assertEq(coin.decimals(), 18);
        assertEq(coin.totalSupply(), 1_000_000e18);
        assertEq(coin.balanceOf(RECIPIENT), 1_000_000e18);
        assertEq(coin.balanceOf(address(this)), 0);
        assertEq(coin.DRIP_AMOUNT(), 1e18);
        assertEq(coin.COOLDOWN(), 1 days);
        assertEq(coin.DAILY_CAP(), 500e18);
        assertEq(coin.nextDripAt(ALICE), 0);
        assertEq(coin.dailyRemaining(), 500e18);
    }

    function test_firstDripEmitsAndViewsMatchExactCooldownBoundary() public {
        _admit(ALICE);
        uint256 start = block.timestamp;
        vm.expectEmit(true, false, false, true, address(coin));
        emit Drip(ALICE, 1e18);
        _drip(ALICE);
        assertEq(coin.balanceOf(ALICE), 1e18);
        assertEq(coin.totalSupply(), 1_000_001e18);
        assertEq(coin.nextDripAt(ALICE), start + 1 days);
        assertEq(coin.dailyRemaining(), 499e18);

        _expectCooldown(ALICE, start + 1 days);
        vm.warp(start + 1 days - 1);
        _expectCooldown(ALICE, start + 1 days);
        assertEq(coin.nextDripAt(ALICE), start + 1 days);
        assertEq(coin.dailyRemaining(), 500e18);
        vm.warp(start + 1 days);
        _drip(ALICE);
        assertEq(coin.balanceOf(ALICE), 2e18);
        assertEq(coin.totalSupply(), 1_000_002e18);
        assertEq(coin.nextDripAt(ALICE), start + 2 days);
        assertEq(coin.dailyRemaining(), 499e18);
    }

    function test_timestampZeroDoesNotBypassCooldown() public {
        _admit(ALICE);
        vm.warp(0);
        _drip(ALICE);
        assertEq(coin.nextDripAt(ALICE), 1 days);
        _expectCooldown(ALICE, 1 days);
        assertEq(coin.dailyRemaining(), 499e18);
    }

    function test_dailyCapAcross500AddressesAndResetAtUtcMidnight() public {
        _dailyCapAcross500AddressesAndResetAtUtcMidnight(false);
    }

    function test_dailyCapAlsoAppliesInOpenPhase() public {
        _dailyCapAcross500AddressesAndResetAtUtcMidnight(true);
    }

    function _dailyCapAcross500AddressesAndResetAtUtcMidnight(bool openPhase) private {
        if (openPhase) {
            vm.prank(RECIPIENT);
            coin.setOpen(true);
        } else {
            for (uint160 first = 1; first <= 500; first += 200) {
                uint256 count = first == 401 ? 100 : 200;
                address[] memory wave = new address[](count);
                for (uint160 j; j < count; ++j) wave[j] = address(first + j);
                vm.prank(RECIPIENT);
                coin.admit(wave);
            }
            _admit(ALICE);
            _admit(RECIPIENT);
        }
        uint256 nextDay = (block.timestamp / 1 days + 1) * 1 days;
        for (uint160 i = 1; i <= 500; ++i) {
            assertEq(coin.dailyRemaining(), (501 - uint256(i)) * 1e18);
            _drip(address(i));
            assertEq(coin.balanceOf(address(i)), 1e18);
        }
        assertEq(coin.totalSupply(), 1_000_500e18);
        assertEq(coin.dailyRemaining(), 0);
        _expectCap(ALICE);
        _expectCap(RECIPIENT);
        assertEq(coin.nextDripAt(ALICE), 0, "failed attempt does not start cooldown");
        assertEq(coin.balanceOf(ALICE), 0);
        assertEq(coin.totalSupply(), 1_000_500e18);
        vm.warp(nextDay - 1);
        _expectCap(ALICE);
        vm.warp(nextDay);
        assertEq(coin.dailyRemaining(), 500e18, "view resets before the first new-day transaction");
        _expectCooldown(address(1), nextDay + 12 hours);
        assertEq(coin.dailyRemaining(), 500e18);
        _drip(ALICE);
        assertEq(coin.totalSupply(), 1_000_501e18);
        assertEq(coin.dailyRemaining(), 499e18);
        assertEq(coin.nextDripAt(ALICE), nextDay + 1 days);
    }

    function testFuzz_cooldownTracksLastSuccessfulDrip(uint32 start, uint32 elapsed) public {
        _admit(ALICE);
        vm.warp(start);
        _drip(ALICE);
        vm.warp(uint256(start) + elapsed);
        if (elapsed < 1 days) {
            _expectCooldown(ALICE, uint256(start) + 1 days);
            assertEq(coin.totalSupply(), 1_000_001e18);
        } else {
            _drip(ALICE);
            assertEq(coin.nextDripAt(ALICE), uint256(start) + elapsed + 1 days);
            assertEq(coin.totalSupply(), 1_000_002e18);
        }
    }

    function test_transfersAndApprovalsDoNotChangeSupplyOrFaucetAccounting() public {
        _admit(ALICE);
        _admit(RECIPIENT);
        _drip(ALICE);
        vm.prank(ALICE);
        coin.transfer(RECIPIENT, 0.4e18);
        vm.prank(RECIPIENT);
        coin.approve(ALICE, 10e18);
        vm.prank(ALICE);
        coin.transferFrom(RECIPIENT, ALICE, 10e18);
        assertEq(coin.totalSupply(), 1_000_001e18);
        assertEq(coin.balanceOf(ALICE) + coin.balanceOf(RECIPIENT), coin.totalSupply());
        assertEq(coin.dailyRemaining(), 499e18);
        _expectCooldown(ALICE, block.timestamp + 1 days);
        _drip(RECIPIENT);
        assertEq(coin.totalSupply(), 1_000_002e18);
    }

    function test_noAdminMintBurnFreezePauseOrUpgradeFunctions() public {
        bytes[8] memory calls = [
            abi.encodeWithSignature("pause()"),
            abi.encodeWithSignature("unpause()"),
            abi.encodeWithSignature("freeze(address)", ALICE),
            abi.encodeWithSignature("mint(address,uint256)", ALICE, 1e18),
            abi.encodeWithSignature("burn(uint256)", 1e18),
            abi.encodeWithSignature("burnFrom(address,uint256)", RECIPIENT, 1e18),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", ALICE, bytes("")),
            abi.encodeWithSignature("addBlackList(address)", ALICE)
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.prank(RECIPIENT);
            (bool ok,) = address(coin).call(calls[i]);
            assertFalse(ok, "owner has no additional privileged entry point");
        }
        assertEq(coin.totalSupply(), 1_000_000e18);
        assertEq(coin.dailyRemaining(), 500e18);
    }

    function test_constructorOnlyAllowsSepoliaAndLocalAndRequiresRecipient() public {
        vm.chainId(1);
        vm.expectRevert("testnet only");
        new TestETH(RECIPIENT);
        vm.chainId(10);
        vm.expectRevert("testnet only");
        new TestETH(RECIPIENT);
        vm.chainId(11155111);
        TestETH sepolia = new TestETH(RECIPIENT);
        assertEq(sepolia.totalSupply(), 1_000_000e18);
        vm.expectRevert("recipient and supply");
        new TestETH(address(0));
    }

    function test_listingOtherOneETHWithRealTransferProbe() public {
        address safe = address(0x5AFE);
        address manager = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        ListingRegistry registry = ListingRegistry(deployCode("ListingRegistry.sol:ListingRegistry",
            abi.encode(safe, address(new TestETHEmptyBoxRegistry()), manager, address(0x777))));
        vm.prank(RECIPIENT);
        coin.transfer(safe, 10_000);
        vm.startPrank(safe);
        vm.expectRevert(abi.encodeWithSelector(ListingChecks.ProbeUnfunded.selector, address(coin), safe, 10_000));
        registry.add(address(coin), ListingClass.OTHER, 1e18);
        coin.approve(address(registry), 10_000);
        uint32 id = registry.add(address(coin), ListingClass.OTHER, 1e18);
        assertEq(coin.allowance(safe, address(registry)), 10_000, "probe reverts its allowance use");
        coin.approve(address(registry), 0);
        vm.stopPrank();
        ListingRecord memory row = registry.listing(id);
        assertEq(row.token, address(coin));
        assertEq(uint256(row.class), uint256(ListingClass.OTHER));
        assertEq(row.decimals, 18);
        assertEq(row.raise, 1e18);
        assertEq(abi.encode(row.q), abi.encode(ListingRaises.parameters(1e18)));
        assertEq(registry.listingCount(), 2);
        assertEq(coin.balanceOf(safe), 10_000);
        assertEq(coin.balanceOf(address(registry)), 0);
        assertEq(coin.balanceOf(manager), 0);
        assertEq(coin.allowance(safe, address(registry)), 0);
        assertEq(coin.totalSupply(), 1_000_000e18);
        assertEq(coin.dailyRemaining(), 500e18);
    }

    function _drip(address caller) private {
        vm.prank(caller);
        coin.drip();
    }

    function _admit(address account) private {
        address[] memory wave = new address[](1);
        wave[0] = account;
        vm.prank(RECIPIENT);
        coin.admit(wave);
    }

    function _expectCooldown(address caller, uint256 next) private {
        vm.expectRevert(abi.encodeWithSelector(TestETH.CooldownActive.selector, next));
        _drip(caller);
    }

    function _expectCap(address caller) private {
        vm.expectRevert(TestETH.DailyCapReached.selector);
        _drip(caller);
    }
}
