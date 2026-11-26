// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SetReleaseBase, SetFactorySlot} from "../../../../script/existing-nfts/release/SetReleaseBase.sol";
import {SetReleaseV2} from "../../../../src/box-v2/set/SetReleaseV2.sol";
import {SetFactoryV2} from "../../../../src/box-v2/set/SetFactoryV2.sol";
import {SetFactoryV2Checks} from "../../../../src/box-v2/set/SetFactoryV2Checks.sol";
import {BoxRegistryV2} from "../../../../src/box-v2/BoxRegistryV2.sol";
import {BoxReceiverV2} from "../../../../src/box-v2/BoxReceiverV2.sol";

contract ReleaseCodeFixture {
    receive() external payable {}
}

contract ReleaseHarness is SetReleaseBase {
    function config(string memory json, bytes32 ack) external view returns (ReleaseConfig memory) {
        return _config(json, ack);
    }

    function parts(ReleaseConfig memory c, bytes32 configHash) external returns (Parts memory) {
        return _deployParts(c, configHash, address(this));
    }

    function readRelease(ReleaseConfig memory c, Parts memory p) external view returns (SetReleaseV2 memory) {
        return _readRelease(c, p);
    }

    function staleFactory(SetReleaseV2 memory r, Parts memory p) external returns (address) {
        return SetFactorySlot(p.slot)
            .deploy(bytes.concat(vm.getCode("SetFactoryV2.sol:SetFactoryV2"), abi.encode(r, p.planner, p.checks)));
    }

    function factory(ReleaseConfig memory c, Parts memory p, bytes32 configHash) external returns (address) {
        return _deployFactory(c, p, configHash);
    }
}

contract SetReleaseNetworkTest is Test {
    ReleaseHarness private script;
    SetReleaseBase.ReleaseConfig private config;
    bytes32 private constant CONFIG_HASH = keccak256("reviewed offline fixture");
    string private configJson;

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(1800000000);
        vm.roll(100);
        script = new ReleaseHarness();
        address[] memory directory = new address[](1);
        directory[0] = address(new BoxRegistryV2(address(this), new address[](0)));
        config = SetReleaseBase.ReleaseConfig(
            11155111,
            deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))),
            address(new ReleaseCodeFixture()),
            address(new ReleaseCodeFixture()),
            address(new ReleaseCodeFixture()),
            directory
        );
        configJson = string.concat(
            '{"chainId":"11155111","poolManager":"',
            vm.toString(config.poolManager),
            '","weth":"',
            vm.toString(config.weth),
            '","platformSafe":"',
            vm.toString(config.platformSafe),
            '","fitSafe":"',
            vm.toString(config.fitSafe),
            '","v1RegistryDirectory":["',
            vm.toString(directory[0]),
            '"]}'
        );
    }

    function test_twoPhasesUseMinedCodeAndFactoryChecksPass() public {
        SetReleaseBase.Parts memory p = script.parts(config, CONFIG_HASH);
        vm.warp(block.timestamp + 120);
        vm.roll(block.number + 10);
        SetReleaseV2 memory r = script.readRelease(config, p);
        address factory = script.factory(config, p, CONFIG_HASH);
        assertEq(factory, vm.computeCreateAddress(p.slot, 1));
        assertEq(abi.encode(SetFactoryV2(factory).release()), abi.encode(r));
        SetFactoryV2Checks(p.checks).verifyRelease(r, p.planner);
        for (uint256 i; i < 24; ++i) {
            if (r.implementations[i] != address(0)) {
                assertEq(r.implementationHashes[i], r.implementations[i].codehash);
            }
        }
        vm.expectRevert(SetFactorySlot.SlotRefused.selector);
        script.factory(config, p, CONFIG_HASH);
    }

    function test_singleRunSimulationPinsAreRefusedWithReleaseCode108() public {
        uint256 beforeParts = vm.snapshotState();
        SetReleaseBase.Parts memory simulated = script.parts(config, CONFIG_HASH);
        SetReleaseV2 memory stale = script.readRelease(config, simulated);
        assertTrue(vm.revertToState(beforeParts));
        vm.warp(block.timestamp + 120);
        vm.roll(block.number + 10);
        SetReleaseBase.Parts memory mined = script.parts(config, CONFIG_HASH);
        assertEq(abi.encode(mined), abi.encode(simulated));
        (,, address directory) = BoxReceiverV2(payable(mined.implementations[5])).receiverCode();
        assertNotEq(stale.dependencyHashes[8], directory.codehash);
        vm.expectRevert(abi.encodeWithSelector(SetFactoryV2Checks.ReleaseCode.selector, 108));
        SetFactoryV2Checks(mined.checks).verifyCode(stale, mined.planner);
        vm.roll(block.number + 1);
        vm.expectRevert(abi.encodeWithSelector(SetFactoryV2Checks.ReleaseCode.selector, 108));
        script.staleFactory(stale, mined);
        address factory = script.factory(config, mined, CONFIG_HASH);
        assertGt(factory.code.length, 0);
    }

    function test_sameBlockAndChangedConfigCannotConsumeSlot() public {
        SetReleaseBase.Parts memory p = script.parts(config, CONFIG_HASH);
        vm.expectRevert(SetFactorySlot.SlotRefused.selector);
        script.factory(config, p, CONFIG_HASH);
        vm.roll(block.number + 1);
        vm.expectRevert(SetReleaseBase.HandoffMismatch.selector);
        script.factory(config, p, keccak256("changed config"));
        vm.prank(address(0xBAD));
        vm.expectRevert(SetFactorySlot.SlotRefused.selector);
        SetFactorySlot(p.slot).deploy(hex"00");
    }

    function test_configChecksChainAndCode() public {
        assertEq(script.config(configJson, bytes32(0)).chainId, block.chainid);
        vm.chainId(31337);
        vm.expectRevert(SetReleaseBase.WrongChain.selector);
        script.config(configJson, bytes32(0));
    }

    function test_mainnetRequiresExactReviewedConfigHash() public {
        vm.chainId(1);
        string memory json = string.concat(
            '{"chainId":"1","poolManager":"',
            vm.toString(config.poolManager),
            '","weth":"',
            vm.toString(config.weth),
            '","platformSafe":"',
            vm.toString(config.platformSafe),
            '","fitSafe":"',
            vm.toString(config.fitSafe),
            '","v1RegistryDirectory":["',
            vm.toString(config.v1RegistryDirectory[0]),
            '"]}'
        );
        vm.expectRevert(SetReleaseBase.MainnetAcknowledgement.selector);
        script.config(json, bytes32(0));
        vm.expectRevert(SetReleaseBase.MainnetAcknowledgement.selector);
        script.config(json, keccak256("wrong"));
        assertEq(script.config(json, keccak256(bytes(json))).chainId, 1);
    }
}
