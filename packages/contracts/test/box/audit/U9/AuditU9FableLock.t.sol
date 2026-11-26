// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {BoxMetadataTable} from "../../../../src/box/libraries/BoxMetadataTable.sol";
import {FeeBatch, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {AuditPhases} from "../common/AuditPhases.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";

/// @notice TEST ONLY: a tip recipient that, while the receiver pays it (inside `collect`'s guarded call, through the
/// PoolManager's `take`), calls back into both halves of the receiver and into two other box contracts, recording each
/// call's revert selector. Stand-in for "a callee that re-enters" (the property is about how the lock treats it).
contract AuditU9FableReenterer {
    IBoxReceiver public immutable receiver;
    address public immutable launchRouter;
    address public immutable coordinator;
    bytes4[] public selectors;
    bool[] public succeeded;
    uint256 public received;

    constructor(IBoxReceiver receiver_, address launchRouter_, address coordinator_) {
        receiver = receiver_;
        launchRouter = launchRouter_;
        coordinator = coordinator_;
    }

    receive() external payable {
        received += msg.value;
        // The hot half (nonReentrantCall) and the cold half (the extension, by DELEGATECALL, nonReentrantCall).
        _try(address(receiver), abi.encodeCall(IBoxReceiver.fundFees, ()));
        _try(address(receiver), abi.encodeCall(IBoxReceiver.collect, (address(this))));
        _try(address(receiver), abi.encodeCall(IBoxReceiver.payPlatform, ()));
        _try(address(receiver), abi.encodeCall(IBoxReceiver.noteModuleFees, (0, 0)));
        _try(address(receiver), abi.encodeCall(IBoxReceiver.proposeCreatorPayee, (address(this))));
        _try(address(receiver), abi.encodeCall(IBoxReceiver.acceptCreatorPayee, ()));
        // Other contracts' locks are their own: these fail for their own reasons, never Reentrancy().
        _try(launchRouter, abi.encodeWithSignature("sweep()"));
        _try(coordinator, abi.encodeCall(IBoxCoordinator.claimReward, (address(this))));
    }

    function _try(address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        succeeded.push(ok);
        selectors.push(ret.length >= 4 ? bytes4(ret) : bytes4(0));
    }

    function count() external view returns (uint256) {
        return selectors.length;
    }
}

/// @title AuditU9FableLock
/// @notice SH-AUDIT-B0-U9 (Fable 5.1), lenses L3 (P9.3) and L2, on the factory's box 0 (the shared world): the
/// transient lock is released at the end of each guarded call (two guarded calls in one transaction; a caught inner
/// revert leaves it released, for the inline `nonReentrant` and for `nonReentrantCall`); `_insideGuardedCall` gates
/// every `unlockCallback` and the receiver's `receive`; the receiver's two DELEGATECALL halves share one lock (a
/// re-entry from the tip recipient into either half reverts `Reentrancy()`), while other contracts' locks are their
/// own. Also the L8 pin that the factory records `BoxSpecV1.specHash` of the created spec, and P9.8 on box 0's real
/// collection. The Amsterdam variant runs the same tests; this unit sends no ETH of its own (every payment here is the
/// PoolManager's `take` with all gas), so the EIP-7702 stipend observation has no bearing on it.
/// @dev Sources: `TransientReentrancyGuard.sol:4-5, 51-53`, `BoxReceiver.sol:70-73, 386-387, 406-407`, BC-100.
/// forge-config: default.evm_version = "osaka"
contract AuditU9FableLockTest is AuditPhases {
    /// @dev `TransientReentrancyGuard.Reentrancy()`'s selector (`TransientReentrancyGuard.sol:15`).
    bytes4 internal constant REENTRANCY = 0xab143c06;

    function setUp() public virtual override {
        super.setUp();
    }

    // ------------------------------------------------------------------------------------------------ release

    /// Two guarded calls of the same contract in one transaction both succeed (the lock is cleared at the end of each),
    /// for `nonReentrantCall` (receiver) and for the inline `nonReentrant` (vault, through the tickets' take).
    function testProperty_AUDIT_U9_twoGuardedCallsInOneTransaction() public {
        _toBonding();
        _fundFees(eoa[4], 0.01 ether);
        _fundFees(eoa[4], 0.01 ether);
        _fundDepth(eoa[4], 0.01 ether);
        _fundDepth(eoa[4], 0.01 ether);
        uint256 first = _take(eoa[0], 1);
        uint256 second = _take(eoa[0], 1);
        assertTrue(first != second, "two placeholders");
        _assertGhostLedger();
    }

    /// A caught inner revert of a guarded function leaves the lock released: after `collect` reverts (the batch too
    /// small) `fundFees` succeeds; after `graduate` reverts (already graduated; inline lock) `claimReward` succeeds.
    function testProperty_AUDIT_U9_caughtInnerRevertLeavesTheLockReleased() public {
        _toGraduated();
        bytes memory err;
        try receiver.collect(keeper) returns (FeeBatch memory) {
            revert("collect should fail with nothing to collect");
        } catch (bytes memory e) {
            err = e;
        }
        assertEq(bytes4(err), IBoxReceiver.BatchTooSmall.selector);
        _fundFees(eoa[4], 0.01 ether);
        try coordinator.graduate() returns (uint256) {
            revert("graduate should fail twice");
        } catch (bytes memory e) {
            assertTrue(bytes4(e) != REENTRANCY, "its own reason");
        }
        uint256 reward = _claimReward(keeper, keeper);
        assertEq(reward, graduationReward);
        _assertGhostLedger();
    }

    // ------------------------------------------------------------------------------------------------ gates

    /// `unlockCallback` of the coordinator, the launch router, the receiver and FIT's executor, and the receiver's
    /// `receive`, refuse every caller outside a guarded call of their own: a stranger, and the PoolManager itself when
    /// no guarded call is running.
    function testProperty_AUDIT_U9_callbacksAndReceiveOnlyInsideGuardedCalls() public {
        _toBonding();
        address[4] memory targets = [address(coordinator), address(launchRouter), address(receiver), address(executor)];
        for (uint256 i; i < 4; ++i) {
            (bool ok, bytes memory ret) = targets[i].call(abi.encodeWithSignature("unlockCallback(bytes)", ""));
            assertFalse(ok, "a stranger");
            assertEq(bytes4(ret), bytes4(keccak256("NotPoolManager()")));
            vm.prank(address(pm));
            (ok, ret) = targets[i].call(abi.encodeWithSignature("unlockCallback(bytes)", ""));
            assertFalse(ok, "the PoolManager outside a guarded call");
            assertEq(bytes4(ret), bytes4(keccak256("NotPoolManager()")));
        }
        vm.deal(eoa[5], 1 ether);
        vm.prank(eoa[5]);
        (bool sent, bytes memory data) = address(receiver).call{value: 1}("");
        assertFalse(sent, "plain ETH refused");
        assertEq(bytes4(data), IBoxReceiver.EthRefused.selector);
        vm.deal(address(pm), address(pm).balance + 1);
        vm.prank(address(pm));
        (sent, data) = address(receiver).call{value: 1}("");
        assertFalse(sent, "the PoolManager's ETH outside a guarded call");
        assertEq(bytes4(data), IBoxReceiver.EthRefused.selector);
        assertEq(address(receiver).balance, 0, "nothing arrived");
    }

    // ------------------------------------------------------------------------------------------------ one lock

    /// The receiver's two halves share one transient lock: paid its tip inside `collect`, the recipient's re-entries
    /// into the hot half (fundFees, collect, payPlatform) and into the extension half (noteModuleFees,
    /// proposeCreatorPayee, acceptCreatorPayee: DELEGATECALL into the same clone) all revert `Reentrancy()`, before
    /// any caller or state check; calls into the launch router and the coordinator fail for their own reasons.
    function testProperty_AUDIT_U9_receiverHalvesShareOneLock() public {
        _toBonding();
        _buy(eoa[3], 1 ether); // 1 % LP fee: a batch above the 0.005 ETH minimum for the next collect
        AuditU9FableReenterer r = new AuditU9FableReenterer(receiver, address(launchRouter), address(coordinator));
        _ghostAddOutside(address(r));
        FeeBatch memory b = _collect(keeper, address(r));
        assertGt(b.tip, 0, "a tip was paid");
        assertEq(r.received(), b.tip, "to the recipient, through the PoolManager's take");
        assertEq(r.count(), 8);
        for (uint256 i; i < 6; ++i) {
            assertFalse(r.succeeded(i), "every re-entry failed");
            assertEq(r.selectors(i), REENTRANCY, "with Reentrancy(), both halves");
        }
        for (uint256 i = 6; i < 8; ++i) {
            assertFalse(r.succeeded(i));
            assertTrue(r.selectors(i) != REENTRANCY, "other contracts' locks are their own");
        }
        _assertGhostLedger();
    }

    /// Outside a guarded call the same six entry points answer with their own reasons (never Reentrancy()), so the
    /// previous test's selectors come from the lock alone.
    function testProperty_AUDIT_U9_sameCallsOutsideTheLockFailForTheirOwnReasons() public {
        _toBonding();
        AuditU9FableReenterer r = new AuditU9FableReenterer(receiver, address(launchRouter), address(coordinator));
        bytes[6] memory calls = [
            abi.encodeCall(IBoxReceiver.collect, (address(r))),
            abi.encodeCall(IBoxReceiver.payPlatform, ()),
            abi.encodeCall(IBoxReceiver.noteModuleFees, (0, 0)),
            abi.encodeCall(IBoxReceiver.proposeCreatorPayee, (address(r))),
            abi.encodeCall(IBoxReceiver.acceptCreatorPayee, ()),
            abi.encodeCall(IBoxReceiver.fundFees, ())
        ];
        for (uint256 i; i < 5; ++i) {
            vm.prank(address(r));
            (bool ok, bytes memory ret) = address(receiver).call(calls[i]);
            assertFalse(ok);
            assertTrue(bytes4(ret) != REENTRANCY, "its own reason outside the lock");
        }
        vm.prank(address(r));
        (bool fine,) = address(receiver).call(calls[5]);
        assertTrue(fine, "fundFees with no value is a no-op outside the lock");
    }

    // ------------------------------------------------------------------------------------------------ L8, P9.8

    /// P9.11 / L8: the coordinator records exactly `BoxSpecV1.specHash` of the spec the factory created box 0 from
    /// (the audit world's: the Sepolia safe file with N 1,969, the audit reveal root and the creation's openAt), and
    /// the collection serves that spec's table under its keccak256.
    function testProperty_AUDIT_U9_factoryRecordsTheSpecHashOfTheCreatedSpec() public view {
        BoxSpecV1.BoxSpec memory s = abi.decode(
            vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), AUDIT_SPEC_FILE)), ".encoded"),
            (BoxSpecV1.BoxSpec)
        );
        s.n = uint32(editionSize);
        s.revealRoot = AuditRevealSet.root(editionSize);
        s.openAt = uint32(hook.openAt());
        assertEq(coordinator.specHash(), BoxSpecV1.specHash(s), "the recorded hash is the library's");
        assertEq(collection.metadataTableHash(), keccak256(s.metadataTable));
        assertEq(
            keccak256(collection.metadataTableBytes()), keccak256(s.metadataTable), "the served table is the spec's"
        );
        assertEq(collection.collectionSize(), s.n);
        assertEq(collection.revealRoot(), s.revealRoot);
        (uint16 reason,) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK);
        // The layout box 0 runs on is the library's curve for R with native ETH as currency0.
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(s.raise, false);
        assertEq(coordinator.raise(), s.raise);
        assertEq(curve.tickLower, c.tickLower);
        assertEq(curve.tickUpper, c.tickUpper);
        assertEq(curve.liquidity, c.liquidity);
        assertEq(curve.curveT, c.curveT);
        assertEq(curve.poolShare, c.poolShare);
    }

    /// P9.8 on box 0's real collection: a revealed item's tokenJSON parses with the test set's traits rendered from the
    /// spec's table, and an unrevealed item's hidden JSON (the placeholders add-on's text and SVG) parses.
    function testProperty_AUDIT_U9_box0TokenJsonParses() public {
        _toDrawing();
        string memory json = collection.tokenJSON(itemA);
        vm.parseJson(json);
        assertEq(vm.parseJsonString(json, ".name"), string.concat(collection.name(), " #", vm.toString(itemA)));
        ItemReveal memory r = _reveal(itemA);
        bytes memory t = collection.metadataTableBytes();
        bytes memory attrs = BoxMetadataTable.attributes(t, r.traitsPacked);
        string memory expected = string.concat(
            '{"name":"',
            collection.name(),
            " #",
            vm.toString(itemA),
            '","description":"',
            string(BoxMetadataTable.description(t)),
            '","image":"ipfs://',
            collection.imageCid(itemA),
            '","attributes":[',
            string(attrs),
            "]}"
        );
        if (r.modelHash != bytes32(0)) {
            // A model adds animation_url before the attributes: compare the parsed fields instead.
            assertEq(vm.parseJsonString(json, ".animation_url"), string.concat("ipfs://", collection.modelCid(itemA)));
        } else {
            assertEq(json, expected, "the whole JSON, byte for byte");
        }
        assertEq(vm.parseJsonString(json, ".description"), string(BoxMetadataTable.description(t)));
        string memory hidden = collection.tokenJSON(itemB);
        vm.parseJson(hidden);
        assertEq(vm.parseJsonString(hidden, ".description"), collection.hiddenDescription());
        assertEq(vm.parseJsonString(hidden, ".attributes[0].value"), "Not revealed");
        // P9.5 on box 0's own table (the Sepolia test set's, 3,341 bytes): the rendering gas per token.
        uint256 g0 = gasleft();
        string memory uri = collection.tokenURI(itemA);
        uint256 uriGas = g0 - gasleft();
        g0 = gasleft();
        collection.tokenURI(itemB);
        uint256 hiddenGas = g0 - gasleft();
        emit log_named_uint("box 0 tokenURI gas, a revealed item", uriGas);
        emit log_named_uint("box 0 tokenURI gas, a hidden item", hiddenGas);
        emit log_named_uint("box 0 tokenURI bytes, a revealed item", bytes(uri).length);
        assertLt(uriGas, 1_500_000, "pinned bound: box 0's tokenURI below 1,500,000 gas");
    }
}

/// @notice The same tests under Amsterdam (the unit sends no ETH of its own; the lock and the gates are fork-independent).
/// forge-config: default.evm_version = "amsterdam"
contract AuditU9FableLockAmsterdamTest is AuditU9FableLockTest {}
