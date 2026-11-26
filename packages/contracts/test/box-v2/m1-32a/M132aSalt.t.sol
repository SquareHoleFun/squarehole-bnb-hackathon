// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "./M132aBase.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {IBoxFactoryV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";

contract M132aSaltTest is M132aBase {
    function testFuzz_midpointUsesFullWidth(address p) public view {
        assertEq(uint160(factory.tokenAddressLimit(p)), uint160(p) + ((uint256(1) << 160) - uint160(p)) / 2);
    }

    function test_creatorAndSpecBindPredictions() public view {
        BoxSpec memory s = _spec();
        (address a,,) = factory.predictBox(CREATOR, s, 0);
        (address b,,) = factory.predictBox(address(0xB0B), s, 0);
        assertNotEq(a, b);
        s.tokenName = "Another";
        (b,,) = factory.predictBox(CREATOR, s, 0);
        assertNotEq(a, b);
    }

    function test_minedSaltSurvivesNewBlockAndAlreadyUsedRefuses() public {
        BoxSpec memory s = _spec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        (address c, address t,) = factory.predictBox(CREATOR, s, cs);
        address h = factory.predictHook(CREATOR, s, cs, hs);
        assertGt(uint160(t), uint160(s.pricing.token));
        assertLt(uint160(t), uint160(factory.tokenAddressLimit(s.pricing.token)));
        vm.roll(block.number + 10);
        vm.warp(block.timestamp + 120);
        uint256 value = factory.boxQParameters(0, s.raise).bootstrapQ;
        vm.prank(CREATOR);
        (, address actual, address actualHook) = factory.createBox{value: value}(s, cs, hs);
        assertEq(actual, c);
        assertEq(actualHook, h);
        vm.expectRevert();
        vm.prank(CREATOR);
        factory.createBox{value: value}(s, cs, hs);
        assertEq(registry.boxCount(), 1);
    }

    function test_unminedHookRefusedBeforeCreate() public {
        BoxSpec memory s = _spec();
        (bytes32 cs,) = _salts(s);
        address h = factory.predictHook(CREATOR, s, cs, 0);
        assertNotEq(uint160(h) & 0x3fff, 0x2ae0);
        uint256 value = factory.boxQParameters(0, s.raise).bootstrapQ;
        vm.expectRevert(abi.encodeWithSelector(IBoxFactoryV2.HookSaltNotMined.selector, h));
        vm.prank(CREATOR);
        factory.createBox{value: value}(s, cs, 0);
    }
}
