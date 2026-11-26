// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {RoyaltyCustodyTest} from "test/box-v2/rc5-c/RoyaltyCustody.t.sol";
import {FactoryLife} from "test/box-v2/kit/FactoryLife.sol";
import {InboxListingOffline} from "test/box-v2/kit/RoyaltyRelease.sol";
import {HostileToken} from "test/box-v2/kit/HostileToken.sol";
import {BoxRoyaltyRouterV2} from "src/box-v2/BoxRoyaltyRouterV2.sol";

// Offline recordings from real inbox/coordinator implementations. The sale actor is a double;
// its Trade receipt has GPv2Settlement's event ABI, not a mainnet settlement certification.
contract TradeRecorder {
    event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount,
        uint256 buyAmount, uint256 feeAmount, bytes orderUid);
    function record(address owner, address sell, address buy) external {
        emit Trade(owner, sell, buy, 100e6, 77, 0, hex"aabb");
    }
}

contract InboxRecorderTest is RoyaltyCustodyTest {

    function snapshot(string memory name, address coin) internal {
        emit log_named_bytes(name, abi.encode(coin, router.lotSize(coin), router.heldBalance(coin),
            router.oldestUnsoldAt(coin), router.orderRegistered(coin)));
    }

    function test_recordInbox() public {
        vm.warp(1_000_000);
        HostileToken other = new HostileToken("Other", "OTHER", 6);
        InboxListingOffline(router.listingRegistry()).set(address(other), 100e6);
        other.mint(address(router), 900719925474099312345);
        emit log_named_bytes("wiring", abi.encode(address(router), address(sink), address(p), address(weth),
            address(other), router.cowHandler(), router.settlement()));
        snapshot("unregistered", address(other));
        vm.recordLogs();
        vm.deal(address(router), 1 ether + 1);
        router.refreshOrder();
        router.refreshOrder(address(other));
        emit log_named_bytes("refreshLogs", abi.encode(vm.getRecordedLogs()));
        snapshot("registered", address(other));
        vm.warp(1_000_100);
        vm.prank(router.vaultRelayer()); other.transferFrom(address(router), address(this), 100e6);
        vm.recordLogs();
        // The protocol double does not emit Trade itself; record the canonical event shape at its address.
        vm.etch(router.settlement(), address(new TradeRecorder()).code);
        TradeRecorder(router.settlement()).record(address(router), address(other), address(p));
        router.refreshOrder(address(other));
        emit log_named_bytes("saleLogs", abi.encode(vm.getRecordedLogs()));
        snapshot("afterSale", address(other));
        vm.warp(1_000_100 + 30 days);
        vm.recordLogs();
        vm.prank(PAYEE); router.claimInKind(address(other));
        emit log_named_bytes("inKindLogs", abi.encode(vm.getRecordedLogs()));
        snapshot("afterInKind", address(other));
        _nativeRouter();
        vm.deal(address(router), 123);
        vm.recordLogs(); router.flush();
        emit log_named_bytes("flushLogs", abi.encode(vm.getRecordedLogs()));
    }
}

contract FailureRecorderTest is FactoryLife {
    function snapshot(string memory name, BoxRoyaltyRouterV2 inbox, uint256 t) internal {
        (bool ok, bytes memory quote) = address(box).staticcall(abi.encodeCall(box.quoteClaim, (t)));
        (uint256 pot, uint256 left) = box.claimState();
        emit log_named_bytes(name, abi.encode(pot, left, t, inbox.pendingPriceCoin(), ok, quote));
    }

    function test_recordHolder() public {
        _start(_spec()); _buy(box.raise() / 5);
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        vm.warp(box.deadline());
        vm.recordLogs(); box.fail();
        emit log_named_bytes("holderFailureLogs", abi.encode(vm.getRecordedLogs()));
        (, uint256 left) = box.claimState();
        vm.deal(address(inbox), 900719925474099312345);
        snapshot("pending", inbox, left);
        snapshot("partial", inbox, left / 2);
        vm.recordLogs();
        vm.startPrank(address(buyer)); token.approve(address(box), left); box.claim(left, address(buyer)); vm.stopPrank();
        emit log_named_bytes("holderClaimLogs", abi.encode(vm.getRecordedLogs()));
        snapshot("exhausted", inbox, 0);
    }

    function test_recordNoBuyer() public {
        _start(_spec());
        BoxRoyaltyRouterV2 inbox = BoxRoyaltyRouterV2(payable(box.royaltyRouter()));
        vm.deal(address(inbox), 123456789);
        vm.warp(box.deadline());
        vm.recordLogs(); box.fail();
        emit log_named_bytes("noBuyerFailureLogs", abi.encode(vm.getRecordedLogs()));
        snapshot("noBuyer", inbox, 0);
        vm.prank(CREATOR); box.claim(0, CREATOR);
        // RC6-RR-INBOX (RC6RR-FC-3): late inbox P after the creator's paid claim, before anyone sweeps it; the views
        // now preview it, as claim(0) would take it.
        vm.deal(address(inbox), 77);
        snapshot("noBuyerLate", inbox, 0);
        inbox.sweepPriceCoin();
        snapshot("noBuyerReopened", inbox, 0);
    }
}
