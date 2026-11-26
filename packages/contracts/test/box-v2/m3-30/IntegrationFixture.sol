// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {CoordinatorViews} from "../../../src/box-v2/libraries/CoordinatorViews.sol";
import {CoordinatorV2Config, BoxCoordinatorV2Args as A} from "../../../src/box-v2/libraries/BoxCoordinatorV2Args.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {IPileVaultV2} from "../../../src/box-v2/interfaces/IPileVaultV2.sol";
import {PileVaultV2} from "../../../src/box-v2/PileVaultV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {PricingToken} from "../../../src/box-v2/libraries/PricingToken.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {FailureHook, FailureReceiver, FailureRouter} from "../m1-31/FailureShells.sol";

contract PileEmptyDirectory {
    function directory() external pure returns (address[] memory) { return new address[](0); }
    function boxIdOf(address) external pure returns (bool, uint256) { return (false, 0); }
}

/// @dev Local lifecycle counterparts: no curve trade, factory or production receiver allocation claim.
contract PileHookPart is FailureHook {
    uint256 public openAt;
    constructor(IPoolManager pm_, address c, address r, address t, address p_) FailureHook(pm_, c, r, t, p_) {}
    function initialize() external {}
    function launch() external {}
    function setOpen(uint256 at) external { openAt = at; }
}
contract PileRouterPart is FailureRouter {
    uint256 public openAt;
    bool public refuseOpen;
    constructor(IPoolManager pm_, address c, address p_) FailureRouter(pm_, c, p_) {}
    function initialize() external {}
    function setOpen(uint256 at) external { require(!refuseOpen, "open refused"); openAt = at; }
    function setRefuseOpen(bool on) external { refuseOpen = on; }
    function bootstrap() external payable returns (uint256) { return 0; }
}
contract PileReceiverPart is FailureReceiver {
    constructor(IPoolManager pm_, address c, address h, address p_) FailureReceiver(pm_, c, h, p_) {}
    function initialize() external { choice = 1; }
}

abstract contract PileIntegrationFixture is Test {
    address internal constant CREATOR = address(0xCAFE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    uint256 internal constant SEED = 1000;
    IPoolManager internal pm;
    BoxCoordinatorV2 internal box;
    BoxTokenV2 internal token;
    IPileVaultV2 internal pile;
    PileHookPart internal hook;
    PileRouterPart internal router;
    PileReceiverPart internal receiver;
    ListingRegistry internal listings;
    HostileToken internal price;
    HostileToken internal seedToken;
    address internal p;
    address internal asset;
    address internal coordinatorImpl;
    address internal pileImpl;
    bytes24 internal roleNonces;
    bytes[] internal codes;
    bytes internal hookCode;
    bool internal chunked;

    receive() external payable {}

    function _prepare(bool nativeSeed, bool sameAsP, uint256 amount, bool chunks, uint32 scheduled) internal {
        vm.warp(1_000_000);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        price = new HostileToken("Price", "P", 6);
        p = nativeSeed && sameAsP ? address(0) : address(price);
        seedToken = sameAsP ? price : new HostileToken("Seed", "S", 8);
        asset = nativeSeed ? address(0) : address(seedToken);
        listings = ListingRegistry(deployCode("ListingRegistry.sol:ListingRegistry",
            abi.encode(address(this), address(new PileEmptyDirectory()), address(pm), address(0x777))));
        _list(price);
        if (seedToken != price) _list(seedToken);
        coordinatorImpl = deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(pm, address(this)));
        pileImpl = deployCode("PileVaultV2.sol:PileVaultV2", abi.encode(coordinatorImpl));
        bytes memory nonces = new bytes(24);
        nonces[1] = 0x01; nonces[5] = 0x02; nonces[6] = 0x03; nonces[3] = 0x04;
        if (amount != 0) nonces[19] = 0x04;
        roleNonces = bytes24(nonces);
        CoordinatorV2Config memory c;
        c.creator = CREATOR; c.p = p; c.raise = 1e18; c.deadlineDays = 30;
        c.listingRegistry = address(listings); c.openAt = scheduled; c.nonces = roleNonces;
        box = BoxCoordinatorV2(BoxClones.create(BoxClones.initCode(coordinatorImpl, A.encode(c))));
        token = BoxTokenV2(vm.computeCreateAddress(address(box), 1));
        receiver = PileReceiverPart(vm.computeCreateAddress(address(box), 2));
        router = PileRouterPart(payable(vm.computeCreateAddress(address(box), 3)));
        pile = IPileVaultV2(vm.computeCreateAddress(address(box), 4));
        hookCode = abi.encodePacked(type(PileHookPart).creationCode,
            abi.encode(pm, address(box), address(receiver), address(token), p));
        hook = PileHookPart(vm.computeCreate2Address(bytes32(0), keccak256(hookCode), address(box)));
        address ti = deployCode("BoxTokenV2.sol:BoxTokenV2", abi.encode(coordinatorImpl));
        codes = new bytes[](4);
        codes[0] = BoxClones.initCode(ti, BoxTokenV2Args.encode(address(box), address(pile), address(0), 1e30, "Pile", "T"));
        codes[1] = abi.encodePacked(type(PileReceiverPart).creationCode, abi.encode(pm, address(box), address(hook), p));
        codes[2] = abi.encodePacked(type(PileRouterPart).creationCode, abi.encode(pm, address(box), p));
        codes[3] = BoxClones.initCode(pileImpl,
            abi.encodePacked(address(box), address(token), asset, CREATOR, amount));
        chunked = chunks;
        if (nativeSeed) vm.deal(CREATOR, amount);
        else { seedToken.mint(CREATOR, amount); vm.prank(CREATOR); seedToken.approve(address(pile), amount); }
    }
    function _list(HostileToken t) private {
        t.mint(address(this), 10000); t.approve(address(listings), 10000);
        listings.add(address(t), ListingClass.OTHER, 1_000_000);
    }
    // This fixture is the coordinator's factory: authenticate the selected pile clone.
    function isPileVault(address candidate) external view returns (bool) {
        return candidate.code.length == BoxClones.ARGS_OFFSET + 112 && BoxClones.isCloneOf(candidate, pileImpl);
    }
    function _deploy() internal {
        bytes32 root = chunked ? keccak256(abi.encodePacked(hex"00", bytes32(0))) : bytes32(0);
        box.deploy(codes, hookCode, 0, 1, [root, bytes32(0)], [chunked ? uint256(1) : 0, uint256(0)]);
    }
    function _make(bool nativeSeed, bool sameAsP, uint256 amount, bool chunks, uint32 scheduled) internal {
        _prepare(nativeSeed, sameAsP, amount, chunks, scheduled);
        _deploy(); box.launch();
        vm.prank(address(box)); token.transfer(ALICE, 100);
        vm.prank(ALICE); token.approve(address(box), 100);
        vm.prank(ALICE); token.approve(address(pile), 100);
    }
    function _load() internal {
        if (asset == address(0)) {
            uint256 amount = pile.seedAmount();
            vm.prank(CREATOR); pile.loadSeed{value: amount}();
        }
        else { vm.prank(BOB); pile.loadSeed(); }
    }
    function _fund(address a, address to, uint256 amount) internal {
        if (a == address(0)) vm.deal(address(this), address(this).balance + amount);
        else HostileToken(a).mint(address(this), amount);
        pm.unlock(abi.encode(a, to, amount));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address a, address to, uint256 amount) = abi.decode(data, (address, address, uint256));
        PricingToken.settle(pm, a, amount); pm.mint(to, uint256(uint160(a)), amount); return "";
    }
    function _assetBalance(address to) internal view returns (uint256) { return PricingToken.balanceOf(asset, to); }
    function _pot(uint256 expectedP, uint256 expectedT) internal view {
        (uint256 balance, uint256 left) = box.claimState(); assertEq(balance, expectedP); assertEq(left, expectedT);
    }
}
