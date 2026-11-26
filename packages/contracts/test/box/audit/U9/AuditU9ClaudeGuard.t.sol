// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TransientReentrancyGuard} from "../../../../src/libraries/TransientReentrancyGuard.sol";

/// @notice TEST ONLY: a contract using the guard exactly as the box contracts do (both modifiers, the view), with
/// the exits a guarded body can take.
contract AuditU9ClaudeGuardProbe is TransientReentrancyGuard {
    uint256 internal constant SLOT = uint256(keccak256("squarehole.reentrancy.lock")) - 1;

    error Boom();

    uint256 public count;

    function guarded() external nonReentrant {
        ++count;
    }

    function guardedCall() external nonReentrantCall {
        ++count;
    }

    function guardedReturns(bool early) external nonReentrant returns (uint256) {
        if (early) return 1;
        ++count;
        return 2;
    }

    function guardedReverts() external nonReentrant {
        ++count;
        revert Boom();
    }

    function guardedCallReverts() external nonReentrantCall {
        ++count;
        revert Boom();
    }

    /// @dev A guarded body that calls out (as a payout or a PoolManager unlock does).
    function guardedThenCall(address target, bytes calldata data)
        external
        nonReentrant
        returns (bool ok, bytes memory r)
    {
        (ok, r) = target.call(data);
    }

    function guardedCallThenCall(address target, bytes calldata data)
        external
        nonReentrantCall
        returns (bool ok, bytes memory r)
    {
        (ok, r) = target.call(data);
    }

    function inside() external view returns (bool) {
        return _insideGuardedCall();
    }

    function insideWhileGuarded() external nonReentrant returns (bool) {
        return _insideGuardedCall();
    }

    function insideWhileGuardedCall() external nonReentrantCall returns (bool) {
        return _insideGuardedCall();
    }

    /// @dev The documented slot, read inside a guarded call.
    function documentedSlotWhileGuarded() external nonReentrant returns (uint256 v) {
        uint256 s = SLOT;
        assembly ("memory-safe") {
            v := tload(s)
        }
    }

    function documentedSlotNow() external view returns (uint256 v) {
        uint256 s = SLOT;
        assembly ("memory-safe") {
            v := tload(s)
        }
    }

    /// @dev The one exit that skips the modifier's tail: an inline-assembly `return` (no box contract has one in a
    /// guarded function: the two in src/box, BoxHook.sol:436 and BoxReceiver.sol:1014, are unguarded forwarders).
    function guardedAssemblyReturn() external nonReentrant returns (uint256) {
        assembly ("memory-safe") {
            mstore(0x00, 7)
            return(0x00, 0x20)
        }
    }

    function delegateTo(address half, bytes calldata data) external returns (bool ok, bytes memory r) {
        (ok, r) = half.delegatecall(data);
    }

    function guardedDelegateTo(address half, bytes calldata data)
        external
        nonReentrant
        returns (bool ok, bytes memory r)
    {
        (ok, r) = half.delegatecall(data);
    }

    receive() external payable nonReentrant {}
}

/// @notice TEST ONLY: the other half, reached by DELEGATECALL (as BoxReceiverExtension from BoxReceiver).
contract AuditU9ClaudeGuardHalf is TransientReentrancyGuard {
    function halfGuarded() external nonReentrantCall returns (bool) {
        return true;
    }

    function halfInside() external view returns (bool) {
        return _insideGuardedCall();
    }
}

/// @notice TEST ONLY: several calls inside one transaction (forge runs each top-level call as its own transaction).
contract AuditU9ClaudeMulticall {
    function run(address target, bytes[] calldata calls) external returns (bool[] memory ok, bytes[] memory ret) {
        ok = new bool[](calls.length);
        ret = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (ok[i], ret[i]) = target.call(calls[i]);
        }
    }
}

/// @notice TEST ONLY: a callee that calls back into `target` with a stored payload and keeps the outcome.
contract AuditU9ClaudeReenterer {
    address internal _target;
    bytes internal _payload;
    bool public lastOk;
    bytes public lastRet;

    function arm(address target, bytes calldata payload) external {
        _target = target;
        _payload = payload;
    }

    fallback() external payable {
        (lastOk, lastRet) = _target.call(_payload);
    }
}

/// @title AuditU9ClaudeGuardTest (SH-AUDIT-B0-U9, Claude; P9.3; lens L3)
/// @notice TransientReentrancyGuard (src/libraries/TransientReentrancyGuard.sol:1-58) on its own: the lock is released
/// at the end of each guarded call, so two guarded calls in one transaction both succeed (whatever the mix of
/// `nonReentrant` and `nonReentrantCall`, an early `return` included); a caught inner revert leaves it released (the
/// revert undoes the TSTORE); a re-entry into either modifier from a callback reverts `Reentrancy()`; the two
/// modifiers and `_insideGuardedCall` are one lock in the documented slot (keccak256("squarehole.reentrancy.lock")
/// - 1, :9-10), distinct from every other transient slot in src/box; a DELEGATECALL half sees and takes the caller's
/// lock (BoxReceiverBase.sol:10-12: "the same transient reentrancy lock"). Only an inline-assembly `return` inside a
/// guarded body would leave the lock set until the transaction ends, and src/box has none in a guarded function.
/// The probe contracts are stand-ins by design: the property is the guard's own; the box contracts' use of it is in
/// AuditU9ClaudeWorld.t.sol.
contract AuditU9ClaudeGuardTest is Test {
    bytes4 internal constant REENTRANCY = 0xab143c06;

    AuditU9ClaudeGuardProbe internal probe;
    AuditU9ClaudeGuardHalf internal half;
    AuditU9ClaudeMulticall internal multi;
    AuditU9ClaudeReenterer internal reenterer;

    function setUp() public {
        probe = new AuditU9ClaudeGuardProbe();
        half = new AuditU9ClaudeGuardHalf();
        multi = new AuditU9ClaudeMulticall();
        reenterer = new AuditU9ClaudeReenterer();
    }

    function _calls(bytes memory a, bytes memory b) internal pure returns (bytes[] memory c) {
        c = new bytes[](2);
        (c[0], c[1]) = (a, b);
    }

    function testProperty_AUDIT_U9_lockSelectorIsReentrancy() public pure {
        assertEq(TransientReentrancyGuard.Reentrancy.selector, REENTRANCY);
    }

    /// Two guarded calls in one transaction, every mix of the two modifiers and an early return: all succeed.
    function testProperty_AUDIT_U9_twoGuardedCallsInOneTransaction() public {
        bytes[4] memory forms = [
            abi.encodeCall(probe.guarded, ()),
            abi.encodeCall(probe.guardedCall, ()),
            abi.encodeCall(probe.guardedReturns, (true)),
            abi.encodeCall(probe.guardedReturns, (false))
        ];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                (bool[] memory ok,) = multi.run(address(probe), _calls(forms[i], forms[j]));
                assertTrue(ok[0] && ok[1], string.concat(vm.toString(i), " then ", vm.toString(j)));
            }
        }
        // Counting calls: guarded, guardedCall and guardedReturns(false) count one each, the early return none: over
        // the 16 ordered pairs each form appears 8 times, so 8 × 3 = 24.
        assertEq(probe.count(), 24, "every call ran");
    }

    /// A caught inner revert (either modifier) leaves the lock released: the next guarded call in the same
    /// transaction succeeds, and the reverted call's state change is gone.
    function testProperty_AUDIT_U9_caughtRevertLeavesTheLockReleased() public {
        bytes[2] memory reverts =
            [abi.encodeCall(probe.guardedReverts, ()), abi.encodeCall(probe.guardedCallReverts, ())];
        bytes[2] memory then_ = [abi.encodeCall(probe.guarded, ()), abi.encodeCall(probe.guardedCall, ())];
        for (uint256 i; i < 2; ++i) {
            for (uint256 j; j < 2; ++j) {
                (bool[] memory ok, bytes[] memory ret) = multi.run(address(probe), _calls(reverts[i], then_[j]));
                assertFalse(ok[0]);
                assertEq(bytes4(ret[0]), AuditU9ClaudeGuardProbe.Boom.selector);
                assertTrue(ok[1], "the lock was released by the revert");
            }
        }
        assertEq(probe.count(), 4, "only the four successful calls counted");
    }

    /// A callback re-entering either modifier from inside either modifier reverts Reentrancy(), and so does a plain
    /// call into the guarded `receive`; the outer call itself completes.
    function testProperty_AUDIT_U9_reentryRefusedWithReentrancy() public {
        bytes[3] memory inner = [
            abi.encodeCall(probe.guarded, ()),
            abi.encodeCall(probe.guardedCall, ()),
            abi.encodeCall(probe.guardedReturns, (false))
        ];
        for (uint256 outer; outer < 2; ++outer) {
            for (uint256 k; k < 3; ++k) {
                reenterer.arm(address(probe), inner[k]);
                (bool ok,) = outer == 0
                    ? probe.guardedThenCall(address(reenterer), "")
                    : probe.guardedCallThenCall(address(reenterer), "");
                assertTrue(ok, "the callback itself returns");
                assertFalse(reenterer.lastOk(), "re-entry refused");
                assertEq(bytes4(reenterer.lastRet()), REENTRANCY);
                assertEq(reenterer.lastRet().length, 4, "exactly Reentrancy()");
            }
        }
        // A plain call (empty calldata) into the guarded receive from inside a guarded call.
        AuditU9ClaudeReenterer payer = new AuditU9ClaudeReenterer();
        vm.deal(address(payer), 1 ether);
        payer.arm(address(probe), "");
        (bool ok2,) = probe.guardedThenCall(address(payer), "");
        assertTrue(ok2);
        assertFalse(payer.lastOk(), "a plain call into a guarded receive during a guarded call");
        assertEq(bytes4(payer.lastRet()), REENTRANCY);
        assertEq(probe.count(), 0, "no re-entered body ran");
    }

    /// `_insideGuardedCall` is true exactly while a guarded call (either modifier) runs, in the same transaction.
    function testProperty_AUDIT_U9_insideGuardedCallTracksTheLock() public {
        bytes[] memory c = new bytes[](4);
        c[0] = abi.encodeCall(probe.inside, ());
        c[1] = abi.encodeCall(probe.insideWhileGuarded, ());
        c[2] = abi.encodeCall(probe.insideWhileGuardedCall, ());
        c[3] = abi.encodeCall(probe.inside, ());
        (bool[] memory ok, bytes[] memory ret) = multi.run(address(probe), c);
        for (uint256 i; i < 4; ++i) {
            assertTrue(ok[i]);
        }
        assertFalse(abi.decode(ret[0], (bool)));
        assertTrue(abi.decode(ret[1], (bool)));
        assertTrue(abi.decode(ret[2], (bool)));
        assertFalse(abi.decode(ret[3], (bool)), "released afterwards");
    }

    /// The lock is the documented slot, and no other transient slot in src/box can touch it: the receiver's step
    /// snapshot (BoxReceiver.sol:115, and the next slot), the stream's exits mark (BoxItemStream.sol:91), the vault's
    /// receipt (BoxVault.sol:75), the tickets' in-flight id (slot 1, BoxTickets.sol:88); BoxIdSet's slots are
    /// keccak256(seed, id) (BoxIdSet.sol:37-43), a preimage of the lock slot.
    function testProperty_AUDIT_U9_lockSlotIsTheDocumentedOne() public {
        uint256 lockSlot = 0xef31a04cf6d735a65317e38e827797a212a707e4f76ab21853f1c9877af28024;
        assertEq(lockSlot, uint256(keccak256("squarehole.reentrancy.lock")) - 1, "TransientReentrancyGuard.sol:9-10");
        bytes[] memory c = new bytes[](2);
        c[0] = abi.encodeCall(probe.documentedSlotWhileGuarded, ());
        c[1] = abi.encodeCall(probe.documentedSlotNow, ());
        (bool[] memory ok, bytes[] memory ret) = multi.run(address(probe), c);
        assertTrue(ok[0] && ok[1]);
        assertEq(abi.decode(ret[0], (uint256)), 1, "the guard writes 1 to the documented slot");
        assertEq(abi.decode(ret[1], (uint256)), 0, "and clears it");
        uint256 snap = 0xd51179e6eabe3da5d3cd770323c492b96daf34d73e03ae7bc5e9bc174ad3a1bb;
        assertEq(snap, uint256(keccak256("squarehole.receiver.module.snapshot.q")) - 1, "BoxReceiver.sol:113-115");
        uint256[5] memory others = [
            snap,
            snap + 1,
            0x9ef113852a8e14cfd94eaa0511bb2c8b5ad7e42339ec2988c1197580b6d3dead,
            0x199d5a5f3db3daa3659a7822529312c852d34677e8f1546f076eb8a34780cb5b,
            1
        ];
        for (uint256 i; i < others.length; ++i) {
            assertTrue(others[i] != lockSlot, "a distinct transient slot");
        }
    }

    /// An early `return` in a guarded body runs the modifier's tail (Solidity), so it releases the lock; only an
    /// inline-assembly `return` skips it. That one leaves the lock set for the rest of the transaction (and EIP-1153
    /// clears it at the transaction's end: the next top-level call, its own transaction here, succeeds).
    function testProperty_AUDIT_U9_onlyAnAssemblyReturnLeavesTheLockSet() public {
        (bool[] memory ok, bytes[] memory ret) = multi.run(
            address(probe), _calls(abi.encodeCall(probe.guardedReturns, (true)), abi.encodeCall(probe.guarded, ()))
        );
        assertTrue(ok[0] && ok[1], "early return released the lock");
        (ok, ret) = multi.run(
            address(probe), _calls(abi.encodeCall(probe.guardedAssemblyReturn, ()), abi.encodeCall(probe.guarded, ()))
        );
        assertTrue(ok[0]);
        assertEq(abi.decode(ret[0], (uint256)), 7);
        assertFalse(ok[1], "the assembly return left the lock set");
        assertEq(bytes4(ret[1]), REENTRANCY);
        // A new transaction (forge's isolation: each top-level call is one): the EVM cleared the slot.
        probe.guarded();
        assertEq(probe.count(), 2);
    }

    /// The DELEGATECALL halves (BoxReceiver → BoxReceiverExtension): a half running in the caller's context reads
    /// the caller's lock and takes the same slot. Inside the caller's guarded call the half's guarded entry reverts
    /// Reentrancy(); outside it succeeds and releases the slot, so a guarded call of the caller right after (same
    /// transaction) succeeds; the half's view sees the caller's lock.
    function testProperty_AUDIT_U9_delegatedHalvesShareTheLock() public {
        (bool ok, bytes memory ret) = probe.guardedDelegateTo(address(half), abi.encodeCall(half.halfGuarded, ()));
        assertFalse(ok, "the half sees the caller's lock");
        assertEq(bytes4(ret), REENTRANCY);
        (ok, ret) = probe.guardedDelegateTo(address(half), abi.encodeCall(half.halfInside, ()));
        assertTrue(ok);
        assertTrue(abi.decode(ret, (bool)), "the half's _insideGuardedCall is the caller's");
        bytes[] memory c = new bytes[](3);
        c[0] = abi.encodeCall(probe.delegateTo, (address(half), abi.encodeCall(half.halfGuarded, ())));
        c[1] = abi.encodeCall(probe.guarded, ());
        c[2] = abi.encodeCall(probe.delegateTo, (address(half), abi.encodeCall(half.halfInside, ())));
        bool[] memory oks;
        bytes[] memory rets;
        (oks, rets) = multi.run(address(probe), c);
        assertTrue(oks[0] && oks[1] && oks[2]);
        (bool inner, bytes memory innerRet) = abi.decode(rets[0], (bool, bytes));
        assertTrue(inner, "the half's guarded call outside a caller lock succeeds");
        assertTrue(abi.decode(innerRet, (bool)));
        (inner, innerRet) = abi.decode(rets[2], (bool, bytes));
        assertFalse(abi.decode(innerRet, (bool)), "and released the caller's slot");
        // The half's own storage (its own address) is untouched: called directly, it is unlocked.
        assertFalse(half.halfInside());
    }

    /// Gas (L5): the inline modifier and the call form, measured inside one transaction; a 2,300-gas stipend into a
    /// guarded `receive` fits (cancun here; osaka and amsterdam in the variants below).
    function testProperty_AUDIT_U9_guardGasAndStipend() public {
        uint256 g = gasleft();
        probe.guarded();
        uint256 inline_ = g - gasleft();
        g = gasleft();
        probe.guardedCall();
        uint256 viaCall = g - gasleft();
        emit log_named_uint("guarded() call, nonReentrant, incl. call overhead", inline_);
        emit log_named_uint("guardedCall() call, nonReentrantCall, incl. call overhead", viaCall);
        vm.deal(address(this), 1 ether);
        payable(address(probe)).transfer(1);
        assertEq(address(probe).balance, 1, "a stipend payment into a guarded receive fits");
    }
}

/// @notice The stipend and EIP-7702 under the forks with delegations: a 2,300-gas payment into a guarded `receive`
/// fits when the contract is called directly; through an EIP-7702 delegation the delegated EOA's code gets less (the
/// wave-1 measurement: about 3,000 gas less under Amsterdam). Box 0 never pays with a stipend into a guarded receive
/// of a 7702 account (its guarded receives are FIT's executor's and its gated one the receiver's; both contracts); this
/// pins what the guard costs a delegate that would use it.
/// forge-config: default.evm_version = "osaka"
contract AuditU9ClaudeGuardOsakaTest is Test {
    AuditU9ClaudeGuardProbe internal probe;

    function setUp() public {
        probe = new AuditU9ClaudeGuardProbe();
    }

    function _stipendTo(address to) internal returns (bool ok) {
        vm.deal(address(this), 1 ether);
        // forge-lint: disable-next-line(arbitrary-send-eth)
        ok = payable(to).send(1);
    }

    function testProperty_AUDIT_U9_stipendIntoAGuardedReceive() public {
        assertTrue(_stipendTo(address(probe)), "direct: the stipend fits");
        (address eoa, uint256 key) = makeAddrAndKey("audit.u9.7702");
        vm.signAndAttachDelegation(address(probe), key);
        (bool ok,) = eoa.call("");
        assertTrue(ok, "the authorization's call");
        assertEq(eoa.code.length, 23);
        bool viaDelegation = _stipendTo(eoa);
        emit log_named_string("evm", vm.getEvmVersion());
        emit log_named_uint(
            "stipend into the 7702 EOA delegated to a guarded receive succeeded (1 = yes)", viaDelegation ? 1 : 0
        );
        _pinDelegation(viaDelegation);
    }

    /// @dev Osaka: the stipend still fits through the delegation.
    function _pinDelegation(bool viaDelegation) internal virtual {
        assertTrue(viaDelegation, "osaka: fits");
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU9ClaudeGuardAmsterdamTest is AuditU9ClaudeGuardOsakaTest {
    /// @dev Amsterdam: the delegation's extra cost leaves the guarded receive short of gas.
    function _pinDelegation(bool viaDelegation) internal pure override {
        assertFalse(viaDelegation, "amsterdam: a stipend-only payment to a 7702 account with a guarded receive fails");
    }
}
