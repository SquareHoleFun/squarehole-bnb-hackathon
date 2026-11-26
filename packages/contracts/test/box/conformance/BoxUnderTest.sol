// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";

/// @notice The addresses of one box: what `BoxCreated` will carry (launch pipeline v1 § 3.9), read today from the
/// coordinator's getters (today's coordinator is `MisfitsGenesis`; the registry comes with S7).
struct BoxAddresses {
    address coordinator;
    address token;
    address collection;
    address vault;
    address hook;
    address receiver;
    address router;
    /// The ticket adapter of the placeholders add-on (F55); zero for a box without placeholders
    /// (`test_harness_adapterIffPlaceholdersAddOn`).
    address adapter;
    /// The box's swapping module: box 0's buy-and-burn executor (FIT's executor, `FitBuybackBurner`).
    address module;
    address poolManager;
    address randomnessSource;
    /// The platform's fixed address: the router's tax recipient and the 2/15 fee share (the Safe on mainnet).
    address platform;
}

/// @notice One way a box's spec differs from box 0's fixture (packages/box-spec/fixtures/box-0-misfits.json), and why.
/// `field` is a BoxSpecV1 field id (1-26, or 100 x add-on id (+ param index + 1) for add-ons).
/// Kinds: "instance" (a value box 0's fixture marks as replaced per deployment: reveal data, table, generator,
/// marketplace owner), "today" (today's contracts fix it in code; `note` names the slice that makes it data),
/// "build" (the neutral Sepolia rehearsal build, F30 Q2).
struct SpecDelta {
    uint16 field;
    string kind;
    string note;
}

/// @notice A known gap in a version constant: today's code fixes `name` (`<add-on key>.<constant>` as in
/// packages/box-spec/add-ons.v1.json) at `value` where the add-on catalog (`BoxSpecV1.ADD_ON_*`) has another value.
/// The check that reads the constant asserts the declared value, and fails when the gap is stale (the catalog already
/// has that value) or unread (no check reads that name).
struct ConstantGap {
    string name;
    uint256 value;
    string note;
}

/// @notice A box under test: its BoxSpec, the version context it validates under, its addresses, its creation block,
/// and the declared differences from box 0's fixture (the harness checks that exactly these fields differ).
struct BoxUnderTest {
    string name;
    /// "template-0" (today's Misfits contracts in a local test setup), "deployed" (a fork) or, from S7, "built".
    string provider;
    /// The template the box was built from, as the case file's `appliesTo` names it: "T0" (box 0, the Misfits),
    /// "T1"-"T10", "T3a". Checks of T0-only cases (and the box-0 parts of others) skip every other template.
    string template;
    BoxSpecV1.BoxSpec spec;
    /// The version whose context (`BoxSpecV1.contextV1()`, `contextV2()`) the spec validates under.
    uint16 version;
    BoxAddresses a;
    uint256 creationBlock;
    /// The creation block's timestamp (0: not known to the provider; open-at-clock-time.md).
    uint256 creationTime;
    /// Built in this test run: no outside party can have sent the box dust or forced ETH into it, so balance checks
    /// can be exact (a box on a fork may hold both).
    bool local;
    /// Scan every item id (a local box) or a sample (a fork, where every storage slot is an RPC call).
    bool fullScan;
    /// BC-055: how many single transfers the exchange probe batches.
    uint256 transferBatch;
    /// The randomness source the box's coordinator must pin: zero for the chain's production pin (`SourceCode.sol`); a
    /// local builder names the test source it gave the coordinator (BC-101 reads the coordinator's own and compares).
    address harnessSource;
    SpecDelta[] deltas;
    ConstantGap[] constantGaps;
}
