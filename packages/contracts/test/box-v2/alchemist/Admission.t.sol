// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {CoreV2GasRules} from "../../../script/sepolia-v2/CoreV2GasRules.sol";
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {FeeModuleDirectoryV21} from "../../../src/box-v2/FeeModuleDirectoryV21.sol";
import {RegisterAlchemistV21} from "../../../script/RegisterAlchemistV21.s.sol";
import {AlchemistHopV21} from "../../../src/box-v2/modules/AlchemistRouteV21.sol";
import {IFeeModulesV21} from "../../../src/box-v2/interfaces/IFeeModulesV21.sol";

// Local ABI until the new module exists; no change to the core's frozen shapes.
struct AlchemistHop { uint8 kind; address tokenIn; address tokenOut; address pool; uint24 fee; int24 tickSpacing; }
interface AlchemistView {
    function feeActionVersion() external pure returns (uint256);
    function executor() external view returns (address);
    function priceCoin() external view returns (address);
    function conversionTrigger() external view returns (address);
    function dustMax() external view returns (uint256);
    function pileCoin() external view returns (address);
}
contract AlchemistAdmissionTest is Test, CoreV2GasRules {
    address internal constant KEEPER = address(0xA14);
    address internal constant DEPLOYER = address(0xD14);
    uint256 internal constant DUST = 1e6;
    function test_AL14_scriptPreparesSafeRegistrationWithoutRegistering() public {
        address pm = address(0x2100); address ri = address(0x2101); address ci = address(0x2102);
        for (uint160 i = 0x2100; i <= 0x2104; ++i) vm.etch(address(i),hex"00");
        FeeModuleDirectoryV21 d = new FeeModuleDirectoryV21(address(this),new address[](0));
        vm.mockCall(ri,abi.encodeCall(IFeeModulesV21.receiverCode,()),abi.encode(address(0),address(0),address(d)));
        AlchemistHopV21[] memory route = new AlchemistHopV21[](1);
        route[0] = AlchemistHopV21(4,address(0x2103),address(0x2104),pm,3000,60);
        vm.setEnv("ALCHEMIST_BROADCAST","false");
        (address action,bytes memory data) = new RegisterAlchemistV21().run(DEPLOYER,pm,ri,ci,route,1 ether,DUST,KEEPER);
        assertEq(data,abi.encodeCall(FeeModuleDirectoryV21.register,(action)));
        assertGt(action.code.length,0);
        assertEq(AlchemistView(action).conversionTrigger(), KEEPER, "script keeps trigger separate from deployer");
        assertEq(AlchemistView(action).dustMax(), DUST, "script passes the dust size through");
        assertEq(vm.getNonce(DEPLOYER), 1, "configured deployer creates the action");
        // A first registration now proves that the script left directory writes to its lister.
        uint32 id = d.register(action);
        (, ,uint64 readyAt,) = d.record(id);
        vm.expectRevert(); d.resolve(id);
        assertEq(readyAt,block.timestamp+d.DELAY());
        vm.warp(readyAt); (address resolved,) = d.resolve(id); assertEq(resolved,action);
    }
    function test_AL01_firstModuleIsAdmittedWithoutCoreChanges() public {
        address pm = address(0x1100);
        address ri = address(0x1101);
        address ci = address(0x1102);
        address p = address(0x1103);
        address q = address(0x1104);
        for (uint160 i = 0x1100; i <= 0x1104; ++i) vm.etch(address(i), hex"00");
        AlchemistHop[] memory route = new AlchemistHop[](1);
        route[0] = AlchemistHop(4, p, q, pm, 3000, 60);
        bytes memory initCode = bytes.concat(vm.getCode("AlchemistFeeModuleV21.sol:AlchemistFeeModuleV21"), abi.encode(pm,ri,ci,route,1 ether,DUST,KEEPER));
        vm.prank(DEPLOYER);
        uint256 beforeDeploy = gasleft();
        address action;
        assembly ("memory-safe") { action := create(0,add(initCode,32),mload(initCode)) }
        uint256 deploymentGas = beforeDeploy - gasleft();
        uint256 stateGas = _frameStateGas();
        deploymentGas += 21_000;
        for (uint256 i; i < initCode.length; ++i) deploymentGas += initCode[i] == 0 ? 4 : 16;
        emit log_named_uint("action deployment gas", deploymentGas);
        emit log_named_uint("action deployment state gas", stateGas);
        _checkGasStep(GasStep("Alchemist",deploymentGas,stateGas,false),stateGas != 0,54_500_000);
        AlchemistView m = AlchemistView(action);
        assertEq(m.feeActionVersion(), 1);
        assertEq(m.conversionTrigger(), KEEPER);
        _coldGetter(action, "conversionTrigger()", uint160(KEEPER));
        _coldGetter(action, "inputCap()", 1 ether);
        _coldGetter(action, "dustMax()", DUST);
        _coldGetter(m.executor(), "dustMax()", DUST);
        assertEq(m.priceCoin(), p); assertEq(m.pileCoin(), q);
        assertLe(action.code.length, 22_118); assertLe(m.executor().code.length, 22_118);
        FeeModuleDirectoryV21 d = new FeeModuleDirectoryV21(address(this), new address[](0));
        uint32 id = d.register(action);
        (, bytes32 hash, uint64 readyAt,) = d.record(id);
        vm.warp(readyAt - 1); vm.expectRevert(); d.resolve(id);
        vm.warp(readyAt); (address resolved, bytes32 actualHash) = d.resolve(id);
        assertEq(resolved, action); assertEq(actualHash, hash);
    }
    function _coldGetter(address action, string memory getter, uint256 expected) private {
        bytes memory data = abi.encodeWithSignature(getter);
        vm.cool(action);
        uint256 before_ = gasleft();
        (bool ok, bytes memory result) = action.staticcall{gas: 30000}(data);
        uint256 used = before_ - gasleft();
        emit log_named_uint(getter, used);
        assertLt(used, 6000); assertTrue(ok); assertEq(abi.decode(result, (uint256)), expected);
    }
    function test_D1_zeroTriggerRefusedAtCreation() public {
        address pm = address(0x1100); address ri = address(0x1101); address ci = address(0x1102);
        for (uint160 i = 0x1100; i <= 0x1104; ++i) vm.etch(address(i), hex"00");
        AlchemistHop[] memory route = new AlchemistHop[](1);
        route[0] = AlchemistHop(4, address(0x1103), address(0x1104), pm, 3000, 60);
        bytes memory invalidCode = bytes.concat(vm.getCode("AlchemistFeeModuleV21.sol:AlchemistFeeModuleV21"),
            abi.encode(pm,ri,ci,route,1 ether,DUST,address(0)));
        address refused;
        assembly ("memory-safe") { refused := create(0,add(invalidCode,32),mload(invalidCode)) }
        assertEq(refused, address(0), "zero trigger refused");
    }
    /// G1-INT: the dust size is fixed at creation, positive and at most the cap; the cap itself is admitted.
    function test_E4_dustSizeRefusedAtCreationUnlessPositiveAndWithinCap() public {
        address pm = address(0x1100); address ri = address(0x1101); address ci = address(0x1102);
        for (uint160 i = 0x1100; i <= 0x1104; ++i) vm.etch(address(i), hex"00");
        AlchemistHop[] memory route = new AlchemistHop[](1);
        route[0] = AlchemistHop(4, address(0x1103), address(0x1104), pm, 3000, 60);
        uint256[3] memory dusts = [uint256(0), 1 ether + 1, 1 ether];
        for (uint256 i; i < dusts.length; ++i) {
            bytes memory initCode = bytes.concat(vm.getCode("AlchemistFeeModuleV21.sol:AlchemistFeeModuleV21"),
                abi.encode(pm,ri,ci,route,1 ether,dusts[i],KEEPER));
            address made;
            assembly ("memory-safe") { made := create(0,add(initCode,32),mload(initCode)) }
            if (i < 2) assertEq(made, address(0), "zero or above-cap dust size refused");
            else assertEq(AlchemistView(made).dustMax(), 1 ether, "a dust size equal to the cap is admitted");
        }
    }
}
