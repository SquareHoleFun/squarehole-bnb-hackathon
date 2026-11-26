// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FinalAccessFixture} from "./Fixture.sol";
import {M3SpecTest} from "../../m3-10/M3Spec.t.sol";
import {M263RemovedRoutesTest} from "../../m2-63/rules/RemovedRoutes.t.sol";

contract FinalRemovedSpecTest is M3SpecTest {}

contract FinalRemovedShopTest is M263RemovedRoutesTest {}

contract FinalRemovedTest is FinalAccessFixture {
    function test_R01_retiredRoutesCannotDispatchBeforeOrAfterFailureInAllFamilies() public {
        for (uint256 family; family < 6; ++family) {
            uint256 snapshot = vm.snapshotState();
            _start(_family(family));
            _buy(box.raise() / 10);
            _removed();
            vm.warp(box.deadline());
            box.fail();
            _removed();
            assertTrue(vm.revertToState(snapshot));
        }
    }

    function _removed() private {
        string[20] memory signatures = _retiredSignatures();
        uint256 supply = token.totalSupply();
        (uint256 pot, uint256 left) = box.claimState();
        for (uint256 role; role < 24; ++role) {
            address target = box.roleAddress(role);
            if (target == address(0)) continue;
            uint256 beforeP = pm.balanceOf(target, 0);
            for (uint256 k; k < signatures.length; ++k) {
                uint256[] memory ids = new uint256[](1);
                ids[0] = 1;
                bytes4 selector = bytes4(keccak256(bytes(signatures[k])));
                bytes memory data = k == 1
                    ? abi.encodeWithSelector(selector, ids)
                    : abi.encodePacked(selector, abi.encode(uint256(1), CREATOR, uint256(1)));
                _refuse(target, CREATOR, data);
            }
            assertEq(pm.balanceOf(target, 0), beforeP);
        }
        uint256[9] memory absent = [uint256(9), 10, 11, 12, 15, 18, 20, 21, 22];
        for (uint256 i; i < absent.length; ++i) {
            assertEq(box.roleAddress(absent[i]), address(0));
        }
        (uint256 afterPot, uint256 afterLeft) = box.claimState();
        assertEq(afterPot, pot);
        assertEq(afterLeft, left);
        assertEq(token.totalSupply(), supply);
    }

    function test_R02_releaseABIsCannotAdvertiseRetiredRoutesEvenUnderAnotherName() public view {
        string[28] memory parts = [
            string("BoxCollectionV2"),
            "BoxCoordinatorV2",
            "BoxFactoryV2",
            "BoxFactoryV2Checks",
            "BoxFactoryV2Parts",
            "BoxFactoryV2Planner",
            "BoxHookV2",
            "BoxHookV2Extension",
            "BoxLaunchRouterV2",
            "BoxReceiverV2",
            "BoxRegistryV2",
            "BoxRoyaltyRouterV2",
            "BoxSpecV2Validator",
            "BoxTicketsV2",
            "BoxTicketsV2Views",
            "BoxTokenV2",
            "BoxTokenV2Ledger",
            "BoxVaultV2",
            "CoordinatorViews",
            "FactoryChecksCurve",
            "HolderLedgerV2",
            "ItemLedgerV2",
            "ListingRegistry",
            "PileVaultV2",
            "ReceiverViews",
            "ShopVaultV2",
            "StarterSetLoaderV2",
            "VaultViews"
        ];
        string[20] memory removed = _retiredSignatures();
        for (uint256 i; i < parts.length; ++i) {
            string memory artifact = vm.readFile(string.concat("out/", parts[i], ".sol/", parts[i], ".json"));
            string[] memory signatures = vm.parseJsonKeys(artifact, ".methodIdentifiers");
            for (uint256 j; j < signatures.length; ++j) {
                bytes4 selector = bytes4(keccak256(bytes(signatures[j])));
                for (uint256 k; k < removed.length; ++k) {
                    assertTrue(
                        selector != bytes4(keccak256(bytes(removed[k]))), string.concat(parts[i], ": ", removed[k])
                    );
                }
            }
        }
    }

    function _retiredSignatures() private pure returns (string[20] memory) {
        return [
            string("claimFor(uint256,address)"),
            "claimFor(uint256[])",
            "settleCap()",
            "claimTip(address)",
            "redeemHeldT()",
            "enterClosing()",
            "priceAverage()",
            "convert(address,uint256)",
            "gift(address,uint256)",
            "setRule(address)",
            "setTarget(address)",
            "setLeg(address)",
            "pair(uint256,uint256)",
            "unpair(uint256)",
            "fundBudget(uint256)",
            "eligibleHolder(address)",
            "closingRange()",
            "retire(uint32)",
            "markUsed(uint32)",
            "poke()"
        ];
    }
}
