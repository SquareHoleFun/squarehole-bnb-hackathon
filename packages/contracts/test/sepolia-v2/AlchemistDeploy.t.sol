// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {DeploySepoliaAlchemist} from "../../script/sepolia-v2/DeploySepoliaAlchemist.s.sol";
import {FeeModuleDirectoryV21} from "../../src/box-v2/FeeModuleDirectoryV21.sol";
import {AlchemistFeeModuleV21} from "../../src/box-v2/modules/AlchemistFeeModuleV21.sol";
import {AlchemistHopV21} from "../../src/box-v2/modules/AlchemistRouteV21.sol";
import {IFeeModulesV21} from "../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {TestPEPE, TestGold} from "../../src/test-coins/TestCoins.sol";

// Only local tests substitute release bytecode provenance. The production wrapper pins the real rc8 hashes.
contract LocalAlchemistPreparation is DeploySepoliaAlchemist {
    function _checkRelease() internal view override {
        require(RECEIVER.code.length != 0 && COORDINATOR.code.length != 0 && MANAGER.code.length != 0);
    }
}
contract AlchemistDeployTest is Test {
    LocalAlchemistPreparation internal script;
    TestPEPE internal pepe;
    TestGold internal gold;
    address internal constant SENDER = address(0xA11CE);
    address internal constant TRIGGER = address(0xB0B);

    function setUp() public {
        vm.chainId(31337);
        vm.setEnv("ALCHEMIST_BROADCAST", "false");
        script = new LocalAlchemistPreparation();
        vm.etch(script.MANAGER(), hex"00");
        vm.etch(script.RECEIVER(), hex"00");
        vm.etch(script.COORDINATOR(), hex"00");
        FeeModuleDirectoryV21 d = new FeeModuleDirectoryV21(script.SAFE(), new address[](0));
        vm.etch(script.DIRECTORY(), address(d).code);
        // Directory lister slot: local fixture only; fork tests use the actual directory untouched.
        vm.store(script.DIRECTORY(), bytes32(uint256(3)), bytes32(uint256(uint160(script.SAFE()))));
        vm.mockCall(script.RECEIVER(), abi.encodeCall(IFeeModulesV21.receiverCode,()), abi.encode(address(0), address(0), script.DIRECTORY()));
        pepe = new TestPEPE(SENDER, 1_000_000e18);
        gold = new TestGold(SENDER, 100e18);
    }

    function test_routePinsUnsignedRegistrationAndMaturity() public {
        FeeModuleDirectoryV21 d = FeeModuleDirectoryV21(script.DIRECTORY());
        uint256 count = d.count();
        (address action, bytes memory data) = script.prepare(SENDER, address(pepe), address(gold), 1e6, TRIGGER);
        assertEq(d.count(), count, "preparation does not register");
        assertEq(data, abi.encodeCall(FeeModuleDirectoryV21.register, (action)));
        AlchemistFeeModuleV21 m = AlchemistFeeModuleV21(action);
        assertEq(m.inputCap(), 1_000e18);
        assertEq(m.dustMax(), 1e6);
        assertEq(m.conversionTrigger(), TRIGGER);
        assertEq(m.priceCoin(), address(pepe));
        assertEq(m.pileCoin(), address(gold));
        assertEq(m.receiverImplementation(), script.RECEIVER());
        assertEq(m.coordinatorImplementation(), script.COORDINATOR());
        assertEq(address(m.executor()).codehash, m.executorCodeHash());
        assertEq(m.executor().length(), 2);
        for (uint256 i; i < 2; ++i) {
            AlchemistHopV21 memory h = m.executor().hop(i);
            assertEq(h.kind, 4); assertEq(h.pool, script.MANAGER());
            assertEq(h.fee, 3000); assertEq(h.tickSpacing, 60);
            assertEq(h.tokenIn, i == 0 ? address(pepe) : address(0));
            assertEq(h.tokenOut, i == 0 ? address(0) : address(gold));
        }
        vm.prank(script.SAFE());
        (bool ok, bytes memory result) = address(d).call(data);
        assertTrue(ok);
        uint32 id = abi.decode(result, (uint32));
        (address registered, bytes32 pinned, uint64 readyAt,) = d.record(id);
        assertEq(registered, action); assertEq(pinned, action.codehash);
        assertEq(readyAt, block.timestamp + 1 days);
        vm.warp(readyAt - 1); vm.expectRevert(); d.resolve(id);
        vm.warp(readyAt); (address resolved, bytes32 hash) = d.resolve(id);
        assertEq(resolved, action); assertEq(hash, action.codehash);
    }

    function test_refusesUnreviewedParametersAndReleaseCode() public {
        vm.expectRevert(); script.prepare(SENDER, address(pepe), address(gold), 0, TRIGGER);
        vm.expectRevert(); script.prepare(SENDER, address(pepe), address(gold), 1e6 + 1, TRIGGER);
        vm.expectRevert(); script.prepare(SENDER, address(gold), address(pepe), 1, TRIGGER);
        vm.expectRevert(); script.prepare(SENDER, address(pepe), address(gold), 1, address(0));
        vm.expectRevert(); script.prepare(address(0), address(pepe), address(gold), 1, TRIGGER);
        DeploySepoliaAlchemist production = new DeploySepoliaAlchemist();
        vm.expectRevert(); production.prepare(SENDER, address(pepe), address(gold), 1, TRIGGER);
        vm.chainId(1);
        vm.expectRevert(); script.prepare(SENDER, address(pepe), address(gold), 1, TRIGGER);
    }
}

contract AlchemistForkTest is Test {
    function test_forkRc8RegistrationResolvesAtReadyAt() public {
        if (!vm.envOr("SH_EX_L4_FORK", false)) { vm.skip(true); return; }
        vm.createSelectFork(vm.envString("SEPOLIA_FORK_RPC_URL"), vm.envUint("SH_EX_L4_FORK_BLOCK"));
        require(block.chainid == 11_155_111, "Sepolia fork required");
        vm.setEnv("ALCHEMIST_BROADCAST", "false");
        DeploySepoliaAlchemist script = new DeploySepoliaAlchemist();
        // Test coins exist only in this fork. No live address or transaction is invented.
        TestPEPE pepe = new TestPEPE(address(this), 1_000_000e18);
        TestGold gold = new TestGold(address(this), 100e18);
        (address action, bytes memory data) = script.prepare(address(0xA11CE), address(pepe), address(gold), 1e6, address(0xB0B));
        FeeModuleDirectoryV21 d = FeeModuleDirectoryV21(script.DIRECTORY());
        vm.prank(script.SAFE());
        (bool ok, bytes memory result) = address(d).call(data);
        assertTrue(ok); uint32 id = abi.decode(result, (uint32));
        (, bytes32 hash, uint64 readyAt,) = d.record(id);
        vm.warp(readyAt - 1); vm.expectRevert(); d.resolve(id);
        vm.warp(readyAt); (address resolved, bytes32 resolvedHash) = d.resolve(id);
        assertEq(resolved, action); assertEq(resolvedHash, hash); assertEq(hash, action.codehash);
    }
}
