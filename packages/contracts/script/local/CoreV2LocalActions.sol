// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxFactoryV2} from "../../src/box-v2/BoxFactoryV2.sol";
import {BoxCoordinatorV2} from "../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../src/box-v2/BoxTokenV2.sol";
import {IBoxHookV2, ProtocolSkip} from "../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IListingRegistry} from "../../src/box-v2/interfaces/IListingRegistry.sol";
import {IShopVaultV2, IStarterSetLoaderV2, ShopConfigV2} from "../../src/box-v2/interfaces/IShopVaultV2.sol";
import {SparseBoxTree} from "../../test/box/items/BoxItemsKit.sol";
import {BoxVaultV2} from "../../src/box-v2/BoxVaultV2.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BoxCollectionV2} from "../../src/box-v2/BoxCollectionV2.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";
import {BoxFactoryV2Parts} from "../../src/box-v2/BoxFactoryV2Parts.sol";
import {ChunkPart} from "../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxVaultV2} from "../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {IPileVaultV2} from "../../src/box-v2/interfaces/IPileVaultV2.sol";
import {BoxSpec, AddOn} from "../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch, Side} from "../../src/box-v2/interfaces/RecipeTypes.sol";
import {BoxClones} from "../../src/box/libraries/BoxClones.sol";
import {BoxLayoutV2} from "../../src/box-v2/libraries/BoxLayoutV2.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {HostileCollection} from "../../test/box-v2/kit/m2/ShopDoubles.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {LocalPriceCoin} from "./LocalQuoteMocks.sol";
import {LocalBoxArt} from "./LocalBoxArt.sol";
import {CoreV2GasRules} from "../sepolia-v2/CoreV2GasRules.sol";

/// @notice Local script/test actions. The caller establishes an unlocked broadcast or test prank as localActor.
abstract contract CoreV2LocalActions is CoreV2GasRules {
    // Explicit per-transaction broadcast gas: consumed gas does not cover fail-safe gasleft floors.
    uint256 internal constant LOCAL_TX_GAS = 15_000_000; // Below EIP-7825, same as the JS direct sender.
    // Local/rehearsal recipes: measured with Amsterdam state costs, separate from ordinary call floors.
    uint256 internal constant LOCAL_CREATE_GAS = 16_500_000;
    event LocalCreationGas(string symbol, uint256 totalGas, uint256 stateGas, uint256 intrinsicGas);

    BoxFactoryV2 internal localFactory;
    PriceLimitSwapper internal localSwapper;
    HostileCollection internal localNft;
    address internal localActor;

    /// @dev Broadcasts advance on anvil (--slow); offline tests override this to model each mined transaction.
    function _beforeLocalTransaction() internal virtual {}

    /// @dev mode: 0 plain keep/grow, 1 holders, 2 shop, 3 failing keep, 4 every item, 5 seed-only pile, 6 USDC, 7 NVDAon, 8 PAXG.
    function _localSpec(uint8 mode) internal view returns (BoxSpec memory s) {
        require(mode <= 8, "unknown local box recipe");
        s.format = 2; s.version = 2; s.boxType = mode == 2 ? 4 : 3;
        s.tokenName = mode == 0 ? "Local Plain" : mode == 1 ? "Local Holders" : mode == 2 ? "Local Shop" : "Local Failure";
        s.tokenSymbol = mode == 0 ? "PLAIN" : mode == 1 ? "HOLD" : mode == 2 ? "SHOP" : "FAIL";
        s.raise = IListingRegistry(localFactory.listingRegistry()).listing(0).raise;
        if (mode >= 6) {
            IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
            uint32 id = mode == 6 ? 1 : mode == 7 ? 4 : 6;
            string memory symbol = mode == 6 ? "USDC" : mode == 7 ? "NVDAon" : "PAXG";
            s.pricing.listingId = id; s.pricing.token = listings.listing(id).token;
            require(keccak256(bytes(LocalPriceCoinMetadata(s.pricing.token).symbol())) == keccak256(bytes(symbol)),
                "local price coin listing required");
            s.raise = listings.listing(id).raise;
            s.tokenName = string.concat("Local ", symbol);
            s.tokenSymbol = mode == 6 ? "USDBOX" : mode == 7 ? "STOCKBOX" : "GOLDBOX";
        }
        s.layout = 1; s.gradLayout = 3; s.launchFormat = 1; s.deadlineDays = 30;
        s.creatorBuy = s.raise / 100; s.coverSha256 = LocalBoxArt.logo(mode);
        s.buyers.split = 1; s.sellers.split = 1;
        if (mode == 1 || mode == 2) {
            s.buyers.a = Branch(1, 6, "", abi.encode(uint8(1)));
            s.sellers = abi.decode(abi.encode(s.buyers), (Side));
        } else {
            s.buyers.a = Branch(1, 2, "", ""); // keep
            s.sellers.a = Branch(1, mode == 0 ? 4 : 2, "", "");
            s.creatorFeeRecipient = localActor;
        }
        if (mode == 4) {
            // Keep the committed item metadata table; the collection cover is our local catalogued PNG.
            string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/box-spec/box-spec-v1.json"));
            BoxSpecV1.BoxSpec memory v = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[2]"), (BoxSpecV1.BoxSpec));
            s.boxType = 1; s.tokenName = "Local Every Item"; s.tokenSymbol = "ITEM";
            s.collectionName = "Local Items"; s.collectionSymbol = "ITEMS";
            (s.n, s.firstId, s.artMode, s.metadataTable) = (10, 1, v.artMode, v.metadataTable);
            (uint256[] memory positions, bytes32[] memory leaves) = _localItemTree();
            s.revealRoot = SparseBoxTree.root(4, positions, leaves);
            (s.generatorHash, s.revealListId) = (v.generatorHash, v.revealListId);
            (s.marketplaceOwner, s.collectionCoverSha256) = (v.marketplaceOwner, LocalBoxArt.ITEMS_COVER);
            s.pickFeeBps = 100; s.creatorFeeRecipient = address(0);
            s.buyers.a = Branch(1, 8, "", abi.encode(uint8(1)));
            s.sellers = abi.decode(abi.encode(s.buyers), (Side));
        }
        if (mode == 5) {
            s.boxType = 5; s.tokenName = "Local Coin Pile"; s.tokenSymbol = "PILE";
            s.contentsParams = abi.encode(address(0), uint256(1 ether));
        }
        if (mode == 2) {
            s.sellers.a = Branch(2, 7, "", abi.encode(uint8(2)));
            ShopConfigV2 memory cfg;
            cfg.seedT = 1000 ether; cfg.givePricesT = [uint256(1 ether), 2 ether, 4 ether, 8 ether];
            cfg.pickBps = 15000; cfg.weeklyBps = 1000; cfg.collectionBps = 250;
            cfg.listDelay = 7 days; cfg.curator = localActor;
            cfg.collections = new address[](1); cfg.collections[0] = address(localNft);
            cfg.tiers = new uint8[](1); s.contentsParams = abi.encode(cfg);
            bytes32 root;
            for (uint256 i = 10; i != 0;) { --i; root = keccak256(abi.encode(address(localNft), i, uint8(0), root)); }
            s.addOns = new AddOn[](2); s.addOns[0] = AddOn(7, ""); s.addOns[1] = AddOn(8, abi.encode(root, uint32(10)));
        }
    }

    function _createLocal(uint8 mode) internal returns (BoxCoordinatorV2 b) {
        BoxSpec memory s = _localSpec(mode);
        bytes32 cs; bytes32 hs; address predicted; bytes32 initHash;
        // Each spec is different, so the salts can start from zero independently.
        for (uint256 i;; ++i) {
            address t; cs = bytes32(i);
            (predicted, t, initHash) = localFactory.predictBox(localActor, s, cs);
            if (t > s.pricing.token && t < localFactory.tokenAddressLimit(s.pricing.token)) break;
        }
        for (uint256 i;; ++i) {
            hs = bytes32(i); address h = BoxClones.predict(predicted, hs, initHash);
            if (uint160(h) & 0x3fff == 0x2ae0 && uint160(h) >> 152 != 0x91) break;
        }
        uint256 payment = localFactory.boxQParameters(s.pricing.listingId, s.raise).bootstrapQ + s.creatorBuy;
        uint256 value = payment;
        if (s.pricing.token != address(0)) {
            LocalPriceCoin coin = LocalPriceCoin(s.pricing.token);
            _beforeLocalTransaction();
            coin.mint{gas: LOCAL_TX_GAS}(localActor, s.raise * 10);
            _beforeLocalTransaction();
            require(coin.approve{gas: LOCAL_TX_GAS}(address(localFactory), payment), "local creation approval");
            value = 0;
        }
        _beforeLocalTransaction();
        address c = _createLocalBox(s, cs, hs, value);
        if (s.pricing.token != address(0)) {
            _beforeLocalTransaction();
            require(LocalPriceCoin(s.pricing.token).approve{gas: LOCAL_TX_GAS}(address(localFactory), 0), "local creation approval cleared");
        }
        return BoxCoordinatorV2(c);
    }

    /// @dev Actor context spends only the quoted creation payment. Measurement excludes salt mining.
    /// Keep the explicit envelope plus worst calldata floor below EIP-7825 and check execution/block room.
    function _createLocalBox(BoxSpec memory s, bytes32 cs, bytes32 hs, uint256 value)
        internal returns (address c)
    {
        uint256 intrinsic = 21_000 + abi.encodeCall(localFactory.createBox, (s, cs, hs)).length * 40;
        require(LOCAL_CREATE_GAS + intrinsic <= TX_GAS_CAP, "creation transaction cap");
        uint256 beforeGas = gasleft();
        (, c,) = localFactory.createBox{value: value, gas: LOCAL_CREATE_GAS}(s, cs, hs);
        uint256 used = beforeGas - gasleft();
        uint256 stateGas = _frameStateGas();
        _checkGasStep(GasStep("local createBox", used + intrinsic, stateGas, true), stateGas != 0, block.gaslimit);
        emit LocalCreationGas(s.tokenSymbol, used, stateGas, intrinsic);
    }

    function _loadLocalShop(BoxCoordinatorV2 b) internal {
        address[] memory collections = new address[](10);
        uint256[] memory ids = new uint256[](10); uint8[] memory tiers = new uint8[](10);
        for (uint256 i; i < 10; ++i) {
            collections[i] = address(localNft); ids[i] = i;
            _beforeLocalTransaction(); localNft.mint{gas: LOCAL_TX_GAS}(localActor, i);
        }
        _beforeLocalTransaction();
        BoxTokenV2(b.token()).approve{gas: LOCAL_TX_GAS}(b.vault(), 1000 ether);
        _beforeLocalTransaction();
        localNft.setApprovalForAll{gas: LOCAL_TX_GAS}(b.vault(), true);
        _beforeLocalTransaction();
        IStarterSetLoaderV2(b.starterSetLoader()).load{gas: LOCAL_TX_GAS}(collections, ids, tiers, 0);
        _beforeLocalTransaction(); IShopVaultV2(b.vault()).fundSeed{gas: LOCAL_TX_GAS}();
        _beforeLocalTransaction(); IStarterSetLoaderV2(b.starterSetLoader()).complete{gas: LOCAL_TX_GAS}();
    }

    /// @dev The creator loads the exact committed chunks or native seed; both paths open their creation gate.
    function _loadLocalM3(BoxCoordinatorV2 b, uint8 mode) internal {
        if (mode == 5) {
            _beforeLocalTransaction(); IPileVaultV2(b.vault()).loadSeed{value: 1 ether, gas: LOCAL_TX_GAS}(); return;
        }
        BoxSpec memory s = _localSpec(4);
        if (!b.gateOpen()) {
            _beforeLocalTransaction(); b.loadChunk{gas: LOCAL_TX_GAS}(ChunkPart.Table, s.metadataTable, 0);
        }
        if (!b.gateOpen()) {
            BoxFactoryV2Parts.Box memory encoding;
            (, bytes memory texts) = localFactory.planner().parts().partArgs(encoding, s);
            _beforeLocalTransaction(); b.loadChunk{gas: LOCAL_TX_GAS}(ChunkPart.Texts, texts, 0);
        }
        require(b.gateOpen(), "local item chunks did not open the gate");
        (uint256[] memory positions, bytes32[] memory leaves) = _localItemTree();
        for (uint256 id = 1; id <= 10; ++id) {
            _beforeLocalTransaction();
            BoxCollectionV2(b.collection()).reveal{gas: LOCAL_TX_GAS}(id, 0, _localItemImage(id), 0, 0, 0,
                SparseBoxTree.proof(4, id - 1, positions, leaves));
        }
    }

    /// @dev Deterministic local art commitments; all ten proofs remain available, so any item can leave.
    function _localItemTree() private pure returns (uint256[] memory positions, bytes32[] memory leaves) {
        positions = new uint256[](10); leaves = new bytes32[](10);
        for (uint256 i; i < 10; ++i) {
            positions[i] = i;
            leaves[i] = SparseBoxTree.leaf(i + 1, 0, _localItemImage(i + 1), 0, 0, 0);
        }
    }

    /// @dev The every-item recipe's committed picture hash of item `id`, in the reveal tree and the reveals alike.
    /// Here `bytes32(id)`: synthetic test art no picture matches, which PrepareCoreV2Box's reveal calls and tuples also
    /// commit, so the Sepolia preparation and the whole-release rehearsals (SepoliaAllRehearsal) keep their tree byte
    /// for byte. Only the local stack's recipe (CoreV2LocalPictures, run by CoreV2LocalLife) overrides it (SH-TA-33).
    function _localItemImage(uint256 id) internal pure virtual returns (bytes32) {
        return bytes32(id);
    }

    /// @dev The local actor spends only its approved T, using the live vault quote and its transaction deadline.
    function _withdrawLocalItem(BoxCoordinatorV2 b) internal {
        uint256 principal = IBoxVaultV2(b.vault()).quoteWithdraw(1);
        uint256 amount = principal + FullMath.mulDivRoundingUp(principal, BoxVaultV2(b.vault()).pickFeeBps(), 10000);
        _beforeLocalTransaction();
        BoxTokenV2(b.token()).approve{gas: LOCAL_TX_GAS}(b.vault(), amount);
        _beforeLocalTransaction();
        IBoxVaultV2(b.vault()).withdraw{gas: LOCAL_TX_GAS}(1, amount, block.timestamp + 1 hours);
    }

    function _tradeLocal(BoxCoordinatorV2 b) internal {
        IBoxHookV2 h = IBoxHookV2(b.hook());
        uint256 amount = b.raise() / 10;
        uint256 beforeT = BoxTokenV2(b.token()).balanceOf(localActor);
        uint160 limit = b.graduated() ? 0 : BoxLayoutV2.curve(b.raise(), false).sqrtPriceEndX96;
        _buyLocal(h, amount, limit);
        uint256 sale = (BoxTokenV2(b.token()).balanceOf(localActor) - beforeT) / 4;
        _beforeLocalTransaction(); BoxTokenV2(b.token()).approve{gas: LOCAL_TX_GAS}(address(localSwapper), sale);
        limit = b.graduated() ? 0 : BoxLayoutV2.curve(b.raise(), false).sqrtPriceStartX96;
        _beforeLocalTransaction(); localSwapper.swap{gas: LOCAL_TX_GAS}(h.poolKey(), false, -int256(sale), limit);
    }

    /// @dev F137: after graduation a sale's 1% T fee waits in the hook until the public `sellFees()` step sells it for
    /// P in the box's own pool. Until then that seller source pays nothing and, in a box with batches, later sources
    /// wait behind it. Press the step once per block (each sells within 49 ticks) until what waits is below the step
    /// minimum; if nothing was sold yet, trade again first. Returns the P sold.
    function _sellLocalFees(BoxCoordinatorV2 b) internal returns (uint256 pOut) {
        IBoxHookV2 h = IBoxHookV2(b.hook());
        for (uint256 i; i < 64; ++i) {
            _beforeLocalTransaction();
            (ProtocolSkip skip,, uint256 sold,) = h.sellFees{gas: LOCAL_TX_GAS}();
            if (skip == ProtocolSkip.None) {
                pOut += sold;
                continue;
            }
            // Below the minimum, or (without block advancement) this block's step is already taken: done once sold.
            if (pOut != 0) return pOut;
            require(skip == ProtocolSkip.BelowMinimum, "local sale fees: step already taken");
            _tradeLocal(b);
        }
        revert("local sale fees did not settle in 64 steps");
    }

    function _fillLocal(BoxCoordinatorV2 b) internal {
        IBoxHookV2 h = IBoxHookV2(b.hook());
        uint160 limit = BoxLayoutV2.curve(b.raise(), false).sqrtPriceEndX96;
        for (uint256 i; i < 5 && !h.closed(); ++i) {
            uint256 amount = b.raise() / 4;
        _buyLocal(h, amount, limit);
        }
        require(h.closed(), "local curve did not fill");
    }

    /// @dev Local actor pays its own P only, with exact approval cleared even after a partial fill.
    function _buyLocal(IBoxHookV2 hook, uint256 amount, uint160 limit) private {
        address p = Currency.unwrap(hook.poolKey().currency0);
        if (p != address(0)) {
            _beforeLocalTransaction();
            require(LocalPriceCoin(p).approve{gas: LOCAL_TX_GAS}(address(localSwapper), amount), "local buy approval");
        }
        _beforeLocalTransaction();
        localSwapper.swap{value: p == address(0) ? amount : 0, gas: LOCAL_TX_GAS}(hook.poolKey(), true, -int256(amount), limit);
        if (p != address(0)) {
            _beforeLocalTransaction();
            require(LocalPriceCoin(p).approve{gas: LOCAL_TX_GAS}(address(localSwapper), 0), "local buy approval cleared");
        }
    }

    function _givePickLocal(BoxCoordinatorV2 b) internal {
        IShopVaultV2 shop = IShopVaultV2(b.vault());
        _beforeLocalTransaction();
        localNft.mint{gas: LOCAL_TX_GAS}(localActor, 100);
        _beforeLocalTransaction();
        shop.give{gas: LOCAL_TX_GAS}(address(localNft), 100, 1 ether);
        _beforeLocalTransaction();
        BoxTokenV2(b.token()).approve{gas: LOCAL_TX_GAS}(b.vault(), 1.5 ether);
        _beforeLocalTransaction();
        shop.pick{gas: LOCAL_TX_GAS}(address(localNft), 100, 1.5 ether, localActor);
    }
}

/// @notice Local fixture metadata only; anyone reads the symbol without moving funds.
interface LocalPriceCoinMetadata { function symbol() external view returns (string memory); }
