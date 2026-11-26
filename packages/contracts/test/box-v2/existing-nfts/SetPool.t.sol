// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetPoolFixture, SetStandardERC721, SetSpecV2, HostileToken} from "./SetPoolFixture.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";
import {SetVaultV2} from "../../../src/box-v2/set/SetVaultV2.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IBoxCoordinator} from "../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxReceiverItemsV2, FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ProtocolSkip} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";

contract SetPoolTest is SetPoolFixture {
    function test_E07_nativeLoadOpenFundFillGraduatePickReturn() public {
        _lifecycle(false);
    }

    function test_E07_erc20LoadOpenFundFillGraduatePickReturn() public {
        _lifecycle(true);
    }

    function _lifecycle(bool erc20) private {
        SetStandardERC721 art = new SetStandardERC721();
        for (uint256 i; i < 33; ++i) {
            art.mint(CREATOR, _id(i));
        }
        (SetSpecV2 memory s, bytes32[] memory suffix) = _terms(address(art), 33);
        if (erc20) {
            (SetSpecV2 memory priced,) = _pricing();
            s.pricing = priced.pricing;
            s.raise = priced.raise;
        }
        _start(s);
        _noPayouts();
        vm.expectRevert(IBoxVaultV2.GateClosed.selector);
        vault.quoteWithdraw(1);
        _page(0, 32, suffix[32]);
        assertFalse(box.gateOpen());
        vm.expectRevert();
        loader.complete();
        _page(32, 1, 0);
        assertFalse(box.gateOpen(), "final page alone cannot open");
        loader.complete();
        assertTrue(box.gateOpen());
        assertFalse(vault.gateOpen());
        vm.warp(box.effectiveOpenAt());
        vm.roll(block.number + 1);
        uint256 bought = _routerBuy(s.raise / 20);
        assertEq(token.balanceOf(ALICE), bought);
        assertGt(_pBalance(address(router)), 0, "real launch tax held");
        _split(false);
        _fill();
        assertFalse(vault.gateOpen());
        box.graduate();
        assertTrue(vault.gateOpen());
        assertGt(hook.pairedLiquidity(), 0);
        router.sweep();
        assertEq(_pBalance(address(router)), 0);
        _split(true);
        _sellerFees();
        _fundPicker();
        _roundTrip(art);
        _noPayouts();
        vm.expectRevert(IBoxCoordinator.AlreadyGraduated.selector);
        box.fail();
    }

    function _sellerFees() private {
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 10, curve.sqrtPriceStartX96);
        uint256 converted;
        for (uint256 i; i < 256; ++i) {
            vm.roll(block.number + 1);
            vm.prank(address(hook));
            (ProtocolSkip skip,, uint256 p,) = hook.sellFees();
            converted += p;
            if (skip == ProtocolSkip.BelowMinimum) break;
            assertEq(uint8(skip), uint8(ProtocolSkip.None));
        }
        assertGt(converted, 0);
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        uint256 depth = hook.depthBudget();
        FeeBatchV2 memory fees = receiver.collect(address(0));
        assertGt(fees.sellersP, 0, "actual seller fee P harvested");
        uint256 units = receiver.platformOwed() - platform;
        assertGt(units, 0);
        assertEq(receiver.fitOwed() - fit, 2 * units);
        assertEq(hook.depthBudget() - depth, 12 * units);
        // Independent bound allows each side's previous remainder of at most fourteen raw units.
        uint256 total = fees.buyersP + fees.sellersP;
        assertLe(15 * units, total + 28);
        assertLe(total, 15 * units + 28);
        _noPayouts();
    }

    function _pBalance(address who) private view returns (uint256) {
        return box.q() == address(0) ? who.balance : HostileToken(box.q()).balanceOf(who);
    }

    function _split(bool graduated) private {
        receiver.collect(address(0));
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        uint256 pool = receiver.poolHeldP();
        uint256 grow = receiver.growHeldP();
        uint256 depth = hook.depthBudget();
        _gift(address(receiver), 15_000);
        FeeBatchV2 memory batch = receiver.collect(address(0));
        assertEq(batch.buyersP, 15_000);
        assertEq(batch.sellersP, 0);
        assertEq(batch.tip, 0);
        assertEq(receiver.fitOwed() - fit, 2_000);
        assertEq(receiver.platformOwed() - platform, 1_000);
        if (graduated) {
            assertEq(hook.depthBudget() - depth, 12_000);
            assertEq(receiver.poolHeldP() + receiver.growHeldP(), 0);
        } else {
            assertEq(receiver.poolHeldP() - pool, 2_000);
            assertEq(receiver.growHeldP() - grow, 10_000);
        }
        uint256 owed = receiver.fitOwed();
        uint256 before = _pBalance(release.fitSafe);
        assertEq(receiver.payFit(), owed);
        assertEq(_pBalance(release.fitSafe) - before, owed);
        owed = receiver.platformOwed();
        before = _pBalance(release.platformSafe);
        assertEq(receiver.payPlatform(), owed);
        assertEq(_pBalance(release.platformSafe) - before, owed);
    }

    function _roundTrip(SetStandardERC721 art) private {
        uint256[] memory ids = _ids(0, 3);
        uint256 supply = token.totalSupply();
        uint256 principal = (supply * 3 + 32) / 33;
        uint256 fee = (principal * 500 + 9999) / 10_000;
        uint256 before = token.balanceOf(ALICE);
        assertEq(vault.quoteWithdraw(3), principal);
        vm.prank(ALICE);
        (uint256 paid, uint256 burned) = vault.withdrawBatch(ids, principal + fee, block.timestamp);
        assertEq(paid, principal);
        assertEq(burned, fee);
        assertEq(token.totalSupply(), supply - fee);
        assertEq(token.balanceOf(ALICE), before - principal - fee);
        assertEq(token.balanceOf(address(vault)), principal);
        assertEq(vault.escrowPrincipal(), principal);
        assertEq(vault.inside(), 30);
        // A holder-funded burn and permissionless receiver work cannot touch conversion principal.
        vm.prank(ALICE);
        token.burn(12345);
        assertEq(receiver.burnPending(), 0);
        assertEq(token.balanceOf(address(vault)), principal);
        assertEq(vault.escrowPrincipal(), principal);
        for (uint256 i; i < ids.length; ++i) {
            vm.prank(ALICE);
            art.transferFrom(ALICE, BOB, ids[i]);
        }
        uint256 returned = (token.totalSupply() - principal) * 3 / 30;
        uint256 returnFee = (returned * 500 + 9999) / 10_000;
        assertEq(vault.quoteReturn(3), returned);
        vm.prank(BOB);
        art.setApprovalForAll(address(vault), true);
        supply = token.totalSupply();
        vm.prank(BOB);
        (paid, burned) = vault.returnItems(ids, returned - returnFee, block.timestamp);
        assertEq(paid, returned);
        assertEq(burned, returnFee);
        assertEq(token.balanceOf(BOB), returned - returnFee);
        assertEq(token.totalSupply(), supply - returnFee);
        assertEq(vault.escrowPrincipal(), principal - returned);
        assertEq(token.balanceOf(address(vault)), principal - returned);
        assertGt(principal - returned, 0, "surplus remains escrowed");
        assertEq(vault.inside(), 33);
        for (uint256 i; i < ids.length; ++i) {
            assertEq(art.ownerOf(ids[i]), address(vault));
        }
    }

    function test_E07_hostileLastTransferRollsBackRealMoneyAndLoader() public {
        HostileERC721 art = new HostileERC721();
        for (uint256 i; i < 10; ++i) {
            art.mint(CREATOR, _id(i));
        }
        (SetSpecV2 memory s, bytes32[] memory suffix) = _terms(address(art), 10);
        _start(s);
        art.setTransferMode(_id(9), HostileERC721.TransferMode.MissingReceipt);
        vm.expectRevert(SetVaultV2.ReceiptRefused.selector);
        _page(0, 10, 0);
        (uint32 loaded,,) = loader.progress();
        assertEq(loaded, 0);
        assertEq(vault.inside(), 0);
        assertEq(art.actualOwner(0), CREATOR);
        art.setTransferMode(_id(9), HostileERC721.TransferMode.Normal);
        _open(suffix);
        _fill();
        box.graduate();
        _fundPicker();
        art.setMetadata(99, true, 65536);
        uint256[] memory ids = _ids(0, 2);
        art.setTransferMode(ids[1], HostileERC721.TransferMode.NoOp);
        bytes32 before = _moneyState();
        vm.prank(ALICE);
        vm.expectRevert();
        vault.withdrawBatch(ids, type(uint256).max, block.timestamp);
        assertEq(_moneyState(), before);
        assertEq(art.actualOwner(0), address(vault));
        art.setTransferMode(ids[1], HostileERC721.TransferMode.Normal);
        vm.prank(ALICE);
        vault.withdrawBatch(ids, type(uint256).max, block.timestamp);
        vm.prank(ALICE);
        art.setApprovalForAll(address(vault), true);
        art.setTransferMode(ids[1], HostileERC721.TransferMode.DuplicateReceipt);
        before = _moneyState();
        vm.prank(ALICE);
        vm.expectRevert(SetVaultV2.TransferRefused.selector);
        vault.returnItems(ids, 0, block.timestamp);
        assertEq(_moneyState(), before);
        assertEq(art.actualOwner(0), ALICE);
        art.setTransferMode(ids[1], HostileERC721.TransferMode.Normal);
        vm.prank(ALICE);
        vault.returnItems(ids, 0, block.timestamp);
        assertEq(vault.inside(), 10);
    }

    function test_E07_payoutModulesNeverExecuted() public {
        SetStandardERC721 art = new SetStandardERC721();
        for (uint256 i; i < 10; ++i) {
            art.mint(CREATOR, _id(i));
        }
        (SetSpecV2 memory s, bytes32[] memory suffix) = _terms(address(art), 10);
        _start(s);
        for (uint8 i = 6; i <= 9; ++i) {
            (address module,) = BoxReceiverV2(payable(address(receiver))).feeModule(i);
            vm.expectCall(module, bytes(""), uint64(0));
        }
        _open(suffix);
        _routerBuy(s.raise / 20);
        receiver.collect(address(0));
        _fill();
        box.graduate();
        receiver.collect(address(0));
        receiver.buyBack(address(0));
        receiver.burnPending();
        assertEq(IBoxReceiverItemsV2(address(receiver)).itemFundingCount(), 0);
        _noPayouts();
    }

    function _moneyState() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                token.totalSupply(),
                token.balanceOf(ALICE),
                token.balanceOf(address(vault)),
                vault.inside(),
                vault.escrowPrincipal(),
                vault.isOutside(0),
                vault.isOutside(type(uint256).max)
            )
        );
    }
}
