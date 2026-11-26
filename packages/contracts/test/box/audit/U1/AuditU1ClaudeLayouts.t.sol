// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxCollection} from "../../../../src/box/BoxCollection.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxFactoryV1Planner} from "../../../../src/box/BoxFactoryV1Planner.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxItemStream} from "../../../../src/box/BoxItemStream.sol";
import {BoxLaunchRouter} from "../../../../src/box/BoxLaunchRouter.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {BoxVault} from "../../../../src/box/BoxVault.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BoxCloneArgs as A} from "../../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU1ClaudeKitBase} from "./AuditU1ClaudeBase.sol";

/// @notice TEST ONLY: the hook's internal argument readers, exposed (BoxHookBase's offsets, unchanged code).
contract AuditU1ClaudeHookReader is BoxHook {
    constructor(IPoolManager pm_, address coordinatorImplementation_, address extension_)
        BoxHook(pm_, coordinatorImplementation_, extension_)
    {}

    function readHot() external view returns (address q_, address t_, uint160 sqrtP1, uint160 sqrtP0) {
        return _hotArgs();
    }

    function readCurveArgs() external view returns (int24 lo, int24 hi, uint256 openAtArg, uint128 liq) {
        return (_argInt24(_A_TICK_LOWER), _argInt24(_A_TICK_UPPER), _argUint(_A_OPEN_AT, 4), _argUint128(_A_LIQUIDITY));
    }
}

/// @notice TEST ONLY: the tickets' openAt argument and description text, read with BoxCloneArgs' offsets.
contract AuditU1ClaudeTicketsReader is BoxTickets {
    constructor(address coordinatorImplementation_) BoxTickets(coordinatorImplementation_) {}

    function readOpenAtArg() external view returns (uint256) {
        return _argUint(A.T_OPEN_AT, 4);
    }

    function readDescription() external view returns (string memory) {
        uint256 start = A.T_TEXT_BYTES + _argUint(A.T_TEXTS, 1) + _argUint(A.T_TEXTS + 1, 1);
        return string(_argBytes(start, _argUint(A.T_TEXTS + 2, 2)));
    }
}

/// @notice TEST ONLY: the stream's curve ticks, read with BoxCloneArgs' offsets as its private readers do.
contract AuditU1ClaudeStreamReader is BoxItemStream {
    constructor(IPoolManager pm_, address coordinatorImplementation_) BoxItemStream(pm_, coordinatorImplementation_) {}

    function readTicks() external view returns (int24 lo, int24 hi) {
        // forge-lint: disable-next-line(unsafe-typecast)
        lo = int24(uint24(_argUint(A.S_TICK_LOWER, 3)));
        // forge-lint: disable-next-line(unsafe-typecast)
        hi = int24(uint24(_argUint(A.S_TICK_UPPER, 3)));
    }
}

/// @title AuditU1ClaudeLayoutsTest
/// @notice SH-AUDIT-B0 U1, lens L7 (P1.12, P1.13): every clone layout, encoded by the production encoders (the planner
/// for the coordinator, hook, receiver and launch router, `BoxCloneArgs` for the S3 and S8 layouts) and by the
/// layout tables of each implementation's NatSpec, read back by the implementation's own getters (internal readers
/// through test subclasses where a field has no getter), with every field at 0, 1, its maximum or random; no getter
/// reads past its arguments; the template id is stable and structural. cancun (nothing here needs a later EVM).
/// forge-config: default.evm_version = "cancun"
contract AuditU1ClaudeLayoutsTest is AuditU1ClaudeKitBase {
    AuditU1ClaudeHookReader internal hookReader;
    AuditU1ClaudeTicketsReader internal ticketsReader;
    AuditU1ClaudeStreamReader internal streamReader;

    function setUp() public override {
        super.setUp();
        hookReader = new AuditU1ClaudeHookReader(pm, impls.coordinator, impls.hookExtension);
        ticketsReader = new AuditU1ClaudeTicketsReader(impls.coordinator);
        streamReader = new AuditU1ClaudeStreamReader(pm, impls.coordinator);
    }

    // ================================================================================================ helpers

    /// @dev 0, 1, the maximum of `bits` bits, or `raw` reduced to `bits` bits, by `pick`.
    function _x(uint8 pick, uint256 raw, uint256 bits) internal pure returns (uint256) {
        uint256 max = bits == 256 ? type(uint256).max : (uint256(1) << bits) - 1;
        if (pick % 4 == 0) return 0;
        if (pick % 4 == 1) return 1;
        if (pick % 4 == 2) return max;
        return raw & max;
    }

    function _addr(uint8 pick, address raw) internal pure returns (address) {
        return address(uint160(_x(pick, uint160(raw), 160)));
    }

    function _int24(uint8 pick, int24 raw) internal pure returns (int24) {
        if (pick % 4 == 0) return 0;
        if (pick % 4 == 1) return type(int24).min;
        if (pick % 4 == 2) return type(int24).max;
        return raw;
    }

    function _deploy(bytes memory initCode) internal returns (address at) {
        assembly ("memory-safe") {
            at := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(at != address(0) && at.code.length != 0, "layout: CREATE failed");
    }

    function _clone(address impl, bytes memory args) internal returns (address) {
        return _deploy(BoxClones.initCode(impl, args));
    }

    // ================================================================================================ P1.12 (planner)

    struct PlanFuzz {
        address coordinator;
        address poolManager;
        address randomness;
        address weth;
        address safe;
        address creator;
        int24 tickLower;
        int24 tickUpper;
        uint160 sqrtLower;
        uint160 sqrtUpper;
        uint128 liquidity;
        uint128 raise;
        bytes32 specHash;
        uint32 openAt;
        uint32 n;
        uint8 pick;
    }

    /// P1.12 (ADR-0016 checklist item 2, `docs/decisions/0016-custody-clones.md:250-253`; the layout tables of
    /// BoxCoordinator.sol:58-71, BoxHookBase.sol:24-41, BoxReceiver.sol `ARGS_LENGTH` notes, BoxLaunchRouter.sol:42-44,
    /// BoxCloneArgs.sol): the planner's encoding of every clone (`plan` with the version's fields, the creator, the spec
    /// hash, openAt and N fuzzed, each at 0, 1, its maximum or random) reads back through each implementation's getters
    /// as the value encoded: the coordinator's every field and every role address CREATE(coordinator, nonce); the hook's
    /// tokens, √P1, √P0, router, kind, ticks, openAt, liquidity, raise, coordinator, receiver and price average; the
    /// receiver's eighteen fields; the launch router's; the collection's, vault's, tickets', stream's and royalty
    /// router's wiring, sizes and ids.
    function testFuzz_AUDIT_U1_planEncodingsReadBack(PlanFuzz memory f) public {
        BoxFactoryV1Planner.Version memory v = _version(f);
        BoxSpecV1.BoxSpec memory s = _spec();
        s.openAt = uint32(_x(f.pick >> 1, f.openAt, 32));
        s.n = uint32(_x(f.pick >> 3, f.n, 32));
        BoxFactoryV1Planner.Plan memory p = planner.plan(s, v, f.creator, bytes32(0), f.specHash);
        _checkCoordinator(p, v, f.creator);
        _checkHook(p, v, s.openAt);
        _checkReceiverAndRouter(p, v, s);
        _checkItems(p, v, s);
    }

    function _version(PlanFuzz memory f) internal view returns (BoxFactoryV1Planner.Version memory v) {
        v.poolManager = _addr(f.pick, f.poolManager);
        v.randomness = _addr(f.pick >> 1, f.randomness);
        v.weth = _addr(f.pick >> 2, f.weth);
        v.platformSafe = _addr(f.pick >> 3, f.safe);
        v.coordinatorImpl = impls.coordinator;
        v.hookImpl = address(hookReader);
        v.launchRouterImpl = impls.launchRouter;
        v.receiverImpl = impls.receiver;
        v.collectionImpl = impls.collection;
        v.vaultImpl = impls.vault;
        v.ticketsImpl = address(ticketsReader);
        v.royaltyRouterImpl = impls.royaltyRouter;
        v.itemStreamImpl = address(streamReader);
        v.coordinator = _addr(f.pick >> 4, f.coordinator);
        v.tickLower = _int24(f.pick, f.tickLower);
        v.tickUpper = _int24(f.pick >> 2, f.tickUpper);
        v.sqrtLower = uint160(_x(f.pick >> 1, f.sqrtLower, 160));
        v.sqrtUpper = uint160(_x(f.pick >> 3, f.sqrtUpper, 160));
        v.liquidity = uint128(_x(f.pick >> 2, f.liquidity, 128));
        v.raise = _x(f.pick >> 4, f.raise, 128);
    }

    function _checkCoordinator(BoxFactoryV1Planner.Plan memory p, BoxFactoryV1Planner.Version memory v, address creator)
        internal
    {
        BoxCoordinator c = BoxCoordinator(_deploy(p.coordinatorInit));
        assertEq(address(c).code.length, 45 + 154, "coordinator: proxy + 154 argument bytes");
        assertEq(uint8(c.kind()), 1, "kind Box0");
        assertEq(c.q(), address(0), "q");
        assertEq(c.raise(), v.raise, "raise");
        assertEq(c.creatorBuyAmount(), 0, "no creator buy");
        assertEq(c.creator(), creator, "creator");
        assertEq(c.specHash(), p.specHash, "spec hash");
        assertEq(c.randomness(), v.randomness, "randomness");
        uint8[9] memory nonces = [2, 3, 4, 5, 6, 8, 10, 9, 7];
        for (uint8 role; role < 9; ++role) {
            assertEq(c.nonceOf(role), nonces[role], "nonce of a role");
        }
        assertEq(c.nonceOf(9), 0, "no tenth role");
        assertEq(c.token(), vm.computeCreateAddress(address(c), 2), "T at nonce 2");
        assertEq(c.vault(), vm.computeCreateAddress(address(c), 3), "vault at nonce 3");
        assertEq(c.collection(), vm.computeCreateAddress(address(c), 4), "collection at nonce 4");
        assertEq(c.receiver(), vm.computeCreateAddress(address(c), 5), "receiver at nonce 5");
        assertEq(c.launchRouter(), vm.computeCreateAddress(address(c), 6), "router at nonce 6");
        assertEq(c.executor(), vm.computeCreateAddress(address(c), 7), "executor at nonce 7");
        assertEq(c.tickets(), vm.computeCreateAddress(address(c), 8), "tickets at nonce 8");
        assertEq(c.itemStream(), vm.computeCreateAddress(address(c), 9), "stream at nonce 9");
        assertEq(c.royaltyRouter(), vm.computeCreateAddress(address(c), 10), "royalty router at nonce 10");
        assertEq(c.rewardCap(), v.raise * BoxSpecV1.GRADUATION_REWARD_CAP_BPS / 10_000, "reward cap from the raise");
    }

    function _checkHook(BoxFactoryV1Planner.Plan memory p, BoxFactoryV1Planner.Version memory v, uint32 openAt)
        internal
    {
        AuditU1ClaudeHookReader h = AuditU1ClaudeHookReader(_deploy(p.hookInit));
        IBoxFactoryV1.Box0Addresses memory a = p.a;
        assertEq(address(h).code.length, 45 + 203, "hook: proxy + 203 argument bytes");
        (address q_, address t_, uint160 sqrtP1, uint160 sqrtP0) = h.readHot();
        assertEq(q_, address(0), "hook q");
        assertEq(t_, a.token, "hook T");
        assertEq(sqrtP1, v.sqrtLower, "hook sqrt P1");
        assertEq(sqrtP0, v.sqrtUpper, "hook sqrt P0");
        (int24 lo, int24 hi, uint256 openAtArg, uint128 liq) = h.readCurveArgs();
        assertEq(lo, v.tickLower, "hook tick lower");
        assertEq(hi, v.tickUpper, "hook tick upper");
        assertEq(openAtArg, openAt, "hook openAt argument");
        assertEq(liq, v.liquidity, "hook liquidity");
        assertEq(h.launchRouter(), a.launchRouter, "hook router");
        assertEq(uint8(h.kind()), 1, "hook kind");
        assertEq(h.raise(), v.raise, "hook raise");
        assertEq(h.coordinator(), a.coordinator, "hook coordinator");
        assertEq(h.receiver(), a.receiver, "hook receiver");
        assertEq(address(h.priceAverage()), a.executor, "hook price average");
        (int24 clo, int24 chi,) = h.curve();
        assertEq(clo, v.tickLower, "curve() lower");
        assertEq(chi, v.tickUpper, "curve() upper");
    }

    function _checkReceiverAndRouter(
        BoxFactoryV1Planner.Plan memory p,
        BoxFactoryV1Planner.Version memory v,
        BoxSpecV1.BoxSpec memory s
    ) internal {
        IBoxFactoryV1.Box0Addresses memory a = p.a;
        BoxReceiver r = BoxReceiver(payable(_deploy(p.codes[4])));
        assertEq(address(r).code.length, 45 + 201, "receiver: proxy + 201 argument bytes");
        assertEq(uint8(r.kind()), 1, "receiver kind");
        assertEq(r.q(), address(0), "receiver q");
        assertEq(r.token(), a.token, "receiver T");
        assertEq(r.coordinator(), a.coordinator, "receiver coordinator");
        assertEq(r.hook(), p.hook, "receiver hook");
        assertEq(r.executor(), a.executor, "receiver executor");
        assertEq(r.platformSafe(), v.platformSafe, "receiver Safe");
        assertEq(r.itemStream(), a.itemStream, "receiver stream");
        assertEq(r.qStream(), s.qStream, "receiver Q stream");
        assertEq(r.tStream(), s.tStream, "receiver T stream");
        assertEq(uint8(r.royaltyDestination()), 1, "receiver royalty destination");
        assertEq(r.creatorPayee(), address(0), "receiver payee");
        assertEq(r.swapModule(), address(0), "receiver module");
        (uint256 cap, uint8 excess,,,) = r.creatorCap();
        assertEq(cap, 0, "receiver cap");
        assertEq(excess, 0, "receiver cap excess");
        BoxLaunchRouter lr = BoxLaunchRouter(payable(_deploy(p.codes[5])));
        assertEq(address(lr).code.length, 45 + 105, "router: proxy + 105 argument bytes");
        assertEq(uint8(lr.kind()), 1, "router kind");
        assertEq(lr.q(), address(0), "router q");
        assertEq(lr.token(), a.token, "router T");
        assertEq(lr.hook(), p.hook, "router hook");
        assertEq(lr.coordinator(), a.coordinator, "router coordinator");
        // No getter for these two: the router's private offsets (81, 101), read from its code.
        assertEq(_codeUint(address(lr), 45 + 81, 20), v.sqrtLower, "router sqrt P1 bytes");
        assertEq(_codeUint(address(lr), 45 + 101, 4), s.openAt, "router openAt bytes");
    }

    function _checkItems(
        BoxFactoryV1Planner.Plan memory p,
        BoxFactoryV1Planner.Version memory v,
        BoxSpecV1.BoxSpec memory s
    ) internal {
        IBoxFactoryV1.Box0Addresses memory a = p.a;
        assertEq(_deploy(p.codes[0]).code, bytes.concat(hex"00", s.metadataTable), "table: 0x00 ++ the spec's table");
        BoxVault vt = BoxVault(_deploy(p.codes[2]));
        assertEq(address(vt).code.length, 45 + A.V_LENGTH, "vault: proxy + 146 argument bytes");
        assertEq(vt.coordinator(), a.coordinator);
        assertEq(vt.token(), a.token);
        assertEq(vt.collection(), a.collection);
        assertEq(vt.ticketAdapter(), a.tickets);
        assertEq(vt.observer(), a.itemStream);
        assertEq(vt.collectionSize(), s.n, "vault N");
        assertEq(vt.firstId(), s.firstId, "vault firstId");
        assertEq(vt.drawFeeBps(), BoxSpecV1.DRAW_FEE_BPS);
        assertEq(vt.pickFeeBps(), BoxSpecV1.PICK_FEE_BPS);
        assertEq(vt.returnFeeBps(), BoxSpecV1.RETURN_FEE_BPS);
        BoxCollection col = BoxCollection(_deploy(p.codes[3]));
        assertEq(col.coordinator(), a.coordinator);
        assertEq(col.vault(), a.vault);
        assertEq(col.token(), a.token);
        assertEq(col.receiver(), a.receiver);
        assertEq(col.transferObserver(), a.itemStream);
        assertEq(col.metadataTable(), a.table);
        assertEq(col.collectionSize(), s.n, "collection N");
        assertEq(col.royaltyRouter(), a.royaltyRouter, "collection router");
        AuditU1ClaudeTicketsReader tk = AuditU1ClaudeTicketsReader(_deploy(p.codes[7]));
        assertEq(tk.coordinator(), a.coordinator);
        assertEq(tk.vault(), a.vault);
        assertEq(tk.collection(), a.collection);
        assertEq(tk.token(), a.token);
        assertEq(tk.source(), v.randomness, "tickets source");
        assertEq(tk.readOpenAtArg(), s.openAt, "tickets openAt");
        assertEq(tk.collectionSize(), s.n, "tickets N");
        assertEq(tk.firstId(), s.firstId, "tickets firstId");
        AuditU1ClaudeStreamReader st = AuditU1ClaudeStreamReader(_deploy(p.codes[8]));
        assertEq(address(st).code.length, 45 + A.S_LENGTH, "stream: proxy + 182 argument bytes");
        assertEq(st.coordinator(), a.coordinator);
        assertEq(st.token(), a.token);
        assertEq(st.collection(), a.collection);
        assertEq(st.vault(), a.vault);
        assertEq(st.tickets(), a.tickets);
        assertEq(st.receiver(), a.receiver);
        assertEq(st.hook(), p.hook);
        (int24 lo, int24 hi) = st.readTicks();
        assertEq(lo, v.tickLower, "stream tick lower");
        assertEq(hi, v.tickUpper, "stream tick upper");
        assertEq(st.collectionSize(), s.n, "stream N");
        assertEq(st.firstId(), s.firstId, "stream firstId");
        BoxRoyaltyRouter rr = BoxRoyaltyRouter(payable(_deploy(p.codes[9])));
        assertEq(address(rr).code.length, 51 + A.R_LENGTH, "royalty router: receiving proxy + 61 argument bytes");
        assertEq(rr.coordinator(), a.coordinator);
        assertEq(rr.receiver(), a.receiver);
        assertEq(rr.weth(), v.weth);
        assertEq(uint8(rr.destination()), 1, "FeeHandling");
    }

    function _codeUint(address at, uint256 from, uint256 size) internal view returns (uint256 x) {
        bytes memory b = new bytes(size);
        assembly ("memory-safe") {
            extcodecopy(at, add(b, 0x20), from, size)
        }
        for (uint256 i; i < size; ++i) {
            x = (x << 8) | uint8(b[i]);
        }
    }

    // ================================================================================================ P1.12 (docs)

    struct DocFuzz {
        uint8 kind;
        address q;
        uint128 raise;
        uint128 creatorBuy;
        address creator;
        bytes32 specHash;
        address executor;
        address randomness;
        uint8[9] nonces;
        uint8 pick;
    }

    /// P1.12, the coordinator's layout table (BoxCoordinator.sol:58-71: kind 0/1, q 1/20, raise 21/16, creator buy
    /// 37/16, creator 53/20, spec hash 73/32, executor 105/20, randomness 125/20, nine nonces 145/9) encoded here at
    /// each field's extremes reads back through every getter; a role's address is CREATE(clone, its nonce) or zero.
    function testFuzz_AUDIT_U1_coordinatorLayoutTable(DocFuzz memory f) public {
        uint8 kind = f.kind % 3;
        address q_ = _addr(f.pick, f.q);
        uint256 raise_ = _x(f.pick >> 1, f.raise, 128);
        uint256 buy = _x(f.pick >> 2, f.creatorBuy, 128);
        address exec = _addr(f.pick >> 3, f.executor);
        bytes memory nonces;
        for (uint256 i; i < 9; ++i) {
            nonces = bytes.concat(nonces, bytes1(f.nonces[i] % 128));
        }
        bytes memory args = abi.encodePacked(
            kind, q_, uint128(raise_), uint128(buy), f.creator, f.specHash, exec, f.randomness, nonces
        );
        assertEq(args.length, 154, "154 bytes");
        BoxCoordinator c = BoxCoordinator(_clone(impls.coordinator, args));
        assertEq(uint8(c.kind()), kind);
        assertEq(c.q(), q_);
        assertEq(c.raise(), raise_);
        assertEq(c.creatorBuyAmount(), buy);
        assertEq(c.creator(), f.creator);
        assertEq(c.specHash(), f.specHash);
        assertEq(c.randomness(), f.randomness);
        for (uint8 role; role < 9; ++role) {
            uint256 n = f.nonces[role] % 128;
            assertEq(c.nonceOf(role), n, "nonce");
        }
        uint256 e = f.nonces[8] % 128;
        assertEq(c.executor(), e == 0 ? exec : vm.computeCreateAddress(address(c), e), "executor: created or named");
        uint256 t = f.nonces[0] % 128;
        assertEq(c.token(), t == 0 ? address(0) : vm.computeCreateAddress(address(c), t), "token");
        uint256 rr = f.nonces[6] % 128;
        assertEq(c.royaltyRouter(), rr == 0 ? address(0) : vm.computeCreateAddress(address(c), rr), "royalty router");
    }

    struct HookFuzz {
        address q;
        address token;
        uint160 sqrtP1;
        uint160 sqrtP0;
        address router;
        uint8 kind;
        int24 lo;
        int24 hi;
        uint32 openAt;
        uint128 liquidity;
        uint128 raise;
        address coordinator;
        address receiver;
        address average;
        uint8 pick;
    }

    /// P1.12, the hook's layout table (BoxHookBase.sol:24-41) at each field's extremes, through its getters and its
    /// internal readers (`_hotArgs`, `_argInt24`, `_argUint`, `_argUint128`).
    function testFuzz_AUDIT_U1_hookLayoutTable(HookFuzz memory f) public {
        HookFuzz memory g = f;
        g.q = _addr(f.pick, f.q);
        g.token = _addr(f.pick >> 1, f.token);
        g.sqrtP1 = uint160(_x(f.pick >> 2, f.sqrtP1, 160));
        g.sqrtP0 = uint160(_x(f.pick >> 3, f.sqrtP0, 160));
        g.kind = f.kind % 3;
        g.lo = _int24(f.pick >> 1, f.lo);
        g.hi = _int24(f.pick >> 3, f.hi);
        g.liquidity = uint128(_x(f.pick >> 4, f.liquidity, 128));
        g.raise = uint128(_x(f.pick >> 5, f.raise, 128));
        bytes memory head = abi.encodePacked(g.q, g.token, g.sqrtP1, g.sqrtP0, g.router, g.kind);
        bytes memory mid = abi.encodePacked(g.lo, g.hi, g.openAt, g.liquidity, g.raise);
        bytes memory args = bytes.concat(head, mid, abi.encodePacked(g.coordinator, g.receiver, g.average));
        assertEq(args.length, 203, "203 bytes");
        AuditU1ClaudeHookReader h = AuditU1ClaudeHookReader(_clone(address(hookReader), args));
        (address q_, address t_, uint160 p1, uint160 p0) = h.readHot();
        assertEq(q_, g.q);
        assertEq(t_, g.token);
        assertEq(p1, g.sqrtP1);
        assertEq(p0, g.sqrtP0);
        assertEq(h.q(), g.q);
        assertEq(h.token(), g.token);
        assertEq(h.launchRouter(), g.router);
        assertEq(uint8(h.kind()), g.kind);
        (int24 lo, int24 hi, uint256 open, uint128 liq) = h.readCurveArgs();
        assertEq(lo, g.lo);
        assertEq(hi, g.hi);
        assertEq(open, g.openAt);
        assertEq(liq, g.liquidity);
        assertEq(h.raise(), g.raise);
        assertEq(h.coordinator(), g.coordinator);
        assertEq(h.receiver(), g.receiver);
        assertEq(address(h.priceAverage()), g.average);
    }

    struct ReceiverFuzz {
        uint8 kind;
        address q;
        address token;
        address coordinator;
        address hook;
        address executor;
        address safe;
        address stream;
        uint8 qStream;
        uint8 tStream;
        uint8 royalty;
        address payee;
        address module;
        uint128 cap;
        uint8 capExcess;
        uint8 pick;
    }

    /// P1.12, the receiver's layout (BoxReceiverBase.sol:21-40, 201 bytes) at each field's extremes, through its
    /// getters.
    function testFuzz_AUDIT_U1_receiverLayoutTable(ReceiverFuzz memory f) public {
        ReceiverFuzz memory g = f;
        g.kind = f.kind % 3;
        g.royalty = f.royalty % 4;
        g.q = _addr(f.pick, f.q);
        g.safe = _addr(f.pick >> 1, f.safe);
        g.payee = _addr(f.pick >> 2, f.payee);
        g.cap = uint128(_x(f.pick >> 3, f.cap, 128));
        bytes memory head = abi.encodePacked(g.kind, g.q, g.token, g.coordinator, g.hook, g.executor, g.safe, g.stream);
        bytes memory args = bytes.concat(
            head, abi.encodePacked(g.qStream, g.tStream, g.royalty, g.payee, g.module, g.cap, g.capExcess)
        );
        assertEq(args.length, 201, "201 bytes");
        BoxReceiver r = BoxReceiver(payable(_clone(impls.receiver, args)));
        assertEq(uint8(r.kind()), g.kind);
        assertEq(r.q(), g.q);
        assertEq(r.token(), g.token);
        assertEq(r.coordinator(), g.coordinator);
        assertEq(r.hook(), g.hook);
        assertEq(r.executor(), g.executor);
        assertEq(r.platformSafe(), g.safe);
        assertEq(r.itemStream(), g.stream);
        assertEq(r.qStream(), g.qStream);
        assertEq(r.tStream(), g.tStream);
        assertEq(uint8(r.royaltyDestination()), g.royalty);
        assertEq(r.creatorPayee(), g.payee);
        assertEq(r.swapModule(), g.module);
        (uint256 cap, uint8 excess,,,) = r.creatorCap();
        assertEq(cap, g.cap);
        assertEq(excess, g.cap == 0 ? 0 : g.capExcess, "the excess byte reads only with a cap");
    }

    /// P1.12, the S3 and S8 layouts (`BoxCloneArgs`) at extremes, through the implementations' getters: the vault's
    /// uint64 size and uint16 fees, the tickets' uint32 openAt and size, the stream's int24 ticks and uint32 size, the
    /// royalty router's destination byte, the collection's uint32 size, uint16 royalty rate and the text header.
    struct S3Fuzz {
        address w;
        uint64 n64;
        uint16 fee;
        uint32 n32;
        uint32 openAt;
        int24 lo;
        int24 hi;
        uint256 firstId;
        uint16 bps;
        uint8 dest;
        uint8 pick;
    }

    function testFuzz_AUDIT_U1_s3LayoutsAtExtremes(S3Fuzz memory f) public {
        S3Fuzz memory g = f;
        g.w = _addr(f.pick, f.w);
        g.n64 = uint64(_x(f.pick >> 1, f.n64, 64));
        g.fee = uint16(_x(f.pick >> 2, f.fee, 16));
        g.n32 = uint32(_x(f.pick >> 3, f.n32, 32));
        g.firstId = _x(f.pick >> 4, f.firstId, 256);
        g.lo = _int24(f.pick, f.lo);
        g.hi = _int24(f.pick >> 2, f.hi);
        _vaultAtExtremes(g);
        _ticketsAtExtremes(g);
        _streamAtExtremes(g);
        _royaltyRouterAtExtremes(g);
        _collectionAtExtremes(g.w, g.n32, g.bps, g.dest, g.firstId);
    }

    function _vaultAtExtremes(S3Fuzz memory g) internal {
        A.VaultArgs memory v = A.VaultArgs({
            coordinator: g.w,
            token: g.w,
            collection: g.w,
            ticketAdapter: g.w,
            observer: g.w,
            collectionSize: g.n64,
            drawFeeBps: g.fee,
            pickFeeBps: g.fee,
            returnFeeBps: g.fee,
            firstId: g.firstId
        });
        BoxVault vt = BoxVault(_clone(impls.vault, A.vault(v)));
        assertEq(vt.collectionSize(), g.n64, "vault size, uint64");
        assertEq(vt.drawFeeBps(), g.fee);
        assertEq(vt.pickFeeBps(), g.fee);
        assertEq(vt.returnFeeBps(), g.fee);
        assertEq(vt.firstId(), g.firstId);
        assertEq(vt.observer(), g.w);
    }

    function _ticketsAtExtremes(S3Fuzz memory g) internal {
        A.TicketsArgs memory t = A.TicketsArgs({
            coordinator: g.w,
            vault: g.w,
            collection: g.w,
            token: g.w,
            source: g.w,
            openAt: g.openAt,
            collectionSize: g.n32,
            firstId: g.firstId,
            name: "N",
            symbol: "S",
            description: "D"
        });
        AuditU1ClaudeTicketsReader tk = AuditU1ClaudeTicketsReader(_clone(address(ticketsReader), A.tickets(t)));
        assertEq(tk.readOpenAtArg(), g.openAt);
        assertEq(tk.collectionSize(), g.n32);
        assertEq(tk.firstId(), g.firstId);
        assertEq(tk.name(), "N");
        assertEq(tk.symbol(), "S");
        assertEq(tk.readDescription(), "D");
    }

    function _streamAtExtremes(S3Fuzz memory g) internal {
        A.StreamArgs memory a_ = A.StreamArgs({
            coordinator: g.w,
            token: g.w,
            collection: g.w,
            vault: g.w,
            tickets: g.w,
            receiver: g.w,
            hook: g.w,
            tickLower: g.lo,
            tickUpper: g.hi,
            collectionSize: g.n32,
            firstId: g.firstId
        });
        AuditU1ClaudeStreamReader st = AuditU1ClaudeStreamReader(_clone(address(streamReader), A.stream(a_)));
        (int24 l2, int24 h2) = st.readTicks();
        assertEq(l2, g.lo);
        assertEq(h2, g.hi);
        assertEq(st.collectionSize(), g.n32);
        assertEq(st.firstId(), g.firstId);
    }

    function _royaltyRouterAtExtremes(S3Fuzz memory g) internal {
        bytes memory args = A.router(A.RouterArgs({coordinator: g.w, receiver: g.w, weth: g.w, destination: g.dest}));
        BoxRoyaltyRouter rr = BoxRoyaltyRouter(payable(_deploy(BoxClones.initCodeReceiving(impls.royaltyRouter, args))));
        uint8 expected = g.dest == 2 || g.dest == 3 ? g.dest : 1;
        assertEq(uint8(rr.destination()), expected, "an unknown destination byte reads as FeeHandling");
        assertEq(rr.weth(), g.w);
        assertEq(rr.coordinator(), g.w);
        assertEq(rr.receiver(), g.w);
    }

    function _collectionAtExtremes(address x, uint32 n32, uint16 bps, uint8 dest, uint256 firstId) internal {
        A.CollectionArgs memory c;
        (c.coordinator, c.vault, c.token, c.receiver, c.revealUnlocker, c.transferObserver) = (x, x, x, x, x, x);
        (c.royaltyRouter, c.marketplaceOwner, c.metadataTable) = (x, x, x);
        c.collectionSize = n32;
        c.revealTriggers = 1;
        c.royaltyBps = bps;
        c.royaltyDestination = dest;
        c.firstId = firstId;
        c.revealRoot = bytes32(type(uint256).max);
        c.name = "Name";
        c.symbol = "SYM";
        c.description = "A description";
        c.hiddenDescription = "Hidden";
        c.hiddenSvg = "<svg/>";
        c.externalLink = "https://example.org";
        BoxCollection col = BoxCollection(_clone(impls.collection, A.collection(c)));
        assertEq(col.collectionSize(), n32);
        assertEq(col.royaltyBps(), bps);
        assertEq(col.firstId(), firstId);
        assertEq(col.revealRoot(), c.revealRoot);
        assertEq(uint8(col.royaltyDestination()), dest > 3 ? 0 : dest, "an unknown destination reads as None");
        assertEq(col.name(), c.name);
        assertEq(col.symbol(), c.symbol);
        assertEq(col.description(), c.description);
        assertEq(col.hiddenDescription(), c.hiddenDescription);
        assertEq(col.hiddenSvg(), c.hiddenSvg);
        assertEq(col.externalLink(), c.externalLink);
        assertEq(col.owner(), x);
    }

    // ================================================================================================ past the end

    /// P1.12 (ADR-0016 checklist item 2: "EXTCODECOPY past the end of the code returns zeros, so a short encoding reads
    /// as zero addresses rather than failing"): no getter of any of box 0's nine clones reads past its arguments. Each
    /// clone's exact runtime and the same runtime with 64 bytes of 0xFF appended answer every getter identically (a
    /// read past the end would see 0xFF instead of the zeros it sees on the real clone), the hook's internal readers
    /// included; the end of each argument block is exactly its documented length.
    function testProperty_AUDIT_U1_noGetterReadsPastItsArguments() public {
        CoreBoxAddresses memory a = _create();
        uint256[9] memory lengths = [uint256(154), 203, 105, 201, 0, 146, 0, 182, 61];
        address[9] memory clones = [
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.collection,
            a.vault,
            a.tickets,
            a.itemStream,
            a.royaltyRouter
        ];
        for (uint256 i; i < 9; ++i) {
            uint256 base = i == 8 ? 51 : 45;
            if (lengths[i] != 0) assertEq(clones[i].code.length, base + lengths[i], "the documented argument length");
            address padded = makeAddr(string.concat("u1.padded.", vm.toString(i)));
            vm.etch(padded, bytes.concat(clones[i].code, _ff(64)));
            bytes[] memory calls = _getters(i);
            for (uint256 j; j < calls.length; ++j) {
                (bool ok1, bytes memory r1) = clones[i].staticcall(calls[j]);
                (bool ok2, bytes memory r2) = padded.staticcall(calls[j]);
                assertEq(ok1, ok2, string.concat("same success, clone ", vm.toString(i), " getter ", vm.toString(j)));
                if (!_storageDependent(i, calls[j])) {
                    assertEq(r1, r2, string.concat("same answer, clone ", vm.toString(i), " getter ", vm.toString(j)));
                }
            }
        }
        // The collection's and the tickets' texts end exactly where their headers say.
        assertEq(a.collection.code.length, 45 + A.C_TEXT_BYTES + _textsLength(a.collection, 45 + A.C_TEXTS, true));
        assertEq(a.tickets.code.length, 45 + A.T_TEXT_BYTES + _textsLength(a.tickets, 45 + A.T_TEXTS, false));
    }

    function _ff(uint256 n) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = 0xff;
        }
    }

    /// @dev Getters whose answers come from storage or from the clone's own address (a padded copy elsewhere has no
    /// storage and another address): compared for success only.
    function _storageDependent(uint256 clone, bytes memory call_) internal pure returns (bool) {
        bytes4 sel = bytes4(call_);
        if (clone == 0) {
            // The executor is CREATE(this clone, nonce 7): another address, another answer.
            return sel == BoxCoordinator.hook.selector || sel == BoxCoordinator.boxId.selector
                || sel == BoxCoordinator.executor.selector;
        }
        if (clone == 1) {
            return sel == BoxHook.curve.selector || sel == BoxHook.poolId.selector || sel == BoxHook.poolKey.selector
                || sel == BoxHook.graduatedLayout.selector;
        }
        return false;
    }

    function _textsLength(address at, uint256 header, bool collection) internal view returns (uint256 n) {
        if (collection) {
            n = _codeUint(at, header, 1) + _codeUint(at, header + 1, 1) + _codeUint(at, header + 2, 2)
                + _codeUint(at, header + 4, 2) + _codeUint(at, header + 6, 2) + _codeUint(at, header + 8, 1);
        } else {
            n = _codeUint(at, header, 1) + _codeUint(at, header + 1, 1) + _codeUint(at, header + 2, 2);
        }
    }

    function _getters(uint256 i) internal view returns (bytes[] memory c) {
        if (i == 0) {
            c = new bytes[](18);
            string[9] memory s = [
                "kind()",
                "q()",
                "raise()",
                "creatorBuyAmount()",
                "creator()",
                "specHash()",
                "executor()",
                "randomness()",
                "rewardCap()"
            ];
            for (uint256 k; k < 9; ++k) {
                c[k] = abi.encodeWithSignature(s[k]);
            }
            for (uint256 k; k < 9; ++k) {
                c[9 + k] = abi.encodeWithSignature("nonceOf(uint8)", uint8(k));
            }
        } else if (i == 1) {
            string[14] memory s = [
                "q()",
                "token()",
                "launchRouter()",
                "kind()",
                "raise()",
                "coordinator()",
                "receiver()",
                "priceAverage()",
                "poolKey()",
                "poolId()",
                "reserveCap()",
                "minAdd()",
                "curve()",
                "graduatedLayout()"
            ];
            c = _sigs14(s);
        } else if (i == 2) {
            string[5] memory s = ["kind()", "q()", "token()", "hook()", "coordinator()"];
            c = new bytes[](5);
            for (uint256 k; k < 5; ++k) {
                c[k] = abi.encodeWithSignature(s[k]);
            }
        } else if (i == 3) {
            string[14] memory s = [
                "kind()",
                "q()",
                "token()",
                "coordinator()",
                "hook()",
                "executor()",
                "platformSafe()",
                "itemStream()",
                "qStream()",
                "tStream()",
                "royaltyDestination()",
                "creatorPayee()",
                "swapModule()",
                "creatorCap()"
            ];
            c = _sigs14(s);
        } else if (i == 4) {
            string[14] memory s = [
                "name()",
                "symbol()",
                "description()",
                "hiddenDescription()",
                "hiddenSvg()",
                "externalLink()",
                "royaltyBps()",
                "royaltyDestination()",
                "royaltyRouter()",
                "owner()",
                "contractURI()",
                "revealRoot()",
                "generatorHash()",
                "bannerSha256()"
            ];
            c = _sigs14(s);
        } else if (i == 5) {
            string[10] memory s = [
                "coordinator()",
                "token()",
                "collection()",
                "ticketAdapter()",
                "observer()",
                "collectionSize()",
                "firstId()",
                "drawFeeBps()",
                "pickFeeBps()",
                "returnFeeBps()"
            ];
            c = new bytes[](10);
            for (uint256 k; k < 10; ++k) {
                c[k] = abi.encodeWithSignature(s[k]);
            }
        } else if (i == 6) {
            string[9] memory s = [
                "coordinator()",
                "vault()",
                "collection()",
                "token()",
                "source()",
                "collectionSize()",
                "firstId()",
                "name()",
                "symbol()"
            ];
            c = new bytes[](9);
            for (uint256 k; k < 9; ++k) {
                c[k] = abi.encodeWithSignature(s[k]);
            }
        } else if (i == 7) {
            string[9] memory s = [
                "coordinator()",
                "token()",
                "collection()",
                "vault()",
                "tickets()",
                "receiver()",
                "hook()",
                "collectionSize()",
                "firstId()"
            ];
            c = new bytes[](9);
            for (uint256 k; k < 9; ++k) {
                c[k] = abi.encodeWithSignature(s[k]);
            }
        } else {
            string[4] memory s = ["coordinator()", "receiver()", "weth()", "destination()"];
            c = new bytes[](4);
            for (uint256 k; k < 4; ++k) {
                c[k] = abi.encodeWithSignature(s[k]);
            }
        }
    }

    function _sigs14(string[14] memory s) internal pure returns (bytes[] memory c) {
        c = new bytes[](14);
        for (uint256 k; k < 14; ++k) {
            c[k] = abi.encodeWithSignature(s[k]);
        }
    }

    // ================================================================================================ P1.13

    /// P1.13 (BC-013; `BoxFactoryV1Planner.sol:119-135`, box-factory § 3.1): the template id is stable under
    /// re-encoding (the spec through abi.encode/decode, any number of times) and does not move for any data field
    /// (names, texts, N, the art commitments, the table, openAt, the royalty rate, the logo and the creator fields),
    /// and it moves for every structural choice: version, box type, layout, graduated layout, launch format, Q class,
    /// either stream action, art mode, each wiring add-on (placeholders, per-item stream and royalties dropped, the
    /// creator-fee cap added), the royalty destination, the version's code hash and the module's code hash; all those
    /// ids are distinct.
    function testFuzz_AUDIT_U1_templateIdStableAndStructural(
        bytes32 dataWord,
        uint32 dataNumber,
        string memory dataText,
        uint8 which
    ) public view {
        BoxSpecV1.BoxSpec memory s = _spec();
        bytes32 vh = factory.versionCodeHash();
        bytes32 eh = factory.executorInitCodeHash();
        bytes32 id = planner.templateIdOf(s, vh, eh);
        BoxSpecV1.BoxSpec memory r =
            abi.decode(abi.encode(abi.decode(abi.encode(s), (BoxSpecV1.BoxSpec))), (BoxSpecV1.BoxSpec));
        assertEq(planner.templateIdOf(r, vh, eh), id, "stable under re-encoding");
        assertEq(factory.templateIdOf(s), id, "the factory's view is the planner's");
        // A data field: unchanged.
        BoxSpecV1.BoxSpec memory d = _copy(s);
        uint256 k = which % 14;
        if (k == 0) d.tokenName = dataText;
        else if (k == 1) d.collectionName = dataText;
        else if (k == 2) d.description = dataText;
        else if (k == 3) d.n = dataNumber;
        else if (k == 4) d.revealRoot = dataWord;
        else if (k == 5) d.metadataTable = bytes(dataText);
        else if (k == 6) d.openAt = dataNumber;
        else if (k == 7) d.generatorHash = dataWord;
        else if (k == 8) d.coverSha256 = dataWord;
        else if (k == 9) d.collectionCoverSha256 = dataWord;
        else if (k == 10) d.creatorFeeRecipient = address(uint160(uint256(dataWord)));
        else if (k == 11) d.firstId = uint256(dataWord);
        else if (k == 12) d.marketplaceOwner = address(uint160(uint256(dataWord)));
        else _setRoyaltyBps(d, uint16(dataNumber));
        assertEq(planner.templateIdOf(d, vh, eh), id, "data does not move the template id");
        // Every structural choice: moved, and all distinct.
        bytes32[17] memory ids;
        ids[0] = id;
        for (uint256 j = 1; j < 17; ++j) {
            ids[j] = _structural(s, j, vh, eh);
            for (uint256 m; m < j; ++m) {
                assertNotEq(ids[j], ids[m], string.concat("structural change ", vm.toString(j), " is its own template"));
            }
        }
    }

    function _structural(BoxSpecV1.BoxSpec memory s, uint256 j, bytes32 vh, bytes32 eh)
        internal
        view
        returns (bytes32)
    {
        BoxSpecV1.BoxSpec memory v = _copy(s);
        if (j == 1) v.version = 2;
        else if (j == 2) v.boxType = BoxSpecV1.BOX_TYPE_TOKEN_ONLY;
        else if (j == 3) v.layout = v.layout + 1;
        else if (j == 4) v.gradLayout = v.gradLayout + 1;
        else if (j == 5) v.launchFormat = v.launchFormat + 1;
        else if (j == 6) v.q = factory.weth();
        else if (j == 7) v.qStream = BoxSpecV1.Q_STREAM_ALL_TO_FIT;
        else if (j == 8) v.tStream = BoxSpecV1.T_STREAM_BURN_T;
        else if (j == 9) v.artMode = BoxSpecV1.ART_MODE_OPEN;
        else if (j == 10) _drop(v, BoxSpecV1.ADD_ON_PLACEHOLDERS);
        else if (j == 11) _drop(v, BoxSpecV1.ADD_ON_PER_ITEM_STREAM);
        else if (j == 12) _drop(v, BoxSpecV1.ADD_ON_ROYALTIES);
        else if (j == 13) _setRoyaltyDestination(v, BoxSpecV1.ROYALTY_DESTINATION_POOL_DEPTH);
        else if (j == 14) _add(v, BoxSpecV1.ADD_ON_CREATOR_FEE_CAP, abi.encode(uint256(1 ether), uint8(2)));
        else if (j == 15) return planner.templateIdOf(v, keccak256(abi.encode(vh)), eh);
        else return planner.templateIdOf(v, vh, keccak256(abi.encode(eh)));
        return planner.templateIdOf(v, vh, eh);
    }

    function _copy(BoxSpecV1.BoxSpec memory s) internal pure returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(abi.encode(s), (BoxSpecV1.BoxSpec));
    }

    function _drop(BoxSpecV1.BoxSpec memory s, uint16 id) internal pure {
        uint256 kept;
        BoxSpecV1.AddOn[] memory l = new BoxSpecV1.AddOn[](s.addOns.length);
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != id) l[kept++] = s.addOns[i];
        }
        assembly ("memory-safe") {
            mstore(l, kept)
        }
        s.addOns = l;
    }

    function _add(BoxSpecV1.BoxSpec memory s, uint16 id, bytes memory params) internal pure {
        BoxSpecV1.AddOn[] memory l = new BoxSpecV1.AddOn[](s.addOns.length + 1);
        for (uint256 i; i < s.addOns.length; ++i) {
            l[i] = s.addOns[i];
        }
        l[s.addOns.length] = BoxSpecV1.AddOn({id: id, params: params});
        s.addOns = l;
    }

    function _setRoyaltyBps(BoxSpecV1.BoxSpec memory s, uint16 bps) internal pure {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_ROYALTIES) {
                (, uint8 dest) = abi.decode(s.addOns[i].params, (uint16, uint8));
                s.addOns[i].params = abi.encode(bps, dest);
            }
        }
    }

    function _setRoyaltyDestination(BoxSpecV1.BoxSpec memory s, uint8 dest) internal pure {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == BoxSpecV1.ADD_ON_ROYALTIES) {
                (uint16 bps,) = abi.decode(s.addOns[i].params, (uint16, uint8));
                s.addOns[i].params = abi.encode(bps, dest);
            }
        }
    }
}
