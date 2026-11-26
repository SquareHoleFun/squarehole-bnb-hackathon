// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {VaultAction} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxCloneArgs} from "../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";

/// @notice AR-03: retained FAILING specifications. core-v1-interfaces §3 says an uninitialized clone
/// refuses every write and a stranger's clone stays inert. These are unregistered stranger-created clones;
/// this does not demonstrate access to any factory-created box's state or funds.
contract UninitializedStreamReviewTest is Test {
    BoxItemStream internal stream;

    function setUp() public {
        BoxItemStream implementation = new BoxItemStream(IPoolManager(address(1)), address(2));
        bytes memory args = BoxCloneArgs.stream(
            BoxCloneArgs.StreamArgs({
                coordinator: address(2),
                token: address(3),
                collection: address(this),
                vault: address(this),
                tickets: address(0),
                receiver: address(4),
                hook: address(5),
                tickLower: 177180,
                tickUpper: 204060,
                collectionSize: 4269,
                firstId: 1
            })
        );
        stream = BoxItemStream(BoxClones.create(BoxClones.initCode(address(implementation), args)));
    }

    function test_BC100_uninitializedVaultObserverMustRefuseStateChanges() public {
        assertFalse(stream.started());
        assertEq(stream.outsideCount(), 0);
        (bool ok, bytes memory result) = address(stream)
            .call(abi.encodeCall(BoxItemStream.onVaultAction, (VaultAction.Withdrawn, address(6), 1, 4269)));
        emit log_named_uint("outside count after uninitialized callback", stream.outsideCount());
        assertFalse(ok, "uninitialized clone accepted a vault callback: outside count became 1");
        assertEq(bytes4(result), bytes4(keccak256("NotInitialised()")));
        assertEq(stream.outsideCount(), 0);
    }

    function test_BC100_uninitializedCollectionObserverMustRefuseStateChanges() public {
        vm.recordLogs();
        (bool ok, bytes memory result) =
            address(stream).call(abi.encodeCall(BoxItemStream.onItemTransfer, (address(6), address(7), 1)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        emit log_named_uint("logs from uninitialized callback", logs.length);
        assertFalse(ok, "uninitialized clone accepted a transfer callback and wrote an item checkpoint");
        assertEq(bytes4(result), bytes4(keccak256("NotInitialised()")));
        assertEq(logs.length, 0);
    }
}
