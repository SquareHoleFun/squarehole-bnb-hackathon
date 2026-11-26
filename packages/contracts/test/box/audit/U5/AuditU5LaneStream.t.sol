// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU5LaneBase} from "./AuditU5LaneBase.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {ItemReveal, VaultAction} from "../../../../src/box/interfaces/BoxTypes.sol";

/// forge-config: default.evm_version = "osaka"
contract AuditU5LaneStream is AuditU5LaneBase {
    function testProperty_AUDIT_U5_authorizationAndInitialization() public {
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotReceiver.selector, address(this)));
        st.onStreamFunds(0);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotCollection.selector, address(this)));
        st.onItemTransfer(alice, bob, 1);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotVault.selector, address(this)));
        st.onVaultAction(VaultAction.Withdrawn, alice, 1, 4269);
        // Uninitialised state of the actual clone: only the init flag is cleared; arguments/code unchanged.
        vm.store(a.itemStream, bytes32(0), bytes32(0));
        vm.prank(a.receiver);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        st.onStreamFunds(0);
        vm.prank(a.collection);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        st.onItemTransfer(alice, bob, 1);
        vm.prank(a.vault);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        st.onVaultAction(VaultAction.Withdrawn, alice, 1, 4269);
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        st.burn();
        vm.expectRevert(IBoxItemStream.NotInitialised.selector);
        st.onGraduation();
    }

    /// @dev Wiring-return fault injection only; the clone's coordinator and every other contract are factory-built.
    function testProperty_AUDIT_U5_initializeRequiresBackPointers() public {
        address[3] memory targets = [a.receiver, a.collection, a.vault];
        bytes[3] memory getters = [
            abi.encodeWithSignature("itemStream()"),
            abi.encodeWithSignature("transferObserver()"),
            abi.encodeWithSignature("observer()")
        ];
        uint256[3] memory checks = [uint256(1), uint256(3), uint256(4)];
        vm.store(a.itemStream, bytes32(0), bytes32(0));
        for (uint256 i; i < 3; ++i) {
            vm.mockCall(targets[i], getters[i], abi.encode(address(0)));
            vm.prank(a.coordinator);
            vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.WiringMismatch.selector, checks[i]));
            st.initialize();
            vm.clearMockedCalls();
        }
        vm.prank(a.coordinator);
        st.initialize();
        vm.prank(a.coordinator);
        vm.expectRevert(IBoxItemStream.AlreadyInitialised.selector);
        st.initialize();
    }

    function testProperty_AUDIT_U5_claimAuthorizationPayeeAndDuplicate() public {
        _life();
        _collect();
        uint256[] memory ids = new uint256[](1);
        ids[0] = aliceItem;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IBoxItemStream.NotOwner.selector, aliceItem, bob));
        st.claim(ids, bob);
        uint256 snap = vm.snapshotState();
        vm.prank(alice);
        uint256 single = st.claim(ids, carol);
        assertGt(single, 0);
        vm.revertToState(snap);
        ids = new uint256[](3);
        ids[0] = aliceItem;
        ids[1] = aliceItem;
        ids[2] = aliceItem;
        uint256 carolBefore = BoxToken(a.token).balanceOf(carol);
        vm.prank(alice);
        uint256 duplicate = st.claim(ids, carol);
        assertEq(single, duplicate, "duplicates checkpoint once");
        assertEq(BoxToken(a.token).balanceOf(carol) - carolBefore, single);
        vm.revertToState(snap);
        uint256 aliceBefore = BoxToken(a.token).balanceOf(alice);
        uint256 bobBefore = BoxToken(a.token).balanceOf(bob);
        vm.prank(bob);
        uint256 paid = st.claimFor(alice, ids);
        assertEq(paid, single);
        assertEq(BoxToken(a.token).balanceOf(alice) - aliceBefore, paid);
        assertEq(BoxToken(a.token).balanceOf(bob), bobBefore);
        assertEq(st.owedOf(alice), 1, "one retained unit per account, not per repeated id");
        assertEq(st.claimFor(alice, ids), 0);
    }

    /// F126: suppressed notices model a reverting callee; no production state is overwritten.
    function testFuzz_AUDIT_U5_graduationOrderAndDelayedStart(bool receiverFirst, uint160 caller) public {
        vm.assume(caller > 0x10000);
        b.toClosed();
        vm.mockCallRevert(a.receiver, abi.encodeWithSignature("onGraduation()"), "");
        vm.mockCallRevert(a.itemStream, abi.encodeCall(IBoxItemStream.onGraduation, ()), "");
        BoxCoordinator(a.coordinator).graduate();
        vm.clearMockedCalls();
        uint256 expected = BoxCoordinator(a.coordinator).streamStartBalance() + 13
            * ((BoxCoordinator(a.coordinator).streamStartClaims()
                    - BoxReceiver(payable(a.receiver)).streamCurveDepthT())
                / 15);
        _trade(2);
        if (receiverFirst) BoxReceiver(payable(a.receiver)).onGraduation();
        uint256 indexBefore = st.index();
        vm.prank(address(caller));
        st.onGraduation();
        assertEq(st.startValue(), expected);
        assertEq(st.index(), indexBefore, "retry preserves all accrual");
        assertEq(st.streamValue(), _referenceValue());
    }

    function testFuzz_AUDIT_U5_extsloadEqualsStateLibrary(uint96 amount) public {
        _graduateReady();
        uint256 bought = b.buy(dave, bound(amount, 0.001 ether, 5 ether), 0);
        assertEq(st.streamValue(), _referenceValue());
        b.sell(dave, bought);
        assertEq(st.streamValue(), _referenceValue());
        _collect();
        assertEq(st.streamValue(), _referenceValue());
    }

    function testProperty_AUDIT_U5_insideEarnsNothingAndBurnKeepsLiabilities() public {
        _life();
        vm.warp(block.timestamp + 31 days);
        vm.prank(alice);
        BoxVault(a.vault).returnItem(aliceItem, 0, block.timestamp);
        uint256 owed = st.owedOf(alice);
        _trade(3);
        _collect();
        (address owner, uint256 pending) = st.pendingOf(aliceItem);
        assertEq(owner, address(0));
        assertEq(pending, 0);
        assertEq(st.owedOf(alice), owed, "old earnings retained; inside item earns none");
        uint256 liabilities = st.liabilities();
        vm.prank(bob);
        st.burn();
        assertEq(st.liabilities(), liabilities);
        assertGe(BoxToken(a.token).balanceOf(a.itemStream), liabilities);
        assertLe(BoxToken(a.token).balanceOf(a.itemStream) - liabilities, st.outsideCount());
    }

    function testProperty_AUDIT_U5_batchDrawAndDeliveryOrderSameBlock() public {
        _life();
        uint256 snap = vm.snapshotState();
        bytes32 before = _ordered(true);
        vm.revertToState(snap);
        assertEq(_ordered(false), before);
    }

    function _ordered(bool batchFirst) internal returns (bytes32) {
        if (batchFirst) _collect();
        vm.startPrank(carol);
        BoxToken(a.token).approve(a.tickets, type(uint256).max);
        tix.draw(type(uint256).max, block.timestamp);
        vm.stopPrank();
        ItemReveal memory none;
        vm.prank(carol);
        uint256 id = tix.openDraw(drawTicket, address(0), none);
        if (!batchFirst) _collect();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 paid = st.claimFor(carol, ids);
        (address owner, uint256 pending) = st.pendingOf(id);
        return keccak256(abi.encode(st.index(), st.liabilities(), paid, st.owedOf(carol), owner, pending));
    }

    function testProperty_AUDIT_U5_giftFloorRemainderNeverPaidTwice() public {
        _life();
        _collect();
        uint256 amount = 4269 * 11 + 4268;
        uint256 x = st.streamValue();
        uint256 balance = BoxToken(a.token).balanceOf(a.itemStream);
        (uint256 claimed, uint256 burned) = st.totals();
        vm.prank(carol);
        BoxToken(a.token).transfer(a.itemStream, amount);
        assertEq(st.streamValue(), x + amount);
        uint256 all = st.streamValue() - st.startValue();
        assertEq(st.index(), all / 4269);
        assertLe(all - 4269 * st.index(), 4268);
        uint256[] memory ids = new uint256[](2);
        ids[0] = aliceItem;
        ids[1] = aliceSecond;
        st.claimFor(alice, ids);
        assertEq(st.claimFor(alice, ids), 0);
        uint256 snap = vm.snapshotState();
        uint256 firstBurn = st.burn();
        vm.revertToState(snap);
        vm.prank(bob);
        assertEq(st.burn(), firstBurn, "burn independent of caller");
        (uint256 afterClaimed, uint256 afterBurned) = st.totals();
        assertEq(
            BoxToken(a.token).balanceOf(a.itemStream) + afterClaimed + afterBurned,
            balance + claimed + burned + amount,
            "every floor residue burned or held"
        );
        assertGe(BoxToken(a.token).balanceOf(a.itemStream), st.liabilities());
    }

    function testFuzz_AUDIT_U5_flooringAndPackedLifetime(uint256 raw) public pure {
        // Economic bound, not a synthetic storage overflow: issued supply is 1e27. Aggregate stream inflow
        // <= 2^96 * N - 1 keeps J in 96 bits, aggregate accrual in 127, totals in 120, draw sum in 128.
        uint256 n = 4269;
        uint256 lifetime = ((uint256(1) << 96) - 1) * n;
        uint256 amount = raw % (lifetime + 1);
        uint256 j = amount / n;
        assertLe(amount - j * n, n - 1);
        assertLt(j, uint256(1) << 96);
        assertLt(n * j, uint256(1) << 127);
        assertLt(n * j, uint256(1) << 128);
        assertLt(amount, uint256(1) << 120);
        assertLt(uint256(1e27), uint256(1) << 120);
        assertEq(lifetime / n, (uint256(1) << 96) - 1);
        assertEq((lifetime + n) / n, uint256(1) << 96, "first unrepresentable item index");
    }
}
