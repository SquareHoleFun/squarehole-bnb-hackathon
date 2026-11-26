// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {CustomRevert} from "v4-core/src/libraries/CustomRevert.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1} from "../../../../src/box/BoxFactoryV1.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {DeepenSkip, DepthKind, FeeBatch, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {BackedSourcePins} from "../../../../src/box/randomness/BackedSourcePins.sol";
import {BoxBackedSource} from "../../../../src/box/randomness/BoxBackedSource.sol";
import {DrandSource} from "../../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../../src/box/randomness/DrandSourcePins.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {HeaderVectors} from "../../backup/HeaderVectors.sol";
import {History2935} from "../../backup/History2935.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {BoxDrandVectors} from "../../randomness/utils/BoxDrandVectors.sol";
import {OpenTime} from "../../utils/OpenTime.sol";
import {AuditActor, AuditRouterSwapper} from "./AuditActors.sol";
import {AuditGhostLedger, EthIn, EthOut, TIn, TOut} from "./AuditGhostLedger.sol";
import {AuditHeaders} from "./AuditHeaders.sol";
import {AuditRevealSet} from "./AuditRevealSet.sol";

/// @notice Where box 0's ETH sits (plan § 3.1 X01's places), read from the chain.
struct AuditEthPlaces {
    /// The PoolManager's ETH: box 0's pool reserves plus every ERC-6909 ETH claim (box 0's pool is its only pool here).
    uint256 poolManager;
    /// ERC-6909 ETH claims (id 0) of the receiver (ledgers and the next batch), the hook (depth budget) and the
    /// coordinator (D6 reserve, then the credited reward).
    uint256 receiverClaims;
    uint256 hookClaims;
    uint256 coordinatorClaims;
    /// Plain ETH balances: the launch router (unswept tax and forced ETH), FIT's executor (budget), the DrandSource
    /// (pots and posters' credits) and every other system address (zero between calls unless forced).
    uint256 launchRouter;
    uint256 executor;
    uint256 drand;
    uint256 others;
}

/// @title AuditBox0World
/// @notice TEST ONLY (SH-AUDIT-B0 R0-A, box0-audit plan § 3.3). The shared world of box 0's own review: every unit may
/// inherit it (read-only; never edit it from a unit). It is the factory's box 0 as `script/DeployCoreV1.s.sol` builds
/// it (`CoreBox0Kit`, which runs `CoreV1Deployment`'s steps: the implementations, the planner, the pinned DrandSource
/// and BoxBackedSource through a local Arachnid CREATE2 deployer, the factory, then `createBox` with a mined hook
/// salt), on the default (mainnet) build profile, chain id 1, the PoolManager compiled from the pinned source.
/// - **EVM.** The quicknet check needs EIP-2537: every concrete test contract sets `default.evm_version` to `"osaka"`
///   (or `"amsterdam"`) in its own Foundry inline config, as `AuditWorldSmoke.t.sol` does; setUp refuses an EVM
///   without the precompiles (`_requireEip2537`).
/// - **Spec.** `script/config/box0-spec.11155111.safe.json` (box 0's fixture with the Sepolia test set's names, table
///   and generator, the mainnet Safe as `marketplaceOwner`, the mainnet raise) with N = `_auditN()` (1,969, the
///   mainnet edition, F141), `revealRoot` = `AuditRevealSet.root(N)` (so every item can be revealed with public data)
///   and `openAt` one hour after creation (mainnet's is 45 minutes to 14 days ahead). Override `_auditN` or
///   `_auditSpec` for another edition (N 4,269 is exactly the Sepolia test set).
/// - **Clock.** Anchored to `BoxDrandVectors`' 16 consecutive committed quicknet rounds `r0 … r0 + 15` (3 s apart):
///   box 0 is created a day before `r0`'s time (as every box 0 kit does); a request 12 s before `r0`'s time fixes
///   r0 (`AuditPhases` graduates there), and on each following 12-second block a request fixes r0 + 4, r0 + 8,
///   r0 + 12 (all committed), then r0 + 16 and later, which have no committed signature: drand is silent for them
///   and only the backup gives words. Blocks advance 12 s each (`_advance`, OpenTime). The base fee is 1 gwei, so a
///   draw pays its round's 600,000-gas posting pot (0.0006 ETH).
/// - **Actors.** `eoa[0..7]` (keys in `eoaKey`; `keeper` = eoa[6], `poster` = eoa[7]); `contractDrawer` (accepts
///   ETH and ERC-721); `eoa7702`, an EOA with a real EIP-7702 delegation (`vm.signAndAttachDelegation`) to an
///   accepting `AuditActor`; `ethRefuser` (`receive` reverts); `gasBurner` (`receive` uses all gas);
///   `routerSwapper`, the Universal Router stand-in (`AuditRouterSwapper`: any swap parameters through
///   `PoolManager.unlock`). The platform Safe is the spec's address with no code (it accepts ETH as the Safe does);
///   a unit that needs a hostile Safe etches its own code there.
/// - **Ghost ledger** (`AuditGhostLedger`): every helper below books the ETH and T that cross box 0's boundary, by
///   class, on the outside party's side; `_assertGhostLedger` checks system ETH == Σ in − Σ out, outside T == Σ out −
///   Σ in, and that the system and the outside holders hold all of T's supply. A unit that moves ETH or T across the
///   boundary without these helpers books it itself (`_noteEthIn` …) or does not call the check.
/// - **Headers.** `_parentHeader` (the real mainnet header as the previous block's, for `startBackup`), `_mineHeader`
///   (a synthetic post-London header carrying a chosen prevRandao, served by BLOCKHASH within 256 blocks and by
///   EIP-2935's real history code after), `_startBackup`, `_fixBackup`, `_backup`: the helpers of
///   `test/box/backup/CoreBox0BackupBase.sol`.
abstract contract AuditBox0World is BoxDrandVectors, AuditGhostLedger {
    /// @notice The spec file the world starts from (read-only; fs_permissions allow ./script/config).
    string internal constant AUDIT_SPEC_FILE = "/script/config/box0-spec.11155111.safe.json";
    uint256 internal constant AUDIT_OPEN_DELAY = 1 hours;
    uint256 internal constant AUDIT_BASE_FEE = 1 gwei;
    uint256 internal constant SLOT = 12;
    /// @notice What a draw sends: above the 600,000-gas pot at 1 gwei (0.0006 ETH), so the first draw of a round pays
    /// the pot and gets the rest back.
    uint256 internal constant AUDIT_DRAW_VALUE = 0.001 ether;

    // ------------------------------------------------------------------------------------------------ the world
    CoreBox0Kit internal kit;
    CoreBoxAddresses internal a;
    IPoolManager internal pm;
    /// @notice Box 0's source (the pinned BoxBackedSource, F143): requests, words, the backup.
    BoxBackedSource internal src;
    /// @notice The pinned DrandSource the backed source names: rounds are posted here.
    DrandSource internal drand;
    BoxFactoryV1 internal factory;
    PoolKey internal poolKey;
    BoxLayoutV1.Curve internal curve;
    uint256 internal raise;
    /// @notice The edition size N of this world's box 0.
    uint256 internal editionSize;
    /// @notice The first of the 16 consecutive committed quicknet rounds.
    uint256 internal r0;
    uint256 internal createdAt;
    uint256 internal createdAtBlock;

    BoxCoordinator internal coordinator;
    BoxHook internal hook;
    BoxLaunchRouter internal launchRouter;
    BoxReceiver internal receiver;
    FitBuybackExecutor internal executor;
    BoxTickets internal tickets;
    BoxVault internal vault;
    BoxCollection internal collection;
    BoxItemStream internal stream;
    BoxRoyaltyRouter internal royaltyRouter;
    BoxToken internal token;
    address internal safe;

    // ------------------------------------------------------------------------------------------------ actors
    address[8] internal eoa;
    uint256[8] internal eoaKey;
    address internal keeper;
    address internal poster;
    AuditActor internal contractDrawer;
    AuditActor internal ethRefuser;
    AuditActor internal gasBurner;
    /// @notice The code `eoa7702` delegates to (EIP-7702).
    AuditActor internal delegate7702;
    address internal eoa7702;
    uint256 internal eoa7702Key;
    AuditRouterSwapper internal routerSwapper;

    // ================================================================================================ setUp

    function setUp() public virtual {
        _setUpAuditWorld();
    }

    function _setUpAuditWorld() internal {
        _requireEip2537();
        _loadBoxDrand();
        r0 = _localFirst();
        // The kit embeds a whole version: its code deposit stays out of the test's gas budget (as S5M4Base does).
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        pm = kit.pm();
        src = kit.source();
        drand = kit.drand();
        factory = kit.factory();
        assertEq(address(src), BackedSourcePins.ADDRESS_MAINNET, "world: the pinned BoxBackedSource");
        assertEq(address(drand), DrandSourcePins.ADDRESS_MAINNET, "world: the pinned DrandSource");
        assertEq(address(src.DRAND()), address(drand), "world: the backed source names the DrandSource");

        vm.warp(src.roundTime(r0) - 1 days);
        vm.fee(AUDIT_BASE_FEE);
        _makeActors();

        BoxSpecV1.BoxSpec memory s = _auditSpec();
        editionSize = s.n;
        raise = s.raise;
        kit.prepare(s);
        createdAt = vm.getBlockTimestamp();
        createdAtBlock = vm.getBlockNumber();
        kit.create();
        a = kit.addresses();
        poolKey = kit.poolKey();
        curve = kit.curve();
        coordinator = BoxCoordinator(a.coordinator);
        hook = BoxHook(a.hook);
        launchRouter = BoxLaunchRouter(payable(a.launchRouter));
        receiver = BoxReceiver(payable(a.receiver));
        executor = FitBuybackExecutor(payable(a.executor));
        tickets = BoxTickets(a.tickets);
        vault = BoxVault(a.vault);
        collection = BoxCollection(a.collection);
        stream = BoxItemStream(a.itemStream);
        royaltyRouter = BoxRoyaltyRouter(payable(a.royaltyRouter));
        token = BoxToken(a.token);
        safe = a.platform;

        assertEq(coordinator.raise(), BoxBuildV1.RAISE, "world: the mainnet build's raise");
        assertEq(safe, BoxSpecV1.PLATFORM_SAFE_MAINNET, "world: the mainnet platform Safe");
        assertEq(collection.collectionSize(), editionSize, "world: N");
        assertEq(collection.revealRoot(), s.revealRoot, "world: the reveal root");
        assertEq(tickets.source(), address(src), "world: box 0's tickets read the backed source");
        assertEq(hook.openAt(), s.openAt, "world: openAt");
        _labelWorld();
        _bookWorld();
        _assertGhostLedger();
    }

    /// @notice The spec of this world's box 0 (see the contract's NatSpec); called once, at the creation time.
    function _auditSpec() internal view virtual returns (BoxSpecV1.BoxSpec memory s) {
        s = abi.decode(
            vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), AUDIT_SPEC_FILE)), ".encoded"),
            (BoxSpecV1.BoxSpec)
        );
        uint256 size = _auditN();
        // casting to 'uint32' is safe because N ≤ 10,000 (AuditRevealSet.MAX_N)
        // forge-lint: disable-next-line(unsafe-typecast)
        s.n = uint32(size);
        s.revealRoot = AuditRevealSet.root(size);
        // forge-lint: disable-next-line(unsafe-typecast)
        s.openAt = uint32(vm.getBlockTimestamp() + AUDIT_OPEN_DELAY);
    }

    /// @notice The edition size: the mainnet edition's 1,969 (F141) unless a unit overrides it.
    function _auditN() internal view virtual returns (uint256) {
        return 1_969;
    }

    function _requireEip2537() internal view {
        // BLS12_G1ADD of two points at infinity answers 128 bytes from Prague on; without the precompile, nothing.
        (bool ok, bytes memory ret) = address(0x0b).staticcall(new bytes(256));
        require(
            ok && ret.length == 128,
            "AuditBox0World: no EIP-2537 here; set default.evm_version = \"osaka\" in the test contract's inline config"
        );
    }

    function _makeActors() internal {
        for (uint256 i; i < 8; ++i) {
            (eoa[i], eoaKey[i]) = makeAddrAndKey(string.concat("audit.eoa.", vm.toString(i)));
        }
        keeper = eoa[6];
        poster = eoa[7];
        contractDrawer = new AuditActor(address(this), AuditActor.EthMode.Accept);
        ethRefuser = new AuditActor(address(this), AuditActor.EthMode.Refuse);
        gasBurner = new AuditActor(address(this), AuditActor.EthMode.BurnAllGas);
        delegate7702 = new AuditActor(address(this), AuditActor.EthMode.Accept);
        routerSwapper = new AuditRouterSwapper(pm);
        (eoa7702, eoa7702Key) = makeAddrAndKey("audit.eoa7702");
        // A real EIP-7702 authorization (chain id 1, nonce 0), applied by the next call.
        vm.signAndAttachDelegation(address(delegate7702), eoa7702Key);
        (bool ok,) = eoa7702.call("");
        require(ok, "world: the 7702 authorization's call");
        require(
            eoa7702.code.length == 23 && bytes3(eoa7702.code) == bytes3(hex"ef0100"),
            "world: eoa7702 carries a delegation designator"
        );
    }

    function _labelWorld() internal {
        vm.label(address(contractDrawer), "audit.contractDrawer");
        vm.label(address(ethRefuser), "audit.ethRefuser");
        vm.label(address(gasBurner), "audit.gasBurner");
        vm.label(address(delegate7702), "audit.delegate7702");
        vm.label(address(routerSwapper), "audit.routerSwapper");
        vm.label(a.coordinator, "box0.coordinator");
        vm.label(a.hook, "box0.hook");
        vm.label(a.launchRouter, "box0.launchRouter");
        vm.label(a.receiver, "box0.receiver");
        vm.label(a.executor, "box0.executor");
        vm.label(a.tickets, "box0.tickets");
        vm.label(a.vault, "box0.vault");
        vm.label(a.collection, "box0.collection");
        vm.label(a.itemStream, "box0.stream");
        vm.label(a.royaltyRouter, "box0.royaltyRouter");
        vm.label(a.token, "box0.T");
        vm.label(address(src), "box0.backedSource");
        vm.label(address(drand), "drandSource");
        vm.label(safe, "platformSafe");
    }

    /// @dev The ghost ledger's places, and the creation's bootstrap (createBox's value, from the kit).
    function _bookWorld() internal {
        _ghostToken = a.token;
        _ghostWeth = a.weth;
        address[17] memory sys = [
            address(pm),
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
            address(drand),
            address(src),
            address(factory),
            address(factory.registry())
        ];
        for (uint256 i; i < sys.length; ++i) {
            _ghostAddSystem(sys[i]);
        }
        for (uint256 i; i < 8; ++i) {
            _ghostAddOutside(eoa[i]);
        }
        _ghostAddOutside(eoa7702);
        _ghostAddOutside(address(contractDrawer));
        _ghostAddOutside(address(ethRefuser));
        _ghostAddOutside(address(gasBurner));
        _ghostAddOutside(address(delegate7702));
        _ghostAddOutside(address(routerSwapper));
        _ghostAddOutside(address(kit));
        _ghostAddOutside(safe);
        _ghostAddOutside(address(this));
        _noteEthIn(EthIn.Bootstrap, BoxSpecV1.BOOTSTRAP_ETH);
    }

    // ================================================================================================ ghost checks

    /// @notice The ghost ledger holds: system ETH == Σ in − Σ out; outside T == Σ out − Σ in; every unit of T's supply
    /// is in the system or with an outside holder; supply + burned == the issuance.
    function _assertGhostLedger() internal view {
        (, uint256 heldEth, uint256 inEth, uint256 outEth) = _ghostEthBalanced();
        assertEq(heldEth + outEth, inEth, "ghost: system ETH + booked out == booked in");
        (, uint256 heldT, uint256 inT, uint256 outT) = _ghostTBalanced();
        assertEq(heldT + inT, outT, "ghost: outside T + booked in == booked out");
        assertEq(_ghostSystemT() + heldT, token.totalSupply(), "ghost: system T + outside T == T's supply");
        assertEq(token.totalSupply() + token.totalBurned(), BoxSpecV1.ISSUANCE, "ghost: supply + burned == issuance");
    }

    /// @notice Where box 0's ETH sits now.
    function _ethPlaces() internal view returns (AuditEthPlaces memory p) {
        p.poolManager = address(pm).balance;
        p.receiverClaims = pm.balanceOf(a.receiver, 0);
        p.hookClaims = pm.balanceOf(a.hook, 0);
        p.coordinatorClaims = pm.balanceOf(a.coordinator, 0);
        p.launchRouter = a.launchRouter.balance;
        p.executor = a.executor.balance;
        p.drand = address(drand).balance;
        p.others = _ghostSystemEth() - p.poolManager - p.launchRouter - p.executor - p.drand;
    }

    // ================================================================================================ time

    /// @notice `blocks` blocks of 12 s each.
    function _advance(uint256 blocks) internal {
        vm.roll(vm.getBlockNumber() + blocks);
        vm.warp(vm.getBlockTimestamp() + SLOT * blocks);
    }

    /// @notice Forward to time `t`, one block per started 12 s (never back).
    function _warpTo(uint256 t) internal {
        OpenTime.to(t);
    }

    // ================================================================================================ trading

    /// @notice Outside ETH for an actor (not booked: the outside world's ETH is unbounded).
    function _fund(address who, uint256 amount) internal {
        vm.deal(who, who.balance + amount);
    }

    /// @notice A taxed buy through box 0's launch router (`qIn` gross), T to `who`.
    function _windowBuy(address who, uint256 qIn) internal returns (uint256 tOut) {
        _fund(who, qIn);
        uint256 e0 = who.balance;
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        tOut = launchRouter.buy{value: qIn}(qIn, 1, who, deadline);
        _noteEthIn(EthIn.WindowBuy, qIn);
        uint256 e1 = who.balance;
        if (e1 + qIn > e0) _noteEthOut(EthOut.Refund, e1 + qIn - e0);
        _noteTChange(t0, token.balanceOf(who), TIn.Other, TOut.Buy);
    }

    /// @notice Any swap through the Universal Router stand-in, `who` paying (`ethValue` sent; the rest refunded) and
    /// receiving; T owed is pulled from `who` (approved here).
    function _swap(address who, SwapParams memory p, uint256 ethValue) internal returns (BalanceDelta d) {
        if (ethValue != 0) _fund(who, ethValue);
        if (!p.zeroForOne) {
            vm.prank(who);
            token.approve(address(routerSwapper), type(uint256).max);
        }
        uint256 e0 = who.balance;
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        d = routerSwapper.swapOne{value: ethValue}(poolKey, p, "", who);
        _noteEthChange(e0, who.balance, EthIn.SwapIn, EthOut.SwapOut);
        _noteTChange(t0, token.balanceOf(who), TIn.Sell, TOut.Buy);
    }

    /// @notice An exact-input buy of `ethIn` at any price.
    function _buy(address who, uint256 ethIn) internal returns (uint256 tOut) {
        return _buyTo(who, ethIn, TickMath.MIN_SQRT_PRICE + 1);
    }

    /// @notice An exact-input buy of at most `ethIn`, stopping at `limit` (the rest refunded).
    function _buyTo(address who, uint256 ethIn, uint160 limit) internal returns (uint256 tOut) {
        uint256 t0 = token.balanceOf(who);
        _swap(
            who, SwapParams({zeroForOne: true, amountSpecified: _amount(ethIn, true), sqrtPriceLimitX96: limit}), ethIn
        );
        tOut = token.balanceOf(who) - t0;
    }

    /// @notice An exact-output buy of `tOut`, paying at most `ethMax`.
    function _buyExactOut(address who, uint256 tOut, uint256 ethMax) internal returns (uint256 ethIn) {
        uint256 e0 = who.balance + ethMax;
        uint160 limit = TickMath.MIN_SQRT_PRICE + 1;
        _swap(
            who, SwapParams({zeroForOne: true, amountSpecified: _amount(tOut, false), sqrtPriceLimitX96: limit}), ethMax
        );
        ethIn = e0 - who.balance;
    }

    /// @notice An exact-input sell of `tIn` at any price.
    function _sell(address who, uint256 tIn) internal returns (uint256 ethOut) {
        uint256 e0 = who.balance;
        uint160 limit = TickMath.MAX_SQRT_PRICE - 1;
        _swap(who, SwapParams({zeroForOne: false, amountSpecified: _amount(tIn, true), sqrtPriceLimitX96: limit}), 0);
        ethOut = who.balance - e0;
    }

    /// @notice An exact-output sell for `ethOut`.
    function _sellExactOut(address who, uint256 ethOut) internal returns (uint256 tIn) {
        uint256 t0 = token.balanceOf(who);
        uint160 limit = TickMath.MAX_SQRT_PRICE - 1;
        _swap(
            who, SwapParams({zeroForOne: false, amountSpecified: _amount(ethOut, false), sqrtPriceLimitX96: limit}), 0
        );
        tIn = t0 - token.balanceOf(who);
    }

    /// @notice The revert data a swap or other PoolManager call carries when box 0's hook reverts with `reason` in
    /// `callback` (v4 wraps it: `CustomRevert.WrappedError(hook, callback, reason, HookCallFailed())`).
    function _hookRevert(bytes4 callback, bytes memory reason) internal view returns (bytes memory) {
        return abi.encodeWithSelector(
            CustomRevert.WrappedError.selector,
            a.hook,
            callback,
            reason,
            abi.encodeWithSelector(Hooks.HookCallFailed.selector)
        );
    }

    /// @notice v4's `amountSpecified`: negative for an exact input, positive for an exact output.
    function _amount(uint256 x, bool exactInput) internal pure returns (int256 amount) {
        // casting to 'int256' is safe because every amount here is far below 2^255
        // forge-lint: disable-next-line(unsafe-typecast)
        amount = int256(x);
        if (exactInput) amount = -amount;
    }

    // ================================================================================================ ETH intake

    function _fundFees(address who, uint256 amount) internal {
        _fund(who, amount);
        uint256 e0 = who.balance;
        vm.prank(who);
        receiver.fundFees{value: amount}();
        _noteEthChange(e0, who.balance, EthIn.FundFees, EthOut.Other);
    }

    function _fundDepth(address who, uint256 amount) internal {
        _fund(who, amount);
        uint256 e0 = who.balance;
        vm.prank(who);
        receiver.fundDepth{value: amount}();
        _noteEthChange(e0, who.balance, EthIn.FundDepth, EthOut.Other);
    }

    function _fundBudget(address who, uint256 amount) internal {
        _fund(who, amount);
        uint256 e0 = who.balance;
        vm.prank(who);
        executor.fundBudget{value: amount}();
        _noteEthChange(e0, who.balance, EthIn.FundBudget, EthOut.Other);
    }

    /// @notice A royalty paid in ETH to the royalty router (ERC-2981's receiver).
    function _payRoyalty(address who, uint256 amount) internal {
        _fund(who, amount);
        uint256 e0 = who.balance;
        vm.prank(who);
        (bool ok,) = a.royaltyRouter.call{value: amount}("");
        require(ok, "world: the royalty router accepts every payment");
        _noteEthChange(e0, who.balance, EthIn.Royalty, EthOut.Other);
    }

    /// @notice A royalty paid in WETH (the world's MockWETH, 1:1) to the royalty router.
    function _payRoyaltyWeth(address who, uint256 amount) internal {
        _fund(who, amount);
        vm.startPrank(who);
        (bool ok,) = a.weth.call{value: amount}(abi.encodeWithSignature("deposit()"));
        require(ok, "world: WETH deposit");
        (ok,) = a.weth.call(abi.encodeWithSignature("transfer(address,uint256)", a.royaltyRouter, amount));
        require(ok, "world: WETH transfer");
        vm.stopPrank();
        _noteEthIn(EthIn.RoyaltyWeth, amount);
    }

    /// @notice ETH forced onto `target` (no code runs), booked when `target` is one of box 0's system addresses.
    function _forceEth(address target, uint256 amount) internal {
        vm.deal(target, target.balance + amount);
        if (_ghostIsSystem[target]) _noteEthIn(EthIn.Forced, amount);
    }

    // ================================================================================================ keepers

    function _collect(address caller, address tipTo) internal returns (FeeBatch memory b) {
        uint256 e0 = tipTo.balance;
        vm.prank(caller);
        b = receiver.collect(tipTo);
        if (!_ghostIsSystem[tipTo]) _noteEthChange(e0, tipTo.balance, EthIn.Other, EthOut.Tip);
    }

    function _payPlatform(address caller) internal returns (uint256 amount) {
        uint256 s0 = safe.balance;
        vm.prank(caller);
        amount = receiver.payPlatform();
        _noteEthChange(s0, safe.balance, EthIn.Other, EthOut.Platform);
    }

    /// @notice `payFit`: the receiver's FIT share into the executor's budget (an inside move: nothing booked).
    function _payFit(address caller) internal returns (uint256 amount) {
        vm.prank(caller);
        amount = receiver.payFit();
    }

    /// @notice `claimReward(to)` as `who`; booked as an exit only when `to` is outside box 0's system (a claim to one
    /// of its own addresses keeps the ETH inside).
    function _claimReward(address who, address to) internal returns (uint256 amount) {
        uint256 e0 = to.balance;
        vm.prank(who);
        amount = coordinator.claimReward(to);
        if (!_ghostIsSystem[to]) _noteEthChange(e0, to.balance, EthIn.Other, EthOut.Reward);
    }

    /// @notice `withdrawBounty(to)` as `who`; booked as an exit only when `to` is outside box 0's system.
    function _withdrawBounty(address who, address payable to) internal returns (uint256 amount) {
        uint256 e0 = to.balance;
        vm.prank(who);
        amount = drand.withdrawBounty(to);
        if (!_ghostIsSystem[to]) _noteEthChange(e0, to.balance, EthIn.Other, EthOut.BountyWithdraw);
    }

    /// @notice `addBounty(round)` by `who` with `value`, on box 0's backed source (`viaBacked`, which forwards it) or
    /// on the DrandSource itself: ETH into the round's pot.
    function _addBounty(address who, uint256 round, uint256 value, bool viaBacked) internal {
        _fund(who, value);
        uint256 e0 = who.balance;
        vm.prank(who);
        if (viaBacked) src.addBounty{value: value}(round);
        else drand.addBounty{value: value}(round);
        _noteEthChange(e0, who.balance, EthIn.Bounty, EthOut.Other);
    }

    /// @notice A direct `request(key)` by `who` (any account may request) with `value` as the round's pot, on the
    /// backed source (`viaBacked`) or the DrandSource; returns the round it fixed.
    function _requestRound(address who, uint256 key, uint256 value, bool viaBacked) internal returns (uint256 round) {
        _fund(who, value);
        uint256 e0 = who.balance;
        vm.prank(who);
        round = viaBacked ? src.request{value: value}(key) : drand.request{value: value}(key);
        _noteEthChange(e0, who.balance, EthIn.Bounty, EthOut.Other);
    }

    /// @notice `requestGraduationWord` by `who` with `value` (reachable only while graduation's own poke of it has
    /// not run: graduate() normally requests the word itself).
    function _requestGraduationWord(address who, uint256 value) internal {
        _fund(who, value);
        uint256 e0 = who.balance;
        vm.prank(who);
        tickets.requestGraduationWord{value: value}();
        _noteEthChange(e0, who.balance, EthIn.WordValue, EthOut.Other);
    }

    function _deepen(address caller, address tipTo)
        internal
        returns (DepthKind kind, DeepenSkip skip, uint256 qAdded, uint256 tAdded, uint256 tip)
    {
        uint256 e0 = tipTo.balance;
        vm.prank(caller);
        (kind, skip, qAdded, tAdded, tip) = hook.deepen(tipTo);
        if (!_ghostIsSystem[tipTo]) _noteEthChange(e0, tipTo.balance, EthIn.Other, EthOut.Tip);
    }

    /// @notice `graduate()` by `caller`; counts the coordinator's `PokeFailed` events.
    function _graduate(address caller) internal returns (uint256 reward, uint256 pokeFailures) {
        vm.recordLogs();
        vm.prank(caller);
        reward = coordinator.graduate();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.coordinator && logs[i].topics[0] == IBoxCoordinator.PokeFailed.selector) {
                ++pokeFailures;
            }
        }
    }

    // ================================================================================================ tickets

    function _approveT(address who, address spender) internal {
        vm.prank(who);
        token.approve(spender, type(uint256).max);
    }

    /// @notice `count` placeholders for `who` on the curve; returns the first token id.
    function _take(address who, uint256 count) internal returns (uint256 firstToken) {
        _approveT(who, a.tickets);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        firstToken = tickets.take(count, type(uint256).max, deadline);
        _noteTChange(t0, token.balanceOf(who), TIn.Take, TOut.Other);
    }

    function _handBack(address who, uint256[] memory tokenIds) internal returns (uint256 principal, uint256 fee) {
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        (principal, fee) = tickets.handBack(tokenIds, 0, deadline);
        _noteTChange(t0, token.balanceOf(who), TIn.Other, TOut.HandBack);
    }

    /// @notice One draw by `who`, `value` sent (the pot's top-up is kept, the rest refunded).
    function _draw(address who, uint256 value) internal returns (uint256 ticketId) {
        _approveT(who, a.tickets);
        _fund(who, value);
        uint256 e0 = who.balance;
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        ticketId = tickets.draw{value: value}(type(uint256).max, deadline);
        _noteEthIn(EthIn.DrawValue, value);
        uint256 e1 = who.balance;
        if (e1 + value > e0) _noteEthOut(EthOut.Refund, e1 + value - e0);
        _noteTChange(t0, token.balanceOf(who), TIn.Draw, TOut.Other);
    }

    function _settle(address caller, uint256 maxCount) internal returns (uint256 settled) {
        vm.prank(caller);
        settled = tickets.settle(maxCount);
    }

    /// @notice Opens placeholder `tokenId` as `who`, with its item's reveal or without one.
    function _open(address who, uint256 tokenId, bool withReveal) internal returns (uint256 item) {
        ItemReveal memory r;
        if (withReveal) r = _reveal(tickets.numberOf(tokenId));
        vm.prank(who);
        item = tickets.open(tokenId, r);
    }

    /// @notice Opens a settled draw as `who` to `to`, with its item's reveal or without one.
    function _openDraw(address who, uint256 ticketId, address to, bool withReveal) internal returns (uint256 item) {
        ItemReveal memory r;
        if (withReveal) r = _reveal(tickets.drawTicket(ticketId).itemId);
        vm.prank(who);
        item = tickets.openDraw(ticketId, to, r);
    }

    function _cancelDraw(address caller, uint256 ticketId) internal returns (uint256 principal) {
        address drawer = tickets.drawTicket(ticketId).drawer;
        uint256 t0 = token.balanceOf(drawer);
        vm.prank(caller);
        principal = tickets.cancelDraw(ticketId);
        _noteTChange(t0, token.balanceOf(drawer), TIn.Other, TOut.Cancel);
    }

    /// @notice Terminal mode's `takeByNumber` of `itemId` (at draw-pool index `poolIndex` when numbered) by `who`, with
    /// its reveal or without one.
    function _takeByNumber(address who, uint256 itemId, uint256 poolIndex, bool withReveal)
        internal
        returns (uint256 principal, uint256 fee)
    {
        _approveT(who, a.tickets);
        ItemReveal memory r;
        if (withReveal) r = _reveal(itemId);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        (principal, fee) = tickets.takeByNumber(itemId, poolIndex, type(uint256).max, deadline, r);
        _noteTChange(t0, token.balanceOf(who), TIn.TakeByNumber, TOut.Other);
    }

    /// @notice The item at draw-pool index `poolIndex` under the stored graduation word (BoxTickets' numbering), and
    /// whether the vault still hides it (a take by number may name it).
    function _poolItem(uint256 poolIndex) internal view returns (uint256 item, bool hidden) {
        (uint256 u, uint256 v) = BoxShuffle.halves(editionSize);
        item = tickets.firstId()
            + BoxShuffle.permute(tickets.graduationWord(), tickets.poolPositionAt(poolIndex), editionSize, u, v);
        hidden = vault.isHidden(item);
    }

    // ================================================================================================ vault, stream

    /// @notice The vault's named pick of shelf item `id` by `who`.
    function _pick(address who, uint256 id) internal returns (uint256 principal, uint256 fee) {
        _approveT(who, a.vault);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        (principal, fee) = vault.withdraw(id, type(uint256).max, deadline);
        _noteTChange(t0, token.balanceOf(who), TIn.Pick, TOut.Other);
    }

    /// @notice The vault's named pick of several shelf items (`withdrawBatch`) by `who`.
    function _pickBatch(address who, uint256[] memory ids) internal returns (uint256 principal, uint256 fee) {
        _approveT(who, a.vault);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        (principal, fee) = vault.withdrawBatch(ids, type(uint256).max, deadline);
        _noteTChange(t0, token.balanceOf(who), TIn.Pick, TOut.Other);
    }

    function _returnItem(address who, uint256 id) internal returns (uint256 principal, uint256 fee) {
        vm.prank(who);
        collection.setApprovalForAll(a.vault, true);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        (principal, fee) = vault.returnItem(id, 0, deadline);
        _noteTChange(t0, token.balanceOf(who), TIn.Other, TOut.Return);
    }

    /// @notice `returnItems` of several items by `who`.
    function _returnItems(address who, uint256[] memory ids) internal returns (uint256 principal, uint256 fee) {
        vm.prank(who);
        collection.setApprovalForAll(a.vault, true);
        uint256 t0 = token.balanceOf(who);
        uint256 deadline = vm.getBlockTimestamp();
        vm.prank(who);
        (principal, fee) = vault.returnItems(ids, 0, deadline);
        _noteTChange(t0, token.balanceOf(who), TIn.Other, TOut.Return);
    }

    function _claimStream(address who, uint256[] memory ids) internal returns (uint256 paid) {
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        paid = stream.claim(ids, who);
        _noteTChange(t0, token.balanceOf(who), TIn.Other, TOut.StreamClaim);
    }

    /// @notice `claimFor(account, ids)` by `caller`: paid to `account`.
    function _claimStreamFor(address caller, address account, uint256[] memory ids) internal returns (uint256 paid) {
        uint256 t0 = token.balanceOf(account);
        vm.prank(caller);
        paid = stream.claimFor(account, ids);
        _noteTChange(t0, token.balanceOf(account), TIn.Other, TOut.StreamClaim);
    }

    // ================================================================================================ T by holders

    /// @notice A holder's own `burn` of `amount` T.
    function _burnT(address who, uint256 amount) internal {
        uint256 t0 = token.balanceOf(who);
        vm.prank(who);
        token.burn(amount);
        _noteTChange(t0, token.balanceOf(who), TIn.OwnBurn, TOut.Other);
    }

    /// @notice A plain T transfer by `who` to `to`: T in (`Direct`, the accepted M01/M25 class) when `to` is one of box
    /// 0's addresses; between outside holders nothing crosses the boundary. A `to` the ledger does not know is left
    /// unbooked, so the check reports it.
    function _transferT(address who, address to, uint256 amount) internal {
        uint256 b0 = token.balanceOf(who);
        if (to != who && _ghostIsOutside[to]) b0 += token.balanceOf(to);
        vm.prank(who);
        require(token.transfer(to, amount), "world: T transfer");
        uint256 b1 = token.balanceOf(who);
        if (to != who && _ghostIsOutside[to]) b1 += token.balanceOf(to);
        _noteTChange(b0, b1, TIn.Direct, TOut.Other);
    }

    // ================================================================================================ reveals

    /// @notice Item `id`'s reveal (data and proof) in this world's edition.
    function _reveal(uint256 id) internal view returns (ItemReveal memory) {
        return AuditRevealSet.itemReveal(editionSize, id);
    }

    // ================================================================================================ randomness

    /// @notice Whether `round` has a committed quicknet signature (`BoxDrandVectors`).
    function _committed(uint256 round) internal view returns (bool) {
        uint256[] memory rounds = vm.parseJsonUintArray(_boxDrandJson, ".rounds");
        for (uint256 i; i < rounds.length; ++i) {
            if (rounds[i] == round) return true;
        }
        return false;
    }

    /// @notice The time a request must be made at to fix `round` (the source fixes the first round ≥ now + 12 s).
    function _requestTimeFor(uint256 round) internal view returns (uint256) {
        return src.roundTime(round) - drand.MARGIN();
    }

    /// @notice Posts committed `round` on the DrandSource as `poster` (from its time on).
    function _post(uint256 round) internal {
        bytes memory sig = _boxDrand(round).xy;
        vm.prank(poster);
        drand.postRound(round, sig);
    }

    /// @notice The real mainnet header as the previous block's (what `startBackup` proves), returned.
    function _parentHeader() internal returns (bytes memory h) {
        h = HeaderVectors.MAINNET;
        vm.setBlockhash(vm.getBlockNumber() - 1, keccak256(h));
    }

    /// @notice A header of block `number` carrying `mix` as prevRandao, served as the chain would: BLOCKHASH within 256
    /// blocks, EIP-2935's history code (real runtime) after.
    function _mineHeader(uint256 number, bytes32 mix) internal returns (bytes memory h) {
        h = AuditHeaders.header(number, mix);
        uint256 now_ = vm.getBlockNumber();
        if (now_ > number && now_ - number <= 256) vm.setBlockhash(number, keccak256(h));
        History2935.put(vm, number, keccak256(h));
    }

    /// @notice `startBackup(round)` as `who`, proving the previous block's header; returns the target block.
    function _startBackup(uint256 round, address who) internal returns (uint256 target) {
        bytes memory p = _parentHeader();
        uint256 parent = vm.getBlockNumber() - 1;
        vm.prank(who);
        target = src.startBackup(round, parent, p);
    }

    /// @notice `fixBackup(round)` as `who` with a header of the target block carrying `mix`.
    function _fixBackup(uint256 round, bytes32 mix, address who) internal returns (bytes32 fixedMix) {
        (, uint64 target,,) = src.backupOf(round);
        bytes memory h = _mineHeader(target, mix);
        vm.prank(who);
        fixedMix = src.fixBackup(round, h);
    }

    /// @notice Start (as `starter`), 257 blocks on, fix with `mix` (as `poster`).
    function _backup(uint256 round, bytes32 mix, address starter) internal returns (uint256 target) {
        target = _startBackup(round, starter);
        _advance(src.TARGET_BLOCKS() + 1);
        _fixBackup(round, mix, poster);
    }

    /// @notice The word box 0's tickets get for `key` from `value` under `tag` (the backed source's domain separation).
    function _word(bytes32 tag, bytes32 value, uint256 key) internal view returns (bytes32) {
        return keccak256(abi.encode(tag, value, keccak256(abi.encode(a.tickets, key))));
    }

    receive() external payable {}
}
