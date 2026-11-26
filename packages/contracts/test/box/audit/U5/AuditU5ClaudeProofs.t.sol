// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

/// @title AuditU5ClaudeProofsTest
/// @notice SH-AUDIT-B0 U5 (Claude): the proof tests. Each passes while the behaviour it pins exists and asserts what
/// is observed (box0-audit plan § 1.1); at fix time it is flipped into the property's assertion (red first). World:
/// the shared factory's box 0 in its Drawing phase (seven slots outside, J = 0).
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeProofsTest is AuditU5ClaudeBase {
    function setUp() public override {
        super.setUp();
        _toDrawing();
    }

    // W2-U5-1, accepted as built (FQ-22, F147): owners short by at most N - 1 - m raw units until the next fee.
    /// @notice AUDIT-U5-01 (low): after a full fee batch the stream can hold less T than its owners have accrued.
    /// @dev **Property** (BoxItemStream.sol:628-630, `_burnSurplus`: "less one raw unit per slot outside once started
    /// (J is floored, so each outside slot may be owed up to one more raw unit than J books yet; keeping m back means a
    /// later full collect always covers every owner)"; IBoxItemStream.sol:126-128, `liabilities()`;
    /// IBoxItemStream.sol:55-56, a claim "leaves the rest owed until the next collect()"): once a full batch has landed
    /// (no T left on its way: U = 0 and R below one fifteenth), the stream's T balance is at least `liabilities()`.
    /// **Expected:** balance ≥ liabilities after the batch.
    /// **Observed:** balance = liabilities − (k − 1), k being the slots that went outside after the last burn. The burn
    /// keeps the m raw units counted at the burn; a slot that leaves the vault later (a draw, a named pick) takes a
    /// whole J unit at J's next tick, although most of the remainder that tick completes was burned as the inside
    /// share while that slot was inside. In general the shortfall is at most N − 1 − m_b raw units, m_b the outside
    /// count at the last burn that burned (N − 2 = 1,967 at N 1,969 while a slot stays outside at the burn), and it
    /// needs the remainder (X − X₀) mod N at that burn to be within k of N: rare and a few raw units in a natural
    /// life, up to that bound with deliberate dust. It heals as fees bring the inside slots' share above it (the
    /// test's next 1,000 T sell did); while it lasts, the last claimer is paid that much less and the rest stays owed.
    /// **Steps** (amounts as run): a sell of 10,000,000 T and a 1 ETH buy, then a batch (its notice burns: balance =
    /// liabilities + 7); a gift of N − 1 − r raw units brings r = (X − X₀) mod N to N − 1 = 1,968 and `burn()` burns
    /// its surplus (balance = liabilities + 7 again); three draws by eoa[2] (m 7 → 10, no burn); a gift of 1 raw unit
    /// (J + 1: liabilities + 10, balance + 1); a 0.6 ETH buy and a full batch (Q fees only, nothing pending after it).
    /// **Amounts:** balance 308,109,023,192,822,075,505, liabilities 308,109,023,192,822,075,507 raw units: short 2.
    function testAccepted_AUDIT_U5_01_fullBatchCanLeaveOwnersUncovered() public {
        _sell(eoa[2], 10_000_000 ether);
        _buy(eoa[4], 1 ether);
        _collect(keeper, keeper);
        uint256 m0 = stream.outsideCount();
        assertEq(m0, 7);
        assertEq(token.balanceOf(a.itemStream), stream.liabilities() + m0, "the batch's notice burned to the margin");
        // r = (X − X0) mod N to N − 1, then a burn at that remainder.
        uint256 r = (stream.streamValue() - stream.startValue()) % editionSize;
        if (r != editionSize - 1) _transferT(eoa[2], a.itemStream, editionSize - 1 - r);
        vm.prank(eoa[5]);
        stream.burn();
        assertEq((stream.streamValue() - stream.startValue()) % editionSize, editionSize - 1, "r = N - 1");
        assertEq(token.balanceOf(a.itemStream), stream.liabilities() + m0, "burned to the margin again");
        // k = 3 slots go outside, no burn between.
        for (uint256 i; i < 3; ++i) {
            _draw(eoa[2], AUDIT_DRAW_VALUE);
        }
        uint256 k = stream.outsideCount() - m0;
        assertEq(k, 3);
        // One raw unit arrives: J ticks once, every one of the m0 + k slots accrues a whole unit.
        uint256 j0 = stream.index();
        _transferT(eoa[2], a.itemStream, 1);
        assertEq(stream.index(), j0 + 1);
        // A full batch: Q fees only, so after it nothing is on its way (X == F).
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
        assertEq(_streamPending(), 0, "nothing pending: a full batch");
        uint256 held = token.balanceOf(a.itemStream);
        uint256 owed = stream.liabilities();
        emit log_named_uint("stream T balance after the full batch", held);
        emit log_named_uint("liabilities()", owed);
        // Observed (the defect): the owners' accrual exceeds the T held by k − 1.
        assertEq(owed - held, k - 1, "short by k - 1 raw units after a full batch");
        // The bound: N - 1 - m at the burn (here 1,961).
        assertLe(owed - held, editionSize - 1 - m0);
        // It heals with the next real fee (the inside share refills the shortfall).
        _sell(eoa[2], 1_000 ether);
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
        assertGe(token.balanceOf(a.itemStream), stream.liabilities(), "covered again after a real fee");
    }

    // W2-U5-2, accepted as built (F147, the register's default): the comment's figure was corrected in 603da37ad.
    /// @notice AUDIT-U5-02 (note): the stated lifetime margin of a record's 96-bit J is too high by a factor of about
    /// 3·10^16.
    /// @dev **Property** (BoxItemStream.sol:497, `_record`: "J < 2^96: X − X₀ would need N·2^96 raw T (above 10^31 FIT
    /// for N 4,269)"): the comment states the T the stream must receive before J overflows a record's 96 bits.
    /// **Expected:** N·2^96 raw T above 10^31 FIT (10^49 raw units) for N 4,269.
    /// **Observed:** N·2^96 = 3.38·10^32 raw units = 3.38·10^14 FIT for N 4,269 (1.56·10^14 FIT at the mainnet
    /// edition's 1,969): the figure reads as raw units written as FIT. The conclusion still holds by far (the stream
    /// would need fees worth about 156,000 times T's whole issuance at N 1,969; past it `_record` masks J to 96 bits
    /// and a record would wrap), so the comment's figure, not the code, is wrong.
    /// **Steps:** the arithmetic, at N 4,269 and at this world's N 1,969.
    function testAccepted_AUDIT_U5_02_recordWidthCommentOverstatesItsMargin() public view {
        uint256 j96 = uint256(1) << 96;
        uint256 at4269 = 4_269 * j96;
        uint256 claimed = 1e31 * 1e18; // "10^31 FIT" in raw units
        assertLt(at4269, claimed, "N 4,269 needs far less than 10^31 FIT");
        assertEq(at4269 / 1e18, 338_225_025_773_394, "3.38e14 FIT at N 4,269");
        uint256 at1969 = editionSize * j96;
        assertEq(at1969 / 1e18, 156_000_251_990_586, "1.56e14 FIT at N 1,969");
        assertGt(at1969 / BoxSpecV1.ISSUANCE, 155_000, "still 156,000 issuances of fees");
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeProofsAmsterdamTest is AuditU5ClaudeProofsTest {}
