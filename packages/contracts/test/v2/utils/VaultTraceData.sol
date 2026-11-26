// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @notice Shared reader for the trace exports in test/vectors/v2-vault (`squarehole.vault-trace.forge/v2`, written by
/// packages/domain/src/test-support/vault-trace/forge.ts; placeholder tickets stage 1). Used by the recomputation
/// (`VaultTraceFixtures.t.sol`) and the contract replay (`MisfitsVaultTraces.t.sol`). Test only.
///
/// Column layout: one array per field; per-account columns are step-major (account i after step s is at
/// s·numAccounts + i); ID lists use start/count offsets (a take's IDs are the IDs it reserved); a custody holder below
/// numAccounts is that account, equal to numAccounts the vault, numAccounts + 1 + i account i's tickets. Every
/// `vm.parseJson*` call copies the whole file into EVM memory, which is never freed, so large traces get a test each.
abstract contract VaultTraceData is Test {
    string internal constant DIR = "/test/vectors/v2-vault/";

    uint256 internal constant OP_WITHDRAW = 0; // named pick of revealed shelf Misfits
    uint256 internal constant OP_RETURN = 1;
    uint256 internal constant OP_TRANSFER_MISFIT = 2;
    uint256 internal constant OP_TRANSFER_FIT = 3;
    uint256 internal constant OP_SEND_FIT = 4;
    uint256 internal constant OP_SEND_MISFIT = 5;
    uint256 internal constant OP_BURN = 6;
    uint256 internal constant OP_ALLOCATE = 7;
    uint256 internal constant OP_CLAIM = 8;
    uint256 internal constant OP_TAKE = 9;
    uint256 internal constant OP_RELEASE = 10;
    uint256 internal constant OP_DELIVER = 11;
    uint256 internal constant OP_OPEN_GATE = 12;
    uint256 internal constant OP_REVEAL = 13;
    uint256 internal constant OP_TRANSFER_TICKET = 14;
    uint256 internal constant OP_WAIVE_HAND_BACK_FEE = 15; // the coordinator's F38 (4) hook (stage-1 review)

    // Refusal codes, in the export's `errorCodes` order (forge.ts ERROR_CODES); 0 = success.
    uint256 internal constant ERR_INVALID_QUANTITY = 1;
    uint256 internal constant ERR_LAST_MISFIT = 2;
    uint256 internal constant ERR_MAX_FIT_EXCEEDED = 3;
    uint256 internal constant ERR_MIN_FIT_NOT_MET = 4;
    uint256 internal constant ERR_INSUFFICIENT_FIT = 5;
    uint256 internal constant ERR_INELIGIBLE_IDS = 6;
    uint256 internal constant ERR_INVALID_ID_LIST = 7;
    uint256 internal constant ERR_NOT_OWNER = 8;
    uint256 internal constant ERR_RETURN_BELOW_UNIT = 9;
    uint256 internal constant ERR_ESCROW_INSOLVENT = 10;
    uint256 internal constant ERR_DUST_GUARD = 11;
    uint256 internal constant ERR_STREAM_NOT_FUNDED = 12;
    uint256 internal constant ERR_UNSOLICITED_MISFIT = 13;
    uint256 internal constant ERR_GATE_CLOSED = 17;
    uint256 internal constant ERR_GATE_ALREADY_OPEN = 18;
    uint256 internal constant ERR_NO_HIDDEN = 19;
    uint256 internal constant ERR_HIDDEN_MISFIT = 20;
    uint256 internal constant ERR_NOT_REVEALED = 21;
    uint256 internal constant ERR_NOT_REVEALABLE = 22;
    uint256 internal constant ERR_ALREADY_REVEALED = 23;
    uint256 internal constant ERR_FEE_ALREADY_WAIVED = 24;

    uint256 internal constant LIMIT_MAX_FIT = 1;
    uint256 internal constant LIMIT_MIN_FIT = 2;

    struct Ops {
        uint256[] kind;
        uint256[] a;
        uint256[] b;
        uint256[] amount;
        uint256[] tokenId;
        uint256[] count;
        uint256[] limitKind;
        uint256[] limit;
        uint256[] idsStart;
        uint256[] idsCount;
        uint256[] ids;
    }

    struct Expected {
        uint256[] err;
        uint256[] principal;
        uint256[] fee;
        uint256[] streamBurned;
        uint256[] streamCredited;
        uint256[] streamDust;
        uint256[] paid;
        uint256[] supply;
        uint256[] escrow;
        uint256[] unsolicited;
        uint256[] vaultFit;
        uint256[] active;
        uint256[] inside;
        uint256[] hidden;
        uint256[] tickets;
        uint256[] gateOpen;
        uint256[] revealed;
        uint256[] burned;
        uint256[] reserve;
        uint256[] balances;
        uint256[] claimable;
        uint256[] nftCounts;
        uint256[] ticketCounts;
        uint256[] quoteW;
        uint256[] quoteWErr;
        uint256[] quoteR;
        uint256[] quoteRErr;
        uint256[] quoteT;
        uint256[] quoteTErr;
        uint256[] kFloor;
        uint256[] kRem;
        uint256[] custodyStart;
        uint256[] custodyCount;
        uint256[] custodyId;
        uint256[] custodyHolder;
    }

    struct Meta {
        string id;
        uint256 steps;
        uint256 accounts;
        uint256 collection;
        uint256 initialSupply;
        bool rawBalance;
        uint256 drawBps;
        uint256 pickBps;
        uint256 returnBps;
        uint256[] initBalances;
    }

    struct State {
        uint256 supply;
        uint256 escrow;
        uint256 unsolicited;
        uint256 inside;
        uint256 hidden;
        uint256 tickets;
        bool gateOpen;
        uint256 revealed;
        uint256 burned;
        uint256 reserve;
        uint256[] balances;
        uint256[] claimable;
        uint256[] nftCounts;
        uint256[] ticketCounts;
    }

    // ------------------------------------------------------------------------------------------------------------
    // Loading

    function _read(string memory id) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), DIR, id, ".json"));
    }

    function _uints(string memory json, string memory key) internal pure returns (uint256[] memory out) {
        string[] memory raw = vm.parseJsonStringArray(json, key);
        out = new uint256[](raw.length);
        for (uint256 i; i < raw.length; ++i) {
            out[i] = vm.parseUint(raw[i]);
        }
    }

    function _meta(string memory json) internal pure returns (Meta memory m) {
        m.id = vm.parseJsonString(json, ".id");
        m.steps = vm.parseJsonUint(json, ".steps");
        m.accounts = vm.parseJsonUint(json, ".numAccounts");
        m.collection = vm.parseJsonUint(json, ".collectionSize");
        m.initialSupply = vm.parseUint(vm.parseJsonString(json, ".initialSupply"));
        m.rawBalance = vm.parseJsonBool(json, ".rawBalanceDonations");
        m.drawBps = vm.parseJsonUint(json, ".feeDrawBps");
        m.pickBps = vm.parseJsonUint(json, ".feePickBps");
        m.returnBps = vm.parseJsonUint(json, ".feeReturnBps");
        m.initBalances = _uints(json, ".initBalances");
    }

    function _ops(string memory json) internal pure returns (Ops memory o) {
        o.kind = vm.parseJsonUintArray(json, ".opKind");
        o.a = vm.parseJsonUintArray(json, ".opA");
        o.b = vm.parseJsonUintArray(json, ".opB");
        o.amount = _uints(json, ".opAmount");
        o.tokenId = vm.parseJsonUintArray(json, ".opTokenId");
        o.count = vm.parseJsonUintArray(json, ".opCount");
        o.limitKind = vm.parseJsonUintArray(json, ".opLimitKind");
        o.limit = _uints(json, ".opLimit");
        o.idsStart = vm.parseJsonUintArray(json, ".opIdsStart");
        o.idsCount = vm.parseJsonUintArray(json, ".opIdsCount");
        o.ids = vm.parseJsonUintArray(json, ".opIds");
    }

    function _expected(string memory json) internal pure returns (Expected memory e) {
        e.err = vm.parseJsonUintArray(json, ".expError");
        e.principal = _uints(json, ".expPrincipal");
        e.fee = _uints(json, ".expFee");
        e.streamBurned = _uints(json, ".expStreamBurned");
        e.streamCredited = _uints(json, ".expStreamCredited");
        e.streamDust = _uints(json, ".expStreamDust");
        e.paid = _uints(json, ".expPaid");
        e.supply = _uints(json, ".expSupply");
        e.escrow = _uints(json, ".expEscrow");
        e.unsolicited = _uints(json, ".expUnsolicited");
        e.vaultFit = _uints(json, ".expVaultFit");
        e.active = _uints(json, ".expActive");
        e.inside = vm.parseJsonUintArray(json, ".expInside");
        e.hidden = vm.parseJsonUintArray(json, ".expHidden");
        e.tickets = vm.parseJsonUintArray(json, ".expTickets");
        e.gateOpen = vm.parseJsonUintArray(json, ".expGateOpen");
        e.revealed = vm.parseJsonUintArray(json, ".expRevealed");
        e.burned = _uints(json, ".expBurned");
        e.reserve = _uints(json, ".expClaimsReserve");
        e.balances = _uints(json, ".expBalances");
        e.claimable = _uints(json, ".expClaimable");
        e.nftCounts = vm.parseJsonUintArray(json, ".expNftCounts");
        e.ticketCounts = vm.parseJsonUintArray(json, ".expTicketCounts");
        e.quoteW = _uints(json, ".expQuoteWithdraw1");
        e.quoteWErr = vm.parseJsonUintArray(json, ".expQuoteWithdraw1Error");
        e.quoteR = _uints(json, ".expQuoteReturn1");
        e.quoteRErr = vm.parseJsonUintArray(json, ".expQuoteReturn1Error");
        e.quoteT = _uints(json, ".expQuoteTake1");
        e.quoteTErr = vm.parseJsonUintArray(json, ".expQuoteTake1Error");
        e.kFloor = _uints(json, ".expSurplusFloor");
        e.kRem = _uints(json, ".expSurplusRemainder");
        e.custodyStart = vm.parseJsonUintArray(json, ".expCustodyStart");
        e.custodyCount = vm.parseJsonUintArray(json, ".expCustodyCount");
        e.custodyId = vm.parseJsonUintArray(json, ".expCustodyId");
        e.custodyHolder = vm.parseJsonUintArray(json, ".expCustodyHolder");
    }

    function _stateAt(Expected memory e, uint256 s, uint256 k) internal pure returns (State memory st) {
        st.supply = e.supply[s];
        st.escrow = e.escrow[s];
        st.unsolicited = e.unsolicited[s];
        st.inside = e.inside[s];
        st.hidden = e.hidden[s];
        st.tickets = e.tickets[s];
        st.gateOpen = e.gateOpen[s] == 1;
        st.revealed = e.revealed[s];
        st.burned = e.burned[s];
        st.reserve = e.reserve[s];
        st.balances = new uint256[](k);
        st.claimable = new uint256[](k);
        st.nftCounts = new uint256[](k);
        st.ticketCounts = new uint256[](k);
        for (uint256 i; i < k; ++i) {
            st.balances[i] = e.balances[s * k + i];
            st.claimable[i] = e.claimable[s * k + i];
            st.nftCounts[i] = e.nftCounts[s * k + i];
            st.ticketCounts[i] = e.ticketCounts[s * k + i];
        }
    }

    function _index() internal view returns (string[] memory files) {
        string memory index = vm.readFile(string.concat(vm.projectRoot(), DIR, "index.json"));
        files = vm.parseJsonStringArray(index, ".files");
    }

    function _opIds(Ops memory o, uint256 s) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](o.idsCount[s]);
        for (uint256 j; j < ids.length; ++j) {
            ids[j] = o.ids[o.idsStart[s] + j];
        }
    }

    function _startsWith(string memory s, string memory prefix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory p = bytes(prefix);
        if (a.length < p.length) return false;
        for (uint256 i; i < p.length; ++i) {
            if (a[i] != p[i]) return false;
        }
        return true;
    }
}
