// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M360Measure} from "./Measure.sol";
import {BoxSpec} from "../../../../src/box-v2/interfaces/SpecTypes.sol";
import {PileVaultV2} from "../../../../src/box-v2/PileVaultV2.sol";
import {BoxTokenV2} from "../../../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {ListingClass} from "../../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxLayoutV2} from "../../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {PoolDriver} from "../../kit/BoxV2TestBase.sol";
import {HostileToken} from "../../kit/HostileToken.sol";

contract M360PilesTest is M360Measure {
    function test_nativeSeedRedemptionAndReturn() public {
        _pileLife(0, false);
    }

    function test_sixDecimalSeedRedemptionAndReturn() public {
        _pileLife(6, false);
    }

    function test_eightDecimalSeedRedemptionAndReturn() public {
        _pileLife(8, false);
    }

    function test_eighteenDecimalSeedRedemptionAndReturn() public {
        _pileLife(18, false);
    }

    function test_nativePileWithHolderToken() public {
        _pileLife(0, true);
    }

    function test_erc20PileWithHolderToken() public {
        _pileLife(18, true);
    }

    function _pileLife(uint8 decimals, bool holders) private {
        HostileToken asset;
        uint256 seed = 3 ether;
        if (decimals != 0) {
            asset = new HostileToken("Seed", "SEED", decimals);
            asset.mint(address(this), 10000);
            asset.approve(address(listings), 10000);
            listings.add(address(asset), ListingClass.OTHER, 10 ** uint256(decimals));
            seed = 3 * 10 ** uint256(decimals);
            asset.mint(CREATOR, seed);
        }
        BoxSpec memory s = _pile(address(asset), seed);
        if (holders) {
            s.buyers.a.leg = 1;
            s.buyers.a.dest = 6;
            s.buyers.a.destParams = abi.encode(uint8(1));
            s.sellers = s.buyers;
        }
        box = _create(s);
        PileVaultV2 pile = PileVaultV2(payable(box.vault()));
        assertFalse(box.gateOpen());
        if (decimals == 0) {
            _measureValue(
                "native seed and completion",
                address(pile),
                CREATOR,
                abi.encodeCall(PileVaultV2.loadSeed, ()),
                seed,
                2_000_000
            );
        } else {
            vm.prank(CREATOR);
            asset.approve(address(pile), seed);
            vm.cool(address(asset));
            _measure(
                "ERC20 seed and completion", address(pile), BOB, abi.encodeCall(PileVaultV2.loadSeed, ()), 2_000_000
            );
        }
        assertTrue(box.gateOpen());
        token = BoxTokenV2(box.token());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        layout = BoxLayoutV2.curve(s.raise, false);
        buyer = new PoolDriver(pm);
        vm.deal(address(buyer), 10 * s.raise);
        vm.warp(box.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
        _buy(s.raise / 5);
        uint256 snapshot = vm.snapshotState();
        _fill();
        box.graduate();
        uint256 held = token.balanceOf(address(buyer));
        vm.prank(address(buyer));
        token.approve(address(pile), held);
        uint256 supply = token.totalSupply();
        uint256 quote = pile.quoteRedeem(held / 2);
        if (decimals != 0) vm.cool(address(asset));
        (bytes memory ret,) = _measure(
            "pile redemption to fresh recipient",
            address(pile),
            address(buyer),
            abi.encodeCall(PileVaultV2.redeem, (held / 2, quote, BOB)),
            5_000_000
        );
        assertEq(abi.decode(ret, (uint256)), quote);
        assertEq(token.totalSupply(), supply - held / 2);
        assertEq(decimals == 0 ? address(pile).balance : asset.balanceOf(address(pile)), seed - quote);
        assertEq(decimals == 0 ? BOB.balance : asset.balanceOf(BOB), quote);
        assertTrue(vm.revertToState(snapshot));
        if (decimals != 0) asset.setPaused(true);
        vm.warp(box.deadline());
        _measure(
            "seeded pile deadline failure", address(box), BOB, abi.encodeCall(IBoxCoordinatorV2.fail, ()), 15_000_000
        );
        uint256 owed = _claimBuyer();
        assertGt(owed, 0);
        if (decimals != 0) {
            vm.expectRevert();
            pile.returnSeed();
            assertEq(asset.balanceOf(address(pile)), seed);
            asset.setPaused(false);
            vm.cool(address(asset));
        }
        uint256 before = decimals == 0 ? CREATOR.balance : asset.balanceOf(CREATOR);
        (ret,) =
            _measure("failed seed return", address(pile), BOB, abi.encodeCall(PileVaultV2.returnSeed, ()), 2_000_000);
        assertEq(abi.decode(ret, (uint256)), seed);
        assertEq((decimals == 0 ? CREATOR.balance : asset.balanceOf(CREATOR)) - before, seed);
    }
}
