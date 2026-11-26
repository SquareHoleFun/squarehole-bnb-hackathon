// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Test.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {VaultTraceData} from "./utils/VaultTraceData.sol";

/// @notice v2 T06 (placeholder tickets stage 1): loads every trace export in test/vectors/v2-vault (written by
/// packages/domain from the TypeScript reference and checked there against the preserved Python oracle) and re-derives,
/// in Solidity, every quote, principal, flat fee (`ceil(p × bps ÷ 10,000)`, ADR-0014 § G05), stream split, count
/// (n = h + s, m = outside Misfits + t) and docs/03 identity with 512-bit arithmetic (FullMath, the pinned v4-core
/// library). Inputs reach S = 2^256 - 1 (VLT-12), so every product that can pass 256 bits goes through mulDiv or the
/// 512-bit helpers below.
///
/// This is not the vault. It proves that the contract tests can read the same traces and that Solidity integer
/// rounding equals the reference on every raw integer. The loading code and column layout it shares with the contract
/// replay (`MisfitsVaultTraces.t.sol`) live in `utils/VaultTraceData.sol`.
///
/// Only the 46 quote-neutral traces are re-derived here. The 8 raw-balance traces (donations join E) are retired from
/// the contract tests since FIT refuses sends to the vault (F24 d); they stay in the corpus for the TypeScript
/// reference and the Python oracle (`pnpm check:traces`), which still check every one of the 54.
contract VaultTraceFixturesTest is VaultTraceData {
    struct U512 {
        uint256 hi;
        uint256 lo;
    }

    /// holder[id]: 0 inside the vault, 1 + i account i's Misfit, 1 + k + i account i's ticket (a reserved ID).
    struct Custody {
        uint256[] holder;
        bool[] left;
        bool[] revealed;
        uint256[] counts;
        uint256[] ticketCounts;
        /// The coordinator waived the hand-back fee (an op, not a state field).
        bool waived;
    }

    uint256 internal tracesChecked;
    uint256 internal rawBalanceRetired;
    uint256 internal stepsChecked;
    uint256 internal wideProducts;
    uint256 internal feesChecked;

    // One test per worked example (SIM-01): every vm.parseJson* call copies the whole file into EVM memory, which is
    // never freed, so large traces get a fresh test each.
    function test_EX01() public {
        _checkTrace("ex01");
    }

    function test_EX02() public {
        _checkTrace("ex02");
    }

    function test_EX03() public {
        _checkTrace("ex03");
    }

    function test_EX04() public {
        _checkTrace("ex04");
    }

    function test_EX05_immediate() public {
        _checkTrace("ex05-immediate");
    }

    function test_EX05_delayed() public {
        _checkTrace("ex05-delayed");
    }

    function test_EX06() public {
        _checkTrace("ex06");
    }

    function test_EX07() public {
        _checkTrace("ex07");
    }

    function test_EX08() public {
        _checkTrace("ex08");
    }

    function test_examplesAreListed() public view {
        string memory index = vm.readFile(string.concat(vm.projectRoot(), DIR, "index.json"));
        string[] memory files = vm.parseJsonStringArray(index, ".files");
        uint256 examples;
        for (uint256 i; i < files.length; ++i) {
            if (_startsWith(files[i], "ex")) examples += 1;
        }
        assertEq(examples, 9, "EX01-EX08, EX05 in two branches; one test each above");
    }

    function test_adversarialFamilies() public {
        _checkGroup("adv-");
        assertEq(tracesChecked, 22, "25 adversarial traces, 3 of them raw-balance (retired)");
        assertEq(rawBalanceRetired, 3);
        assertGt(feesChecked, 50, "charged steps");
    }

    function test_seededRandomTraces() public {
        _checkGroup("rnd-");
        assertEq(tracesChecked, 16, "21 random traces, 5 of them raw-balance (retired)");
        assertEq(rawBalanceRetired, 5);
        assertGt(wideProducts, 0, "S = 2^256 - 1 traces need 512-bit products");
        assertGt(feesChecked, 20, "charged steps");
    }

    function test_indexCoversEveryFile() public view {
        string memory index = vm.readFile(string.concat(vm.projectRoot(), DIR, "index.json"));
        assertEq(vm.parseJsonString(index, ".schema"), "squarehole.vault-trace.forge-index/v2");
        string[] memory files = vm.parseJsonStringArray(index, ".files");
        assertEq(files.length, vm.parseJsonUint(index, ".traces"));
        uint256 steps;
        for (uint256 i; i < files.length; ++i) {
            string memory json = _read(files[i]);
            assertEq(vm.parseJsonString(json, ".schema"), "squarehole.vault-trace.forge/v2");
            steps += vm.parseJsonUint(json, ".steps");
        }
        assertEq(steps, vm.parseJsonUint(index, ".steps"));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Replay

    function _checkGroup(string memory prefix) internal {
        string memory index = vm.readFile(string.concat(vm.projectRoot(), DIR, "index.json"));
        string[] memory files = vm.parseJsonStringArray(index, ".files");
        for (uint256 i; i < files.length; ++i) {
            if (_startsWith(files[i], prefix)) _checkTrace(files[i]);
        }
        console.log("traces", tracesChecked, "steps", stepsChecked);
        console.log("steps with a product above 2^256", wideProducts);
        console.log("charged steps (fee > 0)", feesChecked);
    }

    function _checkTrace(string memory id) internal {
        string memory json = _read(id);
        Meta memory m = _meta(json);
        assertEq(m.id, id);
        if (m.rawBalance) {
            rawBalanceRetired += 1;
            return;
        }
        Ops memory o = _ops(json);
        Expected memory e = _expected(json);
        assertEq(o.kind.length, m.steps, "op columns");
        assertEq(e.supply.length, m.steps, "state columns");
        assertEq(e.balances.length, m.steps * m.accounts, "account columns");
        assertTrue(
            (m.drawBps == 0 && m.pickBps == 0 && m.returnBps == 0)
                || (m.drawBps == 100 && m.pickBps == 2_500 && m.returnBps == 500),
            "fee policy none or flat-f23"
        );

        State memory pre = State({
            supply: m.initialSupply,
            escrow: 0,
            unsolicited: 0,
            inside: m.collection,
            hidden: m.collection,
            tickets: 0,
            gateOpen: false,
            revealed: 0,
            burned: 0,
            reserve: 0,
            balances: m.initBalances,
            claimable: new uint256[](m.accounts),
            nftCounts: new uint256[](m.accounts),
            ticketCounts: new uint256[](m.accounts)
        });
        uint256 issued;
        for (uint256 i; i < m.accounts; ++i) {
            issued += m.initBalances[i];
        }
        assertEq(issued, m.initialSupply, "one-time issuance");

        Custody memory c = Custody({
            holder: new uint256[](m.collection),
            left: new bool[](m.collection),
            revealed: new bool[](m.collection),
            counts: new uint256[](m.accounts),
            ticketCounts: new uint256[](m.accounts),
            waived: false
        });
        for (uint256 s; s < m.steps; ++s) {
            State memory post = _stateAt(e, s, m.accounts);
            _checkIdentities(m, e, s, post);
            _checkTransition(m, o, e, s, pre, post, c);
            _applyCustody(m, o, e, s, c);
            assertEq(c.counts, post.nftCounts, "NFT counts follow the custody changes");
            assertEq(c.ticketCounts, post.ticketCounts, "ticket counts follow the custody changes");
            _checkHidden(m, c, post);
            pre = post;
        }
        _checkFinal(json, m, c.holder);
        tracesChecked += 1;
        stepsChecked += m.steps;
    }

    /// docs/03 after every step: A = S - E, A >= n, E*n >= m*A, K = floor + rem/n exactly, (E + D)*n >= m*A,
    /// S + burned = issuance, sum of holdings = S, sum of claimable = reserve, NFT + ticket counts = m, and the quotes.
    function _checkIdentities(Meta memory m, Expected memory e, uint256 s, State memory st) internal {
        uint256 n = st.inside;
        assertGe(n, 1, "block-last: n >= 1");
        assertLe(st.hidden, n, "h <= n");
        assertLe(n + st.tickets, m.collection, "n + t <= N");
        assertEq(e.active[s], st.supply - st.escrow, "A = S - E");
        assertGe(e.active[s], n, "A >= n");
        assertEq(e.vaultFit[s], st.escrow + st.unsolicited, "vault FIT = E + D");
        if (_checkSolvency(st, m.collection - n, e.active[s], e.kFloor[s], e.kRem[s])) wideProducts += 1;
        _checkSums(m, st);
        _checkQuotes(m, e, s, e.active[s], st);
    }

    /// E*n >= m*A and E*n - m*A = floor(K)*n + rem, in 512 bits. Returns true when a product passed 2^256.
    function _checkSolvency(State memory st, uint256 outside, uint256 a, uint256 kFloor, uint256 kRem)
        internal
        pure
        returns (bool wide)
    {
        U512 memory ma = _mul(outside, a);
        U512 memory en = _mul(st.escrow, st.inside);
        wide = en.hi != 0 || ma.hi != 0;
        assertTrue(_ge(en, ma), "E*n >= m*A");
        U512 memory kn = _sub(en, ma);
        U512 memory split = _addSmall(_mul(kFloor, st.inside), kRem);
        assertTrue(kn.hi == split.hi && kn.lo == split.lo, "E*n - m*A = floor(K)*n + rem");
        assertLt(kRem, st.inside, "rem < n");
        assertTrue(_ge(_mul(st.escrow + st.unsolicited, st.inside), ma), "(E + D)*n >= m*A");
    }

    function _checkSums(Meta memory m, State memory st) internal pure {
        uint256 held = st.escrow + st.unsolicited + st.reserve;
        uint256 claims;
        uint256 counts;
        uint256 tickets;
        for (uint256 i; i < m.accounts; ++i) {
            held += st.balances[i];
            claims += st.claimable[i];
            counts += st.nftCounts[i];
            tickets += st.ticketCounts[i];
        }
        assertEq(held, st.supply, "sum of holdings = S");
        assertEq(st.supply + st.burned, m.initialSupply, "S + burned = issuance (GOV-05)");
        assertEq(claims, st.reserve, "sum of claimable = reserve");
        assertEq(tickets, st.tickets, "sum of ticket counts = t");
        assertEq(counts + tickets, m.collection - st.inside, "Misfits outside + t = m");
    }

    function _checkQuotes(Meta memory m, Expected memory e, uint256 s, uint256 a, State memory st) internal pure {
        uint256 n = st.inside;
        uint256 outside = m.collection - n;
        if (n == 1) {
            assertEq(e.quoteWErr[s], ERR_LAST_MISFIT, "last Misfit");
            assertEq(e.quoteTErr[s], ERR_LAST_MISFIT, "last Misfit (ticket)");
        } else {
            uint256 principal = FullMath.mulDivRoundingUp(a, 1, n);
            assertEq(e.quoteWErr[s], 0);
            assertEq(e.quoteW[s], principal, "withdraw quote = ceil(A/n)");
            if (st.hidden == 0) {
                assertEq(e.quoteTErr[s], ERR_NO_HIDDEN, "no hidden Misfit for a ticket");
            } else {
                assertEq(e.quoteTErr[s], 0);
                assertEq(e.quoteT[s], principal + _fee(principal, m.drawBps), "ticket quote = ceil(A/n) + draw fee");
            }
        }
        if (outside == 0) {
            assertEq(e.quoteRErr[s], ERR_INVALID_QUANTITY, "nothing outside");
        } else if (a / n == 0) {
            assertEq(e.quoteRErr[s], ERR_RETURN_BELOW_UNIT);
        } else {
            assertEq(e.quoteRErr[s], 0);
            assertEq(e.quoteR[s], a / n, "return quote = floor(A/n)");
        }
    }

    /// ceil(p × bps ÷ 10,000) in full precision (p reaches 2^256 - 1).
    function _fee(uint256 principal, uint256 bps) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(principal, bps, 10_000);
    }

    function _checkTransition(
        Meta memory m,
        Ops memory o,
        Expected memory e,
        uint256 s,
        State memory pre,
        State memory post,
        Custody memory c
    ) internal {
        uint256 kind = o.kind[s];
        _checkResultColumns(kind, e, s);
        assertLe(post.supply, pre.supply, "S never rises");
        assertGe(post.unsolicited, pre.unsolicited, "D never falls");
        assertTrue(!pre.gateOpen || post.gateOpen, "the gate never closes");
        if (e.err[s] != 0) {
            assertTrue(kind != OP_SEND_MISFIT || e.err[s] == ERR_UNSOLICITED_MISFIT || e.err[s] == ERR_NOT_OWNER);
            _assertSame(pre, post);
            assertEq(e.custodyCount[s], 0, "a refusal moves no Misfit");
            return;
        }
        assertTrue(kind != OP_SEND_MISFIT, "a Misfit sent to the vault is always refused");
        State memory want = _copyState(pre);
        want.nftCounts = post.nftCounts;
        want.ticketCounts = post.ticketCounts;
        if (kind <= OP_RETURN || kind == OP_TAKE || kind == OP_RELEASE) {
            _checkConversion(m, o, e, s, pre, want, c);
        } else if (kind == OP_DELIVER) {
            assertTrue(pre.gateOpen, "delivered after graduation only");
            want.tickets -= o.idsCount[s];
        } else if (kind == OP_OPEN_GATE) {
            assertFalse(pre.gateOpen, "the gate opens once");
            want.gateOpen = true;
        } else if (kind == OP_WAIVE_HAND_BACK_FEE) {
            assertFalse(pre.gateOpen || c.waived, "waived once, before graduation");
            c.waived = true;
        } else if (kind == OP_REVEAL) {
            want.revealed += o.idsCount[s];
            for (uint256 j; j < o.idsCount[s]; ++j) {
                uint256 id = o.ids[o.idsStart[s] + j];
                assertTrue(c.left[id] && !c.revealed[id], "revealed once, after it left the vault");
                c.revealed[id] = true;
            }
        } else if (kind == OP_TRANSFER_FIT) {
            want.balances[o.a[s]] -= o.amount[s];
            want.balances[o.b[s]] += o.amount[s];
        } else if (kind == OP_SEND_FIT) {
            // Quote-neutral D; the contract replay parks this FIT at 0x…dEaD instead (F24 d, F26 1).
            want.balances[o.a[s]] -= o.amount[s];
            want.unsolicited += o.amount[s];
        } else if (kind == OP_BURN) {
            want.balances[o.a[s]] -= o.amount[s];
            want.supply -= o.amount[s];
            want.burned += o.amount[s];
        } else if (kind == OP_ALLOCATE) {
            _checkStream(m, o, e, s, pre, want);
        } else if (kind == OP_CLAIM) {
            assertEq(e.paid[s], pre.claimable[o.a[s]], "claim pays what is claimable");
            want.balances[o.a[s]] += pre.claimable[o.a[s]];
            want.claimable[o.a[s]] = 0;
            want.reserve -= pre.claimable[o.a[s]];
        } else {
            assertTrue(kind == OP_TRANSFER_MISFIT || kind == OP_TRANSFER_TICKET, "known op");
        }
        _assertSame(want, post);
    }

    /// Take, release, named pick and return: the principal from the pre-operation state, the flat fee on it, and the
    /// fee burned after the principal moved (S falls by exactly the fee).
    function _checkConversion(
        Meta memory m,
        Ops memory o,
        Expected memory e,
        uint256 s,
        State memory pre,
        State memory want,
        Custody memory c
    ) internal {
        uint256 kind = o.kind[s];
        bool locks = kind == OP_TAKE || kind == OP_WITHDRAW;
        uint256 k = kind == OP_TAKE ? o.count[s] : o.idsCount[s];
        (uint256 principal, uint256 fee) = _principalAndFee(m, kind, pre, k, c.waived);
        assertEq(e.principal[s], principal, "principal from the pre-operation state");
        assertEq(e.fee[s], fee, "fee = ceil(p x bps / 10,000)");
        if (fee != 0) feesChecked += 1;
        if (o.limitKind[s] == LIMIT_MAX_FIT) assertLe(principal + fee, o.limit[s], "maxFit covers principal + fee");
        if (o.limitKind[s] == LIMIT_MIN_FIT) assertGe(principal - fee, o.limit[s], "minFit against the net");
        want.supply -= fee;
        want.burned += fee;
        if (locks) {
            want.escrow += principal;
            want.inside -= k;
            want.balances[o.a[s]] -= principal + fee;
        } else {
            assertLe(principal, pre.escrow, "released from E");
            want.escrow -= principal;
            want.inside += k;
            want.balances[o.a[s]] += principal - fee;
        }
        if (kind == OP_TAKE) {
            want.hidden -= k;
            want.tickets += k;
            assertEq(o.idsCount[s], k, "a take reserves k IDs");
        } else if (kind == OP_RELEASE) {
            want.hidden += k;
            want.tickets -= k;
        } else {
            _checkShelfSide(o, s, c, pre.gateOpen);
        }
        // The fee lands at the new occupancy: after the principal moved, A' - fee >= n' (the supply floor E + n).
        assertGe(want.supply - want.escrow, want.inside, "fee burn keeps one raw FIT per inside Misfit");
    }

    function _principalAndFee(Meta memory m, uint256 kind, State memory pre, uint256 k, bool waived)
        internal
        pure
        returns (uint256 principal, uint256 fee)
    {
        uint256 a = pre.supply - pre.escrow;
        bool locks = kind == OP_TAKE || kind == OP_WITHDRAW;
        principal = locks ? FullMath.mulDivRoundingUp(a, k, pre.inside) : FullMath.mulDiv(a, k, pre.inside);
        uint256 bps = kind == OP_TAKE
            ? m.drawBps
            : kind == OP_WITHDRAW ? m.pickBps : (kind == OP_RELEASE && (pre.gateOpen || waived)) ? 0 : m.returnBps;
        fee = _fee(principal, bps);
    }

    /// Named picks take revealed shelf IDs, returns need the reveal; both only after graduation.
    function _checkShelfSide(Ops memory o, uint256 s, Custody memory c, bool gateOpen) internal pure {
        assertTrue(gateOpen, "named picks and returns after graduation");
        bool pick = o.kind[s] == OP_WITHDRAW;
        for (uint256 j; j < o.idsCount[s]; ++j) {
            uint256 id = o.ids[o.idsStart[s] + j];
            assertTrue(c.revealed[id], "revealed");
            if (pick) assertTrue(c.holder[id] == 0 && c.left[id], "a named pick takes a shelf ID");
        }
    }

    /// Result columns that do not belong to the op kind (or to a refusal) must be zero.
    function _checkResultColumns(uint256 kind, Expected memory e, uint256 s) internal pure {
        bool ok = e.err[s] == 0;
        bool conversion = kind == OP_WITHDRAW || kind == OP_RETURN || kind == OP_TAKE || kind == OP_RELEASE;
        if (!ok || !conversion) {
            assertEq(e.principal[s], 0, "no principal");
            assertEq(e.fee[s], 0, "no fee");
        }
        if (!ok || kind != OP_ALLOCATE) {
            assertEq(e.streamBurned[s], 0, "no stream burn");
            assertEq(e.streamCredited[s], 0, "no stream credit");
            assertEq(e.streamDust[s], 0, "no stream dust");
        }
        if (!ok || kind != OP_CLAIM) assertEq(e.paid[s], 0, "no claim payment");
    }

    /// Equal-slot stream: floor(B*n/N) burns, floor(B*count/N) per outside owner (tickets count) is credited, the rest
    /// stays as dust.
    function _checkStream(
        Meta memory m,
        Ops memory o,
        Expected memory e,
        uint256 s,
        State memory pre,
        State memory want
    ) internal pure {
        uint256 budget = o.amount[s];
        uint256 burned = FullMath.mulDiv(budget, pre.inside, m.collection);
        uint256 credited;
        for (uint256 i; i < m.accounts; ++i) {
            uint256 count = pre.nftCounts[i] + pre.ticketCounts[i];
            if (count == 0) continue;
            uint256 credit = FullMath.mulDiv(budget, count, m.collection);
            want.claimable[i] += credit;
            credited += credit;
        }
        assertEq(e.streamBurned[s], burned, "stream burn = floor(B*n/N)");
        assertEq(e.streamCredited[s], credited, "stream credits = sum floor(B*count/N)");
        assertEq(e.streamDust[s], budget - burned - credited, "stream dust");
        want.balances[o.a[s]] -= burned + credited;
        want.supply -= burned;
        want.burned += burned;
        want.reserve += credited;
    }

    function _applyCustody(Meta memory m, Ops memory o, Expected memory e, uint256 s, Custody memory c) internal pure {
        uint256 k = m.accounts;
        uint256 start = e.custodyStart[s];
        for (uint256 j; j < e.custodyCount[s]; ++j) {
            uint256 id = e.custodyId[start + j];
            uint256 code = e.custodyHolder[start + j];
            uint256 to = code == k ? 0 : code < k ? code + 1 : code;
            assertLt(id, m.collection, "custody change for a collection ID");
            assertTrue(c.holder[id] != to, "a change changes the holder");
            _count(c, k, c.holder[id], false);
            _count(c, k, to, true);
            if (to != 0 && to <= k) c.left[id] = true;
            c.holder[id] = to;
        }
        if (e.err[s] != 0) return;
        uint256 kind = o.kind[s];
        uint256 a = o.a[s];
        if (kind == OP_WITHDRAW || kind == OP_RETURN || kind == OP_TAKE || kind == OP_RELEASE || kind == OP_DELIVER) {
            assertEq(e.custodyCount[s], o.idsCount[s], "every listed ID moved");
            uint256 want = kind == OP_TAKE ? a + 1 + k : (kind == OP_WITHDRAW || kind == OP_DELIVER) ? a + 1 : 0;
            for (uint256 j; j < o.idsCount[s]; ++j) {
                assertEq(c.holder[o.ids[o.idsStart[s] + j]], want, "the listed ID moved to the right holder");
            }
        } else if (kind == OP_TRANSFER_MISFIT) {
            assertEq(c.holder[o.tokenId[s]], o.b[s] + 1, "Misfit transfer");
        } else if (kind == OP_TRANSFER_TICKET) {
            assertEq(c.holder[o.tokenId[s]], o.b[s] + 1 + k, "placeholder transfer");
        } else {
            assertEq(e.custodyCount[s], 0, "no custody change");
        }
    }

    function _count(Custody memory c, uint256 k, uint256 holder, bool add) internal pure {
        if (holder == 0) return;
        if (holder <= k) {
            if (add) c.counts[holder - 1] += 1;
            else c.counts[holder - 1] -= 1;
        } else if (add) {
            c.ticketCounts[holder - 1 - k] += 1;
        } else {
            c.ticketCounts[holder - 1 - k] -= 1;
        }
    }

    /// h = IDs never out and not reserved; the reveal count = the IDs revealed.
    function _checkHidden(Meta memory m, Custody memory c, State memory st) internal pure {
        uint256 hidden;
        uint256 revealed;
        for (uint256 id; id < m.collection; ++id) {
            if (!c.left[id] && c.holder[id] == 0) hidden += 1;
            if (c.revealed[id]) revealed += 1;
        }
        assertEq(hidden, st.hidden, "h = never out and not reserved");
        assertEq(revealed, st.revealed, "reveal count");
    }

    function _checkFinal(string memory json, Meta memory m, uint256[] memory holder) internal pure {
        uint256[] memory ids = vm.parseJsonUintArray(json, ".finalOutsideIds");
        uint256[] memory owners = vm.parseJsonUintArray(json, ".finalOutsideOwners");
        uint256[] memory tickets = vm.parseJsonUintArray(json, ".finalTicketIds");
        uint256[] memory holders = vm.parseJsonUintArray(json, ".finalTicketHolders");
        assertEq(ids.length, owners.length);
        assertEq(tickets.length, holders.length);
        uint256 outside;
        for (uint256 id; id < m.collection; ++id) {
            if (holder[id] != 0) outside += 1;
        }
        assertEq(outside, ids.length + tickets.length, "final number outside");
        for (uint256 j; j < ids.length; ++j) {
            assertEq(holder[ids[j]], owners[j] + 1, "final owner");
        }
        for (uint256 j; j < tickets.length; ++j) {
            assertEq(holder[tickets[j]], holders[j] + 1 + m.accounts, "final ticket holder");
        }
    }

    // ------------------------------------------------------------------------------------------------------------
    // Helpers

    function _assertSame(State memory x, State memory y) internal pure {
        assertEq(x.supply, y.supply, "S");
        assertEq(x.escrow, y.escrow, "E");
        assertEq(x.unsolicited, y.unsolicited, "D");
        assertEq(x.inside, y.inside, "n");
        assertEq(x.hidden, y.hidden, "h");
        assertEq(x.tickets, y.tickets, "t");
        assertEq(x.gateOpen, y.gateOpen, "gate");
        assertEq(x.revealed, y.revealed, "revealed");
        assertEq(x.burned, y.burned, "burned");
        assertEq(x.reserve, y.reserve, "claims reserve");
        assertEq(x.balances, y.balances, "balances");
        assertEq(x.claimable, y.claimable, "claimable");
        assertEq(x.nftCounts, y.nftCounts, "NFT counts");
        assertEq(x.ticketCounts, y.ticketCounts, "ticket counts");
    }

    /// A fresh copy (a memory struct assignment would alias `x`).
    function _copyState(State memory x) internal pure returns (State memory y) {
        y = State({
            supply: x.supply,
            escrow: x.escrow,
            unsolicited: x.unsolicited,
            inside: x.inside,
            hidden: x.hidden,
            tickets: x.tickets,
            gateOpen: x.gateOpen,
            revealed: x.revealed,
            burned: x.burned,
            reserve: x.reserve,
            balances: _copy(x.balances),
            claimable: _copy(x.claimable),
            nftCounts: _copy(x.nftCounts),
            ticketCounts: _copy(x.ticketCounts)
        });
    }

    function _copy(uint256[] memory xs) internal pure returns (uint256[] memory out) {
        out = new uint256[](xs.length);
        for (uint256 i; i < xs.length; ++i) {
            out[i] = xs[i];
        }
    }

    /// Full 512-bit product of two uint256.
    function _mul(uint256 x, uint256 y) internal pure returns (U512 memory r) {
        uint256 hi;
        uint256 lo;
        assembly ("memory-safe") {
            let mm := mulmod(x, y, not(0))
            lo := mul(x, y)
            hi := sub(sub(mm, lo), lt(mm, lo))
        }
        r.hi = hi;
        r.lo = lo;
    }

    function _ge(U512 memory x, U512 memory y) internal pure returns (bool) {
        return x.hi > y.hi || (x.hi == y.hi && x.lo >= y.lo);
    }

    /// x - y for x >= y.
    function _sub(U512 memory x, U512 memory y) internal pure returns (U512 memory r) {
        unchecked {
            r.lo = x.lo - y.lo;
            r.hi = x.hi - y.hi - (x.lo < y.lo ? 1 : 0);
        }
    }

    function _addSmall(U512 memory x, uint256 y) internal pure returns (U512 memory r) {
        unchecked {
            r.lo = x.lo + y;
            r.hi = x.hi + (r.lo < x.lo ? 1 : 0);
        }
    }
}
