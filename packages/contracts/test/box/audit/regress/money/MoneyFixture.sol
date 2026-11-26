// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../../conformance/core/CoreBox0Kit.sol";
import {BoxSpecV1} from "../../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../../src/box/BoxToken.sol";
import {BoxReceiver} from "../../../../../src/box/BoxReceiver.sol";
import {BoxCoordinator} from "../../../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../../src/box/BoxLaunchRouter.sol";
import {BoxVault} from "../../../../../src/box/BoxVault.sol";
import {BoxTickets} from "../../../../../src/box/BoxTickets.sol";
import {BoxItemStream} from "../../../../../src/box/BoxItemStream.sol";
import {FitBuybackExecutor} from "../../../../../src/box/FitBuybackExecutor.sol";

/// Full-size, factory-created box 0 and the pinned local PoolManager. No RPC or storage edits.
abstract contract AuditRegressMoneyFixture is Test {
    CoreBox0Kit internal kit;
    CoreBoxAddresses internal a;
    BoxToken internal token;
    BoxReceiver internal receiver;
    BoxCoordinator internal coordinator;
    BoxHook internal hook;
    BoxLaunchRouter internal router;
    BoxVault internal vault;
    BoxTickets internal tickets;
    BoxItemStream internal stream;
    FitBuybackExecutor internal executor;
    address internal alice = makeAddr("money.alice");
    address internal bob = makeAddr("money.bob");

    function setUp() public virtual {
        // Exclude the fixture's many deployments, never the actions under review, from transaction gas limits.
        vm.pauseGasMetering();
        kit = CoreBox0Kit(payable(deployCode("CoreBox0Kit.sol:CoreBox0Kit")));
        kit.setUpWorld();
        BoxSpecV1.BoxSpec memory spec = abi.decode(
            vm.parseJsonBytes(vm.readFile("test/vectors/box-spec/box-spec-v1.json"), ".columns.encoded[0]"),
            (BoxSpecV1.BoxSpec)
        );
        kit.build(spec);
        a = kit.addresses();
        token = BoxToken(a.token);
        receiver = BoxReceiver(payable(a.receiver));
        coordinator = BoxCoordinator(a.coordinator);
        hook = BoxHook(a.hook);
        router = BoxLaunchRouter(payable(a.launchRouter));
        vault = BoxVault(a.vault);
        tickets = BoxTickets(a.tickets);
        stream = BoxItemStream(a.itemStream);
        executor = FitBuybackExecutor(payable(a.executor));
        vm.resumeGasMetering();
    }

    function _graduate() internal {
        vm.pauseGasMetering();
        kit.toClosed();
        vm.resumeGasMetering();
        coordinator.graduate();
    }

    function _claims(address who, address asset) internal view returns (uint256) {
        return kit.pm().balanceOf(who, uint256(uint160(asset)));
    }

    receive() external payable {}
}

/// Deliberately exhausts a capped call's gas. Used only by explicit fault-injection cases.
contract AuditRegressMoneyGasSink {
    fallback() external payable {
        assembly { for {} 1 {} { mstore(0, gas()) } }
    }
}
