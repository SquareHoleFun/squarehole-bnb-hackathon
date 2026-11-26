// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {StarterGateTest} from "../m2-seam/StarterGate.t.sol";
import {IHolderLedgerV2, IHolderTokenHistoryV2, HolderLedgerLimitsV2 as H} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {IShopVaultV2, IStarterSetLoaderV2, ShopConfigV2, ShopLimitsV2 as S} from "../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {IBoxHolderBatchNoticeV2, IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxShopLifecycleV2} from "../../../src/box-v2/interfaces/IBoxShopLifecycleV2.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxSpec, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {BoxRolesV2 as R} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {M2SeamArgs} from "../../../src/box-v2/libraries/M2SeamArgs.sol";

/// Reuse the supplied real-coordinator gate regressions as the freeze's executable dependency pins.
/// Covers both AND orders, no chunks, loader authorization, rollback/retry, once-only and no reopening.
contract FrozenGateTest is StarterGateTest { }

contract SeamsTest is Test {
    function test_ownedSelectorsAndFrozenUpstreamSelectors() public pure {
        assertEq(IHolderLedgerV2.claim.selector, bytes4(keccak256("claim(uint256,address)")));
        assertEq(IHolderLedgerV2.onTokenCheckpoint.selector, bytes4(keccak256("onTokenCheckpoint(uint256,address,address)")));
        assertEq(IHolderTokenHistoryV2.eligibleBalanceAt.selector, bytes4(keccak256("eligibleBalanceAt(address,uint256)")));
        assertEq(IBoxHolderBatchNoticeV2.onTradeFeeBatch.selector, bytes4(keccak256("onTradeFeeBatch(uint256,address,bool,uint256)")));
        assertEq(IBoxHookV2.tradeBatch.selector, bytes4(keccak256("tradeBatch(uint256)")));
        assertEq(IBoxReceiverV2.holderBatchClosed.selector, bytes4(keccak256("holderBatchClosed(uint256)")));
        assertEq(IBoxShopLifecycleV2.burnFailedT.selector, bytes4(keccak256("burnFailedT()")));
        assertEq(IShopVaultV2.returnStarter.selector, bytes4(keccak256("returnStarter(uint256[])")));
        assertEq(IStarterSetLoaderV2.load.selector, bytes4(keccak256("load(address[],uint256[],uint8[],bytes32)")));
        assertEq(C.HOLDER_NOTICE_GAS, 1_400_000); assertEq(C.TOKEN_SETTLEMENT_GAS, 600_000);
        assertEq(C.HOLDER_NOTICE_RESERVE_GAS, 1_200_000); assertEq(H.TOKEN_SETTLEMENT_RESERVE_GAS, 1_200_000);
        assertEq(H.MAX_SETTLE_STEPS, 64); assertEq(S.MAX_STARTER_BATCH, 32);
    }
    function test_productionEncoderPinsRolesArgumentsAndOpaqueShopContents() public {
        BoxFactoryV2Parts parts = new BoxFactoryV2Parts();
        BoxFactoryV2Parts.Box memory b;
        for (uint256 i; i < 24; ++i) b.roles[i] = address(uint160(0x1000 + i));
        b.nonces = hex"0105031113";
        BoxSpec memory spec; spec.tokenName = "T"; spec.tokenSymbol = "T"; spec.boxType = 4;
        spec.buyers.split = 1; spec.buyers.a.leg = 1; spec.buyers.a.dest = 6; spec.buyers.a.destParams = abi.encode(uint8(1));
        spec.sellers = spec.buyers;
        ShopConfigV2 memory config; config.seedT = 100; config.givePricesT = [uint256(1), 2, 3, 4];
        config.pickBps = 20000; config.weeklyBps = 1000; config.collectionBps = 250; config.listDelay = 7 days;
        spec.contentsParams = abi.encode(config);
        spec.addOns = new AddOn[](1); spec.addOns[0] = AddOn(8, abi.encode(bytes32(uint256(42)), uint32(10)));
        (bytes[] memory args,) = parts.partArgs(b, spec);
        assertEq(R.ROLE_VAULT, 3); assertEq(R.ROLE_HOLDER_LEDGER, 17); assertEq(R.ROLE_STARTER_SET_LOADER, 19);
        assertEq(args[0].length, 137); assertEq(_address(args[0], 40), b.roles[17]);
        assertEq(args[1].length, 263); assertEq(_address(args[1], 223), b.roles[17]);
        assertEq(args[2], bytes.concat(abi.encodePacked(b.roles[0], b.roles[1], b.roles[19]), spec.contentsParams));
        assertEq(args[3], M2SeamArgs.holder(b.roles[0], b.roles[1], b.roles[2], b.roles[5], address(0)));
        assertEq(args[3].length, 100);
        assertEq(args[4], M2SeamArgs.starter(b.roles[0], b.roles[3], bytes32(uint256(42)), 10));
        assertEq(args[4].length, 76);
    }
    function _address(bytes memory data, uint256 offset) private pure returns (address a) {
        assembly ("memory-safe") { a := shr(96, mload(add(add(data, 32), offset))) }
    }
}
