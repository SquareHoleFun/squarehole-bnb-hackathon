// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IV4Router} from "v4-periphery/src/interfaces/IV4Router.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {IRewardLedger} from "../src/interfaces/IRewardLedger.sol";
import {SquareHoleLauncher} from "../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../src/SquareHoleRegistry.sol";
import {MockTetherUSD} from "../src/testnet/MockTetherUSD.sol";
import {ExternalSwapHarness} from "./harness/ExternalSwapHarness.sol";
import {LocalE2EBase} from "./local/LocalE2EBase.sol";
import {LocalWETH9} from "./local/LocalQuoteMocks.sol";

/// @title LocalE2E (SH-B2 Build B item 9; Stage C external-trading test harness)
/// @notice Runs EXTERNAL-style trading and settlement against the Square Hole stack that `script/Deploy.s.sol`
/// deployed on a local anvil chain (31337), the SH-E plan (F10): The Misfits (T = FIT, 10,000 NFTs, quote WETH,
/// R = Q) and ORCHARD (T = ORCH, 1,000 NFTs, quote FIT, R = T). Deploys the external swap harness (v4-periphery
/// V4Router actions, what the Universal Router's V4_SWAP runs), then, each as its own transaction from anvil's public
/// default accounts: WETH buys of FIT (exact in; exact out in whole Misfits NFTs), sells, FIT buys of ORCH, fee
/// processing (burn T, protocol Q to the treasury), R = Q claims on The Misfits paid in WETH, R = T conversions on
/// ORCHARD paid in ORCH (`claimAsT(pairId, minTOut, deadline)` with a quoted minimum), and a USDT-TEST token launch
/// traded with the mock's faucet. `script/LocalE2EReport.s.sol` then reconciles the resulting chain state. Driven by
/// `scripts/local-e2e.sh`; refuses any chain but 31337.
contract LocalE2E is LocalE2EBase {
    Stack internal s;
    ExternalSwapHarness internal harness;
    uint256 internal deadline;

    Actor internal alice;
    Actor internal bob;
    Actor internal carol;
    Actor internal dave;
    Actor internal creator;
    Actor internal keeper;
    Actor internal operator;

    function run() external {
        _requireLocal();
        s = _loadStack();
        deadline = block.timestamp + 1 hours;
        alice = _actor("alice", 1);
        bob = _actor("bob", 2);
        carol = _actor("carol", 3);
        dave = _actor("dave", 4);
        creator = _actor("creator", 5);
        keeper = _actor("keeper", 6);
        operator = _actor("harness operator", 7);

        vm.broadcast(operator.key);
        harness = new ExternalSwapHarness(IPoolManager(s.poolManager));
        console.log("E2E harness (external swap router, local only)", address(harness));

        Pair memory misfits = _pair(s.registry, s.misfitsPairId);
        require(s.orchardPairId != bytes32(0), "local E2E: the local plan launches ORCHARD (launches.ORCHARD.enabled)");
        Pair memory orchard = _pair(s.registry, s.orchardPairId);
        require(orchard.r.quote == misfits.r.token, "local E2E: ORCHARD is quoted in FIT");
        uint256 fitNft = _nftUnit(misfits); // 1e23 raw = 100,000 FIT (F10: 1e27 / 10,000)
        uint256 orchNft = _nftUnit(orchard); // 1e24 raw = 1,000,000 ORCH (1e27 / 1,000)

        // WETH for the traders (anvil accounts hold 10,000 test ETH each). One Misfits NFT starts at 0.0001 WETH, so
        // the buys stay small: one EIP-7825 transaction delivers at most ~1,300 NFTs to an EOA (ADR-0011 §4).
        _wrap(alice, 1 ether);
        _wrap(bob, 1 ether);
        _wrap(carol, 1 ether);
        _wrap(dave, 1 ether);

        // The Misfits (T = FIT, R = Q): the first buy defers its holder share (zero eligible supply), the next releases
        // it; whole-NFT exact-out and exact-in buys; sells pay their fee in FIT (burned at processing).
        _buyExactIn("01 Misfits buy FIT exact-in (first buy: bootstrap)", alice, misfits, 0.005 ether);
        _buyExactOut("02 Misfits buy exact-out 3 whole NFTs (300,000 FIT)", bob, misfits, 3 * fitNft, 0.001 ether);
        _buyExactIn("03 Misfits buy FIT exact-in", carol, misfits, 0.002 ether);
        _buyExactIn("04 Misfits buy FIT exact-in", dave, misfits, 0.01 ether);
        _sellExactIn("05 Misfits sell exact-in 1 whole NFT of FIT", carol, misfits, fitNft);
        _sellExactIn("06 Misfits sell exact-in half", alice, misfits, _balance(misfits.r.token, alice.addr) / 2);

        // ORCHARD (T = ORCH, quote FIT, R = T): paid with the FIT bought above.
        _buyExactIn("07 ORCHARD buy ORCH with FIT exact-in (first buy: bootstrap)", bob, orchard, 20_000e18);
        _buyExactOut("08 ORCHARD buy exact-out 5 whole NFTs (5,000,000 ORCH)", dave, orchard, 5 * orchNft, 10_000e18);
        _buyExactIn("09 ORCHARD buy ORCH with FIT exact-in", alice, orchard, 30_000e18);
        _sellExactIn("10 ORCHARD sell exact-in 1 whole NFT of ORCH", dave, orchard, orchNft);

        // Fee processing by anyone (keeper): burn native fee T, pay protocol Q to the treasury.
        _processFees("11 Misfits processFees (burns FIT, protocol WETH to the treasury)", misfits);
        _processFees("12 ORCHARD processFees (burns ORCH, protocol FIT to the treasury)", orchard);

        // Claims: R = Q on The Misfits (paid in WETH) and R = T on ORCHARD (paid in ORCH through the converter).
        _claimQ("13 Misfits claim in Q (WETH)", alice, misfits);
        _claimQ("14 Misfits claim in Q (WETH)", bob, misfits);
        _claimT("15 ORCHARD claim as T (ORCH, converter, by pair id)", bob, orchard);
        _claimT("16 ORCHARD claim as T (ORCH, converter, by pair id)", dave, orchard);

        // A USDT-TEST launch: faucet, trades with a no-return quote, processing and a claim in USDT-TEST.
        _mockTetherRound();
    }

    /*//////////////////////////////////////////////////////////////
                               ACTIONS
    //////////////////////////////////////////////////////////////*/

    function _wrap(Actor memory a, uint256 amount) internal {
        vm.broadcast(a.key);
        LocalWETH9(payable(s.weth)).deposit{value: amount}();
    }

    /// USDT-style safe exact approval: reset to 0 when needed, then the exact amount (no infinite allowance).
    function _approveExact(Actor memory a, address token, address spender, uint256 amount) internal {
        (, bytes memory ret) = token.staticcall(abi.encodeWithSignature("allowance(address,address)", a.addr, spender));
        vm.startBroadcast(a.key);
        if (abi.decode(ret, (uint256)) != 0) _call(token, abi.encodeWithSelector(0x095ea7b3, spender, 0));
        _call(token, abi.encodeWithSelector(0x095ea7b3, spender, amount));
        vm.stopBroadcast();
    }

    function _call(address target, bytes memory data) internal {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "call failed");
    }

    function _buyExactIn(string memory label, Actor memory a, Pair memory p, uint256 qIn) internal {
        _approveExact(a, p.r.quote, address(harness), qIn);
        bytes[] memory params = new bytes[](3);
        // casting to 'uint128' is safe because E2E amounts are small (≤ 1e27 raw)
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(p.key, !p.tIsCurrency0, uint128(qIn), 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(p.r.quote), qIn);
        params[2] = abi.encode(Currency.wrap(p.r.token), uint256(1));
        _swap(label, a, p, _actions(Actions.SWAP_EXACT_IN_SINGLE), params);
    }

    function _buyExactOut(string memory label, Actor memory a, Pair memory p, uint256 tOut, uint256 maxIn) internal {
        _approveExact(a, p.r.quote, address(harness), maxIn);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            // forge-lint: disable-next-line(unsafe-typecast)
            IV4Router.ExactOutputSingleParams(p.key, !p.tIsCurrency0, uint128(tOut), uint128(maxIn), 0, "")
        );
        params[1] = abi.encode(Currency.wrap(p.r.quote), maxIn);
        params[2] = abi.encode(Currency.wrap(p.r.token), tOut);
        _swap(label, a, p, _actions(Actions.SWAP_EXACT_OUT_SINGLE), params);
        _approveExact(a, p.r.quote, address(harness), 0); // no allowance left behind
    }

    function _sellExactIn(string memory label, Actor memory a, Pair memory p, uint256 tIn) internal {
        _approveExact(a, p.r.token, address(harness), tIn);
        bytes[] memory params = new bytes[](3);
        // forge-lint: disable-next-line(unsafe-typecast)
        params[0] = abi.encode(IV4Router.ExactInputSingleParams(p.key, p.tIsCurrency0, uint128(tIn), 1, 0, ""));
        params[1] = abi.encode(Currency.wrap(p.r.token), tIn);
        params[2] = abi.encode(Currency.wrap(p.r.quote), uint256(1));
        _swap(label, a, p, _actions(Actions.SWAP_EXACT_IN_SINGLE), params);
    }

    function _actions(uint256 swapAction) internal pure returns (bytes memory) {
        // casting to 'uint8' is safe because v4-periphery action ids are < 256
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(uint8(swapAction), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
    }

    function _swap(string memory label, Actor memory a, Pair memory p, bytes memory actions, bytes[] memory params)
        internal
    {
        uint256 qBefore = _balance(p.r.quote, a.addr);
        uint256 tBefore = _balance(p.r.token, a.addr);
        uint256 receipts = p.collector.receiptCount();
        vm.broadcast(a.key);
        harness.execute(abi.encode(actions, params));
        require(p.collector.receiptCount() == receipts + 1, "E2E: every swap is one fee event");
        console.log(label, a.name);
        _logDelta("  Q delta (raw)", qBefore, _balance(p.r.quote, a.addr));
        _logDelta("  T delta (raw)", tBefore, _balance(p.r.token, a.addr));
        if (p.r.mirror != address(0)) console.log("  NFTs held", _balance(p.r.mirror, a.addr));
    }

    function _logDelta(string memory label, uint256 before, uint256 afterwards) internal pure {
        if (afterwards >= before) console.log(string.concat(label, " +"), afterwards - before);
        else console.log(string.concat(label, " -"), before - afterwards);
    }

    function _processFees(string memory label, Pair memory p) internal {
        uint256 pendingT = p.collector.pendingBurnT();
        uint256 pendingQ = p.collector.protocolQPending();
        vm.broadcast(keeper.key);
        (uint256 burned, uint256 paid) = p.collector.processFees();
        require(burned == pendingT && paid == pendingQ, "E2E: processFees amounts");
        console.log(label);
        console.log("  burned fee T (raw)", burned);
        console.log("  protocol Q to the treasury (raw)", paid);
    }

    function _claimQ(string memory label, Actor memory a, Pair memory p) internal {
        uint256 owed = p.ledger.claimable(a.addr);
        uint256 before = _balance(p.r.quote, a.addr);
        vm.broadcast(a.key);
        uint256 paid = p.ledger.claim(a.addr);
        require(paid == owed && _balance(p.r.quote, a.addr) - before == owed, "E2E: claim paid the entitlement");
        console.log(label, a.name);
        console.log("  claimed Q (raw)", paid);
    }

    /// R = T: quote the conversion like an app's eth_call (a snapshot, reverted), then submit it with a 1% minimum.
    function _claimT(string memory label, Actor memory a, Pair memory p) internal {
        uint256 owed = p.ledger.claimable(a.addr);
        uint256 snap = vm.snapshotState();
        vm.prank(a.addr);
        (, uint256 quoted) = s.converter.claimAsT(p.r.pairId, 0, deadline);
        vm.revertToState(snap);
        uint256 minOut = quoted * 99 / 100;
        uint256 before = _balance(p.r.token, a.addr);
        vm.broadcast(a.key);
        (uint256 qIn, uint256 tOut) = s.converter.claimAsT(p.r.pairId, minOut, deadline);
        require(qIn == owed && tOut >= minOut && _balance(p.r.token, a.addr) - before == tOut, "E2E: conversion");
        console.log(label, a.name);
        console.log("  entitlement converted (raw Q)", qIn);
        console.log("  T paid (raw)", tOut);
        console.log("  minTOut (quote - 1%)", minOut);
    }

    function _mockTetherRound() internal {
        MockTetherUSD usdt = MockTetherUSD(s.usdt);
        uint32 version = s.registry.latestTemplateFor(s.usdt);
        require(version != 0, "E2E: no USDT-TEST template");
        vm.broadcast(creator.key);
        (bytes32 pairId,) = s.launcher
            .createLaunch(
                SquareHoleLauncher.LaunchParams({
                    kind: SquareHoleRegistry.AssetKind.Token,
                    name: "E2E Tether pair (local test)",
                    symbol: "E2ET",
                    units: 1e9, // F10: every launch has exactly 1e9 tokens
                    fractionsPerNft: 1,
                    templateVersion: version,
                    payoutAsset: IRewardLedger.PayoutAsset.Q,
                    baseURI: "",
                    metadataManifestHash: keccak256("E2E Tether pair (local test): no metadata")
                })
            );
        console.log("17 USDT-TEST launch by the creator (fungible, 1e9 tokens, R = Q)");
        Pair memory p = _pair(s.registry, pairId);
        vm.broadcast(bob.key);
        usdt.faucet(1_000e6);
        vm.broadcast(carol.key);
        usdt.faucet(1_000e6);
        _buyExactIn("18 USDT-TEST pair buy exact-in (first buy: bootstrap)", bob, p, 500e6);
        _buyExactIn("19 USDT-TEST pair buy exact-in", carol, p, 300e6);
        _sellExactIn("20 USDT-TEST pair sell exact-in half", bob, p, _balance(p.r.token, bob.addr) / 2);
        _processFees("21 USDT-TEST pair processFees", p);
        _claimQ("22 USDT-TEST pair claim in Q (USDT-TEST, no-return transfer)", bob, p);
    }
}
