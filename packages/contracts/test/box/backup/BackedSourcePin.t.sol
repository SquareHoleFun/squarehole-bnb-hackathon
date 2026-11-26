// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {BackedSourcePins} from "../../../src/box/randomness/BackedSourcePins.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {PinnedBackedSource} from "../randomness/utils/PinnedBackedSource.sol";
import {PoisonedDrandTwin} from "../randomness/DrandSourcePin.t.sol";

/// @notice Exposes `BackedSourcePins.isPinned` (internal) for the checks below.
contract BackedPinCheck {
    function isPinned(address source) external view returns (bool) {
        return BackedSourcePins.isPinned(source);
    }
}

/// @notice The pins of `BoxBackedSource` for chains 1 and 11155111 (`BackedSourcePins.sol`; F143, BC-101's values):
/// every value is the compiled source's; the pin accepts exactly that deployment on those chains and nothing elsewhere,
/// and refuses BC-101's four counterfeits (a twin at another address, a storage-poisoned twin, an EIP-7702 delegation
/// at the pinned address, an address with no code), as `DrandSourcePin.t.sol` does for the DrandSource.
contract BackedSourcePinTest is Test {
    BackedPinCheck internal check;

    function setUp() public {
        check = new BackedPinCheck();
    }

    /// The pins are the compiled source: its init code hash, its address through the canonical deployer and its code
    /// hash, the same on both chains (no constructor input, no immutables); it names the pinned DrandSource.
    function test_pin_isTheCompiledSource() public {
        BoxBackedSource src = PinnedBackedSource.deploy(vm);
        assertEq(
            BackedSourcePins.INIT_CODE_HASH,
            keccak256(type(BoxBackedSource).creationCode),
            "update BackedSourcePins.INIT_CODE_HASH to the compiled creation code's hash"
        );
        assertEq(BackedSourcePins.ADDRESS_MAINNET, address(src), "update BackedSourcePins.ADDRESS_MAINNET");
        assertEq(BackedSourcePins.ADDRESS_SEPOLIA, address(src), "update BackedSourcePins.ADDRESS_SEPOLIA");
        assertEq(BackedSourcePins.CODE_HASH_MAINNET, address(src).codehash, "update BackedSourcePins.CODE_HASH_MAINNET");
        assertEq(BackedSourcePins.CODE_HASH_SEPOLIA, address(src).codehash, "update BackedSourcePins.CODE_HASH_SEPOLIA");
        assertEq(address(src), PinnedBackedSource.predict());
        assertEq(BackedSourcePins.SALT, keccak256("squarehole.box.v1.BoxBackedSource"));
        assertEq(BackedSourcePins.DEPLOYER, DrandSourcePins.DEPLOYER, "the same canonical deployer");
        assertEq(address(src.DRAND()), DrandSourcePins.ADDRESS_MAINNET, "names the pinned DrandSource");
        assertEq(DrandSourcePins.ADDRESS_SEPOLIA, DrandSourcePins.ADDRESS_MAINNET, "one DrandSource address for both");
        assertEq(address(new BoxBackedSource()).codehash, address(src).codehash, "no immutables");
        emit log_named_address("pinned BoxBackedSource (chains 1 and 11155111)", address(src));
        emit log_named_bytes32("its code hash", address(src).codehash);
        emit log_named_bytes32("its init code hash", keccak256(type(BoxBackedSource).creationCode));
        emit log_named_uint("runtime bytes", address(src).code.length);
    }

    function test_pinned_perChainAndNothingElsewhere() public pure {
        (address a, bytes32 h) = BackedSourcePins.pinned(1);
        assertEq(a, BackedSourcePins.ADDRESS_MAINNET);
        assertEq(h, BackedSourcePins.CODE_HASH_MAINNET);
        (a, h) = BackedSourcePins.pinned(11_155_111);
        assertEq(a, BackedSourcePins.ADDRESS_SEPOLIA);
        assertEq(h, BackedSourcePins.CODE_HASH_SEPOLIA);
        uint256[4] memory others = [uint256(31_337), 8_453, 17_000, 560_048];
        for (uint256 i; i < others.length; ++i) {
            (a, h) = BackedSourcePins.pinned(others[i]);
            assertEq(a, address(0));
            assertEq(h, bytes32(0));
        }
    }

    /// BC-101 `pinned`: the deployment on chains 1 and 11155111; refused on a local chain and on Base.
    function test_isPinned_acceptsTheDeploymentOnlyOnItsChains() public {
        BoxBackedSource src = PinnedBackedSource.deploy(vm);
        vm.chainId(1);
        assertTrue(check.isPinned(address(src)), "mainnet");
        vm.chainId(11_155_111);
        assertTrue(check.isPinned(address(src)), "Sepolia");
        vm.chainId(31_337);
        assertFalse(check.isPinned(address(src)), "a local chain");
        vm.chainId(8_453);
        assertFalse(check.isPinned(address(src)), "another network");
    }

    /// BC-101 `twin_other_address`: the same code elsewhere, and a twin whose init code planted a fixed backup for a
    /// round of its choosing, are refused although their code hash is the pinned one.
    function test_isPinned_refusesTwinsAtOtherAddresses() public {
        vm.chainId(1);
        BoxBackedSource plain = new BoxBackedSource();
        assertEq(address(plain).codehash, BackedSourcePins.CODE_HASH_MAINNET);
        assertFalse(check.isPinned(address(plain)), "same code, another address");

        uint256 round = 40_000_000;
        bytes32[] memory slots = new bytes32[](2);
        bytes32[] memory values = new bytes32[](2);
        // _backups is slot 0 (startedAt | targetBlock << 64 | fixedAt << 128), _mixes slot 1.
        slots[0] = keccak256(abi.encode(round, uint256(0)));
        values[0] = bytes32(uint256(1) | (uint256(2) << 64) | (uint256(3) << 128));
        slots[1] = keccak256(abi.encode(round, uint256(1)));
        values[1] = keccak256("a mix the deployer ground offline");
        address twin = address(new PoisonedDrandTwin(address(plain).code, slots, values));
        assertEq(twin.codehash, BackedSourcePins.CODE_HASH_MAINNET, "the twin has the pinned code hash");
        (uint64 startedAt,, uint64 fixedAt, bytes32 mix) = BoxBackedSource(twin).backupOf(round);
        assertEq(startedAt, 1);
        assertEq(fixedAt, 3);
        assertEq(mix, values[1], "and a planted mix");
        assertFalse(check.isPinned(twin), "refused");
    }

    /// BC-101 `eip7702`: an EIP-7702 delegation designator at the pinned address (to the real code) is refused.
    function test_isPinned_refusesADelegationAtThePinnedAddress() public {
        vm.chainId(1);
        BoxBackedSource real = new BoxBackedSource();
        address pin = PinnedBackedSource.predict();
        vm.etch(pin, abi.encodePacked(hex"ef0100", address(real)));
        assertFalse(check.isPinned(pin), "refused");
    }

    /// BC-101 `no_code`: nothing at the pinned address yet (before anyone sends the deployment) is refused.
    function test_isPinned_refusesAnAddressWithNoCode() public {
        vm.chainId(1);
        address pin = PinnedBackedSource.predict();
        assertEq(pin.code.length, 0);
        assertFalse(check.isPinned(pin), "no code");
        assertFalse(check.isPinned(address(0)), "zero");
    }
}
