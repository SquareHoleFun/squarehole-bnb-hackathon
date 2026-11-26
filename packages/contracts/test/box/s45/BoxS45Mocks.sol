// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxLaunchRouter} from "../../../src/box/interfaces/IBoxLaunchRouter.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxSwapModuleWiring} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {ModuleProceedsTo} from "../../../src/box/interfaces/BoxTypes.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

interface IBurnToken {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function burn(uint256) external;
    function transfer(address, uint256) external returns (bool);
}

/// @notice TEST ONLY: the coordinator calls of S6 that lanes S4 and S5 rely on (core-v1-interfaces § 2), exactly:
/// `launch` initialises the hook, router and receiver in that order, launches the pool, runs and burns the bootstrap
/// and the creator buy; `graduate` marks graduated, migrates with its whole T, burns the T dust, credits the D6
/// reserve (the Q claims the hook minted here) to its caller, then pokes the receiver and the executor in try/catch.
contract MockBoxCoordinator {
    IPoolManager public immutable pm;
    IBurnToken public token;
    IBoxHook public hook;
    IBoxLaunchRouter public router;
    IBoxReceiver public receiver;
    address public executor;

    bool public graduated;
    uint256 public graduatedAt;
    uint256 public graduatedAtBlock;
    uint256 public bootstrapTokensBurned;
    uint256 public lastReward;
    mapping(address => uint256) public rewardOf;
    bool public receiverPokeFailed;
    /// @dev When set, `graduate` skips its pokes (a test then measures them alone).
    bool public skipPokes;

    function setSkipPokes(bool skip) external {
        skipPokes = skip;
    }

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function wire(address token_, address hook_, address router_, address receiver_, address executor_) external {
        require(address(hook) == address(0), "wired");
        (token, hook, router, receiver, executor) =
        (IBurnToken(token_), IBoxHook(hook_), IBoxLaunchRouter(router_), IBoxReceiver(payable(receiver_)), executor_);
    }

    /// @dev `msg.value` = BOOTSTRAP_ETH + creatorBuy.
    function launch(address creator, uint256 creatorBuy) external payable {
        hook.initialize();
        router.initialize();
        receiver.initialize();
        token.approve(address(hook), type(uint256).max);
        hook.launch();
        uint256 before = token.balanceOf(address(this));
        router.bootstrap{value: BoxSpecV1.BOOTSTRAP_ETH}();
        bootstrapTokensBurned = token.balanceOf(address(this)) - before;
        token.burn(bootstrapTokensBurned);
        if (creatorBuy != 0) router.creatorBuy{value: creatorBuy}(creator, creatorBuy);
    }

    function graduate() external returns (uint256 reward) {
        require(!graduated, "graduated");
        require(hook.closed(), "not closed");
        graduated = true;
        graduatedAt = block.timestamp;
        graduatedAtBlock = block.number;
        hook.migrate(token.balanceOf(address(this)));
        uint256 dust = token.balanceOf(address(this));
        if (dust != 0) token.burn(dust);
        reward = pm.balanceOf(address(this), 0) - lastReward;
        lastReward += reward;
        rewardOf[msg.sender] += reward;
        if (skipPokes) return reward;
        try receiver.onGraduation{gas: BoxSpecV1.POKE_GAS}() {}
        catch {
            receiverPokeFailed = true;
        }
        if (executor != address(0)) {
            try IBoxPriceAverage(executor).poke{gas: 200_000}() {} catch {}
        }
    }

    function reserve() external view returns (uint256) {
        return pm.balanceOf(address(this), 0);
    }

    receive() external payable {}
}

/// @notice TEST ONLY: the per-item stream's receiver side (S8 builds the stream): records what it was told.
contract MockItemStream {
    uint256 public notified;
    // The test-only call counter must not add a second new slot (97,920 state gas each under
    // Amsterdam) to a 200,000-gas notice. Keep notified's fresh write and all failure modes metered.
    uint256 private _callsPlusOne = 1;

    function calls() external view returns (uint256) {
        return _callsPlusOne - 1;
    }
    bool public revertNext;
    bool public burnGas;

    function setMode(bool revertNext_, bool burnGas_) external {
        (revertNext, burnGas) = (revertNext_, burnGas_);
    }

    function onStreamFunds(uint256 amount) external {
        if (revertNext) revert("stream says no");
        if (burnGas) {
            uint256 i;
            while (gasleft() > 1_000) ++i;
        }
        notified += amount;
        ++_callsPlusOne;
    }
}

/// @notice TEST ONLY: WETH9's deposit / withdraw / transfer (the royalty router unwraps it).
contract MockWETH {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "weth: send");
    }
}

/// @notice TEST ONLY: FIT's executor as other boxes see it (fundBudget, fitGraduated), with a switch.
contract MockFitExecutor {
    uint256 public funded;
    bool public fitGraduated;
    bool public refuse;

    function setGraduated(bool g) external {
        fitGraduated = g;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    function fundBudget() external payable {
        require(!refuse, "executor refuses");
        funded += msg.value;
    }

    receive() external payable {
        funded += msg.value;
    }
}

/// @notice TEST ONLY: a recipient that refuses ETH, or burns all gas sent with it.
contract RefusingRecipient {
    bool public burn;

    function setBurn(bool b) external {
        burn = b;
    }

    receive() external payable {
        if (burn) {
            uint256 i;
            while (true) ++i;
        }
        revert("no ETH");
    }

    /// @dev Lets a test drive calls from this contract (as payee or tipper).
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

/// @notice TEST ONLY: a price average whose answers the test sets (for `deepen()`'s guards).
contract SettablePriceAverage is IBoxPriceAverage {
    bool public ready;
    int24 public avgTick;
    int24 public sample;
    bool public revertPoke;
    uint256 public pokes;

    function set(bool ready_, int24 avgTick_, int24 sample_) external {
        (ready, avgTick, sample) = (ready_, avgTick_, sample_);
    }

    function setRevert(bool r) external {
        revertPoke = r;
    }

    function poke() external returns (int24) {
        require(!revertPoke, "average down");
        ++pokes;
        return sample;
    }

    function twap() external view returns (bool, int24, uint32) {
        return (ready, avgTick, 3600);
    }

    function latestSampleTick() external view returns (int24) {
        return sample;
    }
}

/// @notice TEST ONLY: settles native ETH into the PoolManager and mints the claims to `to` (exact fee batches: the
/// receiver counts any Q claims it holds outside its ledgers as the next batch).
contract EthClaimsMinter is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function mintTo(address to) external payable {
        pm.unlock(abi.encode(to, msg.value));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.mint(to, 0, amount);
        return "";
    }
}

/// @notice TEST ONLY: calls `target` with `data` from inside its own PoolManager unlock (a "foreign unlock"), or
/// donates to a pool.
contract ForeignUnlocker is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function callInside(address target, bytes calldata data) external {
        pm.unlock(abi.encode(uint8(1), abi.encode(target, data)));
    }

    function donate(PoolKey calldata key) external payable {
        pm.unlock(abi.encode(uint8(2), abi.encode(key)));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        (uint8 action, bytes memory arg) = abi.decode(raw, (uint8, bytes));
        if (action == 1) {
            (address target, bytes memory data) = abi.decode(arg, (address, bytes));
            (bool ok, bytes memory ret) = target.call(data);
            if (!ok) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        } else {
            PoolKey memory key = abi.decode(arg, (PoolKey));
            pm.donate(key, 1, 0, "");
        }
        return "";
    }

    receive() external payable {}
}

/// @notice TEST ONLY: the forcer (GraduationForcing.t.sol's, adapted to D1): buy to P1 in one unlock (closing the
/// curve), `graduate()`, then sell everything into the graduated layout; or a buy to P1 and a sell back inside one
/// unlock (which D1 refuses).
contract BoxForcer is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable pm;
    PoolKey internal key;
    uint160 internal p1;
    uint8 internal mode;

    constructor(IPoolManager pm_, PoolKey memory k, uint160 p1_) {
        pm = pm_;
        key = k;
        p1 = p1_;
    }

    /// @return paid ETH paid by the buy; received ETH the sell returned; tBought T bought and sold
    function force(MockBoxCoordinator coord) external returns (uint256 paid, uint256 received, uint256 tBought) {
        mode = 1;
        (paid, tBought) = abi.decode(pm.unlock(""), (uint256, uint256));
        coord.graduate();
        mode = 2;
        (received,) = abi.decode(pm.unlock(abi.encode(tBought)), (uint256, uint256));
    }

    function roundTripInOneUnlock() external {
        mode = 3;
        pm.unlock("");
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        if (mode == 1 || mode == 3) {
            BalanceDelta d = pm.swap(key, SwapParams(true, -int256(100 ether), p1), "");
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 tOut = uint256(uint128(d.amount1()));
            if (mode == 3) pm.swap(key, SwapParams(false, -int256(tOut), TickMath.MAX_SQRT_PRICE - 1), "");
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 paid = uint256(uint128(-d.amount0()));
            pm.settle{value: paid}();
            pm.mint(address(this), uint256(uint160(Currency.unwrap(key.currency1))), tOut);
            return abi.encode(paid, tOut);
        }
        uint256 tIn = abi.decode(data, (uint256));
        BalanceDelta s = pm.swap(key, SwapParams(false, -int256(tIn), TickMath.MAX_SQRT_PRICE - 1), "");
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 ethOut = uint256(uint128(s.amount0()));
        pm.burn(address(this), uint256(uint160(Currency.unwrap(key.currency1))), tIn);
        pm.take(key.currency0, address(this), ethOut);
        return abi.encode(ethOut, uint256(0));
    }

    receive() external payable {}
}

/// @notice TEST ONLY: a vault stand-in for T's supply floor (the burn rule, BC-016's "a burn that stops lowering
/// supply leaves the share waiting").
contract SupplyFloorStandIn {
    uint256 public supplyFloor;

    function setFloor(uint256 f) external {
        supplyFloor = f;
    }
}

/// @notice TEST ONLY: a Safe-like payee that accepts ETH.
contract AcceptingSafe {
    receive() external payable {}

    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}

/// @notice TEST ONLY: a Standard box's swap module as its receiver sees it (S5.M1 builds the hand-off against this mock;
/// S5.M2 builds the real module). One call is one transaction under this repository's isolated tests, so `step` runs
/// a whole step the way the module will: pull, then move some of its own claims to the receiver (standing in for the
/// output a swap mints there inside the module's unlock), then book proceeds. It can also lie or break: note fees it
/// never paid, book proceeds it never minted, collect in the middle of a step, revert or burn its gas.
contract MockSwapModule is IBoxSwapModuleWiring {
    IPoolManager public immutable pm;
    address public receiver;
    address public q;
    address public token;
    address public hook;
    uint256 public initCalls;
    /// 0 behaves; 1 every call reverts; 2 every call burns its gas
    uint8 public mode;
    /// 1: `initialize` re-enters the receiver (`pullForModule`, then `collect`)
    uint8 public reenter;

    constructor(IPoolManager pm_, address receiver_, address q_, address token_, address hook_) {
        (pm, receiver, q, token, hook) = (pm_, receiver_, q_, token_, hook_);
    }

    function setWiring(address receiver_, address q_, address token_, address hook_) external {
        (receiver, q, token, hook) = (receiver_, q_, token_, hook_);
    }

    function setMode(uint8 mode_) external {
        mode = mode_;
    }

    function setReenter(uint8 reenter_) external {
        reenter = reenter_;
    }

    function wiring() external view returns (address, address, address, address) {
        return (receiver, q, token, hook);
    }

    function initialize() external {
        require(msg.sender == receiver, "module: not its receiver");
        _misbehave();
        ++initCalls;
        if (reenter == 1) {
            IBoxReceiver(receiver).pullForModule();
            IBoxReceiver(receiver).collect(address(this));
        }
    }

    /// @dev What the receiver handed, as one array (qBurn, qCreator, tForFit, tForCreator, qBack, tBack).
    function pull() public returns (uint256[6] memory got) {
        _misbehave();
        (got[0], got[1], got[2], got[3], got[4], got[5]) = IBoxReceiver(receiver).pullForModule();
    }

    /// @dev One step: pull; `give` of this module's own claims of `dest`'s currency to the receiver; book `book`.
    function step(ModuleProceedsTo dest, uint256 give, uint256 book) external returns (uint256[6] memory got) {
        got = pull();
        _give(dest, give);
        IBoxReceiver(receiver).moduleProceeds(dest, book);
    }

    /// @dev A step that books twice (e.g. two destinations, or a lie on the second booking).
    function stepTwice(ModuleProceedsTo dest, uint256 give, uint256 book1, uint256 book2) external {
        pull();
        _give(dest, give);
        IBoxReceiver(receiver).moduleProceeds(dest, book1);
        IBoxReceiver(receiver).moduleProceeds(dest, book2);
    }

    /// @dev A step that pulls again after its arrival: the second pull's snapshot no longer counts it.
    function stepRepull(ModuleProceedsTo dest, uint256 give, uint256 book) external {
        pull();
        _give(dest, give);
        pull();
        IBoxReceiver(receiver).moduleProceeds(dest, book);
    }

    /// @dev A lying step: pull, give, then run the receiver's `collect` (which books the next batch) before booking.
    function stepCollectingBetween(ModuleProceedsTo dest, uint256 give, uint256 book) external {
        pull();
        _give(dest, give);
        IBoxReceiver(receiver).collect(address(this));
        IBoxReceiver(receiver).moduleProceeds(dest, book);
    }

    /// @dev A booking with no pull in the same transaction.
    function proceeds(ModuleProceedsTo dest, uint256 amount) external {
        IBoxReceiver(receiver).moduleProceeds(dest, amount);
    }

    function note(uint256 qFee, uint256 tFee) external {
        IBoxReceiver(receiver).noteModuleFees(qFee, tFee);
    }

    function claimsOf(address asset) external view returns (uint256) {
        return pm.balanceOf(address(this), uint256(uint160(asset)));
    }

    function _give(ModuleProceedsTo dest, uint256 amount) internal {
        if (amount == 0) return;
        address asset = dest == ModuleProceedsTo.CreatorT ? token : q;
        // forge-lint: disable-next-line(unused-return)
        pm.transfer(receiver, uint256(uint160(asset)), amount);
    }

    function _misbehave() internal view {
        if (mode == 1) revert("module broken");
        if (mode == 2) {
            uint256 i;
            while (gasleft() > 1_000) ++i;
        }
    }

    receive() external payable {}
}
