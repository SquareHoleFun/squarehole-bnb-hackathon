// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {IBoxCoordinator} from "../../../../src/box/interfaces/IBoxCoordinator.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {EthIn, EthOut} from "../common/AuditGhostLedger.sol";
import {AuditPhases} from "../common/AuditPhases.sol";

/// @notice TEST ONLY (SH-AUDIT-B0 U4, Fable). One batch's figures as the receiver reported them in its events, read
/// back from recorded logs: `Collected` / `FeesFunded` (what came in), `ModuleFeesReturned` (REV-16's returns),
/// `BatchSplit` (the parts; its `qDepth` includes the cap's excess, its `qPlatform` is the kept part), `PlatformCredited`
/// (kept and excess per cap call), `GraduationSettled` (the held platform share's cap in epoch 0), `StreamFunded` /
/// `StreamNotifyFailed` (the T the stream got), `FitPaid` / `PlatformPaid`. Summed over every split one call made.
/// `qInBeforeSettled` / `tInBeforeSettled`: the ERC-6909 claims the PoolManager moved INTO the receiver before the
/// `GraduationSettled` log of the same call (the migration's last harvest and the coordinator's forwarded gift inside
/// `graduate()`): the settlement split them together with the claims unbooked before the call.
struct AuditU4Tally {
    bool collected;
    bool settled;
    uint256 qInBeforeSettled;
    uint256 tInBeforeSettled;
    uint256 collectedQ;
    uint256 collectedT;
    uint256 qToReserve;
    uint256 tip;
    uint256 funded;
    uint256 back;
    uint256 backT;
    uint256 hookBack;
    uint256 qFit;
    uint256 qDepth;
    uint256 qPlatform;
    uint256 tDepth;
    uint256 tBurned;
    uint256 tStream;
    uint256 splits;
    uint256 streamNotices;
    uint256 streamFailures;
    uint256 heldKept;
    uint256 heldToDepth;
    uint256 fitPaid;
    uint256 platformPaid;
    uint256 depthGifted;
    /// The epochs `PlatformCredited` named, in order (at most 8 per call here), and what each kept; `creditAtSettlement`:
    /// the credit was logged before the call's own intake (`Collected` / `FeesFunded`), so it is the settlement's (the
    /// held share's, or the final harvest's split) when the call settled.
    uint256 credits;
    uint256[8] creditEpoch;
    uint256[8] creditKept;
    uint256[8] creditToDepth;
    uint256[8] creditTotal;
    bool[8] creditAtSettlement;
}

/// @notice TEST ONLY: the parser of the receiver's batch events, shared by the tests and the invariant handler.
library AuditU4FableTallyLib {
    bytes32 internal constant COLLECTED = keccak256("Collected(address,address,uint256,uint256,uint256,uint256)");
    bytes32 internal constant BATCH_SPLIT =
        keccak256("BatchSplit(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)");
    bytes32 internal constant PLATFORM_CREDITED = keccak256("PlatformCredited(uint256,uint256,uint256,uint256)");
    bytes32 internal constant MODULE_FEES_RETURNED = keccak256("ModuleFeesReturned(uint256,uint256,uint256)");
    bytes32 internal constant GRADUATION_SETTLED =
        keccak256("GraduationSettled(uint256,uint256,uint256,uint256,uint256)");
    bytes32 internal constant STREAM_FUNDED = keccak256("StreamFunded(address,uint256)");
    bytes32 internal constant STREAM_NOTIFY_FAILED = keccak256("StreamNotifyFailed(address,uint256)");
    bytes32 internal constant FEES_FUNDED = keccak256("FeesFunded(address,uint256)");
    bytes32 internal constant DEPTH_GIFTED = keccak256("DepthGifted(address,uint256)");
    bytes32 internal constant FIT_PAID = keccak256("FitPaid(address,uint256)");
    bytes32 internal constant PLATFORM_PAID = keccak256("PlatformPaid(address,uint256)");
    /// The PoolManager's ERC-6909 `Transfer(address caller, address indexed from, address indexed to, uint256 indexed
    /// id, uint256 amount)` (v4-core IERC6909Claims.sol:14): a mint has `from` zero, a burn `to` zero.
    bytes32 internal constant CLAIMS_TRANSFER = keccak256("Transfer(address,address,address,uint256,uint256)");

    function tally(VmSafe.Log[] memory logs, address receiver) internal pure returns (AuditU4Tally memory t) {
        bool intake;
        for (uint256 i; i < logs.length; ++i) {
            VmSafe.Log memory l = logs[i];
            bytes32 sig = l.topics[0];
            if (sig == CLAIMS_TRANSFER && l.topics.length == 4) {
                // Claims into the receiver before the settlement's `GraduationSettled`: the only claim ids of box 0's
                // world are 0 (ETH) and the token's, so any other id is T.
                if (!t.settled && address(uint160(uint256(l.topics[2]))) == receiver) {
                    (, uint256 amount) = abi.decode(l.data, (address, uint256));
                    if (uint256(l.topics[3]) == 0) t.qInBeforeSettled += amount;
                    else t.tInBeforeSettled += amount;
                }
                continue;
            }
            if (l.emitter != receiver) continue;
            if (sig == COLLECTED) {
                (, uint256 q, uint256 tt, uint256 res, uint256 tip) =
                    abi.decode(l.data, (address, uint256, uint256, uint256, uint256));
                t.collected = true;
                intake = true;
                t.collectedQ += q;
                t.collectedT += tt;
                t.qToReserve += res;
                t.tip += tip;
            } else if (sig == BATCH_SPLIT) {
                (, uint256 qFit, uint256 qDepth, uint256 qPlatform,,, uint256 tDepth, uint256 tBurned) =
                    abi.decode(l.data, (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256));
                t.qFit += qFit;
                t.qDepth += qDepth;
                t.qPlatform += qPlatform;
                t.tDepth += tDepth;
                t.tBurned += tBurned;
                ++t.splits;
            } else if (sig == PLATFORM_CREDITED) {
                (uint256 kept, uint256 toDepth, uint256 total) = abi.decode(l.data, (uint256, uint256, uint256));
                if (t.credits < 8) {
                    t.creditEpoch[t.credits] = uint256(l.topics[1]);
                    t.creditKept[t.credits] = kept;
                    t.creditToDepth[t.credits] = toDepth;
                    t.creditTotal[t.credits] = total;
                    t.creditAtSettlement[t.credits] = !intake;
                }
                ++t.credits;
            } else if (sig == MODULE_FEES_RETURNED) {
                (uint256 b, uint256 bt, uint256 h) = abi.decode(l.data, (uint256, uint256, uint256));
                t.back += b;
                t.backT += bt;
                t.hookBack += h;
            } else if (sig == GRADUATION_SETTLED) {
                (, uint256 kept, uint256 toDepth,,) = abi.decode(l.data, (uint256, uint256, uint256, uint256, uint256));
                t.settled = true;
                t.heldKept = kept;
                t.heldToDepth = toDepth;
            } else if (sig == STREAM_FUNDED) {
                t.tStream += abi.decode(l.data, (uint256));
                ++t.streamNotices;
            } else if (sig == STREAM_NOTIFY_FAILED) {
                t.tStream += abi.decode(l.data, (uint256));
                ++t.streamFailures;
            } else if (sig == FEES_FUNDED) {
                t.funded += abi.decode(l.data, (uint256));
                intake = true;
            } else if (sig == DEPTH_GIFTED) {
                t.depthGifted += abi.decode(l.data, (uint256));
            } else if (sig == FIT_PAID) {
                t.fitPaid += abi.decode(l.data, (uint256));
            } else if (sig == PLATFORM_PAID) {
                t.platformPaid += abi.decode(l.data, (uint256));
            }
        }
    }
}

/// @title AuditU4FableBase
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Fable 5.1's audit of box 0's receiver and royalty router). The shared world
/// (`AuditPhases`: the factory's box 0 on the mainnet build, real everything) plus what the U4 tests need: claim and
/// ledger reads, a log tally of one call's batch events, a graduation whose receiver poke fails (so a late settlement
/// can be driven), and the receiver's storage slots for the boundary tests.
abstract contract AuditU4FableBase is AuditPhases {
    uint256 internal constant CAP = BoxSpecV1.PLATFORM_CAP_WEI;
    uint256 internal constant EPOCH = BoxSpecV1.PLATFORM_EPOCH_SECONDS;
    uint256 internal constant BATCH_MIN = BoxSpecV1.FEE_BATCH_MIN_ETH;
    uint256 internal constant TIP_MAX = BoxSpecV1.FEE_BATCH_TIP_MAX_ETH;
    uint256 internal constant DENOM = BoxSpecV1.FEE_SHARE_DENOMINATOR;
    uint256 internal constant STREAM_GAS = 200_000;
    /// The receiver's storage slots (`forge inspect BoxReceiver storage-layout`): `_s` 0; `_l` 1-8 (two uint128 a
    /// slot: fitOwed|platformOwed, platformHeld|keptInEpoch, …); `_t` 9-12; `_m` 15-17; `_streamCurveDepthT` 18.
    uint256 internal constant SLOT_S = 0;
    uint256 internal constant SLOT_FIT_PLATFORM = 1;
    uint256 internal constant SLOT_HELD_KEPT = 2;

    bytes32 internal constant POKE_FAILED = keccak256("PokeFailed(address,bytes4)");
    bytes32 internal constant CLAIMS_FORWARDED = keccak256("ClaimsForwarded(address,uint256)");

    AuditU4FableClaimsMinter internal minter;

    function setUp() public virtual override {
        super.setUp();
        minter = new AuditU4FableClaimsMinter(pm);
        vm.label(address(minter), "audit.u4.claimsMinter");
        _ghostAddOutside(address(minter));
    }

    // ================================================================================================ reads

    function _claimsQ(address who) internal view returns (uint256) {
        return pm.balanceOf(who, 0);
    }

    function _claimsT(address who) internal view returns (uint256) {
        return pm.balanceOf(who, uint256(uint160(a.token)));
    }

    /// @notice The receiver's claims not in any ledger: the next batch.
    function _unbooked() internal view returns (uint256 q, uint256 t) {
        (uint256 bq, uint256 bt) = receiver.booked();
        q = _claimsQ(a.receiver) - bq;
        t = _claimsT(a.receiver) - bt;
    }

    function _toPlatform() internal view returns (uint256 x) {
        (, x,,,,,) = receiver.totals();
    }

    function _toFit() internal view returns (uint256 x) {
        (x,,,,,,) = receiver.totals();
    }

    function _qToDepth() internal view returns (uint256 x) {
        (,, x,,,,) = receiver.totals();
    }

    function _tBurnedTotal() internal view returns (uint256 x) {
        (,,,, x,,) = receiver.totals();
    }

    function _epochOf(uint256 t) internal view returns (uint256) {
        return (t - coordinator.graduatedAt()) / EPOCH;
    }

    function _epochStart(uint256 k) internal view returns (uint256) {
        return coordinator.graduatedAt() + k * EPOCH;
    }

    // ================================================================================================ the tally

    /// @notice Sums the receiver's batch events among `logs` (one call's recorded logs).
    function _tally(VmSafe.Log[] memory logs) internal view returns (AuditU4Tally memory t) {
        return AuditU4FableTallyLib.tally(logs, a.receiver);
    }

    /// @notice Per batch (P4.1, BC-015): what came in to be split equals the returns, the tip, the parts and the change of
    /// the carried remainder, to the wei, on both sides. `unbookedBefore` is what the settlement split if it ran in this
    /// call (a collect's `Collected.q` already contains the claims unbooked before it when no settlement ran first).
    function _assertBatchConserved(
        AuditU4Tally memory t,
        uint256 unbookedQBefore,
        uint256 unbookedTBefore,
        uint256 carryQBefore,
        uint256 carryTBefore
    ) internal view {
        (uint256 cq, uint256 ct) = receiver.carried();
        assertEq(
            _qIn(t, unbookedQBefore) + carryQBefore,
            _qOut(t) + cq,
            "P4.1: Q in + old carry == returns + tip + FIT + depth + platform (kept or held) + new carry"
        );
        assertEq(t.backT, 0, "box 0 returns no T notes (BoxReceiver._returnFees: backT = 0 for box 0)");
        assertEq(
            _tIn(t, unbookedTBefore) + carryTBefore,
            t.tDepth + t.tBurned + t.tStream + ct,
            "P4.1: T in + old carry == depth + burned + streamed + new carry"
        );
        assertLt(cq, DENOM, "the Q carry is below one fifteenth");
        assertLt(ct, DENOM, "the T carry is below one fifteenth");
    }

    /// @dev What came in to be split: the settlement's unbooked claims (if it ran: those unbooked before the call plus
    /// the claims the PoolManager moved in before `GraduationSettled`, which is how `graduate()` hands the migration's
    /// last harvest and a forwarded gift to the receiver before its poke), a collect's new Q after the reserve (which
    /// already holds the claims unbooked before it when no settlement ran first), `fundFees`'s amount.
    function _qIn(AuditU4Tally memory t, uint256 unbookedQBefore) internal pure returns (uint256) {
        return (t.settled ? unbookedQBefore + t.qInBeforeSettled : 0) + (t.collected ? t.collectedQ - t.qToReserve : 0)
            + t.funded;
    }

    function _tIn(AuditU4Tally memory t, uint256 unbookedTBefore) internal pure returns (uint256) {
        return (t.settled ? unbookedTBefore + t.tInBeforeSettled : 0) + (t.collected ? t.collectedT : 0);
    }

    /// @dev Where it went: the returns, the tip, the parts; before graduation the platform part (2u a split) is held
    /// and not reported by BatchSplit: 2 × (Σ 11u) / 11.
    function _qOut(AuditU4Tally memory t) internal view returns (uint256) {
        uint256 heldP = receiver.graduationSettled() ? 0 : BoxSpecV1.BOX0_FEE_SHARE_PLATFORM * (t.qFit / 11);
        return t.back + t.hookBack + t.tip + t.qFit + t.qDepth + t.qPlatform + heldP;
    }

    /// @notice Box 0's fifteenths (P4.2, BC-015, F77) over the splits of one call: FIT 11u, depth 2u plus the cap's
    /// excess, platform kept 2u less that excess; T depth 2v, burned or streamed 13v.
    function _assertFifteenths(AuditU4Tally memory t, bool graduated) internal pure {
        uint256 excess;
        uint256 kept;
        for (uint256 i; i < t.credits && i < 8; ++i) {
            excess += t.creditToDepth[i];
            kept += t.creditKept[i];
        }
        if (t.settled) {
            // The held share's cap call is not a split's: take it out of the credit sums.
            excess -= t.heldToDepth;
            kept -= t.heldKept;
        }
        assertEq(t.qFit % BoxSpecV1.BOX0_FEE_SHARE_FIT, 0, "P4.2: FIT is a whole number of units");
        uint256 u = t.qFit / BoxSpecV1.BOX0_FEE_SHARE_FIT;
        assertEq(t.qDepth, BoxSpecV1.FEE_SHARE_DEPTH * u + excess, "P4.2: Q depth == 2u + the cap's excess");
        if (graduated) {
            assertEq(t.qPlatform, kept, "P4.2: the event's platform part is the kept part");
            assertEq(t.qPlatform + excess, BoxSpecV1.BOX0_FEE_SHARE_PLATFORM * u, "P4.2: kept + excess == 2u");
        } else {
            assertEq(t.qPlatform, 0, "before graduation the platform part is held, not credited");
            assertEq(excess, 0);
        }
        assertEq(t.tDepth % BoxSpecV1.FEE_SHARE_DEPTH, 0);
        uint256 v = t.tDepth / BoxSpecV1.FEE_SHARE_DEPTH;
        assertEq(t.tBurned + t.tStream, BoxSpecV1.BOX0_FEE_SHARE_T_BURN * v, "P4.2: T burned or streamed == 13v");
    }

    // ================================================================================================ drivers

    /// @notice Graduates box 0 (from Closed) with the receiver's poke failing: a gas sink stands in for the receiver's
    /// code during `graduate()` only (the carried-over M21/M31 tests do the same), so the settlement is left for the
    /// first later receiver call (`_settleIfDue`). Returns the coordinator's PokeFailed count.
    function _graduateWithFailedReceiverPoke(address caller) internal returns (uint256 pokeFailures) {
        _toClosed();
        bytes memory code = a.receiver.code;
        AuditU4FableGasSink sink = new AuditU4FableGasSink();
        vm.etch(a.receiver, address(sink).code);
        vm.recordLogs();
        vm.prank(caller);
        coordinator.graduate{gas: 15_000_000}();
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        vm.etch(a.receiver, code);
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.coordinator && logs[i].topics[0] == POKE_FAILED) ++pokeFailures;
        }
        require(coordinator.graduated(), "u4: graduated");
        require(!receiver.graduationSettled(), "u4: the receiver did not settle");
    }

    /// @notice Trading after graduation that leaves fees in the pool: `who` buys `ethIn` and sells back a share of it.
    function _trade(address who, uint256 ethIn, uint256 sellBps) internal {
        uint256 got = _buy(who, ethIn);
        if (sellBps != 0) _sell(who, got * sellBps / 10_000);
    }

    /// @notice ETH claims minted to `to` by an outsider's own unlock (a gift the receiver counts as the next batch).
    function _mintClaimsTo(address to, uint256 amount) internal {
        _fund(address(minter), amount);
        uint256 e0 = address(minter).balance;
        minter.mintEth(to, amount);
        _noteEthChange(e0, address(minter).balance, EthIn.Other, EthOut.Other);
    }

    /// @notice The revert selector of `data` (0 when shorter than 4 bytes).
    function _selector(bytes memory data) internal pure returns (bytes4 s) {
        if (data.length < 4) return 0;
        assembly ("memory-safe") {
            s := mload(add(data, 0x20))
        }
    }
}

/// @notice TEST ONLY: burns every unit of gas it is given, whatever the call (a stand-in for a receiver, Safe or stream
/// that uses all its gas).
contract AuditU4FableGasSink {
    fallback() external payable {
        assembly ("memory-safe") {
            for {} 1 {} {}
        }
    }

    receive() external payable {
        assembly ("memory-safe") {
            for {} 1 {} {}
        }
    }
}

/// @notice TEST ONLY: mints ERC-6909 ETH claims to any address through its own unlock (anyone can do this on the
/// PoolManager: settle ETH, mint the claim). A gift the receiver counts as its next batch.
contract AuditU4FableClaimsMinter is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function mintEth(address to, uint256 amount) external payable {
        pm.unlock(abi.encode(to, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "minter: pm");
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.mint(to, 0, amount);
        return "";
    }

    receive() external payable {}
}

/// @notice TEST ONLY: a tip recipient that, while it receives the tip inside the receiver's own unlock, makes one call of
/// the test's choice and records whether it succeeded and its revert data (a re-entrancy probe).
contract AuditU4FableReenterTip {
    address public target;
    bytes public data;
    uint256 public value;
    bool public armed;
    bool public called;
    bool public ok;
    bytes public ret;

    function arm(address target_, uint256 value_, bytes calldata data_) external {
        target = target_;
        value = value_;
        data = data_;
        armed = true;
        called = false;
        ok = false;
        ret = "";
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        called = true;
        (ok, ret) = target.call{value: value}(data);
    }
}

/// @notice TEST ONLY: a WETH9-shaped stand-in whose `withdraw` pays with Solidity's `transfer` (the 2,300-gas stipend),
/// as the real WETH9 does (`msg.sender.transfer(wad)`); the kit's MockWETH pays with a call and all gas. Same storage
/// shape as MockWETH (`balanceOf` at slot 0) so it can be etched over it.
contract AuditU4FableWeth9Like {
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
        payable(msg.sender).transfer(amount);
    }
}

/// @notice TEST ONLY: records the gas it is given at entry (a stand-in for the stream, etched over its code), in a slot
/// the stream never uses.
contract AuditU4FableGasProbe {
    /// "AUDIT_U4_FABLE_GASPROBE" as a slot number: no contract of box 0 uses it.
    uint256 internal constant SLOT = 0x41554449545f55345f4641424c455f47415350524f4245000000000000000000;

    fallback() external payable {
        uint256 g = gasleft();
        assembly ("memory-safe") {
            sstore(SLOT, g)
        }
    }

    function probeSlot() external pure returns (bytes32) {
        return bytes32(SLOT);
    }
}

/// @notice TEST ONLY: an outsider that, in its own unlock, pays ETH to the PoolManager and takes it to any address (so a
/// test can try to push ETH at the receiver through the PoolManager from outside the receiver's guarded calls).
contract AuditU4FableTaker is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function takeTo(address to, uint256 amount) external payable {
        pm.unlock(abi.encode(to, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "taker: pm");
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.take(Currency.wrap(address(0)), to, amount);
        return "";
    }

    receive() external payable {}
}

/// @notice TEST ONLY: a tip recipient that uses the receiver's open unlock while it receives its tip: it pays `mintAmt +
/// takeAmt` of its own ETH to the PoolManager, mints `mintAmt` of ETH claims to `target` and takes `takeAmt` of ETH to
/// `target` (the receiver's `receive` accepts it then: the call comes from the PoolManager inside a guarded call).
contract AuditU4FableInsideTip {
    IPoolManager public immutable pm;
    address public target;
    uint256 public mintAmt;
    uint256 public takeAmt;
    bool public armed;
    bool public ran;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function arm(address target_, uint256 mintAmt_, uint256 takeAmt_) external {
        target = target_;
        mintAmt = mintAmt_;
        takeAmt = takeAmt_;
        armed = true;
        ran = false;
    }

    receive() external payable {
        if (!armed) return;
        armed = false;
        ran = true;
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: mintAmt + takeAmt}();
        if (mintAmt != 0) pm.mint(target, 0, mintAmt);
        if (takeAmt != 0) pm.take(Currency.wrap(address(0)), target, takeAmt);
    }
}

/// @notice TEST ONLY: pays like a marketplace: Solidity's `transfer` (2,300-gas stipend), `send`, a call with a chosen
/// gas limit, or a call carrying calldata.
contract AuditU4FableStipendPayer {
    function payByTransfer(address payable to, uint256 amount) external {
        to.transfer(amount);
    }

    function payBySend(address payable to, uint256 amount) external returns (bool) {
        return to.send(amount);
    }

    function payByCall(address to, uint256 amount, uint256 gasLimit) external returns (bool ok) {
        (ok,) = to.call{value: amount, gas: gasLimit}("");
    }

    function payWithData(address to, uint256 amount, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = to.call{value: amount}(data);
    }

    receive() external payable {}
}
