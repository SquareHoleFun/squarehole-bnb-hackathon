// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {DrandWords} from "../../../src/box/randomness/DrandWords.sol";
import {PinnedDrandSource} from "./utils/PinnedDrandSource.sol";

/// @notice Init code that writes storage, then installs the given runtime code unchanged: a twin of the pinned source
/// with the same EXTCODEHASH and chosen state (security review 2026-09-30, the pinning bypass; copied from
/// test/v2/genesis/SourcePin.t.sol).
contract PoisonedDrandTwin {
    constructor(bytes memory runtime, bytes32[] memory slots, bytes32[] memory values) {
        for (uint256 i; i < slots.length; ++i) {
            bytes32 slot = slots[i];
            bytes32 value = values[i];
            assembly ("memory-safe") {
                sstore(slot, value)
            }
        }
        assembly ("memory-safe") {
            return(add(runtime, 32), mload(runtime))
        }
    }
}

/// @notice Exposes `DrandSourcePins.isPinned` and `DrandWords.isDelegation` (internal) for the checks below.
contract PinCheck {
    function isPinned(address source) external view returns (bool) {
        return DrandSourcePins.isPinned(source);
    }

    function isDelegation(address account) external view returns (bool) {
        return DrandWords.isDelegation(account);
    }
}

/// @notice The pins of `DrandSource` for chains 1 and 11155111 (`DrandSourcePins.sol`; BC-101's pin values, slice S9;
/// the factory's own constructor check is S7's): every value is the compiled source's; the pin accepts exactly that
/// deployment on those chains and nothing elsewhere, and refuses the four BC-101 counterfeits (a twin with the pinned
/// code at another address, a storage-poisoned twin, an EIP-7702 delegation at the pinned address, an address with no
/// code). Chain ids are set with `vm.chainId`; the fork suites (`DrandSourceFork.t.sol`) repeat the check through the
/// real deployer on the real chains.
contract DrandSourcePinTest is Test {
    PinCheck internal check;

    function setUp() public {
        check = new PinCheck();
    }

    /// The pins are the compiled source: its init code hash, its address through the canonical deployer and its code
    /// hash, the same on both chains (no constructor input, no immutables).
    function test_pin_isTheCompiledSource() public {
        DrandSource src = PinnedDrandSource.deploy(vm);
        assertEq(
            DrandSourcePins.INIT_CODE_HASH,
            keccak256(type(DrandSource).creationCode),
            "update DrandSourcePins.INIT_CODE_HASH to the compiled creation code's hash"
        );
        assertEq(DrandSourcePins.ADDRESS_MAINNET, address(src), "update DrandSourcePins.ADDRESS_MAINNET");
        assertEq(DrandSourcePins.ADDRESS_SEPOLIA, address(src), "update DrandSourcePins.ADDRESS_SEPOLIA");
        assertEq(DrandSourcePins.CODE_HASH_MAINNET, address(src).codehash, "update DrandSourcePins.CODE_HASH_MAINNET");
        assertEq(DrandSourcePins.CODE_HASH_SEPOLIA, address(src).codehash, "update DrandSourcePins.CODE_HASH_SEPOLIA");
        assertEq(address(src), PinnedDrandSource.predict());
        assertEq(DrandSourcePins.SALT, keccak256("squarehole.box.v1.DrandSource"));
        // A plain deployment has the same runtime code: nothing chain- or deployer-specific is inside it.
        assertEq(address(new DrandSource()).codehash, address(src).codehash, "no immutables");
        emit log_named_address("pinned DrandSource (chains 1 and 11155111)", address(src));
        emit log_named_bytes32("its code hash", address(src).codehash);
    }

    function test_pinned_perChainAndNothingElsewhere() public pure {
        (address a, bytes32 h) = DrandSourcePins.pinned(1);
        assertEq(a, DrandSourcePins.ADDRESS_MAINNET);
        assertEq(h, DrandSourcePins.CODE_HASH_MAINNET);
        (a, h) = DrandSourcePins.pinned(11_155_111);
        assertEq(a, DrandSourcePins.ADDRESS_SEPOLIA);
        assertEq(h, DrandSourcePins.CODE_HASH_SEPOLIA);
        uint256[4] memory others = [uint256(31_337), 8_453, 17_000, 560_048];
        for (uint256 i; i < others.length; ++i) {
            (a, h) = DrandSourcePins.pinned(others[i]);
            assertEq(a, address(0));
            assertEq(h, bytes32(0));
        }
    }

    /// BC-101 `pinned`: the deployment on chains 1 and 11155111; refused on a local chain and on Base.
    function test_isPinned_acceptsTheDeploymentOnlyOnItsChains() public {
        DrandSource src = PinnedDrandSource.deploy(vm);
        vm.chainId(1);
        assertTrue(check.isPinned(address(src)), "mainnet");
        vm.chainId(11_155_111);
        assertTrue(check.isPinned(address(src)), "Sepolia");
        vm.chainId(31_337);
        assertFalse(check.isPinned(address(src)), "a local chain");
        vm.chainId(8_453);
        assertFalse(check.isPinned(address(src)), "another network");
    }

    /// BC-101 `twin_other_address`: the same code elsewhere (a plain deployment), and a twin whose init code wrote a
    /// posted beacon for a round of its choosing, are refused although their code hash is the pinned one.
    function test_isPinned_refusesTwinsAtOtherAddresses() public {
        vm.chainId(1);
        DrandSource plain = new DrandSource();
        assertEq(address(plain).codehash, DrandSourcePins.CODE_HASH_MAINNET);
        assertFalse(check.isPinned(address(plain)), "same code, another address");

        bytes memory runtime = address(plain).code;
        bytes32[] memory slots = new bytes32[](2);
        bytes32[] memory values = new bytes32[](2);
        uint256 round = 40_000_000;
        // _rounds is the second mapping (slot 1): randomness at keccak(round, 1), postedAt | pot one slot later.
        bytes32 base = keccak256(abi.encode(round, uint256(1)));
        slots[0] = base;
        values[0] = keccak256("a randomness the deployer ground offline");
        slots[1] = bytes32(uint256(base) + 1);
        values[1] = bytes32(uint256(block.timestamp));
        address twin = address(new PoisonedDrandTwin(runtime, slots, values));
        assertEq(twin.codehash, DrandSourcePins.CODE_HASH_MAINNET, "the twin has the pinned code hash");
        (bytes32 r, uint64 postedAt) = DrandSource(twin).beaconOf(round);
        assertEq(r, values[0], "and a planted beacon");
        assertEq(postedAt, block.timestamp);
        assertFalse(check.isPinned(twin), "refused");
    }

    /// BC-101 `eip7702`: an EIP-7702 delegation designator at the pinned address (to the real code) is refused.
    function test_isPinned_refusesADelegationAtThePinnedAddress() public {
        vm.chainId(1);
        DrandSource real = new DrandSource();
        address pin = PinnedDrandSource.predict();
        vm.etch(pin, abi.encodePacked(hex"ef0100", address(real)));
        assertTrue(check.isDelegation(pin), "a delegation");
        assertFalse(check.isDelegation(address(real)), "the real code is not one");
        assertFalse(check.isPinned(pin), "refused");
    }

    /// BC-101 `no_code`: nothing at the pinned address yet (before anyone sends the deployment) is refused.
    function test_isPinned_refusesAnAddressWithNoCode() public {
        vm.chainId(1);
        address pin = PinnedDrandSource.predict();
        assertEq(pin.code.length, 0);
        assertFalse(check.isPinned(pin), "no code");
        assertFalse(check.isPinned(address(0)), "zero");
    }
}
