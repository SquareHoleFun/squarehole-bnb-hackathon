// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {VaultAction} from "../../../../src/box/interfaces/BoxTypes.sol";
import {
    IBoxItemStream,
    IBoxTransferObserver,
    IBoxVaultObserver
} from "../../../../src/box/interfaces/IBoxItemStream.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

/// @title AuditU5ClaudeGasTest
/// @notice SH-AUDIT-B0 U5 (Claude), P5.12 (IBoxTransferObserver/IBoxVaultObserver NatSpec, IBoxItemStream.sol:6-31;
/// F87, F90 R16H: the observers' cap 460,000 at "2x from cold"; BoxReceiver STREAM_NOTIFY_GAS 200,000): the stream's
/// capped paths on the factory's box 0 at the mainnet edition's N 1,969 (F141; the existing ceiling suite measures
/// its own fixture edition), each as the least gas with which the call succeeds from a cold state (every box account
/// and implementation cooled, binary search to 64 gas, as BoxItemStreamGasBase does). The one N-dependent path is a
/// placeholder's first exit, which inverts the graduation word's shuffle with cycle-walking: at N 1,969 (b = 11, 79
/// values outside [0, N)) an inversion takes at most 80 Feistel passes, so its worst case is the measured exit plus
/// (80 − its passes) passes. Claims are measured for 1 to 6 ids (the slope logged).
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeGasTest is AuditU5ClaudeBase {
    uint256 internal constant OBSERVER_CAP = 460_000;
    uint256 internal constant NOTICE_CAP = 200_000;
    CoreImpls internal impls;

    function setUp() public override {
        super.setUp();
        _toDrawing();
        impls = kit.impls();
        assertEq(BoxCollection(a.collection).OBSERVER_GAS(), OBSERVER_CAP);
        assertEq(vault.OBSERVER_GAS(), OBSERVER_CAP);
        assertEq(BoxReceiver(payable(a.receiver)).STREAM_NOTIFY_GAS(), NOTICE_CAP);
        // Three days of life (3 × 7,200 blocks): fees and batches, so every global word of the stream and the receiver
        // is non-zero.
        for (uint256 i; i < 3; ++i) {
            _sell(eoa[2], 2_000_000 ether);
            _buy(eoa[4], 0.6 ether);
            _collect(keeper, keeper);
            _advance(7_200);
        }
    }

    function _coolAll() internal {
        address[30] memory list = [
            a.coordinator,
            a.token,
            a.collection,
            a.vault,
            a.hook,
            a.receiver,
            a.launchRouter,
            a.tickets,
            a.royaltyRouter,
            a.executor,
            a.table,
            address(pm),
            address(src),
            address(drand),
            a.weth,
            a.itemStream,
            impls.coordinator,
            impls.hook,
            impls.hookExtension,
            impls.launchRouter,
            impls.receiver,
            impls.receiverExtension,
            impls.collection,
            impls.vault,
            impls.tickets,
            impls.itemStream,
            impls.royaltyRouter,
            eoa[0],
            eoa[3],
            eoa[5]
        ];
        for (uint256 i; i < list.length; ++i) {
            vm.cool(list[i]);
        }
    }

    /// The least gas with which `caller`'s call of `data` on the stream succeeds from a cold state.
    function _least(address caller, bytes memory data) internal returns (uint256) {
        uint256 lo = 5_000;
        uint256 hi = 1_000_000;
        require(_tryWith(caller, data, hi), "the path fails even with 1,000,000 gas");
        while (hi - lo > 64) {
            uint256 mid = (lo + hi) / 2;
            if (_tryWith(caller, data, mid)) hi = mid;
            else lo = mid;
        }
        return hi;
    }

    function _tryWith(address caller, bytes memory data, uint256 g) internal returns (bool ok) {
        uint256 snap = vm.snapshotState();
        _coolAll();
        vm.prank(caller);
        (ok,) = a.itemStream.call{gas: g}(data);
        vm.revertToState(snap);
    }

    function _log(string memory label, uint256 needs, uint256 cap) internal {
        emit log_string(string.concat(
                "U5GAS|",
                vm.getEvmVersion(),
                "|",
                label,
                "|needs ",
                vm.toString(needs),
                "|cap ",
                vm.toString(cap),
                "|headroom x100 ",
                vm.toString(cap * 100 / needs)
            ));
    }

    /// A placeholder's first exit at N 1,969, measured and extrapolated to the longest cycle-walk any word can give
    /// (80 passes), within the 460,000 cap; the 2x-from-cold rule (F90 R16H) is checked on the measured paths.
    function testProperty_AUDIT_U5_placeholderExitFitsTheCapAtTheWorstShuffle() public {
        bytes32 w = tickets.graduationWord();
        (uint256 u, uint256 v) = BoxShuffle.halves(editionSize);
        assertEq(u + v, 11, "b = 11 at N 1,969");
        uint256 worstPasses = (uint256(1) << (u + v)) - editionSize + 1;
        assertEq(worstPasses, 80);
        uint256 needMax;
        uint256 passesAtMax;
        for (uint256 token = 2; token <= 5; ++token) {
            uint256 item = tickets.numberOf(token);
            address owner = tickets.ownerOf(token);
            uint256 p = BoxShuffle.passes(w, tickets.slotOf(token), editionSize, u, v);
            uint256 need =
                _least(a.collection, abi.encodeCall(IBoxTransferObserver.onItemTransfer, (a.vault, owner, item)));
            _log(string.concat("placeholder exit, passes ", vm.toString(p)), need, OBSERVER_CAP);
            if (need > needMax) (needMax, passesAtMax) = (need, p);
        }
        // One Feistel pass, measured on an inversion of 1 pass and the longest one this word has.
        (uint256 y1, uint256 yMax, uint256 pMax) = _passRange(w, u, v);
        uint256 g1 = _invertGas(w, y1, u, v);
        uint256 gMax = _invertGas(w, yMax, u, v);
        uint256 perPass = pMax > 1 ? (gMax - g1) / (pMax - 1) + 1 : 1_200;
        emit log_named_uint("longest cycle-walk this word has (passes)", pMax);
        emit log_named_uint("gas per Feistel pass", perPass);
        uint256 worst = needMax + (worstPasses - passesAtMax) * perPass;
        _log("placeholder exit at 80 passes (extrapolated)", worst, OBSERVER_CAP);
        assertLe(worst, OBSERVER_CAP, "within the cap at the worst shuffle");
        assertLe(2 * needMax, OBSERVER_CAP, "the measured exit keeps 2x");
    }

    function _passRange(bytes32 w, uint256 u, uint256 v)
        internal
        pure
        returns (uint256 y1, uint256 yMax, uint256 pMax)
    {
        for (uint256 y; y < 1_969; ++y) {
            uint256 p = BoxShuffle.passes(w, y, 1_969, u, v);
            if (p == 1 && y1 == 0) y1 = y;
            if (p > pMax) (pMax, yMax) = (p, y);
        }
    }

    function _invertGas(bytes32 w, uint256 y, uint256 u, uint256 v) internal view returns (uint256 used) {
        uint256 x = BoxShuffle.permute(w, y, 1_969, u, v);
        uint256 g0 = gasleft();
        uint256 back = BoxShuffle.invert(w, x, 1_969, u, v);
        used = g0 - gasleft();
        require(back == y, "invert");
    }

    /// The other capped paths at N 1,969 from cold: a first-time and a known seller's transfer, a return (the vault's
    /// notice and the collection's), a named pick's vault notice, and the receiver's notice with its burn. Each within
    /// its cap; the observers' with 2x (F90 R16H), the notice with 1.6x (Box0StreamCeiling's held figure).
    function testProperty_AUDIT_U5_otherCappedPathsFitTheirCaps() public {
        // A known seller: eoa[3] sells itemA (its record exists, its owed slot is written already by an earlier claim).
        _claimStreamFor(eoa[6], eoa[3], _one(itemA));
        uint256 known =
            _least(a.collection, abi.encodeCall(IBoxTransferObserver.onItemTransfer, (eoa[3], eoa[5], itemA)));
        _log("transfer, known seller", known, OBSERVER_CAP);
        // A first-time seller: eoa[0]'s itemP1, never claimed (its owed slot written from zero).
        uint256 first =
            _least(a.collection, abi.encodeCall(IBoxTransferObserver.onItemTransfer, (eoa[0], eoa[5], itemP1)));
        _log("transfer, first-time seller", first, OBSERVER_CAP);
        // A return: the vault's notice, then the collection's for the item.
        uint256 n = vault.inside();
        uint256 ret =
            _least(a.vault, abi.encodeCall(IBoxVaultObserver.onVaultAction, (VaultAction.Returned, eoa[3], 1, n)));
        _log("vault notice, Returned", ret, OBSERVER_CAP);
        uint256 back =
            _least(a.collection, abi.encodeCall(IBoxTransferObserver.onItemTransfer, (eoa[3], a.vault, itemA)));
        _log("transfer into the vault (a return)", back, OBSERVER_CAP);
        uint256 pick =
            _least(a.vault, abi.encodeCall(IBoxVaultObserver.onVaultAction, (VaultAction.Withdrawn, eoa[5], 3, n)));
        _log("vault notice, Withdrawn (3 items)", pick, OBSERVER_CAP);
        uint256[5] memory obs = [known, first, ret, back, pick];
        for (uint256 i; i < obs.length; ++i) {
            assertLe(2 * obs[i], OBSERVER_CAP, "2x from cold");
        }
        // The receiver's notice with its burn: a batch lands with the notice failing, then the notice alone.
        _sell(eoa[2], 2_000_000 ether);
        _buy(eoa[4], 0.6 ether);
        vm.mockCallRevert(a.itemStream, abi.encodeWithSelector(IBoxItemStream.onStreamFunds.selector), "");
        _collect(keeper, keeper);
        vm.clearMockedCalls();
        uint256 notice = _least(a.receiver, abi.encodeCall(IBoxItemStream.onStreamFunds, (1)));
        _log("receiver notice with its burn", notice, NOTICE_CAP);
        assertLe(notice * 16, NOTICE_CAP * 10, "1.6x");
    }

    /// `claim(ids)` gas grows linearly in the ids: measured from cold for 1 to 6 items of one owner (the slope logged;
    /// each further id costs the same within 10%).
    function testProperty_AUDIT_U5_claimGasIsLinearInIds() public {
        // eoa[0] collects six Misfits: P1, placeholders 2 and 3 opened, eoa[1]'s 4 and 5 opened and handed over,
        // and itemA returned by eoa[3] and picked by name.
        uint256[] memory ids = new uint256[](6);
        ids[0] = itemP1;
        ids[1] = _open(eoa[0], 2, true);
        ids[2] = _open(eoa[0], 3, true);
        uint256 i4 = _open(eoa[1], 4, true);
        uint256 i5 = _open(eoa[1], 5, true);
        vm.startPrank(eoa[1]);
        collection.transferFrom(eoa[1], eoa[0], i4);
        collection.transferFrom(eoa[1], eoa[0], i5);
        vm.stopPrank();
        (ids[3], ids[4]) = (i4, i5);
        _returnItem(eoa[3], itemA);
        _pick(eoa[0], itemA);
        ids[5] = itemA;
        _sell(eoa[2], 3_000_000 ether);
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
        uint256[7] memory used;
        for (uint256 k = 1; k <= 6; ++k) {
            uint256[] memory some = new uint256[](k);
            for (uint256 i; i < k; ++i) {
                some[i] = ids[i];
            }
            uint256 snap = vm.snapshotState();
            _coolAll();
            vm.prank(eoa[0]);
            uint256 g0 = gasleft();
            stream.claim(some, eoa[0]);
            used[k] = g0 - gasleft();
            vm.revertToState(snap);
            emit log_string(string.concat(
                    "U5GAS|", vm.getEvmVersion(), "|claim of ", vm.toString(k), " ids|", vm.toString(used[k])
                ));
        }
        uint256 slope = (used[6] - used[2]) / 4;
        emit log_named_uint("claim gas per further id", slope);
        for (uint256 k = 2; k < 6; ++k) {
            uint256 step = used[k + 1] - used[k];
            assertApproxEqRel(step, slope, 0.1e18, "linear: each further id costs the same");
        }
    }

    function _one(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeGasAmsterdamTest is AuditU5ClaudeGasTest {}
