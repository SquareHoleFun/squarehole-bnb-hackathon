// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCoordinator} from "../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../src/box/BoxReceiver.sol";
import {BoxRegistry} from "../../src/box/BoxRegistry.sol";
import {BoxRoyaltyRouter} from "../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../src/box/BoxTickets.sol";
import {BoxToken} from "../../src/box/BoxToken.sol";
import {ItemReveal} from "../../src/box/interfaces/BoxTypes.sol";
import {IBoxRegistry} from "../../src/box/interfaces/IBoxRegistry.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {LocalTwin} from "./LocalTwin.sol";

/// @title CoreV1LocalLife
/// @notice LOCAL ONLY (S10a § 7.2 step 3): box 0's life on the local twin, one stage per run so the caller
/// (packages/chain/scripts/local-core-chain.mjs) mines blocks and moves time between them (`anvil_mine`,
/// `evm_setNextBlockTimestamp`), and the e2e can check the site and the indexer after each. The phase drivers follow
/// `CoreBox0Kit` (toWindow, toBonding, toClosed, toGraduated) and the randomness life follows CoreBox0Randomness and
/// the S8 life test. The steps that must land at an exact time (graduation on a committed quicknet round, posting rounds,
/// the draw) are sent by the caller as single transactions with `evm_setNextBlockTimestamp`, because forge simulates a
/// script at the latest block's time.
///
/// Every transaction is sent by one of anvil's own unlocked accounts (`--unlocked`): no key anywhere. Buys and sells
/// outside the launch router go through a test swap router (test setup outside the app, as `LocalE2E.s.sol` does).
/// Refuses any chain id but 11155111 and any node that is not anvil.
///
/// Environment: `SH_LIFE_STAGE` (window, bonding, collect, close, trade, settle, depth, stream), `SH_LIFE_REGISTRY`,
/// `SH_LIFE_SWAPPER`.
contract CoreV1LocalLife is Script {
    using TickMath for int24;

    address internal constant ALICE = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    address internal constant BOB = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC;
    address internal constant CAROL = 0x90F79bf6EB2c4f870365E785982E1f101E93b906;
    address internal constant KEEPER = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65;

    error UnknownStage(string stage);

    IBoxRegistry.BoxRecord internal r;
    PriceLimitSwapper internal swapper;
    PoolKey internal key;

    function run() external {
        LocalTwin.check(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        r = BoxRegistry(vm.envAddress("SH_LIFE_REGISTRY")).recordOf(0);
        swapper = PriceLimitSwapper(payable(vm.envAddress("SH_LIFE_SWAPPER")));
        key = PoolKey(Currency.wrap(address(0)), Currency.wrap(_token()), BoxSpecV1.LP_FEE, 60, IHooks(_hook()));
        string memory stage = vm.envString("SH_LIFE_STAGE");
        bytes32 s = keccak256(bytes(stage));
        if (s == keccak256("window")) _window();
        else if (s == keccak256("bonding")) _bonding();
        else if (s == keccak256("collect")) _collect();
        else if (s == keccak256("close")) _close();
        else if (s == keccak256("trade")) _trade();
        else if (s == keccak256("settle")) _settle();
        else if (s == keccak256("depth")) _depth();
        else if (s == keccak256("stream")) _stream();
        else revert UnknownStage(stage);
        console.log(string.concat("LIFE|", stage, "|block|", vm.toString(block.number)));
    }

    // ------------------------------------------------------------------------------------------------ stages

    /// @dev In the launch window: one taxed launch-router buy (its tax left in the router until the sweep).
    function _window() internal {
        vm.startBroadcast(ALICE);
        BoxLaunchRouter(payable(_launchRouter())).buy{value: 0.02 ether}(0.02 ether, 1, ALICE, block.timestamp + 3600);
        vm.stopBroadcast();
    }

    /// @dev On the curve after the window: buys and a sell through the PoolManager, a placeholder taken (F36 a); Carol
    /// buys the FIT her draw after graduation will lock (the curve is closed between the fill and graduate()).
    function _bonding() internal {
        uint256 bought = _buy(ALICE, 0.6 ether, 0);
        _buy(BOB, 0.4 ether, 0);
        _sell(ALICE, bought / 3);
        _buy(CAROL, 0.5 ether, 0);
        vm.startBroadcast(ALICE);
        BoxToken(_token()).approve(_tickets(), type(uint256).max);
        BoxTickets(_tickets()).take(1, type(uint256).max, block.timestamp + 3600);
        vm.stopBroadcast();
        vm.startBroadcast(CAROL);
        BoxToken(_token()).approve(_tickets(), type(uint256).max);
        vm.stopBroadcast();
    }

    /// @dev One fee batch (D2): anyone collects and is tipped.
    function _collect() internal {
        vm.startBroadcast(KEEPER);
        BoxReceiver(payable(_receiver())).collect(KEEPER);
        vm.stopBroadcast();
    }

    /// @dev The curve filled to exactly P1 by an exact-input buy limited at P1 (D1: closed in its own afterSwap).
    function _close() internal {
        (int24 tickLower,,) = BoxHook(_hook()).curve();
        // Box 0's Q is native ETH, always currency0: a buy moves the price down to the curve's lower tick, P1.
        _buy(CAROL, 3 * r.raise, tickLower.getSqrtPriceAtTick());
        require(BoxHook(_hook()).closed(), "life: closed");
    }

    /// @dev Life on the graduated pool: a buy and a sell.
    function _trade() internal {
        uint256 bought = _buy(BOB, 1 ether, 0);
        _sell(BOB, bought / 2);
    }

    /// @dev The reward claimed, the launch tax swept into box 0's own pool (F77), a royalty paid and flushed.
    function _settle() internal {
        vm.startBroadcast(KEEPER);
        BoxCoordinator(_coordinator()).claimReward(KEEPER);
        BoxLaunchRouter(payable(_launchRouter())).sweep();
        vm.stopBroadcast();
        address router = r.contracts[8];
        if (router != address(0)) {
            vm.startBroadcast(CAROL);
            (bool ok,) = router.call{value: 0.1 ether}("");
            require(ok, "life: royalty paid");
            BoxRoyaltyRouter(payable(router)).flush();
            vm.stopBroadcast();
        }
    }

    /// @dev Enough fees for a paired depth add (S10a review): the pair needs both sides worth MIN_ADD (0.5% of the
    /// raise) after the conversion that buys its T side, and the busy stage's batch left too little. A round trip of
    /// 3 ETH (both sides' 1% fees, 2/15 of each into the pool's budget) and a batch.
    function _depth() internal {
        uint256 bought = _buy(BOB, 3 ether, 0);
        _sell(BOB, bought);
        _collect();
    }

    /// @dev Past the reveal grace (box 0's fixture has no reveal proofs): Alice opens her placeholder into a Misfit, a
    /// fee batch funds the stream, and she claims the Misfit's share.
    function _stream() internal {
        ItemReveal memory none;
        vm.startBroadcast(ALICE);
        uint256 id = BoxTickets(_tickets()).open(vm.envOr("SH_LIFE_PLACEHOLDER", uint256(1)), none);
        vm.stopBroadcast();
        // 1 ETH of buys: its 1% fee clears the batch minimum (FEE_BATCH_MIN_ETH, 0.005 ETH) after rounding.
        _buy(BOB, 1 ether, 0);
        _collect();
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.startBroadcast(ALICE);
        BoxItemStream(_itemStream()).claim(ids, ALICE);
        vm.stopBroadcast();
        console.log(string.concat("LIFE|stream|item|", vm.toString(id)));
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _buy(address who, uint256 ethIn, uint160 limit) internal returns (uint256 tOut) {
        uint256 t0 = BoxToken(_token()).balanceOf(who);
        vm.startBroadcast(who);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap{value: ethIn}(key, true, -int256(ethIn), limit);
        vm.stopBroadcast();
        tOut = BoxToken(_token()).balanceOf(who) - t0;
    }

    function _sell(address who, uint256 tIn) internal {
        vm.startBroadcast(who);
        BoxToken(_token()).approve(address(swapper), type(uint256).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        swapper.swap(key, false, -int256(tIn), 0);
        vm.stopBroadcast();
    }

    function _coordinator() internal view returns (address) {
        return r.contracts[0];
    }

    function _token() internal view returns (address) {
        return r.contracts[1];
    }

    function _hook() internal view returns (address) {
        return r.contracts[2];
    }

    function _receiver() internal view returns (address) {
        return r.contracts[5];
    }

    function _launchRouter() internal view returns (address) {
        return r.contracts[6];
    }

    function _tickets() internal view returns (address) {
        return r.contracts[7];
    }

    function _itemStream() internal view returns (address) {
        return r.contracts[10];
    }
}
