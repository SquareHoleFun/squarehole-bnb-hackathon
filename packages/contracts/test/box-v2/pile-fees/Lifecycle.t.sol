// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {ChunkPart} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";

// Additive local shape for the red-first test; legacy interfaces stay callable.
interface PileFeesReceiver {
    function pilePendingP() external view returns (uint256);
    function pileMovedP() external view returns (uint256);
    function moveToPile() external returns (uint256);
}
interface PilePreset { function leaveBehindBps() external view returns (uint256); }

contract PileFeesLifecycleTest is M363Base {
    function _hoard(bool sellers, uint16 leave) internal view returns (BoxSpec memory s) {
        s = _pile(address(0), 0);
        s.contentsParams = abi.encode(address(0), uint256(0), leave);
        if (sellers) s.sellers.a = Branch(1, 7, "", "");
        else s.buyers.a = Branch(1, 7, "", "");
    }
    function test_PF01_eachSideBooksPendingUntilPermissionlessGraduatedMove() public {
        for (uint256 side; side < 2; ++side) {
            _start(_hoard(side == 1, 500));
            PileFeesReceiver r = PileFeesReceiver(address(receiver));
            _buy(box.raise() / 10);
            if (side == 1) buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 4, layout.sqrtPriceStartX96);
            receiver.collect(address(0));
            uint256 pending = r.pilePendingP();
            if (side == 1) assertEq(pending, 0); else assertGt(pending, 0);
            assertEq(box.vault().balance, 0);
            vm.expectRevert(); r.moveToPile();
            _fill(); box.graduate(); receiver.collect(address(0));
            if (side == 1) {
                buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 4, layout.sqrtPriceStartX96);
                _sellFeeP(); receiver.collect(address(0));
            }
            pending = r.pilePendingP(); assertGt(pending, 0);
            assertEq(box.vault().balance, 0, "graduation does not push fees");
            vm.prank(address(0xBEEF)); assertEq(r.moveToPile(), pending);
            assertEq(box.vault().balance, pending); assertEq(r.pileMovedP(), pending);
            assertEq(r.pilePendingP(), 0); assertEq(r.moveToPile(), 0); _booked();
            IPileVaultV2 p = IPileVaultV2(payable(box.vault()));
            assertEq(PilePreset(address(p)).leaveBehindBps(), 500);
            uint256 burn = token.balanceOf(address(buyer)) / 2;
            uint256 expected = (pending * burn / token.totalSupply()) * 9500 / 10000;
            assertEq(p.quoteRedeem(burn), expected);
            vm.startPrank(address(buyer)); token.approve(address(p), burn);
            assertEq(p.redeem(burn, expected, address(buyer)), expected); vm.stopPrank();
            assertEq(box.vault().balance, pending - expected);
        }
    }
    function test_PF02_failurePendingJoinsPotSeedReturnsSeparately() public {
        BoxSpec memory s = _hoard(false, 500);
        s.contentsParams = abi.encode(address(0), uint256(1 ether), uint16(500));
        box = _create(s);
        BoxFactoryV2Parts.Box memory encoding;
        (, bytes memory texts) = planner.parts().partArgs(encoding, s);
        if (texts.length != 0) box.loadChunk(ChunkPart.Texts, texts, 0);
        token = BoxTokenV2(box.token()); hook = IBoxHookV2(box.hook()); receiver = IBoxReceiverV2(box.receiver());
        layout = BoxLayoutV2.curve(s.raise, false); buyer = new PoolDriver(pm);
        vm.deal(address(buyer), 100 ether);
        IPileVaultV2 pile = IPileVaultV2(payable(box.vault()));
        vm.prank(CREATOR); pile.loadSeed{value: 1 ether}();
        vm.warp(box.effectiveOpenAt() + 385);
        _buy(box.raise() / 10); receiver.collect(address(0));
        PileFeesReceiver r = PileFeesReceiver(address(receiver));
        assertGt(r.pilePendingP(), 0);
        vm.warp(box.deadline()); box.fail();
        assertEq(r.pilePendingP(), 0); assertEq(r.pileMovedP(), 0);
        assertEq(box.vault().balance, 1 ether);
        vm.expectRevert(); r.moveToPile();
        assertEq(IPileVaultV2(payable(box.vault())).returnSeed(), 1 ether);
        assertEq(box.vault().balance, 0); assertGt(_claimBuyer(), 0);
    }
}
