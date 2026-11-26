// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {CoreBox0Kit, CoreBoxAddresses, CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditRevealSet} from "../common/AuditRevealSet.sol";

/// @title AuditU1ClaudeKitBase
/// @notice TEST ONLY (SH-AUDIT-B0 U1, the Claude (Opus) auditor's world for creation). `AuditBox0World` creates box 0 in
/// its setUp; unit U1 needs the moment before: this base stops after the version is deployed (`CoreBox0Kit.setUpWorld`:
/// `script/DeployCoreV1.s.sol`'s steps through `CoreV1Deployment`, the pinned sources through the local Arachnid
/// deployer, chain id 1, the PoolManager compiled from its pinned source) and leaves `createBox` to the test. The spec
/// is the audit world's (`script/config/box0-spec.11155111.safe.json`, N 1,969, `AuditRevealSet.root(1,969)`, openAt
/// one hour ahead), so a box created here is the world's box 0. No EIP-2537 is needed before graduation, so the tests
/// built on this base run on cancun, osaka and amsterdam (each concrete contract names its EVM in its inline config).
abstract contract AuditU1ClaudeKitBase is Test {
    string internal constant U1_SPEC_FILE = "/script/config/box0-spec.11155111.safe.json";
    uint256 internal constant U1_N = 1_969;
    uint256 internal constant U1_OPEN_DELAY = 1 hours;

    CoreBox0Kit internal kit;
    BoxFactoryV1 internal factory;
    BoxFactoryV1Planner internal planner;
    BoxRegistry internal registry;
    IPoolManager internal pm;
    CoreImpls internal impls;
    /// @dev The spec, ABI-encoded (a struct holding a struct array cannot be copied to storage).
    bytes internal specEncoded;

    function setUp() public virtual {
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        factory = kit.factory();
        pm = kit.pm();
        impls = kit.impls();
        planner = BoxFactoryV1Planner(impls.planner);
        registry = BoxRegistry(impls.registry);
        specEncoded = abi.encode(_u1Spec());
    }

    /// @notice The audit world's box 0 spec at this block's time.
    function _u1Spec() internal view virtual returns (BoxSpecV1.BoxSpec memory s) {
        s = abi.decode(
            vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), U1_SPEC_FILE)), ".encoded"),
            (BoxSpecV1.BoxSpec)
        );
        // casting to 'uint32' is safe because N is 1,969 and the clock is a 2026-27 time
        // forge-lint: disable-next-line(unsafe-typecast)
        s.n = uint32(U1_N);
        s.revealRoot = AuditRevealSet.root(U1_N);
        // forge-lint: disable-next-line(unsafe-typecast)
        s.openAt = uint32(block.timestamp + U1_OPEN_DELAY);
    }

    function _spec() internal view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(specEncoded, (BoxSpecV1.BoxSpec));
    }

    function _executorCode() internal pure returns (bytes memory) {
        return type(FitBuybackExecutor).creationCode;
    }

    /// @notice A salt putting the hook at a 0x2AE0 address for `openAt` (the deploy script's miner).
    function _mined(uint32 openAt) internal view returns (bytes32 salt) {
        bytes32 initHash = factory.hookInitCodeHash(openAt);
        address deployer = factory.box0Addresses().coordinator;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore8(p, 0xff)
            mstore(add(p, 0x01), shl(96, deployer))
            mstore(add(p, 0x35), initHash)
            for { let s := 0 } 1 { s := add(s, 1) } {
                mstore(add(p, 0x15), s)
                let h := and(keccak256(p, 0x55), 0xffffffffffffffffffffffffffffffffffffffff)
                if and(eq(and(h, 0x3fff), 0x2ae0), iszero(eq(shr(152, h), 0x91))) {
                    salt := s
                    break
                }
            }
        }
    }

    /// @notice createBox as `caller` with `value` (dealt to it first), returning the call's success and its data.
    function _tryCreate(address caller, BoxSpecV1.BoxSpec memory s, bytes32 salt, uint256 value, bytes memory code)
        internal
        returns (bool ok, bytes memory ret)
    {
        vm.deal(caller, caller.balance + value);
        vm.prank(caller);
        (ok, ret) = address(factory).call{value: value}(abi.encodeCall(factory.createBox, (s, salt, code)));
    }

    /// @notice createBox exactly as the deploy script sends it: the creator (the kit), the bootstrap, a mined salt.
    function _create() internal returns (CoreBoxAddresses memory a) {
        kit.prepare(_spec());
        kit.create();
        a = kit.addresses();
    }

    /// @notice Every address box 0 has or will have (the factory's fixed ones and the hook for `hookAt`).
    function _box0List(IBoxFactoryV1.Box0Addresses memory b, address hookAt)
        internal
        pure
        returns (address[12] memory l)
    {
        l = [
            b.coordinator,
            b.table,
            b.token,
            b.vault,
            b.collection,
            b.receiver,
            b.launchRouter,
            b.executor,
            b.tickets,
            b.itemStream,
            b.royaltyRouter,
            hookAt
        ];
    }

    function _box0Names() internal pure returns (string[12] memory n) {
        n = [
            "coordinator",
            "table",
            "token",
            "vault",
            "collection",
            "receiver",
            "launchRouter",
            "executor",
            "tickets",
            "itemStream",
            "royaltyRouter",
            "hook"
        ];
    }

    /// @notice Nothing of box 0 exists: no code and no nonce at any address the factory fixed or at the hook's, no
    /// record, the factory's nonce where its constructor left it, no pool.
    function _assertNothingCreated(address hookAt, string memory why) internal view {
        address[12] memory l = _box0List(factory.box0Addresses(), hookAt);
        for (uint256 i; i < l.length; ++i) {
            assertEq(l[i].code.length, 0, string.concat(why, ": no code at ", _box0Names()[i]));
            assertEq(vm.getNonce(l[i]), 0, string.concat(why, ": no nonce at ", _box0Names()[i]));
        }
        assertEq(registry.boxCount(), 0, string.concat(why, ": no record"));
        assertEq(vm.getNonce(address(factory)), 2, string.concat(why, ": the factory created only its registry"));
    }
}
