// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU1LaneBase} from "./AuditU1LaneBase.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";

/// forge-config: default.evm_version = "osaka"
contract AuditU1LaneCreation is AuditU1LaneBase {
    /// BC-011 / F23 C2: one bootstrap crosses the boundary, no balance retained by the deployment helpers.
    function testProperty_AUDIT_U1_bootstrapConservation() public {
        uint256 beforeCreator = address(kit).balance;
        uint256 beforePool = address(pm).balance;
        _create();
        assertEq(address(factory).balance, 0, "factory retains no bootstrap");
        assertEq(address(planner).balance, 0, "planner retains no bootstrap");
        assertEq(address(registry).balance, 0, "registry retains no bootstrap");
        assertEq(beforeCreator - address(kit).balance, BoxSpecV1.BOOTSTRAP_ETH, "creator debit");
        assertEq(address(pm).balance - beforePool, BoxSpecV1.BOOTSTRAP_ETH, "pool credit");
    }

    /// BC-011: compare every slot accessed by the clean creation against the same creation with advance ETH.
    /// A counterfactual address is funded by a real value CALL, not a storage or code edit. Box 0's T cannot be
    /// sent beforehand: it has no code or supply until this same atomic transaction creates it (separate test).
    function testFuzz_AUDIT_U1_prefundedEthLeavesCreationStorageAndQuotes(uint96 amount) public {
        uint256 dust = bound(uint256(amount), 1, 10 ether);
        address[] memory t = _targets();
        uint256 snap = vm.snapshotState();
        vm.record();
        _create();
        bytes32[][] memory slots = new bytes32[][](t.length);
        bytes32[][] memory values = new bytes32[][](t.length);
        for (uint256 i; i < t.length; ++i) {
            (slots[i],) = vm.accesses(t[i]);
            values[i] = new bytes32[](slots[i].length);
            for (uint256 j; j < slots[i].length; ++j) {
                values[i][j] = vm.load(t[i], slots[i][j]);
            }
        }
        uint256 take = BoxVault(a.vault).quoteWithdraw(1);
        (bool backOk, bytes memory back) = a.vault.staticcall(abi.encodeWithSignature("quoteReturn(uint256)", 1));
        uint256 supply = BoxToken(a.token).totalSupply();
        vm.revertToState(snap);
        vm.deal(address(this), 12 * dust);
        for (uint256 i; i < 12; ++i) {
            (bool ok,) = t[i].call{value: dust}("");
            assertTrue(ok, "advance ETH accepted by codeless address");
        }
        assertEq(factory.refusal(_spec(), address(kit)).length, 0, "same creation checks");
        _create();
        for (uint256 i; i < t.length; ++i) {
            for (uint256 j; j < slots[i].length; ++j) {
                assertEq(vm.load(t[i], slots[i][j]), values[i][j], "same storage");
            }
            if (i < 12) assertEq(t[i].balance, dust, "unrequested ETH remains at creation");
        }
        assertEq(BoxVault(a.vault).quoteWithdraw(1), take);
        (bool dustBackOk, bytes memory dustBack) =
            a.vault.staticcall(abi.encodeWithSignature("quoteReturn(uint256)", 1));
        assertEq(dustBackOk, backOk);
        assertEq(dustBack, back);
        assertEq(BoxToken(a.token).totalSupply(), supply);
        assertEq(BoxCoordinator(a.coordinator).reserve(), 0);
        assertEq(BoxLaunchRouter(payable(a.launchRouter)).totalTaxCollected(), 0);
    }

    function testProperty_AUDIT_U1_noTExistsBeforeAtomicCreation() public {
        address[] memory t = _targets();
        for (uint256 i; i < 12; ++i) {
            assertEq(a.token.code.length, 0);
            (bool ok, bytes memory ret) = a.token.call(abi.encodeWithSignature("transfer(address,uint256)", t[i], 1));
            assertTrue(ok);
            assertEq(ret.length, 0, "codeless CALL is not an ERC20 transfer");
        }
        _create();
        assertEq(BoxToken(a.token).totalSupply() + BoxToken(a.token).totalBurned(), BoxSpecV1.ISSUANCE);
        for (uint256 i = 1; i < 12; ++i) {
            assertEq(BoxToken(a.token).balanceOf(t[i]), 0);
        }
    }

    /// BC-011/108/114/115, F77: unrequested ETH is not booked as launch tax or a funding receipt. It stays
    /// forever at contracts without an intake/sweep; router dust becomes hook depth claims at graduation,
    /// royalty dust becomes receiver fee claims, and executor dust is spendable balance-based budget.
    function testProperty_AUDIT_U1_prefundedEthFollowsDocumentedDestinations() public {
        address[] memory t = _targets();
        for (uint256 i; i < 12; ++i) {
            (bool ok,) = t[i].call{value: 1}("");
            assertTrue(ok);
        }
        _create();
        FitBuybackExecutor e = FitBuybackExecutor(payable(a.executor));
        assertEq(e.budget(), 1);
        assertEq(e.totalToBudget(), 0, "advance ETH is not an intake receipt");
        kit.toClosed();
        BoxCoordinator(a.coordinator).graduate();
        BoxLaunchRouter r = BoxLaunchRouter(payable(a.launchRouter));
        uint256 routerBalance = a.launchRouter.balance;
        uint256 hookClaims = pm.balanceOf(a.hook, 0);
        assertEq(routerBalance, r.totalTaxCollected() + 1, "tax plus unbooked dust");
        assertEq(r.sweep(), routerBalance);
        assertEq(a.launchRouter.balance, 0);
        assertEq(pm.balanceOf(a.hook, 0) - hookClaims, routerBalance, "router's fixed depth destination");
        uint256 receiverClaims = pm.balanceOf(a.receiver, 0);
        assertEq(BoxRoyaltyRouter(payable(a.royaltyRouter)).flush(), 1);
        assertEq(a.royaltyRouter.balance, 0);
        assertEq(pm.balanceOf(a.receiver, 0) - receiverClaims, 1, "royalty's fixed fee destination");
        for (uint256 i; i < 12; ++i) {
            if (i == 6 || i == 7 || i == 10) continue;
            assertEq(t[i].balance, 1, "no route for unrequested ETH at other addresses");
        }
        assertEq(e.budget(), a.executor.balance);
    }

    function testFuzz_AUDIT_U1_onlyCreator(address caller) public {
        vm.assume(caller != address(kit) && caller != address(vm));
        _reject(
            _spec(),
            caller,
            BoxSpecV1.BOOTSTRAP_ETH,
            a.hookSalt,
            type(FitBuybackExecutor).creationCode,
            abi.encodeWithSelector(IBoxFactoryV1.NotBox0Creator.selector, caller)
        );
    }

    function testFuzz_AUDIT_U1_exactBootstrap(uint96 value) public {
        vm.assume(value != BoxSpecV1.BOOTSTRAP_ETH);
        _reject(
            _spec(),
            address(kit),
            value,
            a.hookSalt,
            type(FitBuybackExecutor).creationCode,
            abi.encodeWithSelector(IBoxFactoryV1.WrongValue.selector, value, BoxSpecV1.BOOTSTRAP_ETH)
        );
    }

    function testFuzz_AUDIT_U1_pinnedExecutor(bytes memory code) public {
        vm.assume(keccak256(code) != factory.executorInitCodeHash());
        _reject(
            _spec(),
            address(kit),
            BoxSpecV1.BOOTSTRAP_ETH,
            a.hookSalt,
            code,
            abi.encodeWithSelector(IBoxFactoryV1.ExecutorCodeMismatch.selector, keccak256(code))
        );
    }

    function testProperty_AUDIT_U1_templateZeroAndOneCreation() public {
        BoxSpecV1.BoxSpec memory s = _spec();
        s.marketplaceOwner = address(0x1234);
        bytes memory why = factory.refusal(s, address(kit));
        assertGt(why.length, 0);
        _reject(s, address(kit), BoxSpecV1.BOOTSTRAP_ETH, a.hookSalt, type(FitBuybackExecutor).creationCode, why);
        vm.deal(address(kit), 1 ether);
        (uint256 id, address c, address h) = _create();
        assertEq(id, 0);
        assertEq(c, a.coordinator);
        assertEq(h, a.hook);
        bytes32 codeHash = c.codehash;
        bytes memory executorCode = type(FitBuybackExecutor).creationCode;
        s = _spec();
        vm.prank(address(kit));
        vm.expectRevert(IBoxFactoryV1.Box0Exists.selector);
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, a.hookSalt, executorCode);
        assertEq(registry.boxCount(), 1);
        assertEq(c.codehash, codeHash);
    }

    function testFuzz_AUDIT_U1_hookFlagsAndBadSaltAtomicity(bytes32 salt) public {
        address predicted = factory.predictHook(_spec().openAt, salt);
        if ((uint160(predicted) & 0x3fff) == 0x2ae0 && uint160(predicted) >> 152 != 0x91) return;
        _reject(
            _spec(),
            address(kit),
            BoxSpecV1.BOOTSTRAP_ETH,
            salt,
            type(FitBuybackExecutor).creationCode,
            abi.encodeWithSelector(IBoxFactoryV1.HookSaltNotMined.selector, predicted)
        );
        assertEq(predicted.code.length, 0);
        vm.deal(address(kit), 1 ether);
        (,, address deployed) = _create();
        assertEq(deployed, factory.predictHook(_spec().openAt, a.hookSalt));
        assertEq(uint160(deployed) & 0x3fff, 0x2ae0);
        assertNotEq(uint160(deployed) >> 152, 0x91);
    }
}
