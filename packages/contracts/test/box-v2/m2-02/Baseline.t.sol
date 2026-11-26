// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {NoFailureSweep} from "../rc5-a/NoFailureSweep.sol";

import {Test} from "forge-std/Test.sol";
import {FactoryLife, LifeCustody} from "../kit/FactoryLife.sol";
import {BaselineReader} from "./BaselineReader.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxRolesV2 as R, IBoxRegistryV2} from "../../../src/box-v2/interfaces/IBoxRegistryV2.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2, FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxTokenV2, BoxTokenV2Args as TArgs} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {BoxReceiverV2Args as RArgs, ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {BoxHookV2Args as HArgs} from "../../../src/box-v2/libraries/BoxHookV2Args.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// M202-WIRING / SHAPES / MONEY: factory-built M1, real PoolManager, external extension reader.
contract M2BaselineTest is FactoryLife {
    using PoolIdLibrary for PoolKey;

    function test_frozenRoleIdsAndPackedLengths() public pure {
        assertEq(R.ROLE_VAULT, 3);
        assertEq(R.ROLE_ITEM_LEDGER, 16);
        assertEq(R.ROLE_HOLDER_LEDGER, 17);
        assertEq(R.ROLE_STARTER_SET_LOADER, 19);
        assertEq(R.ROLE_COUNT, 24);
        assertEq(TArgs.LENGTH, 137);
        assertEq(TArgs.LEDGER, 40);
        assertEq(RArgs.LENGTH, 263);
        assertEq(RArgs.HOLDER_LEDGER, 223);
        assertEq(RArgs.ITEM_LEDGER, 243);
        assertEq(HArgs.LENGTH, 211);
        assertEq(IBoxCoordinatorV2.starterSetLoaded.selector, bytes4(0x51faa7f7));
        assertEq(IBoxReceiverV2.holderBatchPaid.selector, bytes4(0x96865e05));
        assertEq(IBoxCoordinatorV2.claim.selector, bytes4(0xddd5e1b2));
    }

    function test_plainBoxKeepsM2SlotsEmptyAndM1RolesAuthentic() public {
        _start(_menu(1, 2));
        _roles(false);
        _readM1();
        assertEq(address(token).code.length, 45 + TArgs.LENGTH);
        assertEq(address(receiver).code.length, 45 + RArgs.LENGTH);
        assertEq(address(hook).code.length, 45 + HArgs.LENGTH);
        assertEq(token.initialHolder(), address(box));
        assertEq(token.vault(), address(0));
        assertEq(receiver.coordinator(), address(box));
        assertEq(receiver.hook(), address(hook));
        assertEq(receiver.token(), address(token));
        assertEq(receiver.registry(), address(registry));
        assertEq(receiver.launchRouter(), box.launchRouter());
        assertEq(receiver.boxId(), box.boxId());
        assertEq(hook.coordinator(), address(box));
        assertEq(hook.receiver(), address(receiver));
        assertEq(hook.launchRouter(), box.launchRouter());
        assertEq(PoolId.unwrap(hook.poolId()), PoolId.unwrap(hook.poolKey().toId()));
        assertEq(hook.poolKey().fee, C.V2_POOL_FEE);
        assertEq(uint160(address(hook)) & 0x3fff, C.V2_HOOK_FLAGS);
    }

    function test_itemBoxKeepsRole3AsVaultAndLaterRolesEmpty() public {
        _start(_hiddenSpec());
        _roles(true);
        _readM1();
        assertEq(token.vault(), box.roleAddress(3));
        assertEq(box.randomness(), release.randomness);
    }

    function test_reservedCloneFieldsReadNonzeroWithoutMovingAdjacentFields() public {
        _start(_menu(1, 2));
        address holder = address(0x1717);
        address items = address(0x1616);
        address t = address(0x10001);
        vm.etch(
            t,
            BoxClones.runtime(
                release.implementations[1], TArgs.encode(address(box), box.vault(), holder, 1e27, "Probe coin", "PROBE")
            )
        );
        assertEq(IBoxTokenV2(t).ledger(), holder);
        assertEq(IBoxTokenV2(t).initialHolder(), address(box));
        assertEq(IBoxTokenV2(t).ISSUANCE(), 1e27);
        ReceiverArgs memory a;
        a.coordinator = address(box);
        a.hook = address(hook);
        a.t = address(token);
        a.launchRouter = box.launchRouter();
        a.registry = address(registry);
        a.creatorPayee = CREATOR;
        a.boxId = 123;
        a.batchMinQ = 111;
        a.tipMaxQ = 222;
        a.stepMinQ = 333;
        a.buyersChoice = 1;
        a.sellersChoice = 2;
        a.holderLedger = holder;
        a.itemLedger = items;
        address r = address(0x10002);
        vm.etch(r, BoxClones.runtime(release.implementations[5], RArgs.encode(a)));
        IBoxReceiverV2 probe = IBoxReceiverV2(r);
        vm.prank(address(box));
        probe.initialize();
        assertEq(probe.holderLedger(), holder);
        assertEq(probe.itemLedger(), items);
        assertEq(probe.boxId(), 123);
        assertEq(probe.creatorPayee(), CREATOR);
        assertEq(uint256(probe.buyersChoice()), 1);
        assertEq(uint256(probe.sellersChoice()), 2);
        assertEq(_word(r, 185, 32), 123);
        assertEq(_word(r, 217, 16), 111);
        assertEq(_word(r, 233, 16), 222);
        assertEq(_word(r, 249, 16), 333);
    }

    function test_NatSpecCallersAndUnbuiltStarterGateFailClosed() public {
        _start(_menu(1, 2));
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(this)));
        receiver.enterFailure();
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotCoordinator.selector, address(this)));
        receiver.onGraduation();
        vm.expectRevert(abi.encodeWithSelector(IBoxReceiverV2.NotPayee.selector, address(this)));
        receiver.claimCreator(address(0), address(this));
        vm.expectRevert(abi.encodeWithSelector(IBoxHookV2.NotReceiver.selector, address(this)));
        hook.harvest();
        vm.expectRevert(abi.encodeWithSelector(IBoxHookV2.NotCoordinator.selector, address(this)));
        hook.close();
        vm.expectRevert(IBoxCoordinatorV2.NOT_OFFERED.selector);
        box.starterSetLoaded();
        assertTrue(box.gateOpen());
        _readM1();
    }

    function test_failureClaimsKeepPConserved6Decimals() public {
        _failure(6);
    }

    function test_failureClaimsKeepPConserved8Decimals() public {
        _failure(8);
    }

    function test_failureClaimsKeepPConserved18Decimals() public {
        _failure(18);
    }

    function _failure(uint8 decimals) private {
        (BoxSpec memory s,) = _priceSpec(1, 2, decimals);
        _start(s);
        uint256 money = _money();
        _buy(s.raise / 10);
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 4, layout.sqrtPriceStartX96);
        uint256 sales = hook.saleFeesPending();
        assertEq(sales, 0, "curve sales accrue T");
        FeeBatchV2 memory batch = receiver.collect(address(0));
        assertEq(batch.sellersP, sales);
        assertEq(hook.saleFeesPending(), 0);
        assertEq(_money(), money);
        _booked();
        _readM1();
        vm.warp(box.deadline());
        box.fail();
        BaselineReader.Snapshot memory snapshot = _readM1();
        assertGt(snapshot.pot, 0);
        assertEq(snapshot.outstanding, token.balanceOf(address(buyer)));
        _claimBuyer();
        snapshot = _readM1();
        assertEq(snapshot.pot, 0);
        assertEq(snapshot.outstanding, 0);
        _gift(address(box), 12345);
        uint256 fit = receiver.fitOwed();
        NoFailureSweep.check(address(box));
        assertEq(receiver.fitOwed(), fit);
        assertEq(receiver.payFit(), fit);
        receiver.payPlatform();
        assertEq(_money(), money);
        _booked();
    }

    function test_refusingFitSafeLeavesIndependentPlatformExitAndRetry() public {
        _start(_menu(1, 2));
        _buy(box.raise() / 10);
        receiver.collect(address(0));
        uint256 money = _money();
        uint256 fit = receiver.fitOwed();
        uint256 platform = receiver.platformOwed();
        assertGt(fit, 0);
        assertGt(platform, 0);
        LifeCustody(payable(fitSafe)).setRefusing(true);
        assertEq(receiver.payFit(), 0);
        assertEq(receiver.fitOwed(), fit);
        assertEq(receiver.payPlatform(), platform);
        LifeCustody(payable(fitSafe)).setRefusing(false);
        assertEq(receiver.payFit(), fit);
        assertEq(receiver.fitOwed(), 0);
        assertEq(_money(), money);
        _readM1();
    }

    function _roles(bool items) private view {
        IBoxRegistryV2.BoxRecordV2 memory record = registry.recordOf(box.boxId());
        for (uint256 i; i < R.ROLE_COUNT; ++i) {
            address part = box.roleAddress(i);
            assertEq(part, record.contracts[i], vm.toString(i));
            assertEq(record.codeHashes[i], part == address(0) ? bytes32(0) : part.codehash);
            bool used = i <= 8 && (items || (i != 3 && i != 4 && i != 7));
            if (used) {
                assertGt(part.code.length, 0);
                assertTrue(
                    i == 8
                        ? BoxClones.isReceivingCloneOf(part, release.implementations[i])
                        : BoxClones.isCloneOf(part, release.implementations[i])
                );
            } else {
                assertEq(part, address(0));
            }
        }
    }

    function _readM1() private returns (BaselineReader.Snapshot memory result) {
        result = new BaselineReader().read(IBoxCoordinatorV2(address(box)), 7);
        assertEq(result.holder, address(0));
        assertEq(result.tokenLedger, address(0));
        assertEq(result.receiverLedger, address(0));
        assertEq(result.loader, address(0));
        assertFalse(result.pending);
        assertEq(result.batchPaid, 0, "M1 stub is not a funded/closed M2 batch");
        assertEq(result.closedAt, hook.closedAt());
    }

    function _word(address target, uint256 offset, uint256 length) private view returns (uint256 result) {
        // Absolute code offsets deliberately independent of the encoder's named offsets.
        assembly ("memory-safe") {
            extcodecopy(target, 0, offset, length)
            result := shr(sub(256, mul(8, length)), mload(0))
        }
    }
}

contract M2ReleaseSizeTest is Test {
    /// M202-SIZE: pick each exact default artifact, not an old estimate or the upstream PM profile.
    function test_everyManifestPartRetainsTheReleaseReserve() public view {
        string memory manifest = vm.readFile("size-budget.v2.json");
        assertEq(vm.parseJsonUint(manifest, ".limitBytes"), 24_576);
        assertEq(vm.parseJsonUint(manifest, ".minReserveBytes"), 2_458);
        string[] memory names = vm.parseJsonKeys(manifest, ".gates");
        assertEq(names.length, 45); // Includes both shared Alchemist parts and the CoW handler; no size ceiling is relaxed.
        for (uint256 i; i < names.length; ++i) {
            string memory key = string.concat(".gates.", names[i]);
            assertEq(vm.parseJsonUint(manifest, string.concat(key, ".m1GateBytes")), 22_118);
            assertEq(vm.parseJsonUint(manifest, string.concat(key, ".reserveBytes")), 2_458);
            string memory source = vm.parseJsonString(manifest, string.concat(key, ".source"));
            bytes memory code = vm.getDeployedCode(string.concat(source, ":", names[i]));
            assertGt(code.length, 0, names[i]);
            assertLe(code.length, 22_118, names[i]);
        }
    }
}
