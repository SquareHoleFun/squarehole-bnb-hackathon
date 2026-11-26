// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";

contract S0ProbeTarget {
    function f() external pure returns (uint256) {
        return 1;
    }
}

contract S0ProbeSink {
    uint256 public x;

    function poke() external {
        x = 1;
    }

    function noop() external {}
}

/// @dev Unit costs measured inside one frame (no cheatcode between a reading's two `gas()` calls).
contract S0ProbeInner {
    function _init(uint256 len) internal pure returns (bytes memory) {
        // PUSH2 len PUSH1 14 PUSH1 0 CODECOPY PUSH2 len PUSH1 0 RETURN (a 14-byte constructor), then `len` zero bytes.
        // forge-lint: disable-next-line(unsafe-typecast)
        return
            abi.encodePacked(hex"61", uint16(len), hex"600e600039", hex"61", uint16(len), hex"6000f3", new bytes(len));
    }

    function run(address cold) external returns (uint256[8] memory o) {
        bytes memory i0 = _init(0);
        bytes memory i1 = _init(1000);
        uint256 g;
        uint256 r;
        address a;
        assembly ("memory-safe") {
            g := gas()
            sstore(0x1234, 1)
            r := gas()
        }
        o[0] = g - r; // SSTORE, cold slot, zero -> non-zero
        assembly ("memory-safe") {
            g := gas()
            sstore(0x5678, 0)
            sstore(0x5678, 2)
            r := gas()
        }
        o[1] = g - r; // the same, after a no-op write (for reference)
        assembly ("memory-safe") {
            g := gas()
            r := sload(0x9999)
            r := sub(g, gas())
        }
        o[2] = r; // SLOAD, cold
        assembly ("memory-safe") {
            g := gas()
            a := create(0, add(i0, 32), mload(i0))
            r := sub(g, gas())
        }
        o[3] = r; // CREATE, empty code
        assembly ("memory-safe") {
            g := gas()
            a := create(0, add(i1, 32), mload(i1))
            r := sub(g, gas())
        }
        o[4] = r; // CREATE, 1,000 bytes of code
        bytes4 sel = S0ProbeTarget.f.selector;
        assembly ("memory-safe") {
            mstore(0, sel)
            g := gas()
            pop(delegatecall(gas(), cold, 0, 4, 0, 32))
            r := sub(g, gas())
        }
        o[5] = r; // DELEGATECALL, cold account (plus the callee's few hundred gas)
        assembly ("memory-safe") {
            mstore(0, sel)
            g := gas()
            pop(delegatecall(gas(), cold, 0, 4, 0, 32))
            r := sub(g, gas())
        }
        o[6] = r; // DELEGATECALL, warm
        o[7] = uint256(uint160(a));
    }

    /// A call capped at `cap` gas whose callee writes one slot from zero (the fail-safe observer's situation).
    function capped(address sink, uint256 cap) external returns (bool ok) {
        bytes memory data = abi.encodeCall(S0ProbeSink.poke, ());
        assembly ("memory-safe") {
            ok := call(cap, sink, 0, add(data, 32), mload(data), 0, 0)
        }
    }
}

/// @notice SPIKE ONLY (S0; docs/evidence/SH-S0-spikes.md § "Can Foundry model Glamsterdam?"): the unit costs Foundry
/// 1.8.3 charges under `vm.setEvmVersion("osaka")` (today's mainnet) and `"amsterdam"` (Glamsterdam: EIP-8037 state gas,
/// EIP-8038 access costs), and how `vm.lastFrameGas` reports state gas. Opt-in: `SH_SPIKE_S0=true`.
contract S0_ScheduleProbe_Test is Test {
    function _probe(string memory evm) internal {
        vm.setEvmVersion(evm);
        S0ProbeInner inner = new S0ProbeInner();
        address cold = address(0xDE1E6A7E);
        vm.etch(cold, address(new S0ProbeTarget()).code);
        uint256[8] memory o = inner.run(cold);
        console.log(string.concat("S0P|", evm, "|sstore cold zero->nonzero ", vm.toString(o[0])));
        console.log(string.concat("S0P|", evm, "|sload cold ", vm.toString(o[2])));
        console.log(string.concat("S0P|", evm, "|create empty ", vm.toString(o[3])));
        console.log(string.concat("S0P|", evm, "|create 1000-byte code ", vm.toString(o[4])));
        console.log(string.concat("S0P|", evm, "|delegatecall cold ", vm.toString(o[5])));
        console.log(string.concat("S0P|", evm, "|delegatecall warm ", vm.toString(o[6])));
        S0ProbeSink sink = new S0ProbeSink();
        bool ok100 = inner.capped(address(sink), 100_000);
        S0ProbeSink sink2 = new S0ProbeSink();
        bool ok300 = inner.capped(address(sink2), 300_000);
        console.log(
            string.concat(
                "S0P|",
                evm,
                "|a 100k-capped call writing one slot from zero: ",
                ok100 ? "succeeds" : "runs out of gas",
                "; 300k-capped: ",
                ok300 ? "succeeds" : "runs out of gas"
            )
        );
        // What lastFrameGas reports: a no-op transaction (the intrinsic base), then one that writes a slot from zero.
        S0ProbeSink fresh = new S0ProbeSink();
        fresh.noop();
        console.log(
            string.concat(
                "S0P|", evm, "|no-op call, lastFrameGas.gasTotalUsed ", vm.toString(vm.lastFrameGas().gasTotalUsed)
            )
        );
        uint256 g0 = gasleft();
        fresh.poke();
        uint256 inFrame = g0 - gasleft();
        uint256 reported = vm.lastFrameGas().gasTotalUsed;
        console.log(
            string.concat(
                "S0P|",
                evm,
                "|one new slot: gasleft delta in the caller ",
                vm.toString(inFrame),
                ", lastFrameGas.gasTotalUsed ",
                vm.toString(reported)
            )
        );
    }

    function test_schedule_today_osaka() public {
        if (!vm.envOr("SH_SPIKE_S0", false)) vm.skip(true);
        _probe("osaka");
    }

    function test_schedule_glamsterdam_amsterdam() public {
        if (!vm.envOr("SH_SPIKE_S0", false)) vm.skip(true);
        _probe("amsterdam");
    }
}
