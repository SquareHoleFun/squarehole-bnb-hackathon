// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../kit/RoyaltyRelease.sol";
import {Test} from "forge-std/Test.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxRoyaltyRouterV2} from "../../../src/box-v2/BoxRoyaltyRouterV2.sol";
import {BoxRoyaltyRouterV2Args} from "../../../src/box-v2/libraries/BoxRoyaltyRouterV2Args.sol";
import {IBoxRoyaltyRouter} from "../../../src/box/interfaces/IBoxRoyaltyRouter.sol";
import {RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {HostileToken} from "../kit/HostileToken.sol";

// Receiver-boundary double only. CQ11-B owns phase booking and conversion-safe retry logic.
contract RoyaltySink {
    bool public refuse;
    bool public shortPull;
    address public lastAsset;
    uint256 public received;

    function configure(bool refuse_, bool short_) external {
        refuse = refuse_;
        shortPull = short_;
    }

    function fundRoyalty(address asset, uint256 amount) external payable {
        require(!refuse, "refused");
        if (asset == address(0)) require(msg.value == amount);
        else require(HostileToken(asset).transferFrom(msg.sender, address(this), shortPull ? amount - 1 : amount));
        lastAsset = asset;
        received += amount;
    }
}

contract RoyaltyWeth is HostileToken {
    constructor() HostileToken("Wrapped ETH", "WETH", 18) {}

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }
}

contract RoyaltyRouterTest is Test {
    BoxRoyaltyRouterV2 internal router;
    BoxRoyaltyRouterV2 internal impl;
    RoyaltySink internal sink;
    HostileToken internal p;
    RoyaltyWeth internal weth;

    function setUp() public virtual {
        vm.mockCall(address(0xC0), abi.encodeWithSignature("failed()"), abi.encode(false));
        sink = new RoyaltySink();
        p = new HostileToken("P", "P", 6);
        weth = new RoyaltyWeth();
        impl = new BoxRoyaltyRouterV2(RoyaltyRelease.config());
        router = BoxRoyaltyRouterV2(
            payable(BoxClones.create(
                    BoxClones.initCodeReceiving(
                        address(impl),
                        RoyaltyRelease.args(
                            address(0xC0), address(sink), address(weth), RoyaltyDestination.FeeHandling, address(p)
                        )
                    )
                ))
        );
    }

    function _nativeRouter() internal {
        router = BoxRoyaltyRouterV2(payable(BoxClones.create(BoxClones.initCodeReceiving(address(impl),
            RoyaltyRelease.args(address(0xC0), address(sink), address(weth), RoyaltyDestination.FeeHandling, address(0))))));
    }

    function test_native2300GasIntakeAndWethGoThroughRoyaltyIntake() public {
        _nativeRouter();
        vm.deal(address(this), 100);
        payable(address(router)).transfer(60);
        vm.deal(address(router), 100);
        vm.prank(address(router));
        weth.deposit{value: 40}();
        assertEq(router.flush(), 100);
        assertEq(sink.received(), 100);
        assertEq(sink.lastAsset(), address(0));
        assertEq(address(router).balance, 0);
        assertEq(weth.balanceOf(address(router)), 0);
    }

    function test_erc20PriceCoinPulledExactlyAndApprovalCleared() public {
        p.mint(address(router), 123);
        assertEq(router.sweep(address(p)), 123);
        assertEq(sink.lastAsset(), address(p));
        assertEq(p.balanceOf(address(router)), 0);
        assertEq(p.balanceOf(address(sink)), 123);
        assertEq(p.allowance(address(router), address(sink)), 0);
    }

    function test_refusedNativeIntakeRollsBackUnwrapThenRetries() public {
        _nativeRouter();
        vm.deal(address(router), 100);
        vm.prank(address(router));
        weth.deposit{value: 100}();
        sink.configure(true, false);
        vm.expectRevert(IBoxRoyaltyRouter.SinkFailed.selector);
        router.flush();
        assertEq(weth.balanceOf(address(router)), 100);
        assertEq(address(sink).balance, 0);
        sink.configure(false, false);
        assertEq(router.sweep(address(weth)), 100);
    }

    function test_refusedAndShortPriceIntakeRollbackThenRetry() public {
        p.mint(address(router), 123);
        sink.configure(true, false);
        vm.expectRevert(IBoxRoyaltyRouter.SinkFailed.selector);
        router.sweep(address(p));
        sink.configure(false, true);
        vm.expectRevert(IBoxRoyaltyRouter.SinkFailed.selector);
        router.sweep(address(p));
        assertEq(p.balanceOf(address(router)), 123);
        assertEq(p.balanceOf(address(sink)), 0);
        assertEq(p.allowance(address(router), address(sink)), 0);
        sink.configure(false, false);
        router.sweep(address(p));
        assertEq(sink.received(), 123);
    }

    function test_pausedPriceCoinRetainsRoyaltyForRetry() public {
        p.mint(address(router), 99);
        p.setPaused(true);
        vm.expectRevert(IBoxRoyaltyRouter.SinkFailed.selector);
        router.sweep(address(p));
        assertEq(p.balanceOf(address(router)), 99);
        p.setPaused(false);
        assertEq(router.sweep(address(p)), 99);
    }

    function test_boundedSweepStillRejectsShortPullAndClearsApproval() public {
        uint256 batch = 4 * uint256(uint128(type(int128).max));
        p.mint(address(router), batch + 123);
        sink.configure(false, true);
        vm.expectRevert(IBoxRoyaltyRouter.SinkFailed.selector);
        router.sweep(address(p));
        assertEq(p.balanceOf(address(router)), batch + 123);
        assertEq(p.balanceOf(address(sink)), 0);
        assertEq(p.allowance(address(router), address(sink)), 0);
        sink.configure(false, false);
        assertEq(router.sweep(address(p)), batch);
        assertEq(p.balanceOf(address(router)), 123);
        assertEq(p.balanceOf(address(sink)), batch);
        assertEq(p.allowance(address(router), address(sink)), 0);
        assertEq(router.sweep(address(p)), 123);
        assertEq(p.balanceOf(address(router)), 0);
    }

    function test_wrongAssetCannotBeSentToCallerOrAnotherSink() public {
        HostileToken other = new HostileToken("other", "O", 18);
        other.mint(address(router), 10);
        vm.expectRevert(abi.encodeWithSelector(IBoxRoyaltyRouter.TokenNotTaken.selector, address(other)));
        router.sweep(address(other));
        assertEq(other.balanceOf(address(router)), 10);
    }

    function test_emptyRepeatCannotDoubleBook() public {
        p.mint(address(router), 123);
        router.sweep(address(p));
        vm.expectRevert(IBoxRoyaltyRouter.NothingToFlush.selector);
        router.sweep(address(p));
        assertEq(sink.received(), 123);
    }

    function test_bareImplementationIsInert() public {
        vm.expectRevert(BoxRoyaltyRouterV2.NotAClone.selector);
        impl.flush();
        vm.expectRevert(BoxRoyaltyRouterV2.NotAClone.selector);
        impl.sweep(address(p));
    }

    function test_allDestinationsAlwaysUseFundRoyaltyWithoutGraduationRead() public {
        for (uint8 destination = 1; destination <= 3; ++destination) {
            BoxRoyaltyRouterV2 r = BoxRoyaltyRouterV2(
                payable(BoxClones.create(
                        BoxClones.initCodeReceiving(
                            address(impl),
                            RoyaltyRelease.args(
                                address(0xC0), address(sink), address(weth), RoyaltyDestination(destination), address(p)
                            )
                        )
                    ))
            );
            p.mint(address(r), 15);
            r.sweep(address(p));
        }
        assertEq(sink.received(), 45);
    }
}
