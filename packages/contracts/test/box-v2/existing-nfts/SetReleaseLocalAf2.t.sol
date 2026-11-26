// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SetReleaseLocal, SetLocalERC721} from "../../../script/local/SetReleaseLocal.s.sol";
import {SetReleaseV2} from "../../../src/box-v2/set/SetReleaseV2.sol";
import {SetFactoryV2} from "../../../src/box-v2/set/SetFactoryV2.sol";
import {SetFactoryV2Checks} from "../../../src/box-v2/set/SetFactoryV2Checks.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxHookV2} from "../../../src/box-v2/BoxHookV2.sol";
import {RoyaltyCowConfig} from "../../../src/box-v2/interfaces/IRoyaltyCow.sol";

/// Exercise the script's actual deployment/hash helpers without its loopback RPC preflight or broadcasting.
contract SetReleaseLocalAf2Harness is SetReleaseLocal {
    Config private config;

    function parts(address manager, address weth, address olderRegistry, address fit, address platform)
        external returns (Parts memory)
    {
        config = Config(address(this), manager, weth, address(0), olderRegistry, fit, platform,
            RoyaltyCowConfig(address(0), address(0), 0));
        return _deployParts(config);
    }

    function readRelease(Parts memory p) external view returns (SetReleaseV2 memory) {
        return _readRelease(config, p);
    }

    function factory(SetReleaseV2 memory r, Parts memory p) external returns (address) {
        return _deployFactory(r, p);
    }
}

contract SetReleaseLocalAf2Test is Test {
    SetReleaseLocalAf2Harness private script;
    address private manager;
    address private weth;
    address private older;
    address private fit;
    uint256 private beforeParts;
    SetReleaseLocal.Parts private simulatedParts;
    SetReleaseV2 private simulatedRelease;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(100);
        script = new SetReleaseLocalAf2Harness();
        manager = deployCode("PoolManager.sol:PoolManager", abi.encode(address(this)));
        weth = address(new SetLocalERC721()); // Only code/identity is needed by release constructors.
        older = address(new BoxRegistryV2(address(this), new address[](0)));
        fit = address(new SetLocalERC721());
        beforeParts = vm.snapshotState();
        // Original single-run order: compute pins from the simulation before its transactions are mined.
        simulatedParts = script.parts(manager, weth, older, fit, address(this));
        simulatedRelease = script.readRelease(simulatedParts);
    }

    function testMinedLaterRejectsSimulatedHashesAndAcceptsFreshOnChainHashes() public {
        // Keep simulation outputs in memory while discarding its state, just like a script/broadcast boundary.
        SetReleaseLocal.Parts memory simulated = simulatedParts;
        SetReleaseV2 memory stale = simulatedRelease;
        assertEq(abi.encode(simulated).length, 960, "address-only handoff consumed by local runner");
        assertTrue(vm.revertToState(beforeParts));
        vm.warp(block.timestamp + 120);
        vm.roll(block.number + 120);
        // Replay the same CREATEs at the same addresses, as the later broadcast does. No code is etched.
        SetReleaseLocal.Parts memory mined = script.parts(manager, weth, older, fit, address(this));
        assertEq(abi.encode(mined), abi.encode(simulated), "same deployment addresses and sender");
        (, , address directory) = BoxReceiverV2(payable(mined.implementations[5])).receiverCode();
        assertNotEq(stale.dependencyHashes[8], directory.codehash, "timestamp immutable changes runtime");
        vm.expectRevert(abi.encodeWithSelector(SetFactoryV2Checks.ReleaseCode.selector, 108));
        SetFactoryV2Checks(mined.checks).verifyCode(stale, mined.planner);
        vm.expectRevert("factory deployment failed");
        script.factory(stale, mined);

        // Second run: parts are already mined; advance again before observing every live runtime.
        vm.warp(block.timestamp + 60);
        vm.roll(block.number + 60);
        SetReleaseV2 memory fresh = script.readRelease(mined);
        _assertLiveHashes(fresh, mined.planner);
        address factory = script.factory(fresh, mined);
        assertEq(factory, vm.computeCreateAddress(mined.slot, 1));
        assertEq(abi.encode(SetFactoryV2(factory).release()), abi.encode(fresh));
        SetFactoryV2Checks(mined.checks).verifyRelease(fresh, mined.planner);
        assertEq(SetLocalERC721(mined.nft).issuer(), address(script));
        vm.expectRevert("local factory slot");
        script.factory(fresh, mined);
    }

    function _assertLiveHashes(SetReleaseV2 memory r, address planner) private view {
        for (uint256 i; i < 24; ++i) {
            assertEq(r.implementationHashes[i], r.implementations[i] == address(0) ? bytes32(0) : r.implementations[i].codehash);
        }
        address[13] memory deps;
        deps[0] = r.registry; deps[1] = r.listingRegistry; deps[2] = r.poolManager; deps[3] = r.weth;
        deps[4] = BoxHookV2(r.implementations[2]).extension();
        deps[5] = vm.computeCreateAddress(r.implementations[0], 1);
        BoxReceiverV2 receiver = BoxReceiverV2(payable(r.implementations[5]));
        (deps[6], deps[7], deps[8]) = receiver.receiverCode();
        for (uint8 i; i < 4; ++i) (deps[9 + i],) = receiver.feeModule(i + 6);
        for (uint256 i; i < deps.length; ++i) assertEq(r.dependencyHashes[i], deps[i].codehash);
        assertEq(r.plannerHash, planner.codehash);
        address[] memory directory = BoxRegistryV2(r.registry).directory();
        bytes32[] memory hashes = new bytes32[](directory.length);
        for (uint256 i; i < directory.length; ++i) hashes[i] = directory[i].codehash;
        assertEq(r.directoryHash, keccak256(abi.encode(directory, hashes)));
    }
}
