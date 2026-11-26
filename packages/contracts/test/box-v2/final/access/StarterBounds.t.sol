// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {StarterFixture} from "../../m2-33/StarterFixture.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {M2SeamArgs} from "../../../../src/box-v2/libraries/M2SeamArgs.sol";
import {IStarterSetLoaderV2} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";

// Same seven m2-33/Bounds properties; explicit default-profile artifact paths for the size check.
// Named artifact lookup may select the upstream-PM compiler profile in a mixed-profile build.
contract FinalStarterBoundsTest is StarterFixture {
    function _commit(bytes32 hash, uint32 n) private {
        // Test malformed immutable input without changing the production factory or its validator.
        vm.etch(
            address(loader), BoxClones.runtime(loaderImpl, M2SeamArgs.starter(address(box), address(shop), hash, n))
        );
    }

    function test_invalidCountsHashAndMalformedCloneCannotAct() public {
        _make(10, 400, false, 0, false);
        _seed();
        _commit(suffix[0], 9);
        vm.expectRevert();
        loader.progress();
        vm.expectRevert();
        loader.complete();
        _commit(suffix[0], 10001);
        vm.expectRevert();
        loader.progress();
        _commit(suffix[0], 0);
        vm.expectRevert();
        loader.progress();
        _commit(0, 10);
        vm.expectRevert();
        loader.progress();
        vm.etch(address(loader), BoxClones.runtime(loaderImpl, new bytes(75)));
        vm.expectRevert();
        loader.complete();
        vm.expectRevert();
        IStarterSetLoaderV2(loaderImpl).complete();
        vm.expectRevert();
        IStarterSetLoaderV2(loaderImpl).progress();
    }

    function test_foreignCloneAndWrongShopCannotUseCreatorApproval() public {
        _make(10, 400, false, 0, false);
        _seed();
        IStarterSetLoaderV2 stranger = IStarterSetLoaderV2(
            BoxClones.create(
                BoxClones.initCode(loaderImpl, M2SeamArgs.starter(address(box), address(shop), suffix[0], 10))
            )
        );
        (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(0, 1);
        vm.prank(CREATOR);
        vm.expectRevert();
        stranger.load(cs, ids, tiers, suffix[1]);
        vm.etch(address(loader), BoxClones.runtime(loaderImpl, M2SeamArgs.starter(address(box), OTHER, suffix[0], 10)));
        vm.prank(CREATOR);
        vm.expectRevert();
        loader.load(cs, ids, tiers, suffix[1]);
        assertEq(nft.ownerOf(1), CREATOR);
        assertEq(shop.inside(), 0);
    }

    function test_exactCountCannotHideNonzeroTailOrEndEarly() public {
        _make(10, 400, false, 0, false);
        _seed();
        // Same authentic ten-item chain, falsely committed as eleven: the final zero is premature.
        _commit(suffix[0], 11);
        vm.expectRevert();
        this.loadPage(0, 10);
        assertEq(shop.inside(), 0);
        bytes32 tail = bytes32(uint256(7));
        bytes32 root = tail;
        for (uint256 i = 10; i != 0;) {
            --i;
            root = keccak256(abi.encode(address(nft), i + 1, uint8(0), root));
        }
        _commit(root, 10);
        (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(0, 10);
        vm.prank(CREATOR);
        vm.expectRevert();
        loader.load(cs, ids, tiers, tail);
        assertEq(shop.inside(), 0);
        _commit(suffix[0], 10);
        _page(0, 10);
        vm.prank(CREATOR);
        vm.expectRevert();
        loader.load(cs, ids, tiers, 0);
        _complete();
    }

    function test_distinctCollectionsMayUseSameIdAndTierThreeIsCommitted() public {
        _make(10, 400, false, 0, false);
        _seed();
        (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(0, 10);
        cs[1] = address(second);
        ids[1] = 1;
        tiers[1] = 3;
        second.mint(CREATOR, 1);
        bytes32 root;
        for (uint256 i = 10; i != 0;) {
            --i;
            root = keccak256(abi.encode(cs[i], ids[i], tiers[i], root));
        }
        _commit(root, 10);
        vm.prank(CREATOR);
        loader.load(cs, ids, tiers, 0);
        loader.complete();
        assertEq(nft.ownerOf(1), address(shop));
        assertEq(second.ownerOf(1), address(shop));
        assertEq(nft.ownerOf(2), CREATOR);
        assertEq(shop.inside(), 10);
        assertTrue(box.gateOpen());
    }

    function test_duplicateValidationPrecedesAnyCollectionCall() public {
        _make(10, 400, false, 0, true);
        _seed();
        (address[] memory cs, uint256[] memory ids, uint8[] memory tiers) = _args(0, 2);
        nft.setSink(true);
        // A collection call would consume this entire allowance. The duplicate must fail locally instead.
        vm.prank(CREATOR);
        (bool ok, bytes memory ret) =
            address(loader).call{gas: 500000}(abi.encodeCall(loader.load, (cs, ids, tiers, suffix[2])));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSignature("InvalidRequest()"));
        _assertProgress(0, false);
        assertEq(nft.ownerOf(1), CREATOR);
    }

    function test_failingFinalChunkRetainsStarterCompletionAndRetries() public {
        _make(10, 400, true, 0, false);
        _seed();
        _page(0, 10);
        _complete();
        vm.mockCallRevert(box.hook(), abi.encodeWithSignature("setOpen(uint256)", block.timestamp + 1), "no open");
        vm.expectRevert();
        this.finishChunks();
        _assertProgress(10, true);
        assertFalse(box.gateOpen());
        vm.clearMockedCalls();
        _chunks();
        assertTrue(box.gateOpen());
    }

    function finishChunks() external {
        _chunks();
    }

    function test_productionPartsFitReservedCeiling() public view {
        assertLe(vm.getDeployedCode("out/StarterSetLoaderV2.sol/StarterSetLoaderV2.json").length, 22118);
        assertLe(vm.getDeployedCode("out/BoxCoordinatorV2.sol/BoxCoordinatorV2.json").length, 22118);
        assertLe(vm.getDeployedCode("out/ShopVaultV2.sol/ShopVaultV2.json").length, 22118);
    }
}
