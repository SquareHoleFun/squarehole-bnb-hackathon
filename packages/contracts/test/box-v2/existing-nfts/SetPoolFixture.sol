// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetReleaseFixture} from "./SetReleaseFixture.sol";
import {SetStandardERC721} from "./SetVaultFixture.sol";
import {SetSpecV2} from "../../../src/box-v2/set/SetTypesV2.sol";
import {SetVaultV2} from "../../../src/box-v2/set/SetVaultV2.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxLaunchRouterV2} from "../../../src/box-v2/BoxLaunchRouterV2.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {BoxLayoutV2} from "../../../src/box-v2/libraries/BoxLayoutV2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {HostileToken} from "../kit/HostileToken.sol";

/// All box parts are created by E-06's factory from its pinned SetReleaseV2. Only the NFT and payer are fixtures.
abstract contract SetPoolFixture is SetReleaseFixture {
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    BoxCoordinatorV2 internal box;
    BoxTokenV2 internal token;
    SetVaultV2 internal vault;
    StarterSetLoaderV2 internal loader;
    BoxLaunchRouterV2 internal router;
    IBoxHookV2 internal hook;
    IBoxReceiverV2 internal receiver;
    IPoolManager internal pm;
    PoolDriver internal buyer;
    BoxLayoutV2.Curve internal curve;
    address internal collection;

    receive() external payable {}

    function _id(uint256 i) internal pure returns (uint256) {
        return i == 0 ? 0 : i == 1 ? type(uint256).max : i * 101;
    }

    function _terms(address nft_, uint32 count) internal view returns (SetSpecV2 memory s, bytes32[] memory suffix) {
        s = _spec();
        s.collection = nft_;
        s.count = count;
        suffix = new bytes32[](uint256(count) + 1);
        for (uint256 i = count; i != 0;) {
            --i;
            suffix[i] = keccak256(abi.encode(nft_, _id(i), uint8(0), suffix[i + 1]));
        }
        s.setHash = suffix[0];
    }

    function _start(SetSpecV2 memory s) internal {
        box = _create(s);
        collection = s.collection;
        token = BoxTokenV2(box.token());
        vault = SetVaultV2(box.vault());
        loader = StarterSetLoaderV2(box.starterSetLoader());
        router = BoxLaunchRouterV2(box.launchRouter());
        hook = IBoxHookV2(box.hook());
        receiver = IBoxReceiverV2(box.receiver());
        pm = IPoolManager(release.poolManager);
        buyer = new PoolDriver(pm);
        curve = BoxLayoutV2.curve(s.raise, false);
        vm.deal(ALICE, 100 ether);
        if (s.pricing.token == address(0)) {
            vm.deal(address(buyer), 100 ether);
        } else {
            HostileToken(s.pricing.token).mint(ALICE, s.raise * 10);
            HostileToken(s.pricing.token).mint(address(buyer), s.raise * 10);
            vm.prank(ALICE);
            HostileToken(s.pricing.token).approve(address(router), type(uint256).max);
        }
        vm.prank(CREATOR);
        SetStandardERC721(collection).setApprovalForAll(address(vault), true);
    }

    function _pageData(uint256 start, uint256 count, bytes32 next) internal view returns (bytes memory) {
        address[] memory cs = new address[](count);
        uint256[] memory ids = _ids(start, count);
        uint8[] memory tiers = new uint8[](count);
        for (uint256 i; i < count; ++i) {
            cs[i] = collection;
        }
        return abi.encodeCall(loader.load, (cs, ids, tiers, next));
    }

    function _ids(uint256 start, uint256 count) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = _id(start + i);
        }
    }

    function _page(uint256 start, uint256 count, bytes32 next) internal {
        bytes memory data = _pageData(start, count, next);
        vm.prank(CREATOR);
        (bool ok, bytes memory reason) = address(loader).call(data);
        if (!ok) {
            assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
        }
    }

    function _load(bytes32[] memory suffix) internal virtual {
        uint256 count = suffix.length - 1;
        for (uint256 i; i < count; i += 32) {
            uint256 n = count - i > 32 ? 32 : count - i;
            _page(i, n, suffix[i + n]);
        }
    }

    function _open(bytes32[] memory suffix) internal {
        _load(suffix);
        loader.complete();
        assertTrue(box.gateOpen(), "complete opens trading gate");
        assertFalse(vault.gateOpen(), "conversion waits for graduation");
        vm.warp(box.effectiveOpenAt());
        vm.roll(block.number + 1);
    }

    function _routerBuy(uint256 p) internal returns (uint256) {
        uint256 value = box.q() == address(0) ? p : 0;
        vm.prank(ALICE);
        return router.buy{value: value}(p, 1, ALICE, block.timestamp);
    }

    function _fill() internal {
        vm.warp(box.effectiveOpenAt() + 384);
        vm.roll(block.number + 1);
        for (uint256 i; i < 5 && !hook.closed(); ++i) {
            buyer.swap(hook.poolKey(), true, box.raise() / 4, curve.sqrtPriceEndX96);
        }
        assertTrue(hook.closed(), "actual buys fill curve");
    }

    function _fundPicker() internal {
        uint256 amount = token.balanceOf(address(buyer));
        vm.prank(address(buyer));
        token.transfer(ALICE, amount);
        vm.prank(ALICE);
        token.approve(address(vault), type(uint256).max);
    }

    function _gift(address to, uint256 amount) internal {
        buyer.mintClaims(Currency.wrap(box.q()), to, amount);
    }

    function _noPayouts() internal view {
        assertEq(box.roleAddress(4), address(0));
        assertEq(box.roleAddress(7), address(0));
        assertEq(box.roleAddress(16), address(0));
        assertEq(box.roleAddress(17), address(0));
        assertEq(uint8(receiver.buyersChoice()), 3);
        assertEq(uint8(receiver.sellersChoice()), 3);
        assertEq(receiver.itemLedger(), address(0));
        assertEq(receiver.holderLedger(), address(0));
        (uint256 owed, uint256 held) = receiver.creatorOwed(box.q());
        assertEq(owed + held, 0);
        assertEq(receiver.creatorP(), 0);
        assertEq(receiver.buyBackP(), 0);
        assertEq(receiver.itemsHeldP(), 0);
        assertEq(receiver.royaltyHeldP(), 0);
        assertLe(receiver.booked(box.q()), pm.balanceOf(address(receiver), uint160(box.q())));
    }
}
