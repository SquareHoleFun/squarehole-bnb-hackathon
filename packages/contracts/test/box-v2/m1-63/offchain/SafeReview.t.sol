// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CoreV2SafeChecks} from "../../../../script/lib/CoreV2SafeChecks.sol";
import {SafeProxyFixture} from "./SafeProxyFixture.sol";

contract ReviewSingleton {
    function VERSION() external pure returns (string memory) {
        return "1.4.1";
    }

    function getOwners() external pure returns (address[] memory owners) {
        owners = new address[](1);
        owners[0] = address(0xF012);
    }

    function getThreshold() external pure returns (uint256) { return 1; }
    function getModulesPaginated(address, uint256) external pure returns (address[] memory, address) {
        return (new address[](0), address(1));
    }
    function getStorageAt(uint256, uint256) external pure returns (bytes memory) { return abi.encode(address(0)); }
}

/// It reports all the expected Safe views but does not delegate to its claimed singleton.
contract ReviewLookalike {
    address public immutable masterCopy;
    address internal immutable owner;

    constructor(address singleton, address founder) {
        masterCopy = singleton;
        owner = founder;
    }
    receive() external payable {}

    function VERSION() external pure returns (string memory) {
        return "1.4.1";
    }

    function getOwners() external view returns (address[] memory owners) {
        owners = new address[](1);
        owners[0] = owner;
    }

    function getThreshold() external pure returns (uint256) {
        return 1;
    }

    function getModulesPaginated(address, uint256) external pure returns (address[] memory, address) {
        return (new address[](0), address(1));
    }

    function getStorageAt(uint256, uint256) external pure returns (bytes memory) {
        return abi.encode(address(0));
    }

    function drain(address payable to) external {
        to.transfer(address(this).balance);
    }
}

contract ReviewSafeReader {
    function read(address account, address founder, address singleton) external view {
        address[] memory owners = new address[](1);
        owners[0] = founder;
        CoreV2SafeChecks.read(
            account, account, owners, 1, "1.4.1", singleton, singleton.codehash, address(0), address(0),
            keccak256(type(SafeProxyFixture).runtimeCode)
        );
    }
}

contract SafeReview is Test {
    ReviewSingleton internal singleton;
    ReviewLookalike internal impostor;
    ReviewSafeReader internal reader;
    address internal constant FOUNDER = address(0xF012);

    function setUp() public {
        singleton = new ReviewSingleton();
        impostor = new ReviewLookalike(address(singleton), FOUNDER);
        reader = new ReviewSafeReader();
    }

    function test_M1_preflightRejectsNonProxyRuntime() public {
        vm.expectRevert(abi.encodeWithSelector(CoreV2SafeChecks.UnsafeSafe.selector, address(impostor)));
        reader.read(address(impostor), FOUNDER, address(singleton));
    }

    function test_M1_acceptsPinnedDelegatingRuntime() public {
        SafeProxyFixture proxy = new SafeProxyFixture(address(singleton));
        reader.read(address(proxy), FOUNDER, address(singleton));
    }

    function test_M1_refusesWrongSingletonBehindPinnedProxy() public {
        SafeProxyFixture proxy = new SafeProxyFixture(address(new ReviewSingleton()));
        vm.expectRevert(abi.encodeWithSelector(CoreV2SafeChecks.UnsafeSafe.selector, address(proxy)));
        reader.read(address(proxy), FOUNDER, address(singleton));
    }

    function test_M1_refusesRuntimeReplacementWithSameSingletonStorage() public {
        SafeProxyFixture proxy = new SafeProxyFixture(address(singleton));
        vm.etch(address(proxy), address(impostor).code);
        vm.expectRevert(abi.encodeWithSelector(CoreV2SafeChecks.UnsafeSafe.selector, address(proxy)));
        reader.read(address(proxy), FOUNDER, address(singleton));
    }

    function test_M1_lookalikeCannotPassByChangingItsClaimedSingleton() public {
        ReviewSingleton another = new ReviewSingleton();
        ReviewLookalike other = new ReviewLookalike(address(another), FOUNDER);
        vm.expectRevert(abi.encodeWithSelector(CoreV2SafeChecks.UnsafeSafe.selector, address(other)));
        reader.read(address(other), FOUNDER, address(another));
    }

    function test_controlReportedSafeViewsDoNotPreventUnsignedDrain() public {
        vm.deal(address(impostor), 1 ether);
        address payable stranger = payable(address(0xBAD));
        vm.prank(stranger);
        impostor.drain(stranger);
        assertEq(stranger.balance, 1 ether);
        assertEq(address(impostor).balance, 0);
    }
}
