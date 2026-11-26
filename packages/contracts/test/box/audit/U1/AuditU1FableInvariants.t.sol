// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxCollection} from "../../../../src/box/interfaces/IBoxCollection.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {IBoxHook} from "../../../../src/box/interfaces/IBoxHook.sol";
import {IBoxItemStream} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {IBoxLaunchRouter} from "../../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxRegistry} from "../../../../src/box/interfaces/IBoxRegistry.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxVault} from "../../../../src/box/interfaces/IBoxVault.sol";
import {CoreBox0Kit, CoreBoxAddresses, CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditRouterSwapper} from "../common/AuditActors.sol";
import {AuditU1FableTables as T} from "./AuditU1FableTables.sol";
import {AuditU1FableWorld, AuditU1Target} from "./AuditU1FableBase.sol";

/// @notice TEST ONLY (SH-AUDIT-B0 U1, Fable). The fail-safe handler of the creation-and-identity campaign: every call
/// is a low-level call whose failure is recorded, never raised (the default profile fails on a revert). Actions: any
/// entry of any box 0 contract, implementation, the factory, planner or registry from any caller class with random
/// calldata and value (the ghost `tableViolations` counts a write by an undocumented caller); a second `createBox`
/// by anyone or the creator; a `record` by anyone or the factory; a once-only step repeated by its documented caller;
/// ETH forced onto any system address; time (up to a day a call, so the open and the window pass); window buys
/// through the launch router, public buys and sells through the router stand-in; `fundFees`, `fundDepth`,
/// `fundBudget`, `poke`; T approvals.
contract AuditU1FableHandler is CommonBase, StdCheats, StdUtils {
    CoreBox0Kit internal kit;
    IPoolManager internal pm;
    BoxFactoryV1 internal factory;
    BoxRegistry internal registry;
    address internal planner;
    CoreBoxAddresses internal a;
    CoreImpls internal impls;
    AuditRouterSwapper internal swapper;
    PoolKey internal key;
    address[] internal actors;
    address[] internal callers;
    AuditU1Target[] internal targets;
    mapping(address => bool) internal isBox0Storage;
    bytes internal specEncoded;

    // ------------------------------------------------------------------ ghosts (must stay zero)
    uint256 public tableViolations;
    string public firstViolation;
    uint256 public secondCreations;
    uint256 public recordsAccepted;
    uint256 public onceOnlyRepeated;
    uint256 public strangerInitialised;

    // ------------------------------------------------------------------ bookkeeping
    mapping(address => uint256) public forced;
    uint256 public calls;
    uint256 public successes;
    uint256 public writesAllowed;
    uint256 public createAttempts;
    uint256 public buys;
    uint256 public sells;
    uint256 public warps;

    constructor(CoreBox0Kit kit_, AuditRouterSwapper swapper_, address[] memory actors_, bytes memory spec) {
        kit = kit_;
        pm = kit_.pm();
        factory = kit_.factory();
        registry = BoxRegistry(factory.registry());
        planner = address(factory.planner());
        a = kit_.addresses();
        impls = kit_.impls();
        swapper = swapper_;
        key = kit_.poolKey();
        actors = actors_;
        specEncoded = spec;
    }

    function addTarget(AuditU1Target memory t) external {
        targets.push(t);
    }

    function addStorage(address x) external {
        isBox0Storage[x] = true;
    }

    function addCaller(address x) external {
        callers.push(x);
    }

    // ================================================================== any entry, any caller

    function callEntry(uint256 targetSeed, uint256 entrySeed, uint256 callerSeed, bytes calldata tail, uint8 valueSeed)
        external
    {
        uint256 t = targetSeed % targets.length;
        (bytes4 sel, uint8 class) = _pickEntry(t, entrySeed);
        address caller = _pickCaller(callerSeed);
        uint256 value = _pickValue(caller, valueSeed);
        bytes memory data = bytes.concat(sel, tail.length > 256 ? tail[:256] : tail);
        if (value != 0) vm.deal(caller, caller.balance + value);
        vm.startStateDiffRecording();
        vm.prank(caller);
        (bool ok,) = targets[t].at.call{value: value, gas: 3_000_000}(data);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        ++calls;
        if (ok) ++successes;
        if (_box0Writes(acc) == 0) return;
        if (_documented(class, caller)) {
            ++writesAllowed;
            return;
        }
        if (tableViolations == 0) firstViolation = _note(t, sel, caller);
        ++tableViolations;
    }

    function _note(uint256 t, bytes4 sel, address caller) internal view returns (string memory) {
        return string.concat(targets[t].label, " ", vm.toString(sel), " from ", vm.toString(caller));
    }

    /// @dev One call in ten takes a random selector; the rest an entry of the target's table.
    function _pickEntry(uint256 t, uint256 entrySeed) internal view returns (bytes4 sel, uint8 class) {
        AuditU1Target memory target = targets[t];
        if (entrySeed % 10 == 0) {
            return (bytes4(bytes32(entrySeed)), _classOfSelector(target, bytes4(bytes32(entrySeed))));
        }
        (sel, class) = T.entry(target.table, (entrySeed / 10) % T.count(target.table));
        if (target.implementation && class != T.VIEW && class != T.POOL_MANAGER) class = T.NOBODY;
    }

    function _pickCaller(uint256 callerSeed) internal view returns (address caller) {
        caller = callerSeed % 8 == 0 ? address(uint160(callerSeed)) : callers[callerSeed % callers.length];
        if (caller == address(0) || caller == address(vm) || caller == address(this)) caller = actors[0];
    }

    /// @dev 0, 1 wei, 0.01 or 1 ETH; the accounts whose balances an invariant pins never get value as callers.
    function _pickValue(address caller, uint8 valueSeed) internal view returns (uint256 value) {
        value = valueSeed % 4 == 0 ? 0 : valueSeed % 4 == 1 ? 1 : valueSeed % 4 == 2 ? 0.01 ether : 1 ether;
        if (_pinnedBalance(caller)) value = 0;
    }

    function _pinnedBalance(address x) internal view returns (bool) {
        return x == address(factory) || x == planner || x == address(registry) || x == a.coordinator;
    }

    function _classOfSelector(AuditU1Target memory target, bytes4 sel) internal pure returns (uint8) {
        uint256 n = T.count(target.table);
        for (uint256 j; j < n; ++j) {
            (bytes4 s, uint8 class) = T.entry(target.table, j);
            if (s == sel) {
                if (target.implementation && class != T.VIEW && class != T.POOL_MANAGER) return T.NOBODY;
                return class;
            }
        }
        return T.VIEW;
    }

    function _box0Writes(VmSafe.AccountAccess[] memory acc) internal view returns (uint256 n) {
        for (uint256 i; i < acc.length; ++i) {
            VmSafe.StorageAccess[] memory s = acc[i].storageAccesses;
            for (uint256 j; j < s.length; ++j) {
                if (!s[j].isWrite || s[j].reverted || s[j].previousValue == s[j].newValue) continue;
                if (isBox0Storage[s[j].account]) ++n;
            }
        }
    }

    function _documented(uint8 class, address caller) internal view returns (bool) {
        if (class == T.ANYONE) return true;
        if (class == T.VIEW || class == T.NOBODY) return false;
        if (class == T.FACTORY) return caller == address(factory);
        if (class == T.COORDINATOR) return caller == a.coordinator;
        if (class == T.POOL_MANAGER) return caller == address(pm);
        if (class == T.RECEIVER) return caller == a.receiver;
        if (class == T.COLLECTION) return caller == a.collection;
        if (class == T.VAULT) return caller == a.vault;
        if (class == T.TICKETS) return caller == a.tickets;
        if (class == T.EXECUTOR_OR_HOOK) return caller == a.executor || caller == a.hook;
        if (class == T.CREATOR) return caller == address(kit);
        return false;
    }

    // ================================================================== creation and the once-only steps

    function tryCreateAgain(uint256 callerSeed, uint32 openAtDelta) external {
        ++createAttempts;
        BoxSpecV1.BoxSpec memory s = abi.decode(specEncoded, (BoxSpecV1.BoxSpec));
        if (openAtDelta % 2 == 1) s.openAt = uint32(block.timestamp + (openAtDelta % 10 days));
        address caller = callerSeed % 3 == 0 ? address(kit) : callers[callerSeed % callers.length];
        if (caller == address(0) || caller == address(vm) || caller == address(this) || _pinnedBalance(caller)) {
            caller = actors[1];
        }
        vm.deal(caller, caller.balance + BoxSpecV1.BOOTSTRAP_ETH);
        vm.prank(caller);
        (bool ok,) = address(factory).call{value: BoxSpecV1.BOOTSTRAP_ETH}(
            abi.encodeCall(IBoxFactoryV1.createBox, (s, kit.hookSalt(), type(FitBuybackExecutor).creationCode))
        );
        if (ok) ++secondCreations;
    }

    function tryRecord(uint256 callerSeed, bytes32 templateId) external {
        address caller = callerSeed % 3 == 0 ? address(factory) : callers[callerSeed % callers.length];
        if (caller == address(0) || caller == address(vm) || caller == address(this)) caller = actors[1];
        vm.prank(caller);
        (bool ok,) =
            address(registry).call(abi.encodeCall(IBoxRegistry.record, (a.coordinator, templateId, specEncoded)));
        if (ok) ++recordsAccepted;
    }

    function tryOnceOnly(uint8 which) external {
        bool ok;
        uint256 w = which % 10;
        if (w == 0) {
            vm.prank(address(factory));
            (ok,) = a.coordinator.call(abi.encodeCall(BoxCoordinator.deploy, (new bytes[](0), "", bytes32(0), 0)));
        } else if (w == 1) {
            vm.prank(address(factory));
            (ok,) = a.coordinator.call(abi.encodeCall(BoxCoordinator.launch, ()));
        } else {
            address[8] memory clones =
                [a.hook, a.launchRouter, a.receiver, a.collection, a.vault, a.tickets, a.itemStream, a.hook];
            bytes memory data = w == 9 ? abi.encodeCall(IBoxHook.launch, ()) : abi.encodeWithSignature("initialize()");
            vm.prank(a.coordinator);
            (ok,) = clones[w - 2].call(data);
        }
        if (ok) ++onceOnlyRepeated;
    }

    // ================================================================== ETH, time, trading, intake

    function forceEth(uint8 targetSeed, uint96 amount) external {
        address[15] memory list = [
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.executor,
            a.tickets,
            a.vault,
            a.collection,
            a.itemStream,
            a.royaltyRouter,
            a.table,
            a.token,
            address(factory),
            address(registry),
            planner
        ];
        address target = list[targetSeed % 15];
        uint256 v = bound(uint256(amount), 1, 10 ether);
        vm.deal(target, target.balance + v);
        forced[target] += v;
    }

    function warp(uint32 seconds_) external {
        uint256 s = bound(uint256(seconds_), 12, 1 days);
        vm.roll(block.number + (s + 11) / 12);
        vm.warp(block.timestamp + s);
        ++warps;
    }

    function windowBuy(uint8 who, uint96 amount) external {
        address buyer = actors[who % actors.length];
        uint256 v = bound(uint256(amount), 0.001 ether, 2 ether);
        vm.deal(buyer, buyer.balance + v);
        vm.prank(buyer);
        (bool ok,) = a.launchRouter.call{value: v}(abi.encodeCall(IBoxLaunchRouter.buy, (v, 0, buyer, block.timestamp)));
        if (ok) ++buys;
    }

    function publicBuy(uint8 who, uint96 amount) external {
        address buyer = actors[who % actors.length];
        uint256 v = bound(uint256(amount), 0.001 ether, 2 ether);
        vm.deal(buyer, buyer.balance + v);
        SwapParams memory p =
            SwapParams({zeroForOne: true, amountSpecified: -int256(v), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1});
        vm.prank(buyer);
        (bool ok,) = address(swapper).call{value: v}(abi.encodeCall(AuditRouterSwapper.swapOne, (key, p, "", buyer)));
        if (ok) ++buys;
    }

    function publicSell(uint8 who, uint8 share) external {
        address seller = actors[who % actors.length];
        uint256 bal = BoxToken(a.token).balanceOf(seller);
        if (bal == 0) return;
        uint256 v = bal * (uint256(share % 100) + 1) / 100;
        vm.prank(seller);
        BoxToken(a.token).approve(address(swapper), type(uint256).max);
        SwapParams memory p = SwapParams({
            zeroForOne: false, amountSpecified: -int256(v), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
        });
        vm.prank(seller);
        (bool ok,) = address(swapper).call(abi.encodeCall(AuditRouterSwapper.swapOne, (key, p, "", seller)));
        if (ok) ++sells;
    }

    function fund(uint8 who, uint8 which, uint96 amount) external {
        address payer = actors[who % actors.length];
        uint256 v = bound(uint256(amount), 1, 5 ether);
        vm.deal(payer, payer.balance + v);
        address target = which % 3 == 0 ? a.receiver : which % 3 == 1 ? a.receiver : a.executor;
        bytes memory data = which % 3 == 0
            ? abi.encodeCall(IBoxReceiver.fundFees, ())
            : which % 3 == 1 ? abi.encodeCall(IBoxReceiver.fundDepth, ()) : abi.encodeWithSignature("fundBudget()");
        vm.prank(payer);
        (bool ok,) = target.call{value: v}(data);
        if (ok) ++successes;
    }

    function poke() external {
        (bool ok,) = a.executor.call(abi.encodeWithSignature("poke()"));
        if (ok) ++successes;
    }
}

/// @notice SH-AUDIT-B0 U1 (Fable), the invariant campaign of creation and identity: under random calls from random
/// callers (undocumented ones included), second creations, repeated once-only steps, forced ETH, time, trades and
/// intake, box 0's identity never moves: the registry's record (and its hash rebuilt from the chain), the fixed
/// addresses and every wiring getter, every contract's code, the implementations' inert markers; no second box, no
/// second record, no once-only step repeats, no undocumented caller writes anything; the factory, planner and
/// registry hold only what was forced onto them; T's supply identity holds.
/// forge-config: default.evm_version = "osaka"
contract AuditU1FableInvariants is AuditU1FableWorld {
    AuditU1FableHandler internal handler;

    bytes32 internal recordHash0;
    bytes32 internal templateId0;
    bytes32 internal specHash0;
    uint256 internal creationBlock0;
    mapping(address => bytes32) internal codeHash0;
    mapping(address => bytes32) internal implSlot0;
    bytes32 internal wiring0;

    function setUp() public override {
        super.setUp();
        _makeStrangerClones();
        address[] memory actors = new address[](6);
        actors[0] = eoa[0];
        actors[1] = eoa[1];
        actors[2] = eoa[2];
        actors[3] = eoa[3];
        actors[4] = address(contractDrawer);
        actors[5] = eoa7702;
        handler = new AuditU1FableHandler(kit, routerSwapper, actors, abi.encode(_worldSpec()));
        for (uint256 i; i < targets.length; ++i) {
            handler.addTarget(targets[i]);
        }
        for (uint256 i; i < box0Storage.length; ++i) {
            handler.addStorage(box0Storage[i]);
        }
        address[11] memory list = _implList();
        for (uint256 i; i < list.length; ++i) {
            handler.addCaller(list[i]);
            handler.addCaller(strangerClones[i]);
        }
        address[14] memory more = [
            eoa[4],
            eoa[5],
            address(contractDrawer),
            eoa7702,
            address(pm),
            a.coordinator,
            address(factory),
            a.receiver,
            a.vault,
            a.collection,
            a.tickets,
            a.executor,
            a.hook,
            address(kit)
        ];
        for (uint256 i; i < more.length; ++i) {
            handler.addCaller(more[i]);
        }
        (, creationBlock0, templateId0, specHash0, recordHash0) = registry.entry(0);
        for (uint256 i; i < box0Storage.length; ++i) {
            codeHash0[box0Storage[i]] = box0Storage[i].codehash;
        }
        for (uint256 i; i < list.length; ++i) {
            implSlot0[list[i]] = vm.load(list[i], bytes32(0));
        }
        wiring0 = _wiring();
        targetContract(address(handler));
        // The campaign drives the actions only, never the handler's own setup entries.
        bytes4[] memory selectors = new bytes4[](11);
        selectors[0] = AuditU1FableHandler.callEntry.selector;
        selectors[1] = AuditU1FableHandler.tryCreateAgain.selector;
        selectors[2] = AuditU1FableHandler.tryRecord.selector;
        selectors[3] = AuditU1FableHandler.tryOnceOnly.selector;
        selectors[4] = AuditU1FableHandler.forceEth.selector;
        selectors[5] = AuditU1FableHandler.warp.selector;
        selectors[6] = AuditU1FableHandler.windowBuy.selector;
        selectors[7] = AuditU1FableHandler.publicBuy.selector;
        selectors[8] = AuditU1FableHandler.publicSell.selector;
        selectors[9] = AuditU1FableHandler.fund.selector;
        selectors[10] = AuditU1FableHandler.poke.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @dev Every wiring getter of box 0 in one hash.
    function _wiring() internal view returns (bytes32) {
        bytes32 h = keccak256(abi.encode(factory.box0Addresses()));
        h = keccak256(
            abi.encode(
                h,
                coordinator.token(),
                coordinator.vault(),
                coordinator.collection(),
                coordinator.receiver(),
                coordinator.launchRouter(),
                coordinator.tickets(),
                coordinator.royaltyRouter()
            )
        );
        h = keccak256(
            abi.encode(
                h,
                coordinator.itemStream(),
                coordinator.executor(),
                coordinator.randomness(),
                coordinator.hook(),
                coordinator.creator(),
                coordinator.specHash(),
                coordinator.boxId()
            )
        );
        h = keccak256(
            abi.encode(
                h,
                hook.coordinator(),
                hook.token(),
                hook.receiver(),
                address(hook.priceAverage()),
                hook.openAt(),
                hook.deployBlock(),
                launchRouter.hook()
            )
        );
        h = keccak256(
            abi.encode(
                h,
                launchRouter.coordinator(),
                launchRouter.openAt(),
                receiver.executor(),
                receiver.platformSafe(),
                receiver.itemStream(),
                vault.ticketAdapter(),
                vault.observer()
            )
        );
        h = keccak256(
            abi.encode(
                h,
                collection.transferObserver(),
                collection.metadataTable(),
                tickets.source(),
                tickets.openAt(),
                stream.hook(),
                royaltyRouter.receiver()
            )
        );
        return h;
    }

    function invariant_AUDIT_U1_registryRecordIsFixed() public view {
        assertEq(registry.boxCount(), 1, "one box");
        (address c, uint256 creation, bytes32 templateId, bytes32 specHash, bytes32 recordHash) = registry.entry(0);
        assertEq(c, a.coordinator);
        assertEq(creation, creationBlock0);
        assertEq(templateId, templateId0);
        assertEq(specHash, specHash0);
        assertEq(recordHash, recordHash0);
        assertEq(keccak256(abi.encode(registry.recordOf(0))), recordHash0, "rebuilt from the chain");
        (bool recorded, uint256 id) = registry.boxIdOf(a.coordinator);
        assertTrue(recorded && id == 0);
    }

    function invariant_AUDIT_U1_addressesAndWiringAreFixed() public view {
        assertEq(_wiring(), wiring0, "a wiring getter moved");
    }

    function invariant_AUDIT_U1_codeIsImmutable() public view {
        for (uint256 i; i < box0Storage.length; ++i) {
            assertEq(box0Storage[i].codehash, codeHash0[box0Storage[i]], "code changed");
        }
    }

    function invariant_AUDIT_U1_noSecondBoxNoSecondRecordNoRepeat() public view {
        assertEq(handler.secondCreations(), 0, "a second createBox succeeded");
        assertEq(handler.recordsAccepted(), 0, "a second record was accepted");
        assertEq(handler.onceOnlyRepeated(), 0, "a once-only step ran again");
        // Not the nonces: Foundry bumps a pranked sender's nonce for every call the handler pranks from it (seen in
        // this unit's probe: 12 -> 13 after one reverting pranked call). No code at the next CREATE addresses is the
        // property.
        assertEq(vm.computeCreateAddress(address(factory), 3).code.length, 0, "the factory created nothing more");
        for (uint256 n = 11; n < 16; ++n) {
            assertEq(vm.computeCreateAddress(a.coordinator, n).code.length, 0, "the coordinator created nothing more");
        }
    }

    function invariant_AUDIT_U1_undocumentedCallersWriteNothing() public view {
        assertEq(handler.tableViolations(), 0, handler.firstViolation());
    }

    function invariant_AUDIT_U1_implementationsStayInert() public view {
        address[11] memory list = _implList();
        for (uint256 i; i < list.length; ++i) {
            assertEq(vm.load(list[i], bytes32(0)), implSlot0[list[i]], "an implementation's marker changed");
        }
    }

    function invariant_AUDIT_U1_factoryPlannerRegistryHoldOnlyForcedEth() public view {
        assertEq(address(factory).balance, handler.forced(address(factory)), "factory");
        assertEq(address(planner).balance, handler.forced(address(planner)), "planner");
        assertEq(address(registry).balance, handler.forced(address(registry)), "registry");
        assertEq(a.coordinator.balance, handler.forced(a.coordinator), "the coordinator holds no ETH but forced");
    }

    function invariant_AUDIT_U1_supplyIdentity() public view {
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE, "supply + burned == issuance");
        assertEq(token.initialHolder(), a.coordinator);
        assertEq(token.vault(), a.vault);
    }

    function afterInvariant() external {
        emit log_named_uint("U1|invariant|handler calls", handler.calls());
        emit log_named_uint("U1|invariant|calls that succeeded", handler.successes());
        emit log_named_uint("U1|invariant|documented or permissionless writes", handler.writesAllowed());
        emit log_named_uint("U1|invariant|createBox attempts", handler.createAttempts());
        emit log_named_uint("U1|invariant|buys", handler.buys());
        emit log_named_uint("U1|invariant|sells", handler.sells());
        emit log_named_uint("U1|invariant|warps", handler.warps());
    }
}
