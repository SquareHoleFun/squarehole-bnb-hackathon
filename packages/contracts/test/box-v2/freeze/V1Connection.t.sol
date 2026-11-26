// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC6909Claims} from "v4-core/src/interfaces/external/IERC6909Claims.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxPriceSampler} from "../../../src/box/BoxPriceSampler.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxRegistry} from "../../../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {ItemReveal} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxReceiver, IFitBuybackExecutor} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRegistry} from "../../../src/box/interfaces/IBoxRegistry.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";
import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../box/conformance/core/CoreBox0Kit.sol";
import {BoxDrandVectors} from "../../box/randomness/utils/BoxDrandVectors.sol";
import {OpenTime} from "../../box/utils/OpenTime.sol";

/// @notice TEST ONLY. A contract as v2's parts are to box 0 (a converter, the platform cap, a v2 vault holding
/// Misfits): it holds ETH, FIT and Misfits, calls box 0's open entry points itself and trades in box 0's pool through
/// its own PoolManager unlock, as an ordinary trader.
contract V1Caller is IUnlockCallback {
    IPoolManager internal immutable _pm;

    constructor(IPoolManager pm) {
        _pm = pm;
    }

    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @notice A call from this contract with `value`, its revert passed on.
    function run(address target, uint256 value, bytes calldata data) external returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    /// @notice `value` to `to` with `transfer`'s 2,300-gas stipend (`send`): whether it was taken.
    function sendWithStipend(address payable to, uint256 value) external returns (bool) {
        return to.send(value);
    }

    /// @notice An exact-input swap in `key`'s pool (`zeroForOne`: ETH in, FIT out), paid from and taken to this contract.
    function swap(PoolKey calldata key, bool zeroForOne, uint256 amountIn) external returns (uint256) {
        return abi.decode(_pm.unlock(abi.encode(key, zeroForOne, amountIn)), (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(_pm), "V1Caller: not the PoolManager");
        (PoolKey memory key, bool zeroForOne, uint256 amountIn) = abi.decode(data, (PoolKey, bool, uint256));
        uint160 limit = zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
        // casting to 'int256' is safe because test amounts stay far below 2^255
        // forge-lint: disable-next-line(unsafe-typecast)
        BalanceDelta d = _pm.swap(key, SwapParams(zeroForOne, -int256(amountIn), limit), "");
        (int128 paid, int128 got) = zeroForOne ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        (Currency tokenIn, Currency tokenOut) =
            zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        // casting to 'uint128' is safe because an exact-input swap owes a negative and gets a positive delta
        // forge-lint: disable-next-line(unsafe-typecast)
        (uint256 owed, uint256 out) = (uint128(-paid), uint128(got));
        _pm.sync(tokenIn);
        if (tokenIn.isAddressZero()) {
            _pm.settle{value: owed}();
        } else {
            require(BoxToken(Currency.unwrap(tokenIn)).transfer(address(_pm), owed), "V1Caller: pay");
            _pm.settle();
        }
        _pm.take(tokenOut, address(this), out);
        return abi.encode(out);
    }
}

/// @title V1ConnectionTest (ticket M1-02; ADR-0017 § 10)
/// @notice v2's connection points to v1, pinned on box 0 as factory v1 builds it (`CoreBox0Kit`: the version's
/// deployment steps, box 0's fixture with the build's raise, so the rehearsal build runs it too). v2 talks to box 0
/// only through open entry points and views (`core-v2-plan.md:309`); each test calls them from a contract, never as an
/// EOA, and reads each view through the exact signature and return length v2 relies on, so a renamed function, a
/// changed return shape or a new caller check in v1 fails here. These are pins: green on today's v1 (the final
/// R1 candidate, F111, main 32f5f835), red only if v1 moves. CQ8-F4 keeps these v1 connection rules unchanged.
/// Osaka for the drand round the stream test verifies (EIP-2537).
/// forge-config: default.evm_version = "osaka"
contract V1ConnectionTest is BoxDrandVectors {
    using PoolIdLibrary for PoolKey;

    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";

    CoreBox0Kit internal kit;
    CoreBoxAddresses internal a;
    V1Caller internal caller;
    IDrandSource internal src;
    uint256 internal r0;
    address internal keeper = makeAddr("v1freeze.keeper");

    function setUp() public {
        _loadBoxDrand();
        r0 = _localFirst();
        kit = new CoreBox0Kit();
        kit.setUpWorld();
        // Rounds are posted on the DrandSource; box 0 reads them through its BoxBackedSource (F143).
        src = IDrandSource(address(kit.drand()));
        vm.warp(src.roundTime(r0) - 1 days);
        BoxSpecV1.BoxSpec memory s =
            abi.decode(vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.raise = BoxSpecV1.qListV1()[0].raisePresets[0];
        kit.build(s);
        a = kit.addresses();
        caller = new V1Caller(IPoolManager(a.poolManager));
    }

    /// FIT's executor takes ETH from any contract through `fundBudget()` and a call with value and gas, before box 0
    /// graduates and after: all of it into the buy-back budget, the sender named (how v2's converters, the platform cap
    /// and a failed box's FIT share pay FIT, `FitBuybackExecutor.sol:208-215`). Never `transfer` or `send`: `receive()`
    /// writes storage, so 2,300 gas is refused.
    function test_freeze_fitsExecutorTakesEthFromAnyContract() public {
        _fundExecutorFromAContract();
        kit.toGraduated();
        _fundExecutorFromAContract();
    }

    /// A contract buys FIT with ETH in box 0's pool in graduate()'s own block, through its own unlock, and sells half
    /// back: the trade v2's converters make (FIT conversions), with no router, list or caller check.
    function test_freeze_aContractTradesFitInBox0sPoolRightAfterGraduate() public {
        kit.toClosed();
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        PoolKey memory key = kit.poolKey();
        assertEq(PoolId.unwrap(key.toId()), PoolId.unwrap(BoxHook(a.hook).poolId()), "box 0's own pool");
        uint256 ethIn = kit.eth(0.1 ether);
        vm.deal(address(caller), ethIn);
        uint256 fitOut = caller.swap(key, true, ethIn);
        assertGt(fitOut, 0, "FIT bought");
        assertEq(BoxToken(a.token).balanceOf(address(caller)), fitOut, "to the contract itself");
        assertEq(address(caller).balance, 0, "all its ETH spent");
        uint256 ethOut = caller.swap(key, false, fitOut / 2);
        assertGt(ethOut, 0, "FIT sold back");
        assertEq(address(caller).balance, ethOut);
        assertEq(BoxToken(a.token).balanceOf(address(caller)), fitOut - fitOut / 2);
    }

    /// A contract burns FIT it holds (`burn(uint256)`, open to any holder above the vault's floor): supply and its
    /// balance fall by exactly the amount.
    function test_freeze_aContractBurnsItsOwnFit() public {
        kit.toGraduated();
        vm.deal(address(caller), kit.eth(0.1 ether));
        uint256 fit = caller.swap(kit.poolKey(), true, kit.eth(0.1 ether));
        uint256 supply = BoxToken(a.token).totalSupply();
        caller.run(a.token, 0, abi.encodeWithSignature("burn(uint256)", fit / 3));
        assertEq(BoxToken(a.token).totalSupply(), supply - fit / 3, "supply");
        assertEq(BoxToken(a.token).balanceOf(address(caller)), fit - fit / 3, "its balance");
    }

    /// A contract's FIT burn that would take supply below box 0's floor (the vault's `supplyFloor()`, E + n) reverts
    /// `BurnBelowSupplyFloor(supplyAfter, floor)` and leaves its balance and supply (M1-31: a failed box's refused burn
    /// becomes a `FIT_OWED` deposit); a burn to exactly the floor passes. No v1 path gives one holder that much FIT, so
    /// the contract's balance is written into the token's storage.
    function test_freeze_aContractsFitBurnBelowBox0sFloorIsRefused() public {
        kit.toGraduated();
        uint256 floor = abi.decode(_read(a.vault, abi.encodeWithSignature("supplyFloor()"), 32), (uint256));
        uint256 supply = BoxToken(a.token).totalSupply();
        assertGt(floor, 0, "items inside back the floor");
        deal(a.token, address(caller), supply);
        uint256 over = supply - floor + 1;
        vm.expectRevert(abi.encodeWithSelector(IBoxToken.BurnBelowSupplyFloor.selector, floor - 1, floor));
        caller.run(a.token, 0, abi.encodeWithSignature("burn(uint256)", over));
        assertEq(BoxToken(a.token).balanceOf(address(caller)), supply, "its balance kept");
        assertEq(BoxToken(a.token).totalSupply(), supply, "supply kept");
        caller.run(a.token, 0, abi.encodeWithSignature("burn(uint256)", over - 1));
        assertEq(BoxToken(a.token).totalSupply(), floor, "down to the floor");
    }

    /// Box 0's `fundDepth()` takes a contract's ETH (gifts to box 0 go only into its pool depth, F90 R16E): before
    /// graduation it is held as the receiver's ETH claims, after it the hook's (box 0's pool depth).
    function test_freeze_box0FundDepthTakesAContractsEth() public {
        _giftDepth(a.receiver);
        kit.toGraduated();
        _giftDepth(a.hook);
    }

    /// The views v2 reads (ADR-0017 § 10), each through its exact signature and return length, before and after
    /// graduation: the registry's `boxIdOf` and `coordinatorOf`, the coordinator's `graduated()`, `collection()`,
    /// `executor()`, `token()`, `q()` and `hook()`, FIT's `fitGraduated()` and `twap()`, the hook's `poolId()` and
    /// `priceAverage()` and the token's `initialHolder()`; `twap()` ready an hour after graduation.
    function test_freeze_theViewsV2Reads() public {
        _views(false);
        kit.toGraduated();
        _views(true);
        for (uint256 i; i < 7; ++i) {
            vm.warp(vm.getBlockTimestamp() + 10 minutes);
            vm.roll(vm.getBlockNumber() + 50);
            caller.run(a.executor, 0, abi.encodeWithSignature("poke()"));
        }
        (bool ready,, uint32 window) =
            abi.decode(_read(a.executor, abi.encodeWithSignature("twap()"), 96), (bool, int24, uint32));
        assertTrue(ready, "FIT's 1-hour average ready");
        assertGe(window, BoxSpecV1.EXECUTOR_TWAP_WINDOW_SECONDS, "over at least the hour");
    }

    /// The views the platform cap reads from box 0 (F106, F108; M1-32-b's constructor and `fund()`, FL8, FL9), each
    /// through its exact signature and return length: the receiver's `PLATFORM_CAP_WEI()` (this build's),
    /// `PLATFORM_EPOCH_SECONDS()` (30 days), `platformSafe()`, `executor()` (the coordinator's) and `platformEpoch()`
    /// (three words: epoch 0, nothing kept and the whole cap until box 0's settlement in graduate(); then
    /// ⌊(now − graduatedAt) / 30 days⌋, what the Safe kept in it and what is left, no carry-over), and the
    /// coordinator's `graduatedAt()` (0, then graduate()'s time).
    function test_freeze_theViewsThePlatformCapReads() public {
        address r = a.receiver;
        uint256 cap = BoxSpecV1.PLATFORM_CAP_WEI;
        assertEq(cap, kit.eth(32 ether), "32 ETH, 3.2 in the rehearsal build");
        assertEq(_uint(r, "PLATFORM_CAP_WEI()"), cap, "PLATFORM_CAP_WEI()");
        assertEq(_uint(r, "PLATFORM_EPOCH_SECONDS()"), 30 days, "PLATFORM_EPOCH_SECONDS()");
        assertTrue(a.platform != address(0), "a Safe");
        assertEq(_address(r, "platformSafe()"), a.platform, "platformSafe(): box 0's Safe");
        assertEq(_address(r, "executor()"), _address(a.coordinator, "executor()"), "executor(): the coordinator's");
        _platformEpoch(0, 0, cap);
        kit.toClosed();
        _platformEpoch(0, 0, cap);
        assertEq(_uint(a.coordinator, "graduatedAt()"), 0, "graduatedAt() before graduate()");
        uint256 t = vm.getBlockTimestamp();
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        assertEq(_uint(a.coordinator, "graduatedAt()"), t, "graduatedAt(): graduate()'s time");
        (, uint256 kept,) =
            abi.decode(_read(r, abi.encodeWithSignature("platformEpoch()"), 96), (uint256, uint256, uint256));
        assertGt(kept, 0, "the held share counted in epoch 0");
        _platformEpoch(0, kept, cap - kept);
        vm.warp(t + 30 days - 1);
        _platformEpoch(0, kept, cap - kept);
        vm.warp(t + 30 days);
        _platformEpoch(1, 0, cap);
        vm.warp(t + 95 days);
        _platformEpoch(3, 0, cap);
    }

    /// Anyone (here a contract) calls `poke()` on FIT's executor and on a sampler, as the keeper does every block in
    /// big moves (F91 R17C): the executor records and returns its sample; a sampler's poke is open too and records
    /// nothing unless its hook names it (box 0's names FIT's executor; every other v1 box's names its sampler).
    function test_freeze_anyoneCanPokeFitsExecutorAndASampler() public {
        kit.toGraduated();
        vm.warp(vm.getBlockTimestamp() + 12);
        vm.roll(vm.getBlockNumber() + 1);
        bytes memory ret = caller.run(a.executor, 0, abi.encodeWithSignature("poke()"));
        assertEq(abi.decode(ret, (int24)), FitBuybackExecutor(payable(a.executor)).latestSampleTick(), "recorded");
        BoxPriceSampler implementation = new BoxPriceSampler(IPoolManager(a.poolManager));
        address sampler = makeAddr("v1freeze.sampler");
        vm.etch(sampler, BoxClones.runtime(address(implementation), abi.encodePacked(a.hook, address(0), a.token)));
        ret = caller.run(sampler, 0, abi.encodeWithSignature("poke()"));
        assertEq(abi.decode(ret, (int24)), 0, "the sampler's poke answers");
        assertEq(BoxPriceSampler(sampler).oracle().filled, 0, "and records nothing for a hook that does not name it");
    }

    /// Box 0's item stream pays a contract that owns a Misfit (a v2 vault holding Misfits, M2) through anyone's
    /// `claimFor(account, ids)`, which pays the accrual `pendingOf(id)` shows less one raw unit kept booked to the
    /// account; `pendingOf` names the contract and `token()` is FIT. The contract takes a placeholder on the curve and
    /// opens it after graduation (REVEAL_GRACE, box 0's fixture has no proofs).
    function test_freeze_box0StreamPaysAContractOwnerThroughClaimFor() public {
        BoxTickets tix = BoxTickets(a.tickets);
        kit.toWindow();
        OpenTime.to(BoxHook(a.hook).windowEndsAt());
        kit.buy(address(caller), kit.eth(0.5 ether), 0);
        uint256 placeholder = uint256(tix.status().minted) + 1;
        caller.run(a.token, 0, abi.encodeWithSignature("approve(address,uint256)", a.tickets, type(uint256).max));
        caller.run(a.tickets, 0, abi.encodeCall(BoxTickets.take, (1, type(uint256).max, vm.getBlockTimestamp())));
        kit.buy(makeAddr("v1freeze.closer"), 3 * BoxCoordinator(a.coordinator).raise(), kit.curve().sqrtPriceLowerX96);
        vm.warp(src.roundTime(r0) - 12);
        vm.roll(vm.getBlockNumber() + 1);
        vm.prank(keeper);
        BoxCoordinator(a.coordinator).graduate();
        vm.warp(src.roundTime(r0));
        src.postRound(r0, _localSig(0));
        tix.acceptGraduationWord();
        vm.warp(vm.getBlockTimestamp() + 31 days);
        vm.roll(vm.getBlockNumber() + 31 * 7_200);
        ItemReveal memory none;
        bytes memory opened = caller.run(a.tickets, 0, abi.encodeCall(BoxTickets.open, (placeholder, none)));
        uint256 id = abi.decode(opened, (uint256));
        address trader = makeAddr("v1freeze.trader");
        uint256 t = kit.buy(trader, kit.eth(2 ether), 0);
        kit.sell(trader, t / 2);
        vm.roll(vm.getBlockNumber() + 12);
        BoxReceiver(payable(a.receiver)).collect(keeper);

        address stream = a.itemStream;
        assertEq(abi.decode(_read(stream, abi.encodeWithSignature("token()"), 32), (address)), a.token, "token()");
        (address owner, uint256 pending) =
            abi.decode(_read(stream, abi.encodeWithSignature("pendingOf(uint256)", id), 64), (address, uint256));
        assertEq(owner, address(caller), "pendingOf names the contract");
        assertGt(pending, 0, "its Misfit earned");
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 before = BoxToken(a.token).balanceOf(address(caller));
        vm.prank(makeAddr("v1freeze.stranger"));
        (bool ok, bytes memory ret) =
            stream.call(abi.encodeWithSignature("claimFor(address,uint256[])", address(caller), ids));
        assertTrue(ok && ret.length == 32, "anyone's claimFor");
        uint256 paid = abi.decode(ret, (uint256));
        assertEq(paid, pending - 1, "the accrual, less the one raw unit v1 keeps booked (BoxItemStream._claim)");
        assertEq(BoxItemStream(stream).owedOf(address(caller)), 1, "that unit");
        assertEq(BoxToken(a.token).balanceOf(address(caller)), before + paid, "to the contract itself");
        (, pending) = BoxItemStream(stream).pendingOf(id);
        assertEq(pending, 0, "nothing left on the item");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _fundExecutorFromAContract() internal {
        FitBuybackExecutor x = FitBuybackExecutor(payable(a.executor));
        uint256 v = kit.eth(0.01 ether);
        vm.deal(address(caller), 2 * v);
        (uint256 budget, uint256 total) = (x.budget(), x.totalToBudget());
        vm.expectEmit(true, false, false, true, a.executor);
        emit IFitBuybackExecutor.BudgetFunded(address(caller), v);
        caller.run(a.executor, v, abi.encodeWithSignature("fundBudget()"));
        caller.run(a.executor, v, "");
        vm.deal(address(caller), v);
        assertFalse(caller.sendWithStipend(payable(a.executor), v), "2,300 gas refused");
        assertEq(x.budget(), budget + 2 * v, "the budget");
        assertEq(x.totalToBudget(), total + 2 * v, "the lifetime intake");
    }

    function _giftDepth(address claimsTo) internal {
        IERC6909Claims claims = IERC6909Claims(a.poolManager);
        uint256 v = kit.eth(0.01 ether);
        vm.deal(address(caller), v);
        uint256 before = claims.balanceOf(claimsTo, 0);
        vm.expectEmit(true, false, false, true, a.receiver);
        emit IBoxReceiver.DepthGifted(address(caller), v);
        caller.run(a.receiver, v, abi.encodeWithSignature("fundDepth()"));
        assertEq(claims.balanceOf(claimsTo, 0), before + v, "the ETH claims");
    }

    function _views(bool graduated) internal {
        address registry = kit.impls().registry;
        bytes memory ret = _read(registry, abi.encodeWithSignature("coordinatorOf(uint256)", 0), 32);
        assertEq(abi.decode(ret, (address)), a.coordinator, "coordinatorOf(0)");
        ret = _read(registry, abi.encodeWithSignature("boxIdOf(address)", a.coordinator), 64);
        (bool recorded, uint256 boxId) = abi.decode(ret, (bool, uint256));
        assertTrue(recorded && boxId == 0, "boxIdOf(box 0's coordinator)");
        ret = _read(registry, abi.encodeWithSignature("boxIdOf(address)", address(caller)), 64);
        (recorded, boxId) = abi.decode(ret, (bool, uint256));
        assertFalse(recorded || boxId != 0, "boxIdOf(a stranger)");
        vm.expectRevert(abi.encodeWithSelector(IBoxRegistry.UnknownBox.selector, 1));
        BoxRegistry(registry).coordinatorOf(1);

        address c = a.coordinator;
        assertEq(_bool(c, "graduated()"), graduated, "graduated()");
        assertEq(_address(c, "collection()"), a.collection, "collection()");
        assertEq(_address(c, "executor()"), a.executor, "executor()");
        assertEq(_address(c, "token()"), a.token, "token()");
        assertEq(_address(c, "q()"), address(0), "q(): native ETH");
        assertEq(_address(c, "hook()"), a.hook, "hook()");
        assertEq(_bool(a.executor, "fitGraduated()"), graduated, "fitGraduated()");
        _read(a.executor, abi.encodeWithSignature("twap()"), 96);
        ret = _read(a.hook, abi.encodeWithSignature("poolId()"), 32);
        assertEq(abi.decode(ret, (bytes32)), PoolId.unwrap(kit.poolKey().toId()), "poolId()");
        assertEq(_address(a.hook, "priceAverage()"), a.executor, "priceAverage(): FIT's executor");
        assertEq(_address(a.token, "initialHolder()"), a.coordinator, "initialHolder(): the coordinator");
    }

    function _address(address target, string memory signature) internal view returns (address) {
        return abi.decode(_read(target, abi.encodeWithSignature(signature), 32), (address));
    }

    function _uint(address target, string memory signature) internal view returns (uint256) {
        return abi.decode(_read(target, abi.encodeWithSignature(signature), 32), (uint256));
    }

    /// @dev Box 0's receiver's `platformEpoch()`, three words.
    function _platformEpoch(uint256 epoch, uint256 kept, uint256 remaining) internal view {
        bytes memory ret = _read(a.receiver, abi.encodeWithSignature("platformEpoch()"), 96);
        (uint256 e, uint256 k, uint256 left) = abi.decode(ret, (uint256, uint256, uint256));
        assertEq(e, epoch, "platformEpoch(): the epoch");
        assertEq(k, kept, "platformEpoch(): kept");
        assertEq(left, remaining, "platformEpoch(): remaining");
    }

    function _bool(address target, string memory signature) internal view returns (bool) {
        return abi.decode(_read(target, abi.encodeWithSignature(signature), 32), (bool));
    }

    /// @dev A view by its exact calldata: it answers, with exactly `length` bytes.
    function _read(address target, bytes memory data, uint256 length) internal view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.staticcall(data);
        assertTrue(ok, "the view answers");
        assertEq(ret.length, length, "its return length");
    }
}
