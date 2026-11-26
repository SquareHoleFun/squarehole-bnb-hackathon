// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M130aBase, M130aPrice} from "./M130aBase.sol";
import {CQAAsset} from "../cq11-a/Fixture.sol";

contract M130aLaunchRouterTest is M130aBase {
    function test_M130a_BC220_routerTakesItsOpenFromTheCoordinator() public view {
        assertEq(router.openAt(), box.effectiveOpenAt()); assertEq(router.coordinator(), address(box));
    }
    function test_M130a_BC220_windowAndTaxFromTheEffectiveOpen() public {
        _window();
        for (uint256 i; i < 32; ++i) {
            vm.warp(box.effectiveOpenAt() + i * 12);
            (uint256 tax, uint256 spend) = router.quote(1000000);
            assertEq(tax, router.taxPips(i)); assertEq(tax + spend, 1000000);
        }
        vm.warp(box.effectiveOpenAt() + 384); vm.expectRevert(); router.quote(1000000);
    }
    function testFuzz_M130a_BC157_erc20BuyPullsExactlyQIn(uint64 seed) public {
        uint256 input = bound(seed, 1000000, RAISE / 100); _window();
        uint256 before = p.balanceOf(address(this)); uint256 tokenBefore = t.balanceOf(address(this));
        (uint256 tax,) = router.quote(input); uint256 out = _taxBuy(input);
        assertEq(before - p.balanceOf(address(this)), input); assertEq(out, t.balanceOf(address(this)) - tokenBefore);
        assertEq(p.balanceOf(address(router)), tax); assertEq(router.totalTaxCollected(), tax);
    }
    function test_M130a_BC159_erc20BuyRefusals() public {
        _window(); M130aPrice coin = _hostile(); coin.configure(address(this), false);
        vm.expectRevert(); _taxBuy(RAISE / 100); assertEq(router.totalTaxCollected(), 0);
        coin.configure(address(0), false); vm.expectRevert(); router.buy(RAISE / 100, type(uint256).max, address(this), block.timestamp);
        assertEq(router.totalTaxCollected(), 0);
    }
    function test_M130a_BC157_closingFillRefundsPToThePayer() public {
        _window(); vm.warp(box.effectiveOpenAt() + 372); p.mint(address(this), RAISE * 2);
        uint256 before = p.balanceOf(address(this)); _taxBuy(RAISE * 2);
        assertTrue(hook.closed()); assertLt(before - p.balanceOf(address(this)), RAISE * 2);
        assertEq(p.balanceOf(address(router)), router.totalTaxCollected());
    }
    function test_M130a_BC157_bootstrapAndCreatorBuyPulledExactly() public {
        creatorBuy = RAISE / 10; _make(RAISE);
        assertTrue(router.bootstrapped()); assertTrue(router.creatorBought());
        assertEq(p.balanceOf(address(router)), 0); assertEq(router.totalTaxCollected(), 0);
        assertEq(p.balanceOf(address(box)), 0); assertGt(t.balanceOf(address(this)), 0);
    }
    function test_M130a_BC159_bootstrapRefusals() public {
        vm.expectRevert(); router.bootstrap();
        vm.prank(address(box)); vm.expectRevert(); router.bootstrap();
        assertTrue(router.bootstrapped());
    }
    function test_M130a_BC157_ethBoxKeepsV1sPayment() public {
        p = CQAAsset(address(0)); _make(RAISE); vm.warp(box.effectiveOpenAt());
        uint256 input = RAISE / 100; (uint256 tax,) = router.quote(input);
        uint256 out = router.buy{value: input}(input, 0, address(this), block.timestamp);
        assertGt(out, 0); assertEq(address(router).balance, tax);
        vm.expectRevert(); router.buy{value: input - 1}(input, 0, address(this), block.timestamp);
    }
    function test_M130a_BC229_sweepMakesTheTaxTheHooksPClaims() public {
        _window(); _taxBuy(RAISE / 10); uint256 tax = router.totalTaxCollected();
        vm.expectRevert(); router.sweep(); _graduate(); router.sweep();
        assertEq(router.totalSwept(), tax); assertEq(p.balanceOf(address(router)), 0); assertGe(hook.depthBudget(), tax);
    }
}
