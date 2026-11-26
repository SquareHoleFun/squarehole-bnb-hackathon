// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {AuditU1LaneBase} from "./AuditU1LaneBase.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {BoxData} from "../../../../src/box/libraries/BoxData.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";

/// forge-config: default.evm_version = "osaka"
contract AuditU1LaneIdentity is AuditU1LaneBase {
    function testProperty_AUDIT_U1_sourcesAreCompiledCreate2Pins() public view {
        assertEq(DrandSourcePins.DEPLOYER, 0x4e59b44847b379578588920cA78FbF26c0B4956C);
        assertEq(BackedSourcePins.DEPLOYER, DrandSourcePins.DEPLOYER);
        assertEq(keccak256(type(DrandSource).creationCode), DrandSourcePins.INIT_CODE_HASH);
        assertEq(keccak256(type(BoxBackedSource).creationCode), BackedSourcePins.INIT_CODE_HASH);
        assertEq(
            vm.computeCreate2Address(
                DrandSourcePins.SALT, keccak256(type(DrandSource).creationCode), DrandSourcePins.DEPLOYER
            ),
            DrandSourcePins.ADDRESS_MAINNET
        );
        assertEq(
            vm.computeCreate2Address(
                BackedSourcePins.SALT, keccak256(type(BoxBackedSource).creationCode), BackedSourcePins.DEPLOYER
            ),
            BackedSourcePins.ADDRESS_MAINNET
        );
        assertEq(DrandSourcePins.ADDRESS_MAINNET, DrandSourcePins.ADDRESS_SEPOLIA);
        assertEq(BackedSourcePins.ADDRESS_MAINNET, BackedSourcePins.ADDRESS_SEPOLIA);
        assertEq(address(drand).codehash, DrandSourcePins.CODE_HASH_MAINNET);
        assertEq(address(src).codehash, BackedSourcePins.CODE_HASH_MAINNET);
        assertEq(address(src.DRAND()), address(drand));
        assertEq(factory.randomness(), address(src));
    }

    /// BC-101/F143. Etching only models absent/wrong code at a trust input; no box callee is substituted.
    function testProperty_AUDIT_U1_wrongOrAbsentSourceRefusesConstruction() public {
        address[2] memory pins = [address(src), address(drand)];
        for (uint256 i; i < 2; ++i) {
            bytes memory original = pins[i].code;
            for (uint256 j; j < 2; ++j) {
                vm.etch(pins[i], j == 0 ? bytes("") : bytes(hex"00"));
                IBoxFactoryV1.Implementations memory impls = factory.implementations();
                bytes32 executorHash = factory.executorInitCodeHash();
                address wethAddress = address(kit.weth());
                vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV1.SourceNotPinned.selector, pins[i]));
                new BoxFactoryV1(pm, impls, planner, address(src), wethAddress, a.platform, address(kit), executorHash);
                _nothingCreated();
            }
            vm.etch(pins[i], original);
        }
        _create();
        assertEq(registry.boxCount(), 1);
    }

    /// BC-013: mutate one structural coordinate at a time, including version, launch format, each wiring add-on,
    /// royalty destination, version code and module code. The hash API is pure and can classify future templates.
    function testProperty_AUDIT_U1_everyStructuralChoiceMovesTemplate() public view {
        BoxSpecV1.BoxSpec memory base = _spec();
        bytes32 id = factory.templateIdOf(base);
        for (uint256 k; k < 15; ++k) {
            BoxSpecV1.BoxSpec memory s = _spec();
            if (k == 0) ++s.version;
            if (k == 1) ++s.boxType;
            if (k == 2) ++s.layout;
            if (k == 3) ++s.gradLayout;
            if (k == 4) ++s.launchFormat;
            if (k == 5) s.q = address(1);
            if (k == 6) ++s.qStream;
            if (k == 7) ++s.tStream;
            if (k == 8) ++s.artMode;
            if (k >= 9 && k <= 11) {
                uint16 drop = k == 9 ? uint16(1) : k == 10 ? uint16(2) : uint16(4);
                for (uint256 j; j < s.addOns.length; ++j) {
                    if (s.addOns[j].id == drop) s.addOns[j].id = 0;
                }
            }
            if (k == 12) {
                BoxSpecV1.AddOn[] memory expanded = new BoxSpecV1.AddOn[](s.addOns.length + 1);
                for (uint256 j; j < s.addOns.length; ++j) {
                    expanded[j] = s.addOns[j];
                }
                expanded[s.addOns.length] = BoxSpecV1.AddOn(5, "");
                s.addOns = expanded;
            }
            if (k == 13) {
                for (uint256 j; j < s.addOns.length; ++j) {
                    if (s.addOns[j].id == 4) s.addOns[j].params = abi.encode(uint16(500), uint8(3));
                }
            }
            bytes32 actual = k == 14
                ? planner.templateIdOf(s, bytes32(uint256(1)), factory.executorInitCodeHash())
                : factory.templateIdOf(s);
            assertNotEq(actual, id, vm.toString(k));
        }
        assertNotEq(planner.templateIdOf(base, factory.versionCodeHash(), bytes32(uint256(1))), id);
    }

    function testFuzz_AUDIT_U1_templateReencodingAndDataStability(uint32 n, bytes32 art, uint32 open) public view {
        BoxSpecV1.BoxSpec memory s = _spec();
        bytes32 id = factory.templateIdOf(s);
        assertEq(factory.templateIdOf(abi.decode(abi.encode(s), (BoxSpecV1.BoxSpec))), id);
        s.n = n;
        s.openAt = open;
        s.revealRoot = art;
        s.generatorHash = ~art;
        s.tokenName = "Data only";
        s.collectionName = "Different collection";
        s.metadataTable = hex"01000000";
        assertEq(factory.templateIdOf(s), id);
    }

    /// ADR-0016 sections 2/4. The receiving predicate is intentionally distinct from isCloneOf.
    function testFuzz_AUDIT_U1_bothCloneShapesAndFalsePositives(bytes memory args) public {
        vm.assume(args.length <= 512);
        address impl = factory.implementations().royaltyRouter;
        address standard = BoxClones.create(BoxClones.initCode(impl, args));
        address receiving = BoxClones.create(BoxClones.initCodeReceiving(impl, args));
        assertTrue(BoxClones.isCloneOf(standard, impl));
        assertFalse(BoxClones.isCloneOf(receiving, impl));
        assertTrue(BoxClones.isReceivingCloneOf(receiving, impl));
        assertFalse(BoxClones.isReceivingCloneOf(standard, impl));
        assertFalse(BoxClones.isCloneOf(standard, address(uint160(impl) ^ 1)));
        assertFalse(BoxClones.isReceivingCloneOf(receiving, address(uint160(impl) ^ (uint160(1) << 159))));
        assertFalse(BoxClones.isCloneOf(impl, impl));
        assertFalse(BoxClones.isReceivingCloneOf(address(0), impl));
        vm.record();
        (bool ok,) = receiving.call{value: 1, gas: 2300}("");
        assertTrue(ok, "receiving prefix handles stipend");
        (, bytes32[] memory writes) = vm.accesses(receiving);
        assertEq(writes.length, 0);
    }

    /// BC-100: reproduce the exact planner codes from another deployer, with the outsider as the coordinator
    /// argument; direct implementations and both coordinator clones remain inert to that outsider.
    function testProperty_AUDIT_U1_foreignClonesAndImplementationsCannotInitialise() public {
        BoxFactoryV1Planner.Version memory v = factory.version();
        v.coordinator = address(this);
        BoxFactoryV1Planner.Plan memory p = planner.plan(_spec(), v, address(this), bytes32(0), bytes32(0));
        address[7] memory impl = [
            v.collectionImpl,
            v.vaultImpl,
            v.ticketsImpl,
            v.hookImpl,
            v.launchRouterImpl,
            v.receiverImpl,
            v.itemStreamImpl
        ];
        bytes[7] memory codes = [p.codes[3], p.codes[2], p.codes[7], p.hookInit, p.codes[5], p.codes[4], p.codes[8]];
        for (uint256 i; i < impl.length; ++i) {
            address foreign = BoxClones.create(codes[i]);
            (bool ok,) = foreign.call(abi.encodeWithSignature("initialize()"));
            assertFalse(ok, "foreign clone cannot initialise");
            (ok,) = impl[i].call(abi.encodeWithSignature("initialize()"));
            assertFalse(ok, "implementation cannot initialise");
        }
        address rogueCoordinator = BoxClones.create(p.coordinatorInit);
        bytes[] memory empty = new bytes[](0);
        (bool ok,) = rogueCoordinator.call(
            abi.encodeWithSignature("deploy(bytes[],bytes,bytes32,uint256)", empty, "", bytes32(0), 0)
        );
        assertFalse(ok);
        (ok,) = v.coordinatorImpl.call(abi.encodeWithSignature("launch()"));
        assertFalse(ok);
        (ok,) = v.royaltyRouterImpl.call(abi.encodeWithSignature("initialize()"));
        assertFalse(ok);
    }

    function testFuzz_AUDIT_U1_dataContractAndSizeBoundary(bytes memory data) public {
        vm.assume(data.length <= 1024);
        address pointer = BoxData.write(data);
        assertEq(BoxData.read(pointer), data);
        assertEq(pointer.code, bytes.concat(hex"00", data));
        assertEq(BoxData.read(address(0)), "");
    }
}
