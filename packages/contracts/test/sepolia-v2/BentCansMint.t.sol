// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ERC721Holder} from "v4-core/lib/openzeppelin-contracts/contracts/token/ERC721/utils/ERC721Holder.sol";
import {JunkCollection} from "../../src/test-coins/JunkCollection.sol";
import {BentCansMint} from "../../script/sepolia-v2/BentCansMint.s.sol";
import {BoxEncoding} from "../../src/box/libraries/BoxEncoding.sol";
import {BentCansCatalog} from "./BentCansCatalog.sol";

contract BentCansSafe is ERC721Holder {}

contract BentCansMeter is BentCansMint {
    function stateGasActive() external returns (bool) { return _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN; }
}

contract BentCansMintTest is Test {
    address private constant OWNER = address(0xF112);
    address private constant TESTER = address(0x7E57);
    JunkCollection private cans;
    BentCansSafe private safe;
    BentCansMint private script;

    function setUp() public {
        // The same suite runs on the integrator's pinned Sepolia fork without changing its chain/time.
        if (block.chainid != 11_155_111) vm.chainId(31337);
        cans = new JunkCollection(OWNER, 0);
        safe = new BentCansSafe();
        script = new BentCansMint();
        vm.startPrank(OWNER);
        cans.mint(address(safe), 1, 1);
        cans.mint(address(safe), 2, 2);
        vm.stopPrank();
    }

    function test_L2_allTwelveTokenURIsMatchCatalogAndTesterIdsStaySeparate() public {
        script.mintSet(address(cans), OWNER, address(safe), TESTER, false);
        for (uint256 id = 1; id <= 14; ++id) {
            string memory expected = string.concat("ipfs://", BentCansCatalog.cid(id));
            string memory metadata = cans.metadataJSON(id);
            assertEq(vm.parseJsonString(metadata, ".image"), expected);
            assertEq(cans.tokenURI(id), string.concat("data:application/json;base64,", BoxEncoding.base64(bytes(metadata))));
            assertEq(cans.ownerOf(id), id <= 12 ? address(safe) : TESTER);
        }
        assertEq(cans.balanceOf(address(safe)), 12);
        assertEq(cans.balanceOf(TESTER), 2);
    }

    function test_L2_preflightRejectsWrongOwnerKindSafeTesterAndChain() public {
        vm.expectRevert("collection owner");
        script.mintSet(address(cans), TESTER, address(safe), TESTER, false);
        JunkCollection cogs = new JunkCollection(OWNER, 1);
        vm.expectRevert("Bent Cans required");
        script.mintSet(address(cogs), OWNER, address(safe), TESTER, false);
        vm.expectRevert("deployed creator Safe required");
        script.mintSet(address(cans), OWNER, TESTER, TESTER, false);
        vm.expectRevert("separate tester required");
        script.mintSet(address(cans), OWNER, address(safe), address(0), false);
        vm.expectRevert("separate tester required");
        script.mintSet(address(cans), OWNER, address(safe), address(safe), false);
        vm.expectRevert("collection required");
        script.mintSet(TESTER, OWNER, address(safe), TESTER, false);
        vm.chainId(1);
        vm.expectRevert("testnet only");
        script.mintSet(address(cans), OWNER, address(safe), TESTER, false);
        assertEq(cans.balanceOf(address(safe)), 2);
    }

    function test_L2_preflightRejectsOccupiedLastIdBeforeAnyMint() public {
        vm.prank(OWNER);
        cans.mint(TESTER, 14, 1);
        vm.expectRevert("mint id already exists");
        script.mintSet(address(cans), OWNER, address(safe), TESTER, false);
        assertEq(cans.balanceOf(address(safe)), 2);
        assertEq(cans.balanceOf(TESTER), 1);
    }

    function test_L2_sepoliaChainChecksTheSimulatedGasRules() public {
        BentCansMeter meter = new BentCansMeter();
        uint256 forkTime = meter.GLAMSTERDAM_SEPOLIA();
        vm.warp(meter.stateGasActive() ? forkTime + 1 days : forkTime - 1 days);
        vm.chainId(11_155_111);
        script.mintSet(address(cans), OWNER, address(safe), TESTER, false);
        assertEq(cans.balanceOf(address(safe)), 12);
        assertEq(cans.balanceOf(TESTER), 2);
    }

    function test_L2_refusingReceiverRollsBackAndRecordingRequiresOwnerCaller() public {
        vm.expectRevert();
        script.mintSet(address(cans), OWNER, address(safe), address(this), false);
        assertEq(cans.balanceOf(address(safe)), 2);
        vm.expectRevert("deployer");
        script.mintSet(address(cans), OWNER, address(safe), TESTER, true);
    }

    function test_L2_runUsesExplicitEnvironmentAndRecordsTwelveMints() public {
        // Only this test mutates the process-global environment.
        JunkCollection recording = new JunkCollection(address(this), 0);
        vm.setEnv("BENT_CANS_COLLECTION", vm.toString(address(recording)));
        vm.setEnv("JUNK_DEPLOYER", vm.toString(address(this)));
        vm.setEnv("JUNK_SAFE", vm.toString(address(safe)));
        vm.setEnv("BENT_CANS_TESTER", vm.toString(TESTER));
        vm.setEnv("JUNK_BROADCAST", "true");
        vm.recordLogs();
        script.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 mints;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("BentCanTransactionGas(uint256,uint256,uint256)")) continue;
            assertEq(uint256(logs[i].topics[1]), 3 + mints++);
            (uint256 total, uint256 state) = abi.decode(logs[i].data, (uint256, uint256));
            assertGt(total, 21_000);
            assertLe(total * 130 / 100, 16_777_216);
            assertLe(state, total);
        }
        assertEq(mints, 12);
        assertEq(recording.balanceOf(address(safe)), 10);
        assertEq(recording.balanceOf(TESTER), 2);
        vm.setEnv("JUNK_BROADCAST", "false");
    }
}
