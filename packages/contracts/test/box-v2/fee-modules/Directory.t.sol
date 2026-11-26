// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

// Directory admission boundary and permanent snapshot checks.
interface Directory {
    function DELAY() external view returns (uint256);
    function initialSelectable(uint32 id) external view returns (bool);
    function register(address module) external returns (uint32);
    function withdraw(uint32 id) external;
    function resolve(uint32 id) external view returns (address module, bytes32 codeHash);
    function record(uint32 id) external view returns (address, bytes32, uint64, bool);
    function proposeLister(address next) external;
    function acceptLister() external;
    function proposeRenounce() external;
    function renounce() external;
}

contract ModuleDirectoryTest is Test {
    Directory internal directory;
    address internal constant SAFE = address(0x5afe);

    function setUp() public {
        directory = Directory(deployCode("FeeModuleDirectoryV21.sol:FeeModuleDirectoryV21", abi.encode(SAFE, new address[](0))));
    }

    function _code(bytes memory runtime) internal returns (address module) {
        module = address(uint160(uint256(keccak256(runtime))));
        vm.etch(module, runtime);
    }

    function test_FM01_onlyListerAndPermanentRow() public {
        address module = _code(hex"60006000f3");
        vm.expectRevert(); directory.register(module);
        vm.prank(SAFE); uint32 id = directory.register(module);
        vm.expectRevert(); vm.prank(SAFE); directory.register(module);
        (address fixedModule, bytes32 hash, uint64 readyAt, bool withdrawn) = directory.record(id);
        assertEq(fixedModule, module); assertEq(hash, module.codehash);
        assertEq(readyAt, block.timestamp + 1 days); assertFalse(withdrawn);
    }

    function test_FM02_oneDayBoundaryAndHashReplacement() public {
        assertEq(directory.DELAY(), 1 days);
        address module = _code(hex"60006000f3");
        vm.prank(SAFE); uint32 id = directory.register(module);
        uint256 ready = block.timestamp + 1 days;
        vm.warp(ready - 1); vm.expectRevert(); directory.resolve(id);
        vm.warp(ready); (address fixedModule, bytes32 hash) = directory.resolve(id);
        assertEq(fixedModule, module); assertEq(hash, module.codehash);
        vm.etch(module, hex"00"); vm.expectRevert(); directory.resolve(id);
    }

    function test_FM03_withdrawalCannotReplaceOrReactivate() public {
        address module = _code(hex"60006000f3");
        vm.prank(SAFE); uint32 id = directory.register(module);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(); directory.withdraw(id);
        vm.prank(SAFE); directory.withdraw(id);
        vm.expectRevert(); directory.resolve(id);
        vm.expectRevert(); vm.prank(SAFE); directory.register(module);
        (address fixedModule, bytes32 hash,, bool withdrawn) = directory.record(id);
        assertEq(fixedModule, module); assertEq(hash, module.codehash); assertTrue(withdrawn);
    }

    function test_FM04_rejectMutableInstructionsIncludingUnreachableCode() public {
        bytes memory forbidden = hex"55b35c5df0f2f4f5ff";
        for (uint256 i; i < forbidden.length; ++i) {
            address module = _code(bytes.concat(hex"00", forbidden[i]));
            vm.expectRevert(); vm.prank(SAFE); directory.register(module);
        }
        vm.expectRevert(); vm.prank(SAFE); directory.register(address(123));
        // ERC-1167 proxy's delegatecall is refused, even with a currently immutable target.
        address proxy = _code(hex"363d3d373d3d3d363d7300000000000000000000000000000000000000015af43d82803e903d91602b57fd5bf3");
        vm.expectRevert(); vm.prank(SAFE); directory.register(proxy);
    }

    function test_FM05_pushDataIsNotAnOpcodeAndTruncatedPushRefuses() public {
        address module = _code(hex"67f4fff055f25cf5b300");
        vm.prank(SAFE); directory.register(module);
        address truncated = _code(hex"7f00");
        vm.expectRevert(); vm.prank(SAFE); directory.register(truncated);
    }

    function test_FM17_initialAvailabilityTracksEveryPermanentWithdrawal() public {
        address[] memory initial = new address[](4);
        for (uint256 i; i < 4; ++i) initial[i] = _code(abi.encodePacked(hex"60", uint8(i), hex"00"));
        Directory d = Directory(deployCode("FeeModuleDirectoryV21.sol:FeeModuleDirectoryV21", abi.encode(SAFE, initial)));
        for (uint32 i; i < 4; ++i) assertFalse(d.initialSelectable(i));
        uint256 ready = vm.getBlockTimestamp() + 1 days;
        for (uint32 i; i < 4; ++i) {
            (,, uint64 readyAt,) = d.record(i);
            assertEq(readyAt, ready, "every release action gets one day");
        }
        vm.warp(ready - 1);
        for (uint32 i; i < 4; ++i) {
            assertFalse(d.initialSelectable(i));
            vm.expectRevert(); d.resolve(i);
        }
        vm.warp(ready);
        for (uint32 i; i < 4; ++i) {
            assertTrue(d.initialSelectable(i)); d.resolve(i);
            vm.prank(SAFE); d.withdraw(i);
            for (uint32 j; j < 4; ++j) assertEq(d.initialSelectable(j), j > i);
            vm.expectRevert(); d.resolve(i);
        }
        assertFalse(d.initialSelectable(4));
    }

    function test_FM06_twoStepRoleAndRenounce() public {
        vm.prank(SAFE); directory.proposeLister(address(this));
        vm.expectRevert(); vm.prank(SAFE); directory.acceptLister();
        directory.acceptLister();
        vm.expectRevert(); directory.renounce();
        directory.proposeRenounce(); directory.renounce();
        vm.expectRevert(); directory.register(_code(hex"00"));
    }
}
