// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {Test} from "forge-std/Test.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../box/conformance/core/CoreBox0Kit.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {ListingRegistry} from "../../../src/box-v2/ListingRegistry.sol";
import {ListingClass, ListingKind} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxReceiverV2Args, ReceiverArgs} from "../../../src/box-v2/libraries/BoxReceiverV2Args.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

// Narrow coordinator/hook doubles avoid importing the upstream PoolManager compiler profile into the v1 kit.
contract FitEatCoordinator {
    bool public graduated;
    function failed() external pure returns (bool) { return false; }
    function initialize(BoxReceiverV2 r) external { r.initialize(); }
    function graduation(BoxReceiverV2 r) external { graduated = true; r.onGraduation(); }
}
contract FitEatHook {
    bool private collected;
    function harvest() external returns (uint256, uint256, uint256) {
        if (collected) return (0, 0, 0);
        collected = true; return (1500, 0, 0);
    }
}
contract EatFitTest is Test {
    CoreBox0Kit private kit;
    CoreBoxAddresses private a;
    BoxToken private fit;
    ListingRegistry private listings;
    BoxRegistryV2 private registry;
    uint256 private supply;
    bytes4 private constant SELECTOR = bytes4(keccak256("burn(uint256)"));
    function setUp() public {
        kit = CoreBox0Kit(payable(deployCode("CoreBox0Kit.sol:CoreBox0Kit"))); kit.setUpWorld();
        string memory json = vm.readFile("test/vectors/box-spec/box-spec-v1.json");
        BoxSpecV1.BoxSpec memory s = abi.decode(vm.parseJsonBytes(json, ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.raise = BoxSpecV1.qListV1()[0].raisePresets[0]; kit.build(s); kit.toGraduated();
        a = kit.addresses();
        address[] memory earlier = new address[](1); earlier[0] = kit.impls().registry;
        registry = BoxRegistryV2(deployCode("BoxRegistryV2.sol:BoxRegistryV2", abi.encode(address(this), earlier)));
        listings = ListingRegistry(deployCode("ListingRegistry.sol:ListingRegistry", abi.encode(address(this), address(registry), a.poolManager, a.weth)));
        fit = BoxToken(a.token);
        vm.prank(kit.alice()); fit.transfer(address(this), 10_000); fit.approve(address(listings), 10_000);
        supply = fit.totalSupply();
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == a.poolManager);
        IPoolManager pm = IPoolManager(a.poolManager);
        pm.sync(Currency.wrap(a.token)); fit.transfer(a.poolManager, 1500); pm.settle();
        pm.mint(abi.decode(data, (address)), uint160(a.token), 1500); return "";
    }
    function test_EAT20_genesisFitListingAndActualReceiverBurn() public {
        uint32 id = listings.addWithBurn(a.token, ListingClass.STANDARD, 1 ether, SELECTOR);
        assertEq(uint8(listings.listing(id).kind), uint8(ListingKind.BOX_TOKEN));
        assertEq(listings.checkedBurnSelector(a.token), SELECTOR); assertEq(fit.totalSupply(), supply);
        address ci = address(new FitEatCoordinator());
        FitEatCoordinator c = FitEatCoordinator(BoxClones.create(BoxClones.initCode(ci, "")));
        FitEatHook h = new FitEatHook();
        address impl = deployCode("BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(IPoolManager(a.poolManager), ci, a.platform, a.platform));
        ReceiverArgs memory args;
        args.coordinator = address(c); args.hook = address(h); args.p = a.token;
        args.t = address(type(uint160).max); args.launchRouter = address(1); args.registry = address(registry);
        args.batchMinQ = 1; args.stepMinQ = 1; args.buyersChoice = 6; args.sellersChoice = 6;
        BoxReceiverV2 r = BoxReceiverV2(BoxClones.create(BoxClones.initCode(impl, bytes.concat(BoxReceiverV2Args.encode(args), SELECTOR))));
        c.initialize(r);
        IPoolManager(a.poolManager).unlock(abi.encode(address(r)));
        r.collect(address(0)); c.graduation(r);
        assertEq(r.eatPriceCoin(), 1000); assertEq(fit.totalSupply(), supply - 1000);
        assertEq(r.eatenP(), 1000); assertEq(fit.balanceOf(address(r)), 0);
    }
}
