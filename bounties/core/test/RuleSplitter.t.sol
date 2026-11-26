// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RuleSplitter} from "../src/RuleSplitter.sol";
import {IRuleSplitter} from "../src/IRuleSplitter.sol";
import {FeeRules} from "../src/FeeRules.sol";
import {MockToken} from "./FeeRules.t.sol";

/// @dev A V2-like router: buys `token` at a fixed rate (1 asset unit -> 1000 token units) and mints it to `to`;
/// `empty` makes every buy revert, like a pool with nothing in it.
contract MockRouter {
    address public immutable WETH;
    bool public empty;
    uint256 public payBack; // asset (or native) paid back to the caller during the swap, like a token's tax work
    bool public reenter; // calls the caller's distribute() during the swap
    bool public hog; // burns gas during the swap
    uint256 public taxBps; // the token taxes the buy: fewer tokens arrive

    constructor(address weth) {
        WETH = weth;
    }

    function setEmpty(bool e) external {
        empty = e;
    }

    function setModes(uint256 payBack_, bool reenter_, bool hog_, uint256 taxBps_) external {
        payBack = payBack_;
        reenter = reenter_;
        hog = hog_;
        taxBps = taxBps_;
    }

    function _during(address asset) private {
        if (reenter) RuleSplitter(payable(msg.sender)).distribute();
        if (hog) {
            for (uint256 i; i < 1_000_000; ++i) {
                assembly {
                    sstore(add(1000, i), i)
                }
            }
        }
        if (payBack != 0) {
            if (asset == address(0)) {
                (bool ok,) = msg.sender.call{value: payBack}("");
                require(ok, "pay back");
            } else {
                MockToken(payable(asset)).mint(msg.sender, payBack);
            }
        }
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[] calldata path, address to, uint256)
        external
        payable
    {
        require(!empty, "empty pool");
        require(path[0] == WETH, "path");
        _during(address(0));
        MockToken(payable(path[1])).mint(to, msg.value * 1000 * (10_000 - taxBps) / 10_000);
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256,
        address[] calldata path,
        address to,
        uint256
    ) external {
        require(!empty, "empty pool");
        MockToken(payable(path[0])).transferFrom(msg.sender, address(this), amountIn);
        _during(path[0]);
        MockToken(payable(path[1])).mint(to, amountIn * 1000 * (10_000 - taxBps) / 10_000);
    }

    receive() external payable {}
}

/// @dev A router whose WETH() answers a proper address at construction, then (when set) a word with high bits.
contract BadWethRouter {
    bool public badWord;

    function setBadWord(bool b) external {
        badWord = b;
    }

    fallback() external payable {
        if (msg.sig == bytes4(keccak256("WETH()"))) {
            uint256 w = badWord ? (uint256(1) << 200) | 0xBEEF : 0xBEEF;
            assembly {
                mstore(0, w)
                return(0, 32)
            }
        }
        revert("no swap");
    }
}

/// @dev An ERC-20 whose transfers can return false, return nothing, refuse one recipient, or whose balance read at
/// DEAD reverts; used as the asset or as the token.
contract FlexToken {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    bool public returnFalse;
    bool public returnNothing;
    address public refuseTo;
    bool public revertDeadRead;

    function setModes(bool rf, bool rn, address refuse, bool deadRead) external {
        returnFalse = rf;
        returnNothing = rn;
        refuseTo = refuse;
        revertDeadRead = deadRead;
    }

    function balanceOf(address a) external view returns (uint256) {
        require(!(revertDeadRead && a == DEAD), "no read");
        return _bal[a];
    }

    function mint(address to, uint256 amount) external {
        require(to != refuseTo, "refused");
        totalSupply += amount;
        _bal[to] += amount;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        require(to != refuseTo, "refused");
        _bal[msg.sender] -= amount;
        _bal[to] += amount;
        if (returnNothing) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }

    function transferFrom(address f, address to, uint256 amount) external returns (bool) {
        allowance[f][msg.sender] -= amount;
        _bal[f] -= amount;
        _bal[to] += amount;
        return true;
    }
}

/// @dev A payee that refuses the native coin while `refuse` is set, or burns all the gas it is given.
contract Payee {
    bool public refuse = true;
    bool public burnGas;
    RuleSplitter public reenter;

    function set(bool r, bool b) external {
        refuse = r;
        burnGas = b;
    }

    function setReenter(RuleSplitter s) external {
        reenter = s;
    }

    receive() external payable {
        if (address(reenter) != address(0)) reenter.distribute(); // must fail: the splitter is locked
        if (burnGas) {
            while (true) {}
        }
        require(!refuse, "no thanks");
    }
}

/// @dev Answers like a pile of the right token and asset, and refuses the coin while `refuse` is set.
contract PileLike {
    address public token;
    address public asset;
    bool public refuse = true;

    constructor(address t, address a) {
        token = t;
        asset = a;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    receive() external payable {
        require(!refuse, "closed");
    }
}

contract RuleSplitterTest is Test {
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address[] NONE;
    MockToken tok;
    MockToken wbnb;
    MockToken usd;
    MockRouter router;
    FeeRules pile;
    address creator = address(0xC12EA70);

    function setUp() public {
        tok = new MockToken();
        tok.mint(address(0xA11CE), 1000 ether);
        wbnb = new MockToken();
        usd = new MockToken();
        router = new MockRouter(address(wbnb));
        pile = new FeeRules(address(tok), address(0), NONE);
    }

    function _r(IRuleSplitter.Kind k, uint16 bps, address t) internal pure returns (IRuleSplitter.Rule memory) {
        return IRuleSplitter.Rule({kind: k, bps: bps, target: t});
    }

    function _three(address pileAddr, address creatorAddr) internal view returns (IRuleSplitter.Rule[] memory r) {
        r = new IRuleSplitter.Rule[](3);
        r[0] = _r(IRuleSplitter.Kind.CREATOR, 2000, creatorAddr);
        r[1] = _r(IRuleSplitter.Kind.PILE, 5000, pileAddr);
        r[2] = _r(IRuleSplitter.Kind.BUY_BURN, 3000, address(router));
    }

    function _refused(address t, address a, IRuleSplitter.Rule[] memory r) internal {
        try new RuleSplitter(t, a, r) returns (RuleSplitter) {
            revert("accepted rules that must be refused");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(IRuleSplitter.InvalidRules.selector));
        }
    }

    // ── fixed at construction ─────────────────────────────────────────────────

    function test_config_refusals() public {
        IRuleSplitter.Rule[] memory r0 = new IRuleSplitter.Rule[](0);
        _refused(address(tok), address(0), r0); // no rule
        IRuleSplitter.Rule[] memory r5 = new IRuleSplitter.Rule[](5);
        for (uint256 i; i < 5; ++i) r5[i] = _r(IRuleSplitter.Kind.CREATOR, 2000, address(uint160(0x100 + i)));
        _refused(address(tok), address(0), r5); // five rules
        IRuleSplitter.Rule[] memory r1 = new IRuleSplitter.Rule[](1);
        r1[0] = _r(IRuleSplitter.Kind.CREATOR, 9999, creator);
        _refused(address(tok), address(0), r1); // parts sum to 9,999
        IRuleSplitter.Rule[] memory r2 = new IRuleSplitter.Rule[](2);
        r2[0] = _r(IRuleSplitter.Kind.CREATOR, 0, creator);
        r2[1] = _r(IRuleSplitter.Kind.CREATOR, 10_000, address(0xB0B));
        _refused(address(tok), address(0), r2); // a 0 bps part
        r1[0] = _r(IRuleSplitter.Kind.CREATOR, 10_000, address(0));
        _refused(address(tok), address(0), r1); // zero target
        r1[0] = _r(IRuleSplitter.Kind.NONE, 10_000, creator);
        _refused(address(tok), address(0), r1); // no kind
        r1[0] = _r(IRuleSplitter.Kind.PILE, 10_000, address(pile));
        _refused(address(tok), address(usd), r1); // a pile of another asset
        FeeRules otherPile = new FeeRules(address(usd), address(0), NONE);
        r1[0] = _r(IRuleSplitter.Kind.PILE, 10_000, address(otherPile));
        _refused(address(tok), address(0), r1); // a pile of another token
        _refused(address(0), address(0), _three(address(pile), creator)); // no token
        MockRouter noWeth = new MockRouter(address(0));
        r1[0] = _r(IRuleSplitter.Kind.BUY_BURN, 10_000, address(noWeth));
        _refused(address(tok), address(0), r1); // native buy without WETH
    }

    /// The external surface, from the compiled artifact: one state-changing function (distribute) and receive.
    function test_abi_noOwnerNoSetter() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/out/RuleSplitter.sol/RuleSplitter.json"));
        // forge test compiles into out/ before it runs; the artifact must be this very build
        assertEq(vm.parseJsonBytes(json, ".bytecode.object"), type(RuleSplitter).creationCode, "a stale artifact");
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        string[13] memory expected = [
            "DEAD()",
            "MAX_RULES()",
            "NATIVE_CALL_GAS()",
            "asset()",
            "burned(uint256)",
            "delivered(uint256)",
            "distribute()",
            "owed(uint256)",
            "pending()",
            "rule(uint256)",
            "ruleCount()",
            "token()",
            "totalOwed()"
        ];
        assertEq(sigs.length, 13);
        for (uint256 i; i < sigs.length; ++i) {
            bool known;
            for (uint256 j; j < 13; ++j) {
                if (keccak256(bytes(sigs[i])) == keccak256(bytes(expected[j]))) known = true;
            }
            assertTrue(known, sigs[i]);
        }
    }

    // ── the three rules, native ───────────────────────────────────────────────

    function test_native_creatorPileBuyBurn_exactParts() public {
        address payable c = payable(address(0xC0FFEE));
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), c));
        vm.deal(address(s), 1 ether + 7); // income pushed by plain transfer
        assertEq(s.pending(), 1 ether + 7);
        vm.expectEmit(address(s));
        emit IRuleSplitter.IncomeRecognised(1 ether + 7);
        s.distribute();
        // 20% = 200000000000000001 (floor of 200000000000000001.4), 50% = 500000000000000003 (floor of .5),
        // the last rule takes the rest: 1000000000000000007 - 200000000000000001 - 500000000000000003
        uint256 p0 = (uint256(1 ether) + 7) * 2000 / 10_000;
        uint256 p1 = (uint256(1 ether) + 7) * 5000 / 10_000;
        uint256 p2 = 1 ether + 7 - p0 - p1;
        assertEq(c.balance, p0, "the creator paid");
        assertEq(pile.pile(), p1, "the pile grown");
        assertEq(tok.balanceOf(DEAD), p2 * 1000, "tokens at the dead address");
        assertEq(s.delivered(0) + s.delivered(1) + s.delivered(2), 1 ether + 7, "every unit delivered");
        assertEq(s.burned(2), p2 * 1000);
        assertEq(address(s).balance, 0);
        assertEq(s.totalOwed(), 0);
        // the pile is redeemable: alice holds all circulating tokens but DEAD's
        vm.startPrank(address(0xA11CE));
        tok.approve(address(pile), type(uint256).max);
        assertEq(pile.redeem(1000 ether, 0), p1);
        vm.stopPrank();
    }

    /// The events an index follows, in order: income, each part, each delivery (with the tokens burned).
    function test_events() public {
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), creator));
        vm.deal(address(s), 1000);
        vm.expectEmit(address(s));
        emit IRuleSplitter.IncomeRecognised(1000);
        vm.expectEmit(address(s));
        emit IRuleSplitter.PartOwed(0, 200, 200);
        vm.expectEmit(address(s));
        emit IRuleSplitter.PartOwed(1, 500, 500);
        vm.expectEmit(address(s));
        emit IRuleSplitter.PartOwed(2, 300, 300);
        vm.expectEmit(address(s));
        emit IRuleSplitter.Delivered(0, 200, 0);
        vm.expectEmit(address(s));
        emit IRuleSplitter.Delivered(1, 500, 0);
        vm.expectEmit(address(s));
        emit IRuleSplitter.Delivered(2, 300, 300_000);
        s.distribute();
        // a call with nothing new and nothing owed emits nothing
        vm.recordLogs();
        s.distribute();
        assertEq(vm.getRecordedLogs().length, 0);
    }

    function test_erc20_creatorPileBuyBurn() public {
        FeeRules usdPile = new FeeRules(address(tok), address(usd), NONE);
        RuleSplitter s = new RuleSplitter(address(tok), address(usd), _three(address(usdPile), creator));
        usd.mint(address(s), 1000 ether);
        (bool ok,) = address(s).call(""); // the empty wake call is accepted
        assertTrue(ok);
        s.distribute();
        assertEq(usd.balanceOf(creator), 200 ether);
        assertEq(usdPile.pile(), 500 ether);
        assertEq(tok.balanceOf(DEAD), 300 ether * 1000);
        assertEq(usd.allowance(address(s), address(router)), 0, "no allowance left");
        assertEq(usd.balanceOf(address(s)), 0);
        vm.deal(address(this), 1 ether);
        (ok,) = address(s).call{value: 1}("");
        assertFalse(ok, "an ERC-20 splitter refuses the native coin");
    }

    // ── edge parts ────────────────────────────────────────────────────────────

    function test_edgeParts_oneRule_and_1_9999() public {
        IRuleSplitter.Rule[] memory one = new IRuleSplitter.Rule[](1);
        one[0] = _r(IRuleSplitter.Kind.PILE, 10_000, address(pile));
        RuleSplitter s = new RuleSplitter(address(tok), address(0), one);
        vm.deal(address(s), 12345);
        s.distribute();
        assertEq(pile.pile(), 12345, "one rule takes everything");

        IRuleSplitter.Rule[] memory two = new IRuleSplitter.Rule[](2);
        two[0] = _r(IRuleSplitter.Kind.CREATOR, 1, creator);
        two[1] = _r(IRuleSplitter.Kind.CREATOR, 9999, address(0xB0B));
        RuleSplitter t = new RuleSplitter(address(tok), address(0), two);
        vm.deal(address(t), 9999);
        t.distribute();
        assertEq(creator.balance, 0, "1 bps of 9,999 rounds to 0");
        assertEq(address(0xB0B).balance, 9999, "the last rule takes the rounding units");
        vm.deal(address(t), 10_000);
        t.distribute();
        assertEq(creator.balance, 1);
        assertEq(address(0xB0B).balance, 9999 + 9999);
    }

    function test_edgeParts_fourRules() public {
        IRuleSplitter.Rule[] memory four = new IRuleSplitter.Rule[](4);
        four[0] = _r(IRuleSplitter.Kind.CREATOR, 2500, address(0x1001));
        four[1] = _r(IRuleSplitter.Kind.CREATOR, 2500, address(0x1002));
        four[2] = _r(IRuleSplitter.Kind.PILE, 2500, address(pile));
        four[3] = _r(IRuleSplitter.Kind.BUY_BURN, 2500, address(router));
        RuleSplitter s = new RuleSplitter(address(tok), address(0), four);
        vm.deal(address(s), 103);
        s.distribute();
        assertEq(address(0x1001).balance, 25);
        assertEq(address(0x1002).balance, 25);
        assertEq(pile.pile(), 25);
        assertEq(tok.balanceOf(DEAD), 28 * 1000, "the last rule takes 25 + 3 rounding units");
    }

    // ── a rule that cannot be served never holds back the others ──────────────

    function test_refusingCreator_staysOwed_othersServed() public {
        Payee p = new Payee();
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), address(p)));
        vm.deal(address(s), 1000);
        vm.expectEmit(address(s));
        emit IRuleSplitter.LeftOwed(0, 200);
        s.distribute();
        assertEq(s.owed(0), 200, "the creator's part stays owed");
        assertEq(pile.pile(), 500);
        assertEq(tok.balanceOf(DEAD), 300_000);
        assertEq(address(s).balance, 200);
        // more income arrives; the creator now accepts: it gets its old part and its new one
        vm.deal(address(s), 200 + 1000);
        p.set(false, false);
        s.distribute();
        assertEq(address(p).balance, 400);
        assertEq(s.owed(0), 0);
        assertEq(pile.pile(), 1000);
        assertEq(address(s).balance, 0);
    }

    function test_gasBurningCreator_cannotBlockTheOthers() public {
        Payee p = new Payee();
        p.set(false, true);
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), address(p)));
        vm.deal(address(s), 1000);
        s.distribute{gas: 1_000_000}();
        assertEq(s.owed(0), 200);
        assertEq(pile.pile(), 500);
        assertEq(tok.balanceOf(DEAD), 300_000);
    }

    function test_refusingPile_staysOwed() public {
        PileLike pl = new PileLike(address(tok), address(0));
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pl), creator));
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(s.owed(1), 500);
        assertEq(creator.balance, 200);
        pl.setRefuse(false);
        s.distribute();
        assertEq(address(pl).balance, 500);
        assertEq(s.owed(1), 0);
    }

    function test_emptyPool_buyBurnStaysOwed_thenServed() public {
        router.setEmpty(true);
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), creator));
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(s.owed(2), 300, "a failed buy keeps its part");
        assertEq(creator.balance, 200);
        assertEq(pile.pile(), 500);
        router.setEmpty(false);
        s.distribute();
        assertEq(s.owed(2), 0);
        assertEq(tok.balanceOf(DEAD), 300_000);
    }

    function test_emptyPool_erc20_allowanceCleared() public {
        FeeRules usdPile = new FeeRules(address(tok), address(usd), NONE);
        router.setEmpty(true);
        RuleSplitter s = new RuleSplitter(address(tok), address(usd), _three(address(usdPile), creator));
        usd.mint(address(s), 1000);
        s.distribute();
        assertEq(s.owed(2), 300);
        assertEq(usd.allowance(address(s), address(router)), 0, "a failed buy leaves no allowance");
    }

    function test_reenteringCreator_getsNothingMore() public {
        Payee p = new Payee();
        p.set(false, false);
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), address(p)));
        p.setReenter(s);
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(address(p).balance, 0, "its re-entry failed, so its payment failed");
        assertEq(s.owed(0), 200);
        assertEq(pile.pile(), 500);
    }

    // ── anyone may call; only the rules are paid ──────────────────────────────

    function test_anyoneCalls_onlyRulesPaid() public {
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), creator));
        vm.deal(address(s), 1000);
        address stranger = address(0x5713A9);
        vm.prank(stranger);
        s.distribute();
        assertEq(stranger.balance, 0);
        assertEq(creator.balance + pile.pile() + tok.balanceOf(DEAD) / 1000, 1000);
    }

    // ── nothing stranded, any history ─────────────────────────────────────────

    function testFuzz_nothingStranded(uint256 seed) public {
        Payee p = new Payee();
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), address(p)));
        uint256 total;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 income = seed % 1 ether;
            vm.deal(address(s), address(s).balance + income);
            total += income;
            p.set((seed >> 64) % 2 == 0, false);
            router.setEmpty((seed >> 72) % 3 == 0);
            s.distribute();
            assertEq(address(s).balance, s.totalOwed() + s.pending(), "balance = owed + pending");
            assertEq(s.pending(), 0);
            assertEq(s.owed(0) + s.owed(1) + s.owed(2), s.totalOwed());
            assertEq(s.delivered(0) + s.delivered(1) + s.delivered(2) + s.totalOwed(), total, "every unit to a rule");
        }
        p.set(false, false);
        router.setEmpty(false);
        s.distribute();
        assertEq(address(s).balance, 0, "nothing stranded once every rule can be served");
        assertEq(s.delivered(0) + s.delivered(1) + s.delivered(2), total);
    }

    // ── the fix round on 7691d4d8 ──────────────────────────────────────────────

    /// Fix 1: a BUY_BURN target without code is refused, in both builds.
    function test_fix1_routerWithoutCode_refused_bothBuilds() public {
        IRuleSplitter.Rule[] memory r = _three(address(pile), creator);
        r[2].target = address(0x1234);
        _refused(address(tok), address(0), r);
        FeeRules usdPile = new FeeRules(address(tok), address(usd), NONE);
        r = _three(address(usdPile), creator);
        r[2].target = address(0x1234);
        _refused(address(tok), address(usd), r);
    }

    /// Fix 2: an income of 2^250 units of an openly mintable asset does not overflow the split.
    function test_fix2_hugeIncome_noOverflow() public {
        FeeRules usdPile = new FeeRules(address(tok), address(usd), NONE);
        RuleSplitter s = new RuleSplitter(address(tok), address(usd), _three(address(usdPile), creator));
        uint256 income = uint256(1) << 250;
        usd.mint(address(s), income);
        s.distribute();
        uint256 p0 = income / 10_000 * 2000 + income % 10_000 * 2000 / 10_000;
        uint256 p1 = income / 10_000 * 5000 + income % 10_000 * 5000 / 10_000;
        assertEq(usd.balanceOf(creator), p0);
        assertEq(usdPile.pile(), p1);
        assertEq(s.owed(2) + s.delivered(2), income - p0 - p1, "the buy's part is owed or delivered, never lost");
        s.distribute(); // and later calls do not panic either
    }

    /// Fix 3: income that arrives during the buy stays income: the buy is booked as what it sent.
    function test_fix3_incomeDuringBuy_erc20() public {
        FeeRules usdPile = new FeeRules(address(tok), address(usd), NONE);
        RuleSplitter s = new RuleSplitter(address(tok), address(usd), _three(address(usdPile), creator));
        router.setModes(100, false, false, 0);
        usd.mint(address(s), 1000);
        s.distribute();
        assertEq(s.delivered(2), 300, "the buy sent 300");
        assertEq(s.burned(2), 300_000);
        assertEq(s.owed(2), 0);
        assertEq(s.pending(), 100, "the 100 paid in during the buy is new income");
        router.setModes(0, false, false, 0);
        s.distribute();
        assertEq(usd.balanceOf(creator), 220);
        assertEq(usdPile.pile(), 550);
        assertEq(s.delivered(2), 330);
        assertEq(usd.balanceOf(address(s)), 0);
    }

    function test_fix3_incomeDuringBuy_native() public {
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), creator));
        router.setModes(100, false, false, 0);
        vm.deal(address(router), 1000);
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(s.delivered(2), 300);
        assertEq(s.pending(), 100);
        router.setModes(0, false, false, 0);
        s.distribute();
        assertEq(creator.balance, 220);
        assertEq(pile.pile(), 550);
        assertEq(address(s).balance, 0);
    }

    /// Fix 4: a token whose balance read at DEAD reverts cannot block the rules; burned counts 0.
    function test_fix4_deadReadReverts_othersPaid() public {
        FlexToken ft = new FlexToken();
        FeeRules ftPile = new FeeRules(address(ft), address(0), NONE);
        RuleSplitter s = new RuleSplitter(address(ft), address(0), _three(address(ftPile), creator));
        ft.setModes(false, false, address(0), true);
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(creator.balance, 200);
        assertEq(address(ftPile).balance, 500);
        assertEq(s.delivered(2), 300, "the buy itself went through");
        assertEq(s.burned(2), 0, "the burn could not be measured, so it counts 0");
    }

    // ── the paths the read found untested ─────────────────────────────────────

    function _flexAssetSplitter(FlexToken asset_) internal returns (RuleSplitter s, FeeRules p) {
        p = new FeeRules(address(tok), address(asset_), NONE);
        s = new RuleSplitter(address(tok), address(asset_), _three(address(p), creator));
        asset_.mint(address(s), 1000);
    }

    function test_erc20_refusingCreator_staysOwed() public {
        FlexToken a = new FlexToken();
        (RuleSplitter s, FeeRules p) = _flexAssetSplitter(a);
        a.setModes(false, false, creator, false);
        s.distribute();
        assertEq(s.owed(0), 200);
        assertEq(p.pile(), 500);
        a.setModes(false, false, address(0), false);
        s.distribute();
        assertEq(a.balanceOf(creator), 200);
        assertEq(s.owed(0), 0);
    }

    function test_erc20_assetReturnsFalse_staysOwed() public {
        FlexToken a = new FlexToken();
        (RuleSplitter s,) = _flexAssetSplitter(a);
        a.setModes(true, false, address(0), false);
        s.distribute();
        assertEq(s.owed(0), 200);
        assertEq(s.owed(1), 500);
        assertEq(s.delivered(2), 300, "the buy pulls by transferFrom, which still works");
    }

    function test_erc20_assetReturnsNothing_paid() public {
        FlexToken a = new FlexToken();
        (RuleSplitter s, FeeRules p) = _flexAssetSplitter(a);
        a.setModes(false, true, address(0), false);
        s.distribute();
        assertEq(a.balanceOf(creator), 200);
        assertEq(p.pile(), 500);
    }

    function test_buyTaxedByTheToken_burnedMeasured() public {
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), creator));
        router.setModes(0, false, false, 500); // 5% of the bought tokens taken by the token's tax
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(s.delivered(2), 300);
        assertEq(s.burned(2), 285_000, "only what reached the dead address counts as burned");
    }

    function test_tokenRefusesDead_buyStaysOwed() public {
        FlexToken ft = new FlexToken();
        FeeRules ftPile = new FeeRules(address(ft), address(0), NONE);
        RuleSplitter s = new RuleSplitter(address(ft), address(0), _three(address(ftPile), creator));
        ft.setModes(false, false, DEAD, false);
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(s.owed(2), 300);
        assertEq(creator.balance, 200);
        ft.setModes(false, false, address(0), false);
        s.distribute();
        assertEq(s.owed(2), 0);
        assertEq(ft.balanceOf(DEAD), 300_000);
    }

    function test_reentryFromTheRouter_buyStaysOwed() public {
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), creator));
        router.setModes(0, true, false, 0);
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(s.owed(2), 300, "the re-entering buy failed and stays owed");
        assertEq(creator.balance, 200);
        assertEq(pile.pile(), 500);
    }

    function test_tooLittleGas_buyDelayed_othersPaid() public {
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), creator));
        router.setModes(0, false, true, 0); // the buy needs far more gas than the caller gives
        vm.deal(address(s), 1000);
        s.distribute{gas: 1_500_000}();
        assertEq(creator.balance, 200);
        assertEq(pile.pile(), 500);
        assertEq(s.owed(2), 300, "the buy ran out of gas and stays owed");
        router.setModes(0, false, false, 0);
        s.distribute();
        assertEq(s.owed(2), 0);
    }

    function testFuzz_erc20_oneToFourRules_nothingStranded(uint256 seed, uint8 nRules) public {
        uint256 n = bound(nRules, 1, 4);
        FeeRules usdPile = new FeeRules(address(tok), address(usd), NONE);
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](n);
        uint256 left = 10_000;
        for (uint256 i; i < n; ++i) {
            uint16 bps = i == n - 1 ? uint16(left) : uint16(bound(uint256(keccak256(abi.encode(seed, "bps", i))), 1, left - (n - 1 - i)));
            left -= bps;
            IRuleSplitter.Kind k = i % 3 == 0 ? IRuleSplitter.Kind.CREATOR : i % 3 == 1 ? IRuleSplitter.Kind.PILE : IRuleSplitter.Kind.BUY_BURN;
            address t = k == IRuleSplitter.Kind.CREATOR ? address(uint160(0x7000 + i)) : k == IRuleSplitter.Kind.PILE ? address(usdPile) : address(router);
            r[i] = _r(k, bps, t);
        }
        RuleSplitter s = new RuleSplitter(address(tok), address(usd), r);
        uint256 total;
        for (uint256 j; j < 8; ++j) {
            seed = uint256(keccak256(abi.encode(seed, j)));
            uint256 income = seed % 1e30;
            usd.mint(address(s), income);
            total += income;
            router.setEmpty((seed >> 80) % 3 == 0);
            s.distribute();
            assertEq(usd.balanceOf(address(s)), s.totalOwed() + s.pending());
            uint256 d;
            for (uint256 i; i < n; ++i) d += s.delivered(i);
            assertEq(d + s.totalOwed(), total, "every unit to a rule");
        }
        router.setEmpty(false);
        s.distribute();
        assertEq(usd.balanceOf(address(s)), 0, "nothing stranded");
    }

    /// A router whose WETH() answers a word above 160 bits: the buy stays owed, the others are paid, no revert.
    function test_wethAnswerAbove160Bits_buyStaysOwed() public {
        BadWethRouter bad = new BadWethRouter();
        IRuleSplitter.Rule[] memory r = _three(address(pile), creator);
        r[2].target = address(bad);
        RuleSplitter s = new RuleSplitter(address(tok), address(0), r);
        bad.setBadWord(true);
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(creator.balance, 200);
        assertEq(pile.pile(), 500);
        assertEq(s.owed(2), 300, "no valid WETH: the buy stays owed");
    }

    /// The lifetime counters at the edge (written into storage) wrap; every rule is still paid.
    function test_lifetimeCounters_atTheEdge_neverStopPayments() public {
        RuleSplitter s = new RuleSplitter(address(tok), address(0), _three(address(pile), creator));
        // storage: _rules at 0, _owed at 1..4, _delivered at 5..8, _burned at 9..12
        for (uint256 i; i < 3; ++i) {
            vm.store(address(s), bytes32(5 + i), bytes32(type(uint256).max));
            vm.store(address(s), bytes32(9 + i), bytes32(type(uint256).max));
            assertEq(s.delivered(i), type(uint256).max, "the slot is the counter");
            assertEq(s.burned(i), type(uint256).max, "the slot is the counter");
        }
        vm.deal(address(s), 1000);
        s.distribute();
        assertEq(creator.balance, 200, "creator paid");
        assertEq(pile.pile(), 500, "pile paid");
        assertEq(s.owed(2), 0, "the buy and burn ran");
        assertEq(s.totalOwed(), 0);
        assertEq(s.delivered(0), 199, "wrapped: max + 200");
        assertEq(s.delivered(2), 299, "wrapped: max + 300");
        assertLt(s.burned(2), type(uint256).max, "wrapped");
    }

    receive() external payable {}
}
