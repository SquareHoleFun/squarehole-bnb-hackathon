// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditU8LaneBase, DrandSource, BoxBackedSource, IDrandSource} from "./AuditU8LaneBase.sol";
import {DrandWords} from "../../../../src/box/randomness/DrandWords.sol";

/// @notice Calls the real consumer library; adversarial sources are used only in the fail-closed test.
contract AuditU8LaneWords {
    function read(IDrandSource s, uint256 key) external view returns (bytes32, uint256) {
        return DrandWords.wordOf(s, key);
    }

    function usable(bytes32 w, uint256 ready, uint256 requested) external view returns (bool) {
        return DrandWords.usable(w, ready, requested);
    }

    function dead(IDrandSource s, uint256 key, uint256 at) external view returns (bool) {
        return DrandWords.isDead(s, key, at);
    }

    function paid(IDrandSource s, uint256 key, address refund)
        external
        payable
        returns (uint256 round, uint256 paidWei)
    {
        round = DrandWords.request(s, key, 0);
        paidWei = DrandWords.payRound(s, round, msg.value, refund);
        DrandWords.checkFunded(s, round);
    }
}

/// @notice IDrandSource 50,000-gas invariant and DrandWords caller/source failure distinction.
/// Cancun's posted state is seeded from the committed vector: EIP-2537 does not exist on Cancun.
/// Osaka/Amsterdam override this one fixture operation with a real BLS post; all reads use production code.
/// forge-config: default.evm_version = "cancun"
contract AuditU8LaneWordsGasCancunTest is AuditU8LaneBase {
    AuditU8LaneWords internal consumer;
    uint256 internal worst;

    function setUp() public virtual override {
        super.setUp();
        consumer = new AuditU8LaneWords();
    }

    function _post(uint256 round) internal virtual {
        Round memory r = _boxDrand(round);
        bytes32 slot = keccak256(abi.encode(round, uint256(1)));
        vm.store(address(drand), slot, r.randomness);
        vm.store(address(drand), bytes32(uint256(slot) + 1), bytes32(block.timestamp));
    }

    function _read(address source, uint256 key, bytes32 expected, uint256 ready, string memory state) internal {
        vm.cool(source);
        vm.cool(address(drand));
        bytes memory data = abi.encodeCall(IDrandSource.wordOf, (address(consumer), key));
        uint256 beforeGas = gasleft();
        (bool ok, bytes memory ret) = source.staticcall{gas: 50_000}(data);
        uint256 used = beforeGas - gasleft();
        assertTrue(ok);
        assertEq(ret.length, 64);
        (bytes32 w, uint64 r) = abi.decode(ret, (bytes32, uint64));
        assertEq(w, expected, state);
        assertEq(r, ready, state);
        assertLe(used, 24_000, "cold caller frame incl account access, stricter than 50k forwarded");
        if (used > worst) worst = used;
        emit log_named_uint(state, used);
    }

    function _both(uint256 key, string memory state) internal {
        (bytes32 d, uint64 dt) = drand.wordOf(address(consumer), key);
        (bytes32 b, uint64 bt) = backed.wordOf(address(consumer), key);
        _read(address(drand), key, d, dt, string.concat("drand / ", state));
        _read(address(backed), key, b, bt, string.concat("backed / ", state));
    }

    function testProperty_AUDIT_U8_coldReadEveryState() public {
        _both(0, "none");
        _request(false, address(consumer), 0, 0);
        _request(true, address(consumer), 0, 0);
        _both(0, "requested");
        uint256 snap = vm.snapshotState();
        vm.warp(drand.roundTime(first));
        _post(first);
        _both(0, "posted");
        (bytes32 w,) = backed.wordOf(address(consumer), 0);
        assertNotEq(w, bytes32(0));
        uint256 postedWorst = worst;
        assertTrue(vm.revertToState(snap));
        worst = postedWorst;
        vm.warp(drand.roundTime(first) + 5 days + 1);
        uint256 target = _start(first);
        _both(0, "started");
        uint256 pendingSnap = vm.snapshotState();
        vm.roll(target + 1);
        _fix(first, target, keccak256("gas mix"));
        _both(0, "fixed");
        uint256 fixedWorst = worst;
        assertTrue(vm.revertToState(pendingSnap));
        worst = fixedWorst;
        vm.warp(drand.roundTime(first) + 8 days);
        assertTrue(drand.isSilent(address(consumer), 0));
        assertTrue(backed.isSilent(address(consumer), 0));
        _both(0, "silent");
        emit log_named_uint("worst cold caller frame", worst);
    }

    function testProperty_AUDIT_U8_lowCallerGasIsAnError() public view {
        (bool ok, bytes memory ret) =
            address(consumer).staticcall{gas: 55_000}(abi.encodeCall(consumer.read, (IDrandSource(address(backed)), 0)));
        assertFalse(ok);
        assertEq(bytes4(ret), DrandWords.GasTooLow.selector);
        (bytes32 w, uint256 at) = consumer.read(IDrandSource(address(backed)), 0);
        assertEq(w, bytes32(0));
        assertEq(at, 0);
    }

    /// @notice Stand-ins represent a reverting source, short return, gas burner and out-of-range readyAt.
    function testProperty_AUDIT_U8_badCalleeIsNoWord() public {
        address bad = address(0xBADD);
        bytes[4] memory codes =
            [bytes(hex"5f5ffd"), hex"5f5f5260205ff3", hex"5b600056", hex"60015f52600160401b60205260405ff3"];
        for (uint256 i; i < codes.length; ++i) {
            vm.etch(bad, codes[i]);
            (bytes32 w, uint256 at) = consumer.read(IDrandSource(bad), 0);
            assertEq(w, bytes32(0));
            assertEq(at, 0);
        }
    }

    function testFuzz_AUDIT_U8_usableBoundaries(uint64 requested, uint64 ready, uint64 nowTime, bytes32 w) public {
        vm.warp(nowTime);
        bool expected =
            w != 0 && ready >= requested && ready <= nowTime && uint256(ready) <= uint256(requested) + 7 days;
        assertEq(consumer.usable(w, ready, requested), expected);
    }

    function testProperty_AUDIT_U8_silenceAndUsabilityDeadline() public {
        uint256 requested = block.timestamp;
        _request(false, address(consumer), 0, 0);
        _request(true, address(consumer), 0, 0);
        vm.warp(requested + 7 days);
        assertFalse(drand.isSilent(address(consumer), 0));
        assertFalse(backed.isSilent(address(consumer), 0));
        assertFalse(consumer.dead(IDrandSource(address(backed)), 0, requested));
        uint256 snap = vm.snapshotState();
        _post(first);
        vm.warp(requested + 7 days + 1);
        assertFalse(drand.isSilent(address(consumer), 0));
        assertFalse(backed.isSilent(address(consumer), 0));
        assertFalse(consumer.dead(IDrandSource(address(backed)), 0, requested));
        assertTrue(vm.revertToState(snap));
        vm.warp(requested + 7 days + 1);
        assertTrue(drand.isSilent(address(consumer), 0));
        assertTrue(backed.isSilent(address(consumer), 0));
        _post(first);
        assertTrue(drand.isSilent(address(consumer), 0));
        assertTrue(backed.isSilent(address(consumer), 0));
        assertTrue(consumer.dead(IDrandSource(address(backed)), 0, requested));
    }

    /// @notice A rejecting refund recipient is the only stand-in; the library sends its rest into the real pot.
    function testProperty_AUDIT_U8_payRoundFundsOnlyShortfallOrRefusedRefund() public {
        vm.fee(1 gwei);
        uint256 target = 600_000 * 1 gwei;
        address refund = address(0xCAFE);
        (, uint256 paid) = consumer.paid{value: 2 * target}(IDrandSource(address(backed)), 1, refund);
        assertEq(paid, target);
        assertEq(refund.balance, target);
        (, paid) = consumer.paid{value: target}(IDrandSource(address(backed)), 2, refund);
        assertEq(paid, 0);
        assertEq(refund.balance, 2 * target);
        vm.etch(refund, hex"5f5ffd");
        (, paid) = consumer.paid{value: target}(IDrandSource(address(backed)), 3, refund);
        assertEq(paid, target);
        assertEq(drand.bountyOf(first), 2 * target);
        assertEq(address(consumer).balance, 0);
        assertEq(address(backed).balance, 0);
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU8LaneWordsGasOsakaTest is AuditU8LaneWordsGasCancunTest {
    function _post(uint256 round) internal override {
        drand.postRound(round, _boxDrand(round).xy);
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU8LaneWordsGasAmsterdamTest is AuditU8LaneWordsGasOsakaTest {}
