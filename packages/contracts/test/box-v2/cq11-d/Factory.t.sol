// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M132aBase} from "../m1-32a/M132aBase.sol";
import {BoxFactoryV2} from "../../../src/box-v2/BoxFactoryV2.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";

contract FactoryDTest is M132aBase {
    function test_factoryViewsUseCurrentListingAndCreationRaise() public {
        BoxFactoryV2 f = factory;
        assertEq(f.VERSION(), 2);
        assertEq(f.registry(), release.registry);
        assertEq(f.implementation(1), release.implementations[1]);
        assertEq(f.implementation(9), address(0));
        assertEq(f.implementation(24), address(0));
        BoxSpec memory s = _spec();
        (address old,,) = f.predictBox(address(this), s, bytes32(0));
        uint256 oldBootstrap = f.boxQParameters(0, s.raise).bootstrapQ;
        listings.updateRaise(0, 8.4 ether);
        assertEq(f.boxQParameters(0, s.raise).bootstrapQ, oldBootstrap);
        s.raise = 8.4 ether;
        (address fresh,,) = f.predictBox(address(this), s, bytes32(0));
        assertNotEq(old, fresh);
    }

    function test_realWiringConsumesOnlyTheExactPayment() public {
        uint256 before_ = CREATOR.balance;
        BoxSpec memory s = _spec();
        _create(s);
        assertEq(before_ - CREATOR.balance, factory.boxQParameters(0, s.raise).bootstrapQ);
        assertEq(address(factory).balance, 0);
    }

    function testFuzz_addressLimitUsesFullWidthArithmetic(address p) public {
        BoxFactoryV2 f = factory;
        uint256 expected = uint160(p) + ((uint256(1) << 160) - uint160(p)) / 2;
        assertEq(uint160(f.tokenAddressLimit(p)), expected);
    }
}
