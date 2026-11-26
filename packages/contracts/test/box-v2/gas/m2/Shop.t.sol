// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M260Measure} from "./Measure.sol";
import {ShopLimitsV2 as L} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {M260CapDouble} from "./CapDouble.sol";

contract M260ShopTest is M260Measure, M260CapDouble {
    function test_shopGiveAndPickWithLedgerToken() public {
        _createShop(0, 1000 ether, true, true); _fill(); box.graduate();
        vm.warp(block.timestamp + 7 days); nft.mint(CREATOR, 100);
        uint256 balance = token.balanceOf(CREATOR);
        _measure("shop give", address(shop), CREATOR, abi.encodeCall(shop.give, (address(nft), 100, 1 ether)), 4000000);
        assertEq(token.balanceOf(CREATOR), balance + 1 ether);
        vm.prank(CREATOR); token.approve(address(shop), 1.5 ether);
        _measure("shop pick", address(shop), CREATOR,
            abi.encodeCall(shop.pick, (address(nft), 100, 1.5 ether, CREATOR)), 4000000);
        assertEq(nft.ownerOf(100), CREATOR); assertEq(shop.budgetT(), 1000.5 ether);
    }

    function test_failureThreeEntriesAndSelfClaim() public {
        for (uint256 mode; mode < 3; ++mode) {
            uint256 snapshot = vm.snapshotState();
            _createShop(0, 1000 ether, true, mode != 1);
            if (mode != 1) _trade();
            bytes memory data;
            if (mode == 0) { vm.warp(box.deadline()); data = abi.encodeCall(box.fail, ()); }
            if (mode == 1) { _page(0, 5); vm.warp(box.openAt() + 14 days); data = abi.encodeCall(box.failClosed, ()); }
            if (mode == 2) { _fill(); vm.warp(hook.closedAt() + 7 days); data = abi.encodeCall(box.fail, ()); }
            _measure(mode == 0 ? "deadline failure" : mode == 1 ? "unopened failure" : "filled hatch",
                address(box), address(this), data, 15_000_000);
            assertTrue(box.failed()); _assertOutstanding();
            uint256 amount = token.balanceOf(CREATOR); vm.prank(CREATOR); token.approve(address(box), amount);
            uint256 expected = box.quoteClaim(amount); uint256 beforeP = CREATOR.balance;
            _measure("failure self claim", address(box), CREATOR, abi.encodeCall(box.claim, (amount, CREATOR)), 9_000_000);
            assertEq(CREATOR.balance - beforeP, expected);
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function test_failedShopBurnAndStarterReturn() public {
        _createShop(0, 1000 ether, true, false); _page(0, 10);
        vm.prank(CREATOR); token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        (, uint256 left) = box.claimState(); uint256 supply = token.totalSupply();
        (bytes memory result,) = _measure("failed shop liquid plus claims burn", address(shop), address(this),
            abi.encodeCall(shop.burnFailedT, ()), 4000000);
        assertEq(abi.decode(result, (uint256)), 1100 ether); assertEq(shop.failedT(), 0);
        assertEq(token.totalSupply(), supply - 1100 ether); (, uint256 afterLeft) = box.claimState(); assertEq(left, afterLeft);
        uint256[] memory indexes = new uint256[](1);
        (, uint256 used) = _measure("starter return one cold", address(shop), address(this),
            abi.encodeCall(shop.returnStarter, (indexes)), 2000000);
        assertEq(nft.ownerOf(0), CREATOR);
        emit log_named_uint("production NFT return cap", L.NFT_RETURN_GAS);
        emit log_named_uint("return transaction twice upper bound", used * 2);
    }

    function test_productionLiquidBurnSucceedsAtHalfAllowance() public { _halfRecovery(0); }
    function test_productionClaimsBurnSucceedsAtHalfAllowance() public { _halfRecovery(1); }
    function test_productionStarterReturnSucceedsAtHalfAllowance() public { _halfRecovery(2); }

    function _halfRecovery(uint256 mode) private {
        _createShop(0, 1000 ether, true, false); _page(0, 10);
        vm.prank(CREATOR); token.transfer(address(buyer), 100 ether);
        buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        // Halve the production literals, not the proposed-cap double. Keep all real custody code.
        address implementation = release.implementations[21];
        bytes memory code = _replaceCap(implementation.code, LIQUID, LIQUID / 2, 1);
        code = _replaceCap(code, CLAIMS, CLAIMS / 2, 1);
        vm.etch(implementation, _replaceCap(code, L.NFT_RETURN_GAS, L.NFT_RETURN_GAS / 2, 1));
        if (mode == 2) {
            uint256[] memory indexes = new uint256[](1);
            (bytes memory result,) = _measure("half production NFT return cap", address(shop), address(this),
                abi.encodeCall(shop.returnStarter, (indexes)), 2000000);
            assertEq(abi.decode(result, (uint256)), 1, "NFT return must fit half stipend");
            assertEq(nft.ownerOf(0), CREATOR);
        } else {
            _measure("half production shop burn caps", address(shop), address(this),
                abi.encodeCall(shop.burnFailedT, ()), 4000000);
            if (mode == 0) assertEq(token.balanceOf(address(shop)), 0, "liquid burn must fit half stipend");
            else assertEq(pm.balanceOf(address(shop), uint160(address(token))), 0, "claims burn must fit half stipend");
        }
    }

    function test_productionStarterReturnFitsCallerFloor() public {
        _createShop(0, 1000 ether, true, false); _page(0, 10);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        uint256[] memory indexes = new uint256[](1);
        vm.expectCall(address(shop), 0, uint64(RETURN), abi.encodeWithSignature("returnOne(uint256)", 0), uint64(1));
        (bytes memory result,) = _measure("full production NFT return cap", address(shop), address(this),
            abi.encodeCall(shop.returnStarter, (indexes)), 2000000);
        assertEq(abi.decode(result, (uint256)), 1); assertEq(nft.ownerOf(0), CREATOR);
    }
    function test_productionStarterReturnExhaustionPreservesCustody() public {
        _createShop(0, 1000 ether, true, false); _page(0, 10);
        vm.warp(box.openAt() + 14 days); box.failClosed();
        uint256[] memory indexes = new uint256[](1);
        bytes memory code = address(nft).code;
        vm.etch(address(nft), hex"fe");
        vm.expectCall(address(shop), 0, uint64(RETURN), abi.encodeWithSignature("returnOne(uint256)", 0), uint64(2));
        (bytes memory result, uint256 used) = _measure("production NFT return cap exhausted", address(shop), address(this),
            abi.encodeCall(shop.returnStarter, (indexes)), 2000000);
        assertEq(abi.decode(result, (uint256)), 0);
        assertGt(used, RETURN * 9 / 10);
        vm.etch(address(nft), code);
        assertEq(nft.ownerOf(0), address(shop)); assertEq(shop.inside(), 10);
        (result,) = _measure("NFT return retry after exhaustion", address(shop), address(this),
            abi.encodeCall(shop.returnStarter, (indexes)), 2000000);
        assertEq(abi.decode(result, (uint256)), 1);
        assertEq(nft.ownerOf(0), CREATOR); assertEq(shop.inside(), 9);
    }

    function test_productionBurnExhaustionPreservesCustody() public {
            _createShop(0, 1000 ether, false, false);
            vm.prank(CREATOR); token.transfer(address(buyer), 100 ether);
            buyer.mintClaims(Currency.wrap(address(token)), address(shop), 100 ether);
            vm.warp(box.openAt() + 14 days); box.failClosed();
            bytes memory code = address(token).code; vm.etch(address(token), hex"fe");
            vm.expectCall(address(shop), 0, uint64(LIQUID), abi.encodeWithSignature("burnLiquid()"), uint64(2));
            vm.expectCall(address(shop), 0, uint64(CLAIMS), abi.encodeWithSignature("burnClaims()"), uint64(2));
            (bytes memory result, uint256 used) = _measure("production burn both caps exhausted",
                address(shop), address(this), abi.encodeCall(shop.burnFailedT, ()), 5000000);
            assertEq(abi.decode(result, (uint256)), 0);
            // Nested EIP-150 calls retain some gas before the failed frame unwinds.
            assertGt(used, (LIQUID + CLAIMS) * 9 / 10);
            vm.etch(address(token), code); assertEq(shop.failedT(), 1100 ether); _assertOutstanding();
            (result,) = _measure("burn retry after exhaustion", address(shop), address(this), abi.encodeCall(shop.burnFailedT, ()), 5000000);
            assertEq(abi.decode(result, (uint256)), 1100 ether); assertEq(shop.failedT(), 0); _assertOutstanding();
    }
}
