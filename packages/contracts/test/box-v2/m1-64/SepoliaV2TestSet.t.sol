// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {SepoliaTestToken, SepoliaTestCollection} from "../../../script/sepolia-v2/SepoliaV2TestSet.sol";

interface IRehearsalToken {
    function decimals() external view returns (uint8);
    function mint(address, uint256) external;
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

contract SepoliaTestAssetsTest is Test {
    function test_shopStockHasOnlyOwnerMintAndNormalCustodyTransfers() public {
        SepoliaTestCollection stock = new SepoliaTestCollection(address(this));
        stock.mint(address(this), 0);
        stock.transferFrom(address(this), address(0xB0B), 0);
        assertEq(stock.ownerOf(0), address(0xB0B));
        vm.prank(address(0xB0B));
        vm.expectRevert();
        stock.mint(address(0xB0B), 1);
    }

    function test_testAssetsHaveExactSixEightEighteenDecimalMovementAndOwnerMinting() public {
        for (uint8 d = 6; d <= 18; d = d == 6 ? 8 : d == 8 ? 18 : 19) {
            IRehearsalToken t = IRehearsalToken(
                deployCode("SepoliaV2TestSet.sol:SepoliaTestToken", abi.encode("Test", "TEST", d, address(this)))
            );
            assertEq(t.decimals(), d);
            uint256 amount = 123 * 10 ** d;
            t.mint(address(this), amount);
            t.approve(address(0xA11CE), amount);
            vm.prank(address(0xA11CE));
            t.transferFrom(address(this), address(0xB0B), amount);
            assertEq(t.balanceOf(address(this)), 0);
            assertEq(t.balanceOf(address(0xB0B)), amount);
            vm.prank(address(0xB0B));
            vm.expectRevert();
            t.mint(address(0xB0B), 1);
        }
    }
}
