// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../src/box/BoxCoordinator.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../src/box/BoxItemStream.sol";
import {BoxLayoutV1} from "../../../src/box/BoxLayoutV1.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {DeepenSkip, DepthKind} from "../../../src/box/interfaces/BoxTypes.sol";
import {IBoxHook, IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxReceiver} from "../../../src/box/interfaces/IBoxReceiver.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {CoreBoxAddresses} from "../conformance/core/CoreBox0Kit.sol";
import {S5M4Kit} from "./S5M4Kit.sol";

/// @notice TEST ONLY (slice S5.M4): random life across three boxes of one version, box 0 (factory-built, its per-item
/// stream started and Misfits outside) and the kit's Standard boxes D (BUYBACK_BURN_T, BURN_T; still on its curve at the
/// start, so graduation happens inside the campaign) and C (CREATOR_IN_T, CREATOR_IN_Q, add-on 5 at 32 ETH, BURN):
/// trades, batches, the module's four steps, `sync` and `burnPending`, deepen()'s conversions and pairs, FIT's executor,
/// payouts, ETH intake up to 300 ETH a call (box 0's cap reached), depth gifts, Misfit transfers and stream claims,
/// royalties, an hour of samples or a jump of up to 40 days (new epochs), and D's close and `graduate()`.
/// Every call is fail-safe here; the ghosts record what must never happen: a `collect()` refused for anything but a
/// batch below the minimum, a `graduate()` refused once the curve is closed, a step, `sync`, `burnPending`, deepen() or
/// execute() that reverts (their failures are skips), the Safe's ETH moving outside `payPlatform()`, and the module's
/// fee notes against its allowance (Σ handed × LP_FEE / 10^6 per side, from the receiver's own events).
contract S5M4Handler is CommonBase, StdCheats, StdUtils {
    S5M4Kit internal k;
    IPoolManager internal pm;
    CoreBoxAddresses internal a;
    S5M4Kit.StdBox[2] internal std;
    address[3] internal receivers;
    address[3] internal hooks;
    address[3] internal tokens;
    address[3] internal averages;
    PoolKey[3] internal keys;
    address internal safe;
    address internal payee;
    address[3] internal owners;
    uint256[] internal items;

    // ------------------------------------------------------------------ ghosts (must stay zero)
    uint256 public collectBlocked;
    uint256 public graduateBlocked;
    uint256 public stepReverted;
    uint256 public deepenReverted;
    uint256 public executeReverted;
    uint256 public safeMovedElsewhere;
    uint256 public claimReverted;
    bytes public lastUnexpected;

    // ------------------------------------------------------------------ the platform cap, per epoch
    mapping(uint256 => uint256) public keptInEpoch;
    uint256 public maxEpoch;

    // ------------------------------------------------------------------ the modules' fee notes (index 0: D, 1: C)
    uint256[2] public handedQ;
    uint256[2] public handedT;
    uint256[2] public allowanceQ;
    uint256[2] public allowanceT;
    uint256[2] public notedQ;
    uint256[2] public notedT;

    // ------------------------------------------------------------------ coverage
    uint256 public calls;
    uint256 public collects;
    uint256 public steps;
    uint256 public stepSkips;
    uint256 public converts;
    uint256 public pairs;
    uint256 public executes;
    uint256 public payouts;
    uint256 public claims;
    uint256 public transfers;
    uint256 public graduations;

    constructor(S5M4Kit k_, address payee_, address[3] memory owners_, uint256[] memory items_) {
        k = k_;
        pm = k_.pm();
        a = k_.addresses();
        std[0] = k_.std(0);
        std[1] = k_.std(1);
        receivers = [a.receiver, std[0].receiver, std[1].receiver];
        hooks = [a.hook, std[0].hook, std[1].hook];
        tokens = [a.token, std[0].token, std[1].token];
        averages = [a.executor, std[0].sampler, std[1].sampler];
        keys[0] = k_.poolKey();
        keys[1] = std[0].key;
        keys[2] = std[1].key;
        safe = k_.factory().platformSafe();
        payee = payee_;
        owners = owners_;
        items = items_;
        // Each module's allowance starts at what its receiver reports (zero: nothing handed yet).
        for (uint256 i; i < 2; ++i) {
            (allowanceQ[i], allowanceT[i]) = BoxReceiver(payable(std[i].receiver)).moduleFeeAllowance();
        }
        _track();
    }

    // ================================================================== trading

    function buy(uint256 box, uint256 amount) external {
        box %= 3;
        // Up to 0.5 ETH a buy (about 2.5% of graduation's virtual Q): the averages can follow, so steps also trade.
        amount = bound(amount, 1e15, 0.5 ether);
        k.swapOn(keys[box], tokens[box], address(this), true, amount, 0);
        _after();
    }

    function sell(uint256 box, uint256 frac) external {
        box %= 3;
        uint256 held = BoxToken(tokens[box]).balanceOf(address(this));
        uint256 amount = held * bound(frac, 1, 100) / 100;
        if (amount == 0) return;
        try k.swapOn(keys[box], tokens[box], address(this), false, amount, 0) {} catch {}
        _after();
    }

    /// D's curve filled to exactly P1 and `graduate()`: once closed it must never be refused.
    function graduateD() external {
        S5M4Kit.StdBox memory x = std[0];
        BoxCoordinator c = BoxCoordinator(x.coordinator);
        if (c.graduated()) return;
        uint256 end = BoxHook(x.hook).windowEndsAt();
        if (block.timestamp < end) k.roll((end - block.timestamp + 11) / 12);
        if (!BoxHook(x.hook).closed()) {
            k.swapOn(
                x.key, x.token, address(this), true, 3 * x.raise, BoxLayoutV1.curve(x.raise, false).sqrtPriceLowerX96
            );
        }
        try c.graduate() {
            ++graduations;
        } catch (bytes memory e) {
            ++graduateBlocked;
            lastUnexpected = e;
        }
        _after();
    }

    // ================================================================== keepers

    function collect(uint256 box) external {
        box %= 3;
        try BoxReceiver(payable(receivers[box])).collect(address(this)) {
            ++collects;
        } catch (bytes memory e) {
            if (bytes4(e) != IBoxReceiver.BatchTooSmall.selector) {
                ++collectBlocked;
                lastUnexpected = e;
            }
        }
        _after();
    }

    function step(uint256 box, uint256 action) external {
        uint256 i = box % 2;
        IBoxSwapModule.Action act = IBoxSwapModule.Action(bound(action, 1, 4));
        vm.recordLogs();
        try BoxSwapModule(std[i].module).step(act, address(this)) returns (
            IBoxSwapModule.Stop stop, uint256, uint256, uint256
        ) {
            if (stop == IBoxSwapModule.Stop.None) ++steps;
            else ++stepSkips;
        } catch (bytes memory e) {
            ++stepReverted;
            lastUnexpected = e;
        }
        _notes(i);
        _after();
    }

    function sync(uint256 box) external {
        uint256 i = box % 2;
        vm.recordLogs();
        try BoxSwapModule(std[i].module).sync() {}
        catch (bytes memory e) {
            ++stepReverted;
            lastUnexpected = e;
        }
        _notes(i);
        _after();
    }

    function burnPending(uint256 box) external {
        try BoxSwapModule(std[box % 2].module).burnPending() {}
        catch (bytes memory e) {
            ++stepReverted;
            lastUnexpected = e;
        }
        _after();
    }

    function deepen(uint256 box) external {
        box %= 3;
        try IBoxHook(hooks[box]).deepen(address(this)) returns (DepthKind kind, DeepenSkip, uint256, uint256, uint256) {
            if (kind == DepthKind.Pair) ++pairs;
            if (kind == DepthKind.Convert) ++converts;
        } catch (bytes memory e) {
            ++deepenReverted;
            lastUnexpected = e;
        }
        _after();
    }

    function execute(uint256 chunks) external {
        try FitBuybackExecutor(payable(a.executor)).execute(bound(chunks, 1, 3)) returns (uint256 n, uint256, uint256) {
            if (n != 0) ++executes;
        } catch (bytes memory e) {
            ++executeReverted;
            lastUnexpected = e;
        }
        _after();
    }

    function pay(uint256 box, uint256 which) external {
        box %= 3;
        which %= 3;
        BoxReceiver r = BoxReceiver(payable(receivers[box]));
        if (which == 0) {
            try r.payFit() {
                ++payouts;
            } catch {}
        } else if (which == 1) {
            uint256 s0 = safe.balance;
            try r.payPlatform() returns (uint256 amount) {
                ++payouts;
                // The Safe's ETH rises by exactly what payPlatform paid (BC-141).
                if (safe.balance != s0 + amount) ++safeMovedElsewhere;
                _after();
                return;
            } catch {}
        } else {
            vm.prank(payee);
            try r.claimCreator(payee) {
                ++payouts;
            } catch {}
        }
        _after();
    }

    // ================================================================== money in

    function fundFees(uint256 box, uint256 amount) external {
        box %= 3;
        amount = bound(amount, 0, 300 ether);
        vm.deal(address(this), address(this).balance + amount);
        BoxReceiver(payable(receivers[box])).fundFees{value: amount}();
        _after();
    }

    function fundDepth(uint256 box, uint256 amount) external {
        box %= 3;
        amount = bound(amount, 0, 5 ether);
        vm.deal(address(this), address(this).balance + amount);
        BoxReceiver(payable(receivers[box])).fundDepth{value: amount}();
        _after();
    }

    function royalty(uint256 box, uint256 amount) external {
        box %= 3;
        address router = box == 0 ? a.royaltyRouter : std[box - 1].royaltyRouter;
        amount = bound(amount, 0, 2 ether);
        vm.deal(address(this), address(this).balance + amount);
        (bool ok,) = router.call{value: amount}("");
        require(ok, "royalty paid");
        (ok,) = router.call(abi.encodeWithSignature("flush()"));
        _after();
    }

    // ================================================================== Misfits and the stream

    function transferMisfit(uint256 item, uint256 to) external {
        if (items.length == 0) return;
        uint256 id = items[item % items.length];
        address from = BoxCollection(a.collection).ownerOf(id);
        address dest = owners[to % 3];
        if (from == dest || (from != owners[0] && from != owners[1] && from != owners[2])) return;
        vm.prank(from);
        try BoxCollection(a.collection).transferFrom(from, dest, id) {
            ++transfers;
        } catch {}
        _after();
    }

    function claimStream(uint256 who) external {
        address owner = owners[who % 3];
        uint256 n;
        uint256[] memory mine = new uint256[](items.length);
        for (uint256 i; i < items.length; ++i) {
            if (BoxCollection(a.collection).ownerOf(items[i]) == owner) mine[n++] = items[i];
        }
        assembly ("memory-safe") {
            mstore(mine, n)
        }
        vm.prank(owner);
        try BoxItemStream(a.itemStream).claim(mine, owner) {
            ++claims;
        } catch (bytes memory e) {
            ++claimReverted;
            lastUnexpected = e;
        }
        _after();
    }

    // ================================================================== time

    /// Up to 400 blocks (12 s each), every average poked every 10 blocks (our keeper's samples).
    function hold(uint256 blocks) external {
        blocks = bound(blocks, 1, 400);
        for (uint256 b; b < blocks; b += 10) {
            k.roll(10);
            for (uint256 i; i < 3; ++i) {
                try IBoxPriceAverage(averages[i]).poke() {} catch {}
            }
        }
        _after();
    }

    /// Up to 40 days at once (new platform and creator-cap epochs), then one sample each.
    function jump(uint256 secs) external {
        secs = bound(secs, 1 hours, 40 days);
        vm.warp(block.timestamp + secs);
        vm.roll(block.number + secs / 12);
        for (uint256 i; i < 3; ++i) {
            try IBoxPriceAverage(averages[i]).poke() {} catch {}
        }
        _after();
    }

    // ================================================================== bookkeeping

    /// The module's fee notes against its allowance, from the receiver's own events in this call: each pull adds
    /// handed × LP_FEE / 10^6 per side (rounded down per pull, as the receiver does); each note booked takes from it.
    function _notes(uint256 i) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address r = std[i].receiver;
        address m = std[i].module;
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].emitter != r) continue;
            bytes32 t0 = logs[j].topics[0];
            if (t0 == IBoxReceiver.ModulePulled.selector) {
                (uint256 qb, uint256 qc, uint256 tf, uint256 tc, uint256 qk, uint256 tk) =
                    abi.decode(logs[j].data, (uint256, uint256, uint256, uint256, uint256, uint256));
                uint256 q = qb + qc + qk;
                uint256 t = tf + tc + tk;
                handedQ[i] += q;
                handedT[i] += t;
                allowanceQ[i] += q * BoxSpecV1.LP_FEE / 1_000_000;
                allowanceT[i] += t * BoxSpecV1.LP_FEE / 1_000_000;
            } else if (t0 == IBoxReceiver.ModuleFeesNoted.selector && address(uint160(uint256(logs[j].topics[1]))) == m)
            {
                (uint256 q, uint256 t) = abi.decode(logs[j].data, (uint256, uint256));
                notedQ[i] += q;
                notedT[i] += t;
                allowanceQ[i] -= q;
                allowanceT[i] -= t;
            }
        }
    }

    function _after() internal {
        ++calls;
        _track();
    }

    /// Box 0's platform credits per epoch, as its receiver reports them.
    function _track() internal {
        (uint256 e, uint256 kept,) = BoxReceiver(payable(a.receiver)).platformEpoch();
        if (kept > keptInEpoch[e]) keptInEpoch[e] = kept;
        if (e > maxEpoch) maxEpoch = e;
    }

    receive() external payable {}
}
