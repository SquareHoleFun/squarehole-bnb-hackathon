// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IPileVaultV2, PileVaultV2, PileCoordinatorFixture, HostileToken} from "./PileVault.t.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {FreezeRules, FailureModel, BoxType} from "../m3-00/FreezeRules.sol";

/// @dev M3-00 reference stands in ONLY for the unowned M3-40 pile-H branch/claim arithmetic.
/// Pile and token/PM custody are real; reference claim counters do not move actual P or burn T.
contract PileSurplusTest is Test {
    address private constant ALICE = address(0xA11CE);
    IPileVaultV2 private pile;
    PileCoordinatorFixture private coordinator;
    HostileToken private asset;
    HostileToken private token;
    IPoolManager private pm;

    function setUp() public {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        asset = new HostileToken("Seed", "S", 6); token = new HostileToken("T", "T", 18);
        _pile(address(asset));
        asset.mint(address(this), 1000); asset.approve(address(pile), 1000); token.mint(ALICE, 100);
    }
    function _pile(address a) private {
        address ci = address(new PileCoordinatorFixture());
        coordinator = PileCoordinatorFixture(BoxClones.create(BoxClones.initCode(ci, "")));
        pile = IPileVaultV2(BoxClones.create(BoxClones.initCode(address(new PileVaultV2(ci)),
            abi.encodePacked(address(coordinator), address(token), a, address(this), uint256(1000)))));
        coordinator.configure(address(token), address(pile), a, true); coordinator.initialize();
    }
    function test_R43_M3D_liveFixedGiftsRedeemButOtherAssetsHaveNoExit() public {
        pile.loadSeed(); coordinator.graduate(); asset.mint(address(pile), 13);
        HostileToken unrelated = new HostileToken("Other", "O", 8); unrelated.mint(address(pile), 17);
        vm.deal(address(pile), 19); // Forced native custody, not an admitted load/top-up.
        assertEq(pile.quoteRedeem(100), 1013);
        vm.startPrank(ALICE); token.approve(address(pile), 100);
        assertEq(pile.redeem(100, 1013, ALICE), 1013); vm.stopPrank();
        assertEq(asset.balanceOf(ALICE), 1013); assertEq(asset.balanceOf(address(pile)), 0);
        assertEq(token.totalSupply(), 0); _noExit(address(unrelated));
        assertEq(unrelated.balanceOf(address(pile)), 17); assertEq(address(pile).balance, 19);
    }
    function test_R11_failedSurplusAndExcludedLiquidAndClaimsTStayQuarantined() public {
        pile.loadSeed(); asset.mint(address(pile), 13);
        PoolDriver driver = new PoolDriver(pm);
        vm.startPrank(ALICE); token.transfer(address(pile), 20); token.transfer(address(driver), 10); vm.stopPrank();
        driver.mintClaims(Currency.wrap(address(token)), address(pile), 10);
        FreezeRules rules = new FreezeRules();
        uint256 left = rules.outstanding(BoxType.PILE, token.totalSupply(), 0,
            token.balanceOf(address(pile)), pm.balanceOf(address(pile), uint256(uint160(address(token)))), 0, 0, 0);
        assertEq(left, 70); assertEq(left, token.balanceOf(ALICE));
        FailureModel pot = new FailureModel(1201, 0, 0, left, 1);
        asset.setPaused(true); coordinator.fail(); vm.expectRevert(); pile.returnSeed();
        assertEq(pot.claim(30), 514); assertEq(pot.tLeft(), 40);
        asset.setPaused(false); assertEq(pile.returnSeed(), 1000);
        assertEq(pot.pot(), 687); assertEq(pot.tLeft(), 40);
        assertEq(pot.claim(40), 687); assertEq(pot.pot(), 0); assertEq(pot.tLeft(), 0);
        assertEq(token.balanceOf(address(pile)), 20);
        assertEq(pm.balanceOf(address(pile), uint256(uint160(address(token)))), 10);
        assertEq(token.totalSupply(), 100);
        assertEq(asset.balanceOf(address(this)), 1000); assertEq(asset.balanceOf(address(pile)), 13);
        _noExit(address(token)); _noExit(address(asset));
        vm.expectRevert(); pile.returnSeed(); vm.expectRevert(); pile.redeem(1, 0, ALICE);
        token.mint(address(pile), 9); assertEq(pot.tLeft(), 0);
    }
    function test_R43_M3D_unloadedGiftsAreNotARecordedSeedReturn() public {
        asset.mint(address(pile), 1000); coordinator.fail();
        assertEq(pile.returnSeed(), 0); assertEq(asset.balanceOf(address(pile)), 1000);
        assertEq(asset.balanceOf(address(this)), 1000); assertEq(asset.allowance(address(this), address(pile)), 1000);
        _noExit(address(asset));
    }
    function test_R43_M3D_failedNativeOnlyRecordedSeedReturns() public {
        _pile(address(0)); vm.deal(address(this), 1000); pile.loadSeed{value: 1000}();
        vm.deal(address(pile), 1013); coordinator.fail();
        assertEq(pile.returnSeed(), 1000); assertEq(address(this).balance, 1000); assertEq(address(pile).balance, 13);
        _noExit(address(0)); vm.expectRevert(); pile.returnSeed();
    }
    function _noExit(address a) private {
        bytes[5] memory attempts = [abi.encodeWithSignature("rescue(address,address,uint256)", a, ALICE, 1),
            abi.encodeWithSignature("approve(address,uint256)", ALICE, 1),
            abi.encodeWithSignature("claim(uint256,address)", 1, ALICE),
            abi.encodeWithSignature("sweep()"), abi.encodeWithSignature("fundBudget()")];
        for (uint256 i; i < attempts.length; ++i) {
            (bool ok,) = address(pile).call(attempts[i]); assertFalse(ok);
        }
    }
    receive() external payable {}
}
