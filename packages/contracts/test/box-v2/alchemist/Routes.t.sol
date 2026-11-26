// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {AlchemistRouteV21, AlchemistHopV21} from "../../../src/box-v2/modules/AlchemistRouteV21.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {PoolDriver} from "../kit/BoxV2TestBase.sol";
import {AlchemistV2Pool,AlchemistV3Pool} from "./Pools.sol";

contract AlchemistRouteDriver {
    IPoolManager public immutable pm;
    AlchemistRouteV21 public immutable route;
    address public immutable asset;
    address public immutable pile;
    constructor(IPoolManager pm_, AlchemistHopV21[] memory hops, address pile_, uint256 dust) {
        pm = pm_; asset = hops[0].tokenIn; pile = pile_; route = new AlchemistRouteV21(pm_,hops,dust);
    }
    function execute(uint256 amount) external returns (uint256) { return abi.decode(pm.unlock(abi.encode(amount)),(uint256)); }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm)); uint256 amount = abi.decode(data,(uint256));
        pm.transfer(address(route),uint160(asset),amount);
        return abi.encode(route.convert(pile,amount,address(0xd37)));
    }
}
contract AlchemistRoutesTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    IPoolManager private pm;
    PoolDriver private lp;
    HostileToken private a;
    HostileToken private b;
    HostileToken private c;
    AlchemistV2Pool private pair;
    /// G1-INT: the helpers' dust size here; the module checks it at creation (positive, at most the cap).
    uint256 private constant DUST = 1e6;
    function setUp() public {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager",abi.encode(address(this))));
        lp = new PoolDriver(pm);
        a = new HostileToken("A","A",18); b = new HostileToken("B","B",6); c = new HostileToken("C","C",8);
        a.mint(address(lp),1e30); b.mint(address(lp),1e30); c.mint(address(lp),1e30); vm.deal(address(lp),1e30);
        pair = new AlchemistV2Pool(address(a),address(b));
        a.mint(address(pair),1e24); b.mint(address(pair),1e24); pair.sync();
    }
    receive() external payable {}
    function _hop(uint8 kind,address x,address y,address pool) private pure returns (AlchemistHopV21 memory) {
        return AlchemistHopV21(kind,x,y,pool,3000,kind == 2 ? int24(0) : int24(60));
    }
    function _driver(AlchemistHopV21[] memory hops,uint256 amount) private returns (AlchemistRouteDriver d) {
        return _driver(hops, amount, DUST);
    }
    function _driver(AlchemistHopV21[] memory hops,uint256 amount,uint256 dust) private returns (AlchemistRouteDriver d) {
        d = new AlchemistRouteDriver(pm,hops,address(this),dust);
        lp.mintClaims(Currency.wrap(hops[0].tokenIn),address(d),amount);
    }
    function test_AL07_refusesUnboundedNoncontiguousCyclicAndWrongPoolRoutes() public {
        AlchemistHopV21[] memory h = new AlchemistHopV21[](0);
        vm.expectRevert(); new AlchemistRouteV21(pm,h,DUST);
        h = new AlchemistHopV21[](4); vm.expectRevert(); new AlchemistRouteV21(pm,h,DUST);
        h = new AlchemistHopV21[](1); h[0] = _hop(2,address(a),address(b),address(pair));
        h[0].fee = 500; vm.expectRevert(); new AlchemistRouteV21(pm,h,DUST);
        h[0] = _hop(2,address(a),address(c),address(pair)); vm.expectRevert(); new AlchemistRouteV21(pm,h,DUST);
        h[0] = _hop(4,address(a),address(b),address(pm)); h[0].fee = 0x800000;
        vm.expectRevert(); new AlchemistRouteV21(pm,h,DUST);
        h = new AlchemistHopV21[](2); h[0] = _hop(2,address(a),address(b),address(pair)); h[1] = h[0];
        vm.expectRevert(); new AlchemistRouteV21(pm,h,DUST);
        h[1] = _hop(2,address(b),address(a),address(pair)); vm.expectRevert(); new AlchemistRouteV21(pm,h,DUST);
    }
    function test_G1_A3_v3FeeFloor() public {
        AlchemistV3Pool v3 = new AlchemistV3Pool(address(a), address(b));
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1);
        h[0] = _hop(3, address(a), address(b), address(v3));
        h[0].fee = 2999;
        vm.mockCall(address(v3), abi.encodeWithSignature("fee()"), abi.encode(uint24(2999)));
        vm.expectRevert(AlchemistRouteV21.InvalidRoute.selector); new AlchemistRouteV21(pm, h, DUST);
    }
    function test_G1_A3_v4FeeFloor() public {
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1);
        h[0] = _hop(4, address(a), address(b), address(pm)); h[0].fee = 2999;
        vm.expectRevert(AlchemistRouteV21.InvalidRoute.selector); new AlchemistRouteV21(pm, h, DUST);
    }
    function test_G1_A4_unsyncedAtEntryCannotBeRepairedByTokenCallback() public {
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1);
        h[0] = _hop(2, address(a), address(b), address(pair));
        AlchemistRouteDriver d = _driver(h, 1 ether);
        b.mint(address(pair), 1);
        // The input token's callback repairs the reserves/balances mismatch after snapshots.
        a.armReentry(address(pair), abi.encodeCall(AlchemistV2Pool.skim, (address(0xbeef))));
        vm.expectRevert(AlchemistRouteV21.SwapRefused.selector); d.execute(1 ether);
        assertEq(pm.balanceOf(address(d), uint160(address(a))), 1 ether);
        assertEq(b.balanceOf(address(pair)), 1e24 + 1);
        assertEq(b.balanceOf(address(0xbeef)), 0);
    }
    function testFuzz_AL08_v2ImpactAndConservationInEitherDirection(uint80 raw,bool reverse) public {
        uint256 amount = bound(uint256(raw),1000,1e22);
        address x = reverse ? address(b) : address(a); address y = reverse ? address(a) : address(b);
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1); h[0] = _hop(2,x,y,address(pair));
        AlchemistRouteDriver d = _driver(h,amount);
        uint256 beforePile = HostileToken(y).balanceOf(address(this));
        try d.execute(amount) returns (uint256 output) {
            assertGt(output,0);
            assertEq(HostileToken(x).balanceOf(address(pair)),1e24 + amount);
            assertEq(HostileToken(y).balanceOf(address(pair)),1e24 - output);
            assertEq(HostileToken(y).balanceOf(address(this)) - beforePile,output);
            // 49 ticks is stricter than a 0.5% relative price move, independent reserve-ratio check.
            assertGe((1e24-output) * 1e18 / (1e24+amount),995e15);
            assertEq(pm.balanceOf(address(d),uint160(x)),0);
        } catch {
            assertEq(HostileToken(x).balanceOf(address(pair)),1e24);
            assertEq(HostileToken(y).balanceOf(address(pair)),1e24);
            assertEq(HostileToken(y).balanceOf(address(this)),beforePile);
            assertEq(pm.balanceOf(address(d),uint160(x)),amount);
        }
        assertEq(HostileToken(x).balanceOf(address(d.route())),0);
        assertEq(HostileToken(y).balanceOf(address(d.route())),0);
    }
    function test_AL09_threeHopsIncludeRealV4InTheExistingUnlock() public {
        // Native -> A on real v4, A -> B on v2, B -> C on a v3 double.
        PoolKey memory key = PoolKey(Currency.wrap(address(0)),Currency.wrap(address(a)),3000,60,IHooks(address(0)));
        pm.initialize(key,uint160(1 << 96)); lp.modify(key,-887220,887220,1e24);
        AlchemistV3Pool v3 = new AlchemistV3Pool(address(b),address(c));
        b.mint(address(v3),1e24); c.mint(address(v3),1e24);
        AlchemistHopV21[] memory h = new AlchemistHopV21[](3);
        h[0] = _hop(4,address(0),address(a),address(pm)); h[1] = _hop(2,address(a),address(b),address(pair)); h[2] = _hop(3,address(b),address(c),address(v3));
        AlchemistRouteDriver d = _driver(h,1 ether);
        uint256 output = d.execute(1 ether); assertGt(output,0); assertEq(c.balanceOf(address(this)),output);
        assertEq(pm.balanceOf(address(d),0),0); assertEq(address(d.route()).balance,0);
        assertEq(a.balanceOf(address(d.route())),0); assertEq(b.balanceOf(address(d.route())),0);
        (uint160 spot,,,) = pm.getSlot0(key.toId()); assertLt(spot,uint160(1 << 96));
    }
    function test_AL10_v4ReverseNativeOutputAndPartialFillRollback() public {
        PoolKey memory key = PoolKey(Currency.wrap(address(0)),Currency.wrap(address(a)),3000,60,IHooks(address(0)));
        pm.initialize(key,uint160((1 << 96) + 12345)); lp.modify(key,-887220,887220,1e24);
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1); h[0] = _hop(4,address(a),address(0),address(pm));
        AlchemistRouteDriver d = _driver(h,1e23);
        uint256 before_ = address(this).balance;
        vm.expectRevert(); d.execute(1e23); assertEq(pm.balanceOf(address(d),uint160(address(a))),1e23);
        assertEq(address(this).balance,before_);
        uint256 output = d.execute(1 ether); assertEq(address(this).balance - before_,output);
        assertEq(pm.balanceOf(address(d),uint160(address(a))),1e23 - 1 ether);
    }
    function test_AL11_tokenFreezeFeeReentryAndUnsolicitedBalancesNeverSpendOtherFunds() public {
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1); h[0] = _hop(2,address(a),address(b),address(pair));
        AlchemistRouteDriver d = _driver(h,1 ether);
        a.mint(address(d.route()),31); b.mint(address(d.route()),43);
        b.setPaused(true); vm.expectRevert(); d.execute(1 ether); b.setPaused(false);
        b.setFeeBps(1); vm.expectRevert(); d.execute(1 ether); b.setFeeBps(0);
        a.armReentry(address(d.route()),abi.encodeCall(AlchemistRouteV21.convert,(address(this),1,address(0xd37))));
        vm.expectRevert(); d.execute(1 ether); a.armReentry(address(0),"");
        assertEq(pm.balanceOf(address(d),uint160(address(a))),1 ether);
        assertGt(d.execute(1 ether),0);
        assertEq(a.balanceOf(address(d.route())),31); assertEq(b.balanceOf(address(d.route())),43);
    }
    function test_E2_lateV3DustRollsBackFirstSwapBeforeMovingOriginalClaims() public {
        AlchemistV3Pool first = new AlchemistV3Pool(address(a), address(b));
        AlchemistV3Pool second = new AlchemistV3Pool(address(b), address(c));
        a.mint(address(first), 1e24); b.mint(address(first), 1e24);
        b.mint(address(second), 1e24); c.mint(address(second), 1e24);
        AlchemistHopV21[] memory h = new AlchemistHopV21[](2);
        h[0] = _hop(3, address(a), address(b), address(first)); h[1] = _hop(3, address(b), address(c), address(second));
        AlchemistRouteDriver d = _driver(h, 16);
        vm.expectCall(address(first), abi.encodeWithSelector(AlchemistV3Pool.swap.selector));
        assertEq(d.execute(16), 0);
        assertEq(first.spot(), 1 << 96); assertEq(second.spot(), 1 << 96);
        assertEq(a.balanceOf(address(first)), 1e24); assertEq(b.balanceOf(address(first)), 1e24);
        assertEq(pm.balanceOf(address(0xd37), uint160(address(a))), 16); assertEq(c.balanceOf(address(this)), 0);
        assertEq(pm.balanceOf(address(d), uint160(address(a))), 0);
        assertEq(b.balanceOf(address(d.route())), 0);
    }
    /// G1-INT: a zero minimum adds depth only for a clip within the helper's dust size; one unit above it refuses
    /// and the driver keeps its claims, with every earlier swap rolled back.
    function test_E4_zeroMinimumAboveDustSizeRefusesAndKeepsClaims() public {
        AlchemistV3Pool first = new AlchemistV3Pool(address(a), address(b));
        AlchemistV3Pool second = new AlchemistV3Pool(address(b), address(c));
        a.mint(address(first), 1e24); b.mint(address(first), 1e24);
        b.mint(address(second), 1e24); c.mint(address(second), 1e24);
        AlchemistHopV21[] memory h = new AlchemistHopV21[](2);
        h[0] = _hop(3, address(a), address(b), address(first)); h[1] = _hop(3, address(b), address(c), address(second));
        AlchemistRouteDriver d = _driver(h, 16, 15);
        assertEq(d.route().dustMax(), 15);
        vm.expectRevert(AlchemistRouteV21.SwapRefused.selector); d.execute(16);
        assertEq(pm.balanceOf(address(d), uint160(address(a))), 16);
        assertEq(a.balanceOf(address(0xd37)), 0); assertEq(first.spot(), 1 << 96);
        assertEq(a.balanceOf(address(first)), 1e24); assertEq(b.balanceOf(address(d.route())), 0);
        AlchemistRouteDriver e = _driver(h, 16, 16);
        assertEq(e.execute(16), 0, "a clip equal to the dust size still adds depth");
        assertEq(pm.balanceOf(address(0xd37), uint160(address(a))), 16); assertEq(pm.balanceOf(address(e), uint160(address(a))), 0);
    }
    function test_E2_lateV2ZeroOutputRollsBackFirstSwap() public {
        AlchemistV3Pool first = new AlchemistV3Pool(address(a), address(b));
        AlchemistV2Pool second = new AlchemistV2Pool(address(b), address(c));
        a.mint(address(first), 1e24); b.mint(address(first), 1e24);
        b.mint(address(second), 1e24); c.mint(address(second), 1e22); second.sync();
        AlchemistHopV21[] memory h = new AlchemistHopV21[](2);
        h[0] = _hop(3, address(a), address(b), address(first)); h[1] = _hop(2, address(b), address(c), address(second));
        AlchemistRouteDriver d = _driver(h, 16);
        vm.expectCall(address(first), abi.encodeWithSelector(AlchemistV3Pool.swap.selector));
        assertEq(d.execute(16), 0);
        assertEq(first.spot(), 1 << 96); assertEq(a.balanceOf(address(first)), 1e24);
        assertEq(b.balanceOf(address(first)), 1e24); assertEq(b.balanceOf(address(second)), 1e24);
        assertEq(c.balanceOf(address(second)), 1e22); assertEq(pm.balanceOf(address(0xd37), uint160(address(a))), 16);
        assertEq(pm.balanceOf(address(d), uint160(address(a))), 0);
    }
    function test_E2_nativeDustTransfersClaimsWithoutCallingRecipient() public {
        PoolKey memory key = PoolKey(Currency.wrap(address(0)),Currency.wrap(address(a)),3000,60,IHooks(address(0)));
        pm.initialize(key, uint160(1 << 96)); lp.modify(key, -887220, 887220, 1e24);
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1); h[0] = _hop(4, address(0), address(a), address(pm));
        AlchemistRouteDriver d = _driver(h, 2);
        vm.deal(address(d.route()), 31); a.mint(address(d.route()), 43);
        lp.mintClaims(Currency.wrap(address(0)), address(d.route()), 7);
        address depth = address(0xd37); uint256 before_ = depth.balance;
        uint256 managerBefore = address(pm).balance;
        vm.etch(depth, hex"60006000fd");
        assertEq(d.execute(1), 0);
        assertEq(pm.balanceOf(depth, 0), 1); assertEq(depth.balance, before_);
        vm.etch(depth, hex"5b600056"); // No recipient callback, even for native claims.
        assertEq(d.execute(1), 0);
        assertEq(pm.balanceOf(depth, 0), 2); assertEq(depth.balance, before_);
        assertEq(pm.balanceOf(address(d), 0), 0); assertEq(pm.balanceOf(address(d.route()), 0), 7);
        assertEq(address(pm).balance, managerBefore);
        assertEq(address(d.route()).balance, 31); assertEq(a.balanceOf(address(d.route())), 43);
        (uint160 spot,,,) = pm.getSlot0(key.toId()); assertEq(spot, 1 << 96);
    }
    function test_E2_poolCannotForgeDustToRedirectConvertibleFunds() public {
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1); h[0] = _hop(2, address(a), address(b), address(pair));
        AlchemistRouteDriver d = _driver(h, 1 ether);
        vm.mockCallRevert(address(pair), abi.encodeWithSelector(AlchemistV2Pool.swap.selector), abi.encodeWithSignature("ZeroMinimum()"));
        vm.expectRevert(AlchemistRouteV21.SwapRefused.selector); d.execute(1 ether);
        assertEq(pm.balanceOf(address(d), uint160(address(a))), 1 ether);
        assertEq(a.balanceOf(address(0xd37)), 0); assertEq(a.balanceOf(address(pair)), 1e24);
    }
    function test_E2_selfCallFramesCannotBeUsedAsPublicEntries() public {
        AlchemistHopV21[] memory h = new AlchemistHopV21[](1); h[0] = _hop(2, address(a), address(b), address(pair));
        AlchemistRouteDriver d = _driver(h, 1);
        AlchemistRouteV21 route = d.route();
        vm.expectRevert(AlchemistRouteV21.OnlySelf.selector); route.attempt(address(this), 1);
        vm.expectRevert(AlchemistRouteV21.OnlySelf.selector); route.swapRoute(address(this), 1);
        vm.expectRevert(AlchemistRouteV21.OnlyModule.selector); route.convert(address(this), 1, address(this));
        assertEq(pm.balanceOf(address(d), uint160(address(a))), 1);
    }
}
