// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {DeploySepoliaV2TestSet} from "../../../script/sepolia-v2/DeploySepoliaV2TestSet.s.sol";
import {TestCoin, TestGold, TestFrog} from "../../../src/test-coins/TestCoins.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";

contract TestSetEmptyRegistry {
    function boxIdOf(address) external pure returns (bool, uint256) { return (false, 0); }
}

contract TestSetCoinsTest is Test {
    address private constant FOUNDER = address(0xF030);
    address[6] private coins;

    function setUp() public {
        vm.chainId(31337);
        vm.setEnv("CORE_V2_DEPLOYER", vm.toString(FOUNDER));
        vm.setEnv("TEST_COIN_RECIPIENT", vm.toString(FOUNDER));
        vm.setEnv("CORE_V2_BROADCAST", "false");
        coins = new DeploySepoliaV2TestSet().runTestCoins();
    }

    function test_TA30_namesDecimalsAndFounderIssuance() public view {
        string[6] memory names = ["Test LINK", "Test USDC", "Test NVDA", "Test Gold", "Test PEPE", "Test Frog"];
        string[6] memory symbols = ["tLINK", "tUSDC", "tNVDA", "tGOLD", "tPEPE", "tFROG"];
        for (uint256 i; i < 6; ++i) {
            TestCoin coin = TestCoin(coins[i]);
            uint8 decimals = i == 1 ? 6 : 18;
            uint256 supply = (i >= 4 ? 1_000_000_000 : 1_000_000) * 10 ** uint256(decimals);
            assertEq(coin.name(), names[i]);
            assertEq(coin.symbol(), symbols[i]);
            assertEq(coin.decimals(), decimals);
            assertEq(coin.totalSupply(), supply);
            assertEq(coin.balanceOf(FOUNDER), supply);
            assertEq(coin.balanceOf(address(this)), 0);
        }
        assertEq(TestGold(coins[3]).owner(), FOUNDER);
    }

    function test_TA30_goldPauseFreezeAndAuthorization() public {
        TestGold gold = TestGold(coins[3]);
        vm.expectRevert(); gold.pause();
        vm.expectRevert(); gold.freeze(FOUNDER);
        vm.startPrank(FOUNDER);
        gold.approve(address(this), 100);
        gold.pause();
        vm.expectRevert(); gold.transfer(address(this), 1);
        vm.expectRevert(); gold.approve(address(this), 1);
        gold.unpause();
        gold.freeze(address(this));
        vm.expectRevert(); gold.transfer(address(this), 1);
        vm.expectRevert(); gold.approve(address(this), 1);
        vm.stopPrank();
        vm.expectRevert(); gold.transferFrom(FOUNDER, address(0x123), 1);
        vm.startPrank(FOUNDER);
        gold.unfreeze(address(this));
        gold.transfer(address(this), 10);
        gold.freeze(FOUNDER);
        vm.expectRevert(); gold.transfer(address(this), 1);
        gold.unfreeze(FOUNDER);
        vm.stopPrank();
        assertEq(gold.balanceOf(address(this)), 10);
    }

    function testFuzz_TA30_frogBurnReducesOnlyCallerAndSupply(uint256 amount) public {
        TestFrog frog = TestFrog(coins[5]);
        uint256 supply = frog.totalSupply();
        amount = bound(amount, 0, supply);
        vm.expectRevert(); frog.burn(1);
        vm.prank(FOUNDER); frog.burn(amount);
        assertEq(frog.balanceOf(FOUNDER), supply - amount);
        assertEq(frog.totalSupply(), supply - amount);
        vm.prank(FOUNDER); vm.expectRevert(); frog.burn(supply - amount + 1);
        assertEq(frog.totalSupply(), supply - amount);
    }

    function test_TA30_allListingProbesAndCheckedFrogBurnRollBack() public {
        address manager = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        ListingRegistry registry = ListingRegistry(deployCode("ListingRegistry.sol:ListingRegistry",
            abi.encode(FOUNDER, address(new TestSetEmptyRegistry()), manager, address(0x777))));
        vm.startPrank(FOUNDER);
        for (uint256 i; i < 6; ++i) {
            TestCoin coin = TestCoin(coins[i]);
            uint256 supply = coin.totalSupply();
            coin.approve(address(registry), 10_000);
            ListingClass class_ = i == 1 ? ListingClass.STABLE : i == 2 ? ListingClass.STOCK : ListingClass.OTHER;
            uint256 raise = i == 1 ? 100e6 : i == 3 ? 1e18 : i >= 4 ? 100_000e18 : 100e18;
            if (i == 5) registry.addWithBurn(coins[i], class_, raise, TestFrog.burn.selector);
            else registry.add(coins[i], class_, raise);
            assertEq(coin.balanceOf(FOUNDER), supply);
            assertEq(coin.totalSupply(), supply);
            assertEq(coin.balanceOf(address(registry)), 0);
            assertEq(coin.balanceOf(manager), 0);
            assertEq(coin.allowance(FOUNDER, address(registry)), 10_000);
            coin.approve(address(registry), 0);
            assertEq(coin.allowance(FOUNDER, address(registry)), 0);
        }
        vm.stopPrank();
        assertEq(registry.checkedBurnSelector(coins[5]), TestFrog.burn.selector);
        assertEq(registry.listingCount(), 7);
    }

    function test_TA30_refusesMainnetAndZeroRecipient() public {
        vm.chainId(1);
        vm.expectRevert(); new TestFrog(FOUNDER, 1);
        DeploySepoliaV2TestSet script = new DeploySepoliaV2TestSet();
        vm.expectRevert(); script.runTestCoins();
        vm.chainId(31337);
        vm.expectRevert(); new TestFrog(address(0), 1);
    }

    function test_TA30_supplyOverrideAndMeasuredDeploymentGas() public {
        vm.setEnv("TEST_USDC_SUPPLY_RAW", "9007199254740993");
        vm.recordLogs();
        address[6] memory issued = new DeploySepoliaV2TestSet().runTestCoins();
        assertEq(TestCoin(issued[1]).balanceOf(FOUNDER), 9007199254740993);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("TestDeploymentGas(string,uint256,uint256)")) continue;
            (string memory label, uint256 total, uint256 state) = abi.decode(logs[i].data, (string, uint256, uint256));
            assertGt(total, 21_000);
            assertLe(total * 130 / 100, 16_777_216);
            assertLe(state, total);
            emit log_named_uint(label, total);
            ++count;
        }
        assertEq(count, 6);
        vm.setEnv("TEST_USDC_SUPPLY_RAW", "1000000000000");
    }
}
