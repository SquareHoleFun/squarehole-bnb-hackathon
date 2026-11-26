// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {RoyaltyRelease} from "../../test/box-v2/kit/RoyaltyRelease.sol";
import {NoFailureSweep} from "../../test/box-v2/rc5-a/NoFailureSweep.sol";
import {FeeModuleDirectoryV21} from "../../src/box-v2/FeeModuleDirectoryV21.sol";
import {BoxReceiverV2} from "../../src/box-v2/BoxReceiverV2.sol";


import {Vm} from "forge-std/Vm.sol";
import {IItemLedgerV2} from "../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {IPileVaultV2} from "../../src/box-v2/interfaces/IPileVaultV2.sol";
import {IBoxVaultV2} from "../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {BoxCollectionV2} from "../../src/box-v2/BoxCollectionV2.sol";
import {Test} from "forge-std/Test.sol";
import {CoreV2LocalPictures} from "./CoreV2LocalPictures.sol";
import {CoreV2LocalLife} from "./CoreV2LocalLife.s.sol";
import {LocalBoxArt} from "./LocalBoxArt.sol";
import {DeployCoreV2Local, LocalV2Custody} from "./DeployCoreV2Local.s.sol";
import {CoreV2Deployment} from "../sepolia-v2/CoreV2Deployment.sol";
import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxCoordinatorV2} from "../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IHolderLedgerV2} from "../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2} from "../../src/box-v2/interfaces/IShopVaultV2.sol";
import {BoxTokenV2} from "../../src/box-v2/BoxTokenV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {HostileCollection} from "../../test/box-v2/kit/m2/ShopDoubles.sol";
import {RoyaltyWeth} from "../../test/box-v2/cq11-c/RoyaltyRouter.t.sol";
import {IListingRegistry, ListingRecord, ListingClass} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {LocalERC20} from "./LocalQuoteMocks.sol";
import {BoxSpec} from "../../src/box-v2/interfaces/SpecTypes.sol";

contract LocalV2DeploymentHarness is DeployCoreV2Local {
    function simulate(Config memory c) external returns (BoxFactoryV2) {
        _measureLocalGas();
        vm.startPrank(c.deployer);
        BoxFactoryV2 f = BoxFactoryV2(_deployLocalCoreV2(c).factory);
        vm.stopPrank();
        return f;
    }
}

/// SH-TA-33: the local stack's own entry, with its item-picture hook open to the test.
contract LocalLifeItemPictures is CoreV2LocalLife {
    function itemImage(uint256 id) external pure returns (bytes32) {
        return _localItemImage(id);
    }
}

/// SH-V2-E2E-LOCAL: offline real-part proof of the same seed/actions used by the local scripts.
contract CoreV2LocalTest is Test, CoreV2LocalPictures {
    address private constant ACTOR = address(0xA11CE);
    address private constant DEPLOYER = address(0xDE0107);
    address private fit;
    IPoolManager private manager;

    function setUp() public virtual {
        vm.warp(1_790_000_000); vm.roll(100); vm.deal(ACTOR, 100 ether);
        manager = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(DEPLOYER)));
        address[] memory owners = new address[](3);
        owners[0] = DEPLOYER; owners[1] = ACTOR; owners[2] = address(0xB0B);
        fit = address(new LocalV2Custody(owners, 2));
        address platform = address(new LocalV2Custody(owners, 1));
        // Offline only: the unused directory/source have code. Live bootstrap uses real box 0 and pinned drand.
        address dependency = address(new RoyaltyWeth());
        // The harness embeds the deployment script's code (DeployCoreV2, which F143's `_drandBehind` grew); its own code
        // deposit is test scaffolding, not part of the deployment the tests measure, and under Amsterdam's 1,530 gas per
        // code byte it alone would take the M3 doubles' setUp past forge's 2^30 gas.
        vm.pauseGasMetering();
        LocalV2DeploymentHarness harness = _deploymentHarness();
        vm.resumeGasMetering();
        localFactory = harness.simulate(CoreV2Deployment.Config(
            DEPLOYER, address(manager), dependency, dependency, dependency, fit, platform, RoyaltyRelease.config()));
        vm.warp(block.timestamp + 1 days); // Local fixture waits out production module admission.
        localSwapper = new PriceLimitSwapper(manager);
        localNft = new HostileCollection(); localActor = ACTOR;
    }

    function _deploymentHarness() internal virtual returns (LocalV2DeploymentHarness) {
        return new LocalV2DeploymentHarness();
    }

    function test_DIR_DELAY_localReleaseUsesOneDayNotice() public view {
        (,, address directory) = BoxReceiverV2(localFactory.implementation(5)).receiverCode();
        assertEq(FeeModuleDirectoryV21(directory).DELAY(), 1 days);
    }

    function test_receiverCallbackIsSharedByLocalFactoryClones() public {
        address implementation = localFactory.implementation(5);
        (,address callback,) = BoxReceiverV2(implementation).receiverCode();
        assertGt(callback.code.length, 0);
        assertLe(callback.code.length, 22_118);
        assertLe(implementation.code.length, 22_118);
        bytes32 codeHash = callback.codehash;
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(0);
        vm.stopPrank();
        assertEq(vm.getNonce(implementation), 1, "all fee code is separately deployed");
        assertEq(vm.getNonce(b.receiver()), 1, "no per-box callback deployment");
        assertEq(callback.codehash, codeHash);
        IBoxReceiverV2(b.receiver()).collect(address(0));
    }

    function test_creationEnvelopeCoversEveryLocalRecipe() public {
        uint256[9] memory creationGas;
        vm.startPrank(ACTOR);
        for (uint8 mode; mode < 9; ++mode) {
            vm.recordLogs();
            BoxCoordinatorV2 b = _createLocal(mode);
            Vm.Log[] memory logs = vm.getRecordedLogs();
            bool measured;
            for (uint256 i; i < logs.length; ++i) {
                if (logs[i].emitter != address(this) || logs[i].topics[0] !=
                    keccak256("LocalCreationGas(string,uint256,uint256,uint256)")) continue;
                (, uint256 used, uint256 stateGas, uint256 intrinsic) =
                    abi.decode(logs[i].data, (string, uint256, uint256, uint256));
                measured = true;
                creationGas[mode] = used;
                emit log_named_uint("creation recipe", mode);
                emit log_named_uint("creation gas", used);
                emit log_named_uint("creation state gas", stateGas);
                emit log_named_uint("creation intrinsic upper bound", intrinsic);
                assertLe(LOCAL_CREATE_GAS + intrinsic, TX_GAS_CAP, "creation transaction cap");
                _checkGasStep(GasStep("creation on 30M block", used + intrinsic, stateGas, true),
                    stateGas != 0, 30_000_000);
            }
            assertTrue(measured, "measure the factory call even when ERC20 approval follows it");
            assertEq(b.creator(), ACTOR);
            assertEq(b.raise(), _localSpec(mode).raise);
            assertGt(b.token().code.length, 0);
            assertEq(address(localFactory).balance, 0, "creation keeps no native payment");
        }
        vm.stopPrank();
        // Measure every recipe before asserting, so a regression retains the complete gas table.
        for (uint256 mode; mode < creationGas.length; ++mode) {
            uint256 used = creationGas[mode];
            assertGe(LOCAL_CREATE_GAS - used, used / 10,
                "creation needs ten percent execution and state headroom");
            assertLe(used, 15_000_000, "RC6-CREATION-GAS: creation execution ceiling");
        }
    }

    function test_localArtEveryRecipeCommitsItsOwnLogo() public view {
        bytes32[9] memory logos;
        for (uint8 mode; mode < 9; ++mode) {
            BoxSpec memory s = _localSpec(mode);
            assertNotEq(s.coverSha256, bytes32(0), "logo must exist");
            assertNotEq(s.coverSha256, bytes32(uint256(1)), "dummy logo cannot load");
            for (uint8 prior; prior < mode; ++prior) assertNotEq(s.coverSha256, logos[prior], "distinct local boxes");
            logos[mode] = s.coverSha256;
            assertEq(localFactory.refusal(s, localActor).length, 0, "art preserves real spec admission");
        }
    }

    function test_localArtEveryItemHasItsOwnCollectionCover() public view {
        BoxSpec memory s = _localSpec(4);
        assertNotEq(s.collectionCoverSha256, bytes32(0));
        assertNotEq(s.collectionCoverSha256, s.coverSha256, "separate collection cover and logo");
        assertNotEq(s.collectionCoverSha256,
            bytes32(0x41cf86fd8bf4bf185534477e35ca01b8183316adc947a92f9c3d8933a90f11fb),
            "local item box does not borrow the Misfits cover");
    }

    /// SH-TA-33, XR-SH-TA-33 F1: the local stack's every-item box (CoreV2LocalLife's recipe) commits catalogue PNGs the
    /// local art gateway serves, items 1-9 the nine local logos and item 10 the items cover, in its reveal tree and in
    /// each reveal. The Sepolia preparation's synthetic tree (test/box-v2/sepolia-all/Preparation.t.sol) stays its own.
    function test_localEveryItemCommitsCataloguePictures() public {
        LocalLifeItemPictures life = new LocalLifeItemPictures();
        bytes32[10] memory pictures;
        for (uint256 id = 1; id <= 10; ++id) {
            // casting to 'uint8' is safe because id - 1 is below 9 on this branch
            // forge-lint: disable-next-line(unsafe-typecast)
            pictures[id - 1] = id <= 9 ? LocalBoxArt.logo(uint8(id - 1)) : LocalBoxArt.ITEMS_COVER;
            assertEq(life.itemImage(id), pictures[id - 1], "the local script commits each catalogue picture");
            assertEq(_localItemImage(id), pictures[id - 1], "the offline recipe is the script's");
        }
        BoxSpec memory s = _localSpec(4);
        assertNotEq(s.revealRoot, bytes32(0x7a45fe00dd9393da6f5e34aee75ced42d5a9079c62c64f2b7ed19e3dd605dbf2),
            "not the Sepolia preparation's synthetic tree");
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(4);
        _loadLocalM3(b, 4);
        vm.stopPrank();
        BoxCollectionV2 c = BoxCollectionV2(b.collection());
        assertEq(c.revealRoot(), s.revealRoot);
        for (uint256 id = 1; id <= 10; ++id) {
            (bool revealed,, bytes32 image,) = c.traitsOf(id);
            assertTrue(revealed);
            assertEq(image, pictures[id - 1], "each local item's committed picture is a served catalogue PNG");
        }
    }

    function test_localCoinsUseRealAdmissionAndDecimalScaledRaises() public view {
        IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
        assertEq(listings.listingCount(), 8, "ETH plus seven local price coins");
        uint256 ethRaise = listings.listing(0).raise;
        uint256[7] memory unitsPerEth = [uint256(2000e6), 100e18, 5e6, 10e18, 8e18, 5e17, 5e5];
        uint8[7] memory decimals = [uint8(6), 18, 8, 18, 18, 18, 6];
        string[7] memory symbols = ["USDC", "LINK", "WBTC", "NVDAon", "AAPLon", "PAXG", "XAUt"];
        for (uint32 id = 1; id <= 7; ++id) {
            ListingRecord memory row = listings.listing(id);
            assertEq(row.decimals, decimals[id - 1]);
            assertEq(LocalCoinMetadata(row.token).symbol(), symbols[id - 1]);
            assertTrue(_containsLocalMock(LocalCoinMetadata(row.token).name()), "faucets are visibly local mocks");
            assertEq(uint8(row.class), uint8(id == 1 ? ListingClass.STABLE : id == 4 || id == 5 ? ListingClass.STOCK : ListingClass.OTHER));
            assertEq(row.raise, (ethRaise * unitsPerEth[id - 1] + 1 ether - 1) / 1 ether);
            listings.checkLayout(row.raise);
            assertEq(keccak256(abi.encode(localFactory.boxQParameters(id, row.raise))), keccak256(abi.encode(row.q)));
            BoxSpec memory spec = _localSpec(0);
            spec.pricing.listingId = id; spec.pricing.token = row.token;
            spec.raise = row.raise; spec.creatorBuy = row.raise / 100;
            assertEq(localFactory.refusal(spec, ACTOR).length, 0, "real factory admits each price coin");
            (bool listed, uint32 permanentId) = listings.newestListingOf(row.token);
            assertTrue(listed); assertEq(permanentId, id);
            LocalERC20 coin = LocalERC20(row.token);
            assertEq(coin.allowance(listings.lister(), address(listings)), 0, "probe approval cleared");
            assertEq(coin.balanceOf(listings.lister()), 0, "probe funds returned to local owner");
            assertEq(coin.balanceOf(address(listings)), 0);
            assertEq(coin.balanceOf(address(manager)), 0, "admission rolled back every transfer");
            assertEq(coin.balanceOf(DEPLOYER), coin.totalSupply(), "all issued test funds have an owner");
        }
    }

    function test_usdcCreationBuysGraduationAndFeeExitsConserveSixDecimalMoney() public {
        vm.startPrank(ACTOR);
        uint256 nativeBefore = ACTOR.balance;
        BoxCoordinatorV2 b = _createLocal(6);
        ListingRecord memory row = IListingRegistry(localFactory.listingRegistry()).listing(1);
        LocalERC20 usdc = LocalERC20(row.token);
        assertEq(b.pricingListingId(), 1); assertEq(b.raise(), row.raise);
        assertEq(usdc.allowance(ACTOR, address(localFactory)), 0);
        assertEq(usdc.balanceOf(address(localFactory)), 0);
        uint256 issued = usdc.totalSupply();
        vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        for (uint256 i; i < 3; ++i) {
            uint256 beforeT = BoxTokenV2(b.token()).balanceOf(ACTOR);
            uint256 beforeP = usdc.balanceOf(ACTOR);
            _tradeLocal(b);
            assertGt(BoxTokenV2(b.token()).balanceOf(ACTOR), beforeT);
            assertLt(usdc.balanceOf(ACTOR), beforeP);
            assertEq(usdc.allowance(ACTOR, address(localSwapper)), 0);
        }
        _fillLocal(b); b.graduate(); assertTrue(b.graduated());
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver()); r.collect(ACTOR);
        assertGt(r.fitOwed(), 0); r.payFit(); r.payPlatform(); r.claimCreator(row.token, ACTOR);
        assertGt(usdc.balanceOf(fit), 0); assertGt(usdc.balanceOf(r.PLATFORM_SAFE()), 0);
        assertLe(r.booked(row.token), manager.balanceOf(address(r), uint160(row.token)));
        assertEq(ACTOR.balance, nativeBefore, "no ETH spent on ERC-20 creation/trades");
        assertEq(usdc.balanceOf(ACTOR) + usdc.balanceOf(DEPLOYER) + usdc.balanceOf(address(manager))
            + usdc.balanceOf(fit) + usdc.balanceOf(r.PLATFORM_SAFE()), issued, "all USDC conserved");
        assertEq(usdc.totalSupply(), issued, "buys and payouts never mint test funds");
        vm.stopPrank();
    }

    function test_stockAndGoldCreationTradesGraduationAndExitsConserveMoney() public {
        for (uint8 mode = 7; mode <= 8; ++mode) {
            vm.startPrank(ACTOR);
            uint256 nativeBefore = ACTOR.balance;
            BoxCoordinatorV2 b = _createLocal(mode);
            uint32 id = mode == 7 ? 4 : 6;
            ListingRecord memory row = IListingRegistry(localFactory.listingRegistry()).listing(id);
            LocalERC20 p = LocalERC20(row.token);
            assertEq(b.pricingListingId(), id); assertEq(b.raise(), row.raise);
            assertEq(p.allowance(ACTOR, address(localFactory)), 0);
            assertEq(p.balanceOf(address(localFactory)), 0);
            uint256 issued = p.totalSupply();
            vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1);
            for (uint256 i; i < 3; ++i) {
                uint256 beforeT = BoxTokenV2(b.token()).balanceOf(ACTOR);
                uint256 beforeP = p.balanceOf(ACTOR);
                _tradeLocal(b);
                assertGt(BoxTokenV2(b.token()).balanceOf(ACTOR), beforeT);
                assertLt(p.balanceOf(ACTOR), beforeP);
                assertEq(p.allowance(ACTOR, address(localSwapper)), 0);
            }
            _fillLocal(b); b.graduate(); assertTrue(b.graduated());
            IBoxReceiverV2 r = IBoxReceiverV2(b.receiver()); r.collect(ACTOR);
            uint256 fitOwed = r.fitOwed(); uint256 platformOwed = r.platformOwed();
            assertGt(fitOwed, 0); assertGt(platformOwed, 0);
            assertEq(r.payFit(), fitOwed); assertEq(r.payPlatform(), platformOwed);
            r.claimCreator(row.token, ACTOR); b.claimReward(ACTOR);
            assertEq(p.balanceOf(fit), fitOwed); assertEq(p.balanceOf(r.PLATFORM_SAFE()), platformOwed);
            assertLe(r.booked(row.token), manager.balanceOf(address(r), uint160(row.token)));
            assertEq(ACTOR.balance, nativeBefore, "stock/gold spend no native money");
            assertEq(p.balanceOf(ACTOR) + p.balanceOf(DEPLOYER) + p.balanceOf(address(manager))
                + p.balanceOf(fit) + p.balanceOf(r.PLATFORM_SAFE()), issued, "stock/gold conservation");
            assertEq(p.totalSupply(), issued, "no trade or payout mints");
            vm.stopPrank();
            vm.startPrank(DEPLOYER);
            LocalV2Custody(payable(fit)).withdrawToken(p, DEPLOYER, fitOwed);
            LocalV2Custody(payable(r.PLATFORM_SAFE())).withdrawToken(p, DEPLOYER, platformOwed);
            vm.stopPrank();
            assertEq(p.balanceOf(fit) + p.balanceOf(r.PLATFORM_SAFE()), 0, "custody has owner exits");
        }
    }

    function test_bothStockIssuersAloneCanPauseFreezeAndRestoreTransfers() public {
        for (uint32 id = 4; id <= 5; ++id) {
            LocalERC20 p = LocalERC20(IListingRegistry(localFactory.listingRegistry()).listing(id).token);
            vm.prank(DEPLOYER); p.transfer(ACTOR, 3 ether);
            vm.prank(ACTOR); p.approve(DEPLOYER, 2 ether);
            address controls = LocalStockMetadata(address(p)).controls();
            assertEq(controls, LocalStockMetadata(IListingRegistry(localFactory.listingRegistry()).listing(4).token).controls(),
                "one local issuer controls both stocks");
            bytes memory pause = abi.encodeWithSignature("setPaused(bool)", true);
            vm.prank(ACTOR); (bool ok,) = controls.call(pause); assertFalse(ok, "issuer only");
            vm.prank(DEPLOYER); (ok,) = controls.call(pause); assertTrue(ok, "issuer can pause");
            vm.prank(ACTOR); vm.expectRevert("local coin paused"); p.transfer(DEPLOYER, 1 ether);
            vm.prank(DEPLOYER); vm.expectRevert("local coin paused"); p.transferFrom(ACTOR, DEPLOYER, 1 ether);
            assertEq(p.allowance(ACTOR, DEPLOYER), 2 ether, "refused transfer keeps approval");
            _issuerCall(address(p), abi.encodeWithSignature("setPaused(bool)", false));
            bytes memory freeze = abi.encodeWithSignature("setFrozen(address,bool)", ACTOR, true);
            vm.prank(ACTOR); (ok,) = controls.call(freeze); assertFalse(ok, "issuer only freeze");
            _issuerCall(address(p), freeze);
            vm.prank(ACTOR); vm.expectRevert("local address frozen"); p.transfer(DEPLOYER, 1 ether);
            vm.prank(DEPLOYER); vm.expectRevert("local address frozen"); p.transfer(ACTOR, 1 ether);
            vm.prank(DEPLOYER); vm.expectRevert("local address frozen"); p.transferFrom(ACTOR, DEPLOYER, 1 ether);
            assertEq(p.balanceOf(ACTOR), 3 ether);
            _issuerCall(address(p), abi.encodeWithSignature("setFrozen(address,bool)", ACTOR, false));
            vm.prank(DEPLOYER); assertTrue(p.transferFrom(ACTOR, DEPLOYER, 2 ether));
            assertEq(p.balanceOf(ACTOR), 1 ether); assertEq(p.allowance(ACTOR, DEPLOYER), 0);
        }
    }

    function test_pausedStockFailureAndFrozenClaimPreserveMoneyForOwnerRetry() public {
        vm.startPrank(ACTOR); BoxCoordinatorV2 b = _createLocal(7); vm.stopPrank();
        LocalERC20 p = LocalERC20(IListingRegistry(localFactory.listingRegistry()).listing(4).token);
        _issuerCall(address(p), abi.encodeWithSignature("setPaused(bool)", true));
        vm.warp(b.deadline()); vm.prank(ACTOR); b.fail(); assertTrue(b.failed());
        uint256 amount = BoxTokenV2(b.token()).balanceOf(ACTOR);
        uint256 quote = b.quoteClaim(amount); assertGt(quote, 0);
        (uint256 pot, uint256 left) = b.claimState();
        BoxTokenV2 t = BoxTokenV2(b.token());
        vm.prank(ACTOR); t.approve(address(b), amount);
        assertEq(t.allowance(ACTOR, address(b)), amount);
        vm.prank(ACTOR); vm.expectRevert(); b.claim(amount, ACTOR);
        _issuerCall(address(p), abi.encodeWithSignature("setPaused(bool)", false));
        _issuerCall(address(p), abi.encodeWithSignature("setFrozen(address,bool)", ACTOR, true));
        vm.prank(ACTOR); vm.expectRevert(); b.claim(amount, ACTOR);
        (uint256 unchangedPot, uint256 unchangedLeft) = b.claimState();
        assertEq(unchangedPot, pot); assertEq(unchangedLeft, left);
        assertEq(BoxTokenV2(b.token()).balanceOf(ACTOR), amount, "failed payouts never consume T");
        _issuerCall(address(p), abi.encodeWithSignature("setFrozen(address,bool)", ACTOR, false));
        uint256 beforeP = p.balanceOf(ACTOR);
        vm.prank(ACTOR); assertEq(b.claim(amount, ACTOR), quote);
        assertEq(p.balanceOf(ACTOR), beforeP + quote);
        (uint256 potAfter, uint256 leftAfter) = b.claimState();
        assertEq(potAfter + quote, pot); assertEq(leftAfter + amount, left);
    }

    function _issuerCall(address coin, bytes memory data) private {
        address controls = LocalStockMetadata(coin).controls();
        vm.prank(DEPLOYER); (bool ok,) = controls.call(data); assertTrue(ok, "local issuer control exists");
    }

    function _containsLocalMock(string memory name) private pure returns (bool) {
        bytes memory raw = bytes(name); bytes memory suffix = bytes("(local mock)");
        if (raw.length < suffix.length) return false;
        for (uint256 i; i < suffix.length; ++i) if (raw[raw.length - suffix.length + i] != suffix[i]) return false;
        return true;
    }

    function test_localListerRejectsAnotherActorWithoutSpendingProbeFunds() public {
        IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
        ListingRecord memory row = listings.listing(1);
        LocalV2Custody platform = LocalV2Custody(payable(listings.lister()));
        vm.prank(ACTOR);
        vm.expectRevert("local owner only");
        platform.listPriceCoin(listings, LocalERC20(row.token), row.class, row.raise);
        assertEq(listings.listingCount(), 8);
        assertEq(LocalERC20(row.token).allowance(listings.lister(), address(listings)), 0);
    }

    function test_localCustodyPriceCoinsHaveAnOwnerOnlyExit() public {
        LocalERC20 coin = LocalERC20(IListingRegistry(localFactory.listingRegistry()).listing(1).token);
        vm.prank(DEPLOYER); coin.transfer(fit, 1000e6);
        bytes memory call = abi.encodeWithSignature("withdrawToken(address,address,uint256)", address(coin), ACTOR, 1000e6);
        vm.prank(ACTOR); (bool ok,) = fit.call(call);
        assertFalse(ok, "another actor cannot withdraw");
        assertEq(coin.balanceOf(fit), 1000e6);
        uint256 beforeP = coin.balanceOf(ACTOR);
        vm.prank(DEPLOYER); (ok,) = fit.call(call);
        assertTrue(ok, "local custody owner needs an ERC-20 exit");
        assertEq(coin.balanceOf(fit), 0); assertEq(coin.balanceOf(ACTOR), beforeP + 1000e6);
    }

    function test_usdcFailureHasAnExactOwnerClaimExit() public {
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(6);
        LocalERC20 p = LocalERC20(IListingRegistry(localFactory.listingRegistry()).listing(1).token);
        vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1); _tradeLocal(b);
        vm.warp(b.deadline()); b.fail();
        uint256 amount = BoxTokenV2(b.token()).balanceOf(ACTOR);
        uint256 quote = b.quoteClaim(amount); assertGt(quote, 0);
        (uint256 pot, uint256 left) = b.claimState();
        uint256 beforeP = p.balanceOf(ACTOR);
        BoxTokenV2(b.token()).approve(address(b), amount);
        assertEq(b.claim(amount, ACTOR), quote);
        assertEq(p.balanceOf(ACTOR), beforeP + quote);
        (uint256 potAfter, uint256 leftAfter) = b.claimState();
        assertEq(potAfter + quote, pot); assertEq(leftAfter + amount, left);
        assertEq(BoxTokenV2(b.token()).balanceOf(ACTOR), 0);
        vm.stopPrank();
    }

    function test_plainRealFeesHarvestGraduationDeepenAndConservation() public {
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(0);
        uint256 total = _money(b);
        vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        _tradeLocal(b);
        IBoxHookV2 h = IBoxHookV2(b.hook());
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver());
        // F137: a curve sale pays 1% of its T, which the hook holds (realized at collection) and burns at graduation:
        // no sellers' P waits.
        assertEq(h.saleFeesPending(), 0);
        vm.recordLogs();
        r.collect(ACTOR); assertEq(h.saleFeesPending(), 0);
        assertGt(manager.balanceOf(address(h), uint256(uint160(b.token()))), 0, "curve sale fee held in T");
        (uint256 buys, uint256 sells) = _collected(r);
        assertGt(buys, 0, "plain buyers booked"); assertEq(sells, 0, "a curve sale's fee is T, not sellers' P");
        (uint256 buyersCounter, uint256 sellersCounter,) = r.harvestedFees();
        assertEq(buyersCounter, 0, "plain has no holder/item source counters");
        assertEq(sellersCounter, 0, "zero counter is not a lost sale fee");
        _fillLocal(b); b.graduate(); assertTrue(b.graduated());
        vm.roll(block.number + 1); _tradeLocal(b);
        // After graduation the public sellFees step sells the sale's T fee for P, booked as sellers' fees.
        assertGt(_sellLocalFees(b), 0, "graduated sale fee sold");
        vm.recordLogs();
        r.collect(ACTOR);
        (, sells) = _collected(r);
        assertGt(sells, 0, "plain sellers booked after graduation");
        uint128 beforeL = h.pairedLiquidity(); vm.roll(block.number + 1);
        h.deepen(ACTOR); assertGt(h.pairedLiquidity(), beforeL);
        assertGt(r.fitOwed(), 0);
        r.payFit(); assertGt(fit.balance, 0); r.payPlatform(); r.claimCreator(address(0), ACTOR);
        assertLe(r.booked(address(0)), manager.balanceOf(address(r), 0));
        assertEq(_money(b), total, "ETH conserved across pool, custody, fees, rewards and tips");
        vm.stopPrank();
    }

    function test_holderPayoutIsOwnerClaimOnlyAndNoAutomaticPayment() public {
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(1);
        vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        _tradeLocal(b);
        uint256 beforeP = ACTOR.balance;
        IBoxReceiverV2(b.receiver()).collect(address(0xB0B));
        IHolderLedgerV2 ledger = IHolderLedgerV2(b.roleAddress(17));
        ledger.settleBatch(1, 64);
        assertEq(ACTOR.balance, beforeP, "collect/settle never pushes holder P (F127)");
        uint256 credit = ledger.claimable(1, ACTOR); assertGt(credit, 0);
        assertEq(ledger.claim(1, ACTOR), credit);
        assertEq(ACTOR.balance, beforeP + credit); assertEq(ledger.claimable(1, ACTOR), 0);
        vm.expectRevert(); ledger.claim(1, ACTOR);
        vm.stopPrank();
    }

    function test_shopRealSeedGiveAndPickConserveTokenAndCustody() public {
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(2); _loadLocalShop(b);
        assertTrue(b.gateOpen());
        vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        _fillLocal(b); b.graduate(); vm.warp(block.timestamp + 7 days);
        IShopVaultV2 shop = IShopVaultV2(b.vault());
        uint256 beforeT = BoxTokenV2(b.token()).balanceOf(ACTOR);
        uint256 budget = shop.budgetT(); _givePickLocal(b);
        assertEq(localNft.ownerOf(100), ACTOR);
        assertEq(shop.budgetT(), budget + 0.5 ether);
        assertEq(BoxTokenV2(b.token()).balanceOf(ACTOR), beforeT - 0.5 ether);
        assertEq(shop.inside(), 10);
        vm.stopPrank();
    }

    function test_failurePartialClaimThenYearStillPreservesClaims() public {
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(3);
        vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1); _tradeLocal(b);
        vm.warp(b.deadline()); b.fail();
        (uint256 pot, uint256 left) = b.claimState();
        uint256 amount = BoxTokenV2(b.token()).balanceOf(ACTOR) / 2;
        uint256 quote = b.quoteClaim(amount); uint256 beforeP = ACTOR.balance;
        BoxTokenV2(b.token()).approve(address(b), amount);
        assertEq(b.claim(amount, ACTOR), quote); assertEq(ACTOR.balance, beforeP + quote);
        (uint256 remaining, uint256 leftAfter) = b.claimState();
        assertEq(remaining + quote, pot); assertEq(leftAfter + amount, left);
        vm.warp(b.failedAt() + 365 days - 1); NoFailureSweep.check(address(b));
        vm.warp(b.failedAt() + 365 days);
        NoFailureSweep.check(address(b));
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver());
        uint256 owed = r.fitOwed(); uint256 beforeFit = fit.balance;
        assertEq(r.payFit(), owed); assertEq(fit.balance, beforeFit + owed);
        (remaining,) = b.claimState(); assertEq(remaining, pot - quote);
        assertEq(b.quoteClaim(leftAfter), remaining);
        vm.stopPrank();
    }

    function test_everyItemRealCreationGraduationAndOwnerClaim() public {
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(4);
        _loadLocalM3(b, 4);
        assertTrue(b.gateOpen());
        vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        _tradeLocal(b); IBoxReceiverV2(b.receiver()).collect(address(0xB0B));
        _fillLocal(b); b.graduate();
        // Broadcasts must retain the named budget, even when measured consumption is much lower.
        vm.expectCall(b.vault(), 0, uint64(15_000_000), abi.encodeWithSelector(IBoxVaultV2.withdraw.selector));
        _withdrawLocalItem(b);
        assertEq(BoxCollectionV2(b.collection()).ownerOf(1), ACTOR);
        vm.roll(block.number + 1); _tradeLocal(b);
        IBoxReceiverV2(b.receiver()).collect(address(0xB0B));
        IItemLedgerV2 ledger = IItemLedgerV2(b.roleAddress(16));
        uint256 beforeP = ACTOR.balance;
        ledger.sync(32); assertEq(ACTOR.balance, beforeP, "sync cannot push owner money");
        (uint256 outside, uint256 stash) = ledger.itemCredit(1);
        assertGt(outside + stash, 0);
        uint256[] memory ids = new uint256[](1); ids[0] = 1;
        assertEq(ledger.claim(ids, ACTOR), outside + stash);
        assertEq(ACTOR.balance, beforeP + outside + stash);
        (outside, stash) = ledger.itemCredit(1); assertEq(outside + stash, 0);
        vm.stopPrank();
    }

    function test_coinPileRealSeedGraduationAndRedemption() public {
        vm.startPrank(ACTOR);
        BoxCoordinatorV2 b = _createLocal(5);
        IPileVaultV2 pile = IPileVaultV2(b.vault());
        assertEq(b.roleAddress(19), b.vault());
        assertFalse(b.gateOpen()); assertEq(b.vault().balance, 0);
        pile.loadSeed{value: 1 ether}(); assertTrue(b.gateOpen());
        vm.warp(b.effectiveOpenAt() + 384); vm.roll(block.number + 1);
        _fillLocal(b); b.graduate();
        BoxTokenV2 t = BoxTokenV2(b.token());
        uint256 beforeT = t.balanceOf(ACTOR); uint256 supply = t.totalSupply();
        uint256 amount = beforeT / 4;
        uint256 quote = pile.quoteRedeem(amount); assertGt(quote, 0);
        t.approve(b.vault(), amount);
        uint256 beforeP = ACTOR.balance;
        assertEq(pile.redeem(amount, quote, ACTOR), quote);
        assertEq(ACTOR.balance, beforeP + quote);
        assertEq(b.vault().balance, 1 ether - quote);
        assertEq(t.totalSupply(), supply - amount); assertEq(t.balanceOf(ACTOR), beforeT - amount);
        vm.stopPrank();
    }

    /// @dev The receiver's Collected amounts from the recorded logs (exactly one receipt expected).
    function _collected(IBoxReceiverV2 r) private returns (uint256 buys, uint256 sells) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(r) && logs[i].topics[0] == keccak256("Collected(address,address,uint256,uint256,uint256,uint256)")) {
                (, buys, sells,,) = abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256));
                ++found;
            }
        }
        assertEq(found, 1, "receipt present");
    }

    function _money(BoxCoordinatorV2 b) private view returns (uint256) {
        IBoxReceiverV2 r = IBoxReceiverV2(b.receiver());
        return ACTOR.balance + address(manager).balance + fit.balance + r.PLATFORM_SAFE().balance
            + address(b).balance + b.receiver().balance + b.launchRouter().balance
            + b.hook().balance + address(localSwapper).balance;
    }
}

interface LocalCoinMetadata {
    function symbol() external view returns (string memory);
    function name() external view returns (string memory);
}

interface LocalStockMetadata { function controls() external view returns (address); }
