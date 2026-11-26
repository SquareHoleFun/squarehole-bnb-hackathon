// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeRules} from "../src/FeeRules.sol";
import {IFeeRules} from "../src/IFeeRules.sol";

/// @dev A plain ERC-20 without a burn function (like the Flap tax token for its holders).
contract MockToken {
    string public name = "Mock";
    string public symbol = "MOCK";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    uint256 public transferFeeBps; // > 0 models a token that taxes wallet transfers
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
    }

    function setTransferFeeBps(uint256 bps) external {
        transferFeeBps = bps;
    }

    bool public noop; // transfer reports success and moves nothing
    uint256 public extraDebit; // transfer takes this much more from the sender than it sends

    function setNoop(bool v) external {
        noop = v;
    }

    function setExtraDebit(uint256 v) external {
        extraDebit = v;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (noop) return true;
        _move(msg.sender, to, amount);
        if (extraDebit != 0) {
            balanceOf[msg.sender] -= extraDebit;
            totalSupply -= extraDebit;
        }
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        _runHook();
        return true;
    }

    // ── a hook run inside every transferFrom: models a tax token doing its pending tax work in a transfer ──
    address public hookTarget;
    bytes public hookData;
    uint256 public hookValue;
    bool public hookOk;
    bytes public hookReturn;

    function setHook(address target, bytes calldata data, uint256 value) external {
        hookTarget = target;
        hookData = data;
        hookValue = value;
    }

    function _runHook() private {
        if (hookTarget == address(0)) return;
        (hookOk, hookReturn) = hookTarget.call{value: hookValue}(hookData);
    }

    /// @dev Moves anyone's balance: models an asset that a hostile token could pull from the pile.
    function forceMove(address from, address to, uint256 amount) external {
        _move(from, to, amount);
    }

    receive() external payable {}

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount * transferFeeBps / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee; // the fee is burned
    }
}

/// @dev Tries to re-enter `redeem` from the native payment.
contract Reenterer {
    FeeRules public target;
    MockToken public tok;
    bool public reentered;

    constructor(FeeRules t, MockToken k) {
        target = t;
        tok = k;
    }

    function go(uint256 amount) external {
        tok.approve(address(target), type(uint256).max);
        target.redeem(amount, 0);
    }

    receive() external payable {
        reentered = true;
        target.redeem(1, 0); // must fail, so the outer payment fails
    }
}

/// @dev Sends its payment straight back to the pile from its receive().
contract PayBack {
    FeeRules public target;

    constructor(FeeRules t) {
        target = t;
    }

    function go(uint256 amount) external {
        MockToken(payable(target.token())).approve(address(target), type(uint256).max);
        target.redeem(amount, 0);
    }

    receive() external payable {
        (bool ok,) = address(target).call{value: msg.value}("");
        require(ok, "pay back");
    }
}

/// @dev A redeemer whose receive() does one of three things with its payment: 0 tries to re-enter redeem, redeemTo
/// and sync (catching each result), 1 pays the pile back, 2 reverts.
contract PayoutCallback {
    FeeRules public target;
    uint8 public mode;
    bytes public innerRedeem;
    bytes public innerRedeemTo;
    bytes public innerSync;

    constructor(FeeRules t, uint8 m) {
        target = t;
        mode = m;
    }

    function go(uint256 amount) external returns (uint256) {
        MockToken(payable(target.token())).approve(address(target), type(uint256).max);
        return target.redeem(amount, 0);
    }

    receive() external payable {
        if (mode == 0) {
            (, innerRedeem) = address(target).call(abi.encodeCall(FeeRules.redeem, (1, 0)));
            (, innerRedeemTo) = address(target).call(abi.encodeCall(FeeRules.redeemTo, (1, 0, address(this))));
            (, innerSync) = address(target).call(abi.encodeCall(FeeRules.sync, ()));
        } else if (mode == 1) {
            (bool ok,) = address(target).call{value: msg.value}("");
            require(ok, "pay back");
        } else {
            revert("no thanks");
        }
    }
}

contract FeeRulesTest is Test {
    address[] NONE;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA201);
    address outsider = address(0x0B5E);

    MockToken tok;
    FeeRules fr; // native pile
    MockToken wbnb; // an ERC-20 asset
    FeeRules frErc; // ERC-20 pile

    function setUp() public {
        tok = new MockToken();
        tok.mint(alice, 600 ether);
        tok.mint(bob, 300 ether);
        tok.mint(carol, 100 ether);
        fr = new FeeRules(address(tok), address(0), NONE);
        wbnb = new MockToken();
        frErc = new FeeRules(address(tok), address(wbnb), NONE);
        vm.label(address(fr), "FeeRules");
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? alice : i == 1 ? bob : carol;
            vm.startPrank(who);
            tok.approve(address(fr), type(uint256).max);
            tok.approve(address(frErc), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _redeem(address who, uint256 amount) internal returns (uint256) {
        vm.prank(who);
        return fr.redeem(amount, 0);
    }

    // ── the arithmetic, to the last unit ──────────────────────────────────────

    function test_firstMiddleLast_toTheLastUnit() public {
        vm.deal(address(fr), 1 ether + 1); // pile 1000000000000000001 wei, circulating 1000 tokens
        assertEq(fr.circulatingSupply(), 1000 ether);

        // first: 1000000000000000001 * 600 / 1000 = 600000000000000000.6 -> 600000000000000000
        assertEq(fr.quoteRedeem(600 ether), 600000000000000000);
        uint256 a0 = alice.balance;
        assertEq(_redeem(alice, 600 ether), 600000000000000000);
        assertEq(alice.balance - a0, 600000000000000000);
        assertEq(fr.pile(), 400000000000000001);
        assertEq(fr.circulatingSupply(), 400 ether);
        assertEq(tok.balanceOf(DEAD), 600 ether);

        // middle: 400000000000000001 * 300 / 400 = 300000000000000000.75 -> 300000000000000000
        assertEq(_redeem(bob, 300 ether), 300000000000000000);
        assertEq(fr.pile(), 100000000000000001);
        assertEq(fr.circulatingSupply(), 100 ether);

        // last: the whole circulating supply empties the pile, rounding units included
        assertEq(_redeem(carol, 100 ether), 100000000000000001);
        assertEq(fr.pile(), 0);
        assertEq(fr.circulatingSupply(), 0);
        assertEq(fr.totalTokensRedeemed(), 1000 ether);
        assertEq(fr.totalPaidOut(), 1 ether + 1);
        assertEq(fr.totalReceived(), 1 ether + 1);
    }

    function test_partialHandIns_roundDownAndStayInPile() public {
        vm.deal(address(fr), 7);
        // 7 * 1 / 1000e18 rounds to zero: the hand-in is allowed, pays nothing, and the pile stays for the others
        assertEq(_redeem(alice, 1), 0);
        assertEq(fr.pile(), 7);
        assertEq(fr.circulatingSupply(), 1000 ether - 1);
    }

    function test_redeemTo_paysAnotherAddress() public {
        vm.deal(address(fr), 10 ether);
        uint256 o0 = outsider.balance;
        vm.prank(alice);
        uint256 out = fr.redeemTo(100 ether, 1 ether, outsider);
        assertEq(out, 1 ether);
        assertEq(outsider.balance - o0, 1 ether);
    }

    // ── revenue by plain transfer, in pieces ──────────────────────────────────

    function test_revenue_plainTransferAndPieces() public {
        address payer = address(0xFEE);
        vm.deal(payer, 10 ether);
        vm.startPrank(payer);
        payable(address(fr)).transfer(1 ether); // 2300 gas stipend: receive() does no work
        (bool ok,) = address(fr).call{value: 2 ether}("");
        assertTrue(ok);
        (ok,) = address(fr).call{value: 3}("");
        assertTrue(ok);
        vm.stopPrank();
        assertEq(fr.pile(), 3 ether + 3);
        assertEq(fr.totalReceived(), 3 ether + 3);

        vm.expectEmit(address(fr));
        emit IFeeRules.RevenueRecognised(3 ether + 3, 3 ether + 3);
        fr.sync();

        // a sync with nothing new emits nothing and changes nothing
        vm.recordLogs();
        fr.sync();
        assertEq(vm.getRecordedLogs().length, 0);

        assertEq(_redeem(bob, 300 ether), uint256(3 ether + 3) * 300 / 1000);
        // more revenue after a redemption is recognised as exactly the new piece
        vm.prank(payer);
        payable(address(fr)).transfer(5);
        vm.expectEmit(address(fr));
        emit IFeeRules.RevenueRecognised(5, fr.pile());
        fr.sync();
    }

    function test_erc20Pile_transferPlusWakeCall() public {
        wbnb.mint(address(frErc), 10 ether);
        (bool ok,) = address(frErc).call(""); // the empty wake call after an ERC-20 payment
        assertTrue(ok);
        assertEq(frErc.pile(), 10 ether);
        vm.prank(alice);
        uint256 out = frErc.redeem(250 ether, 2.5 ether);
        assertEq(out, 2.5 ether);
        assertEq(wbnb.balanceOf(alice), 2.5 ether);
        assertEq(frErc.pile(), 7.5 ether);
        assertEq(frErc.totalReceived(), 10 ether);
    }

    function test_erc20Pile_refusesNativeCoin() public {
        vm.deal(address(this), 1 ether);
        (bool ok, bytes memory ret) = address(frErc).call{value: 1}("");
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(FeeRules.NativeNotAccepted.selector));
    }

    // ── a burn to DEAD by anyone raises everyone else's share ─────────────────

    function test_deadBalanceLeavesCirculation() public {
        vm.deal(address(fr), 1 ether);
        vm.prank(carol);
        tok.transfer(DEAD, 100 ether); // like the tax's DEFLATION slot
        assertEq(fr.circulatingSupply(), 900 ether);
        assertEq(fr.quoteRedeem(300 ether), uint256(1 ether) * 300 / 900);
    }

    // ── nothing an outsider can take ──────────────────────────────────────────

    function test_outsider_cannotTake() public {
        vm.deal(address(fr), 5 ether);
        vm.startPrank(outsider);
        tok.approve(address(fr), type(uint256).max);
        vm.expectRevert(IFeeRules.InexactMovement.selector); // holds no tokens: the hand-in fails
        fr.redeem(1 ether, 0);
        vm.expectRevert(IFeeRules.ZeroAmount.selector);
        fr.redeem(0, 0);
        vm.stopPrank();
        // no approval from alice: an outsider cannot hand in alice's tokens (transferFrom is from msg.sender)
        vm.prank(outsider);
        vm.expectRevert(IFeeRules.InexactMovement.selector);
        fr.redeemTo(1 ether, 0, outsider);
        assertEq(fr.pile(), 5 ether);
    }

    function test_exceedsCirculating_andMinimum() public {
        vm.deal(address(fr), 5 ether);
        vm.expectRevert(abi.encodeWithSelector(IFeeRules.ExceedsCirculating.selector, 1001 ether, 1000 ether));
        fr.quoteRedeem(1001 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IFeeRules.BelowMinimum.selector, 0.5 ether, 0.5 ether + 1));
        fr.redeem(100 ether, 0.5 ether + 1);
        vm.prank(alice);
        vm.expectRevert(FeeRules.InvalidRecipient.selector);
        fr.redeemTo(1 ether, 0, address(0));
        vm.prank(alice);
        vm.expectRevert(FeeRules.InvalidRecipient.selector);
        fr.redeemTo(1 ether, 0, address(fr));
    }

    function test_reentrancy_failsTheOuterRedemption() public {
        Reenterer r = new Reenterer(fr, tok);
        vm.prank(alice);
        tok.transfer(address(r), 10 ether);
        vm.deal(address(fr), 1 ether);
        vm.expectRevert(IFeeRules.PaymentFailed.selector);
        r.go(5 ether);
        assertEq(fr.pile(), 1 ether);
        assertEq(tok.balanceOf(address(r)), 10 ether);
    }

    function test_taxedTransfer_isRefused() public {
        tok.setTransferFeeBps(100);
        vm.deal(address(fr), 1 ether);
        vm.prank(alice);
        vm.expectRevert(IFeeRules.InexactMovement.selector);
        fr.redeem(100 ether, 0);
    }

    // ── no path changes the rules ─────────────────────────────────────────────

    /// @dev `new` in a test runs through the deployCode cheatcode in this forge version, where `vm.expectRevert`
    /// before it ends the test as a vacuous pass; so each refusal is caught and its data compared.
    function _refused(address t, address a, address[] memory ex) internal {
        try new FeeRules(t, a, ex) returns (FeeRules) {
            revert("accepted a configuration that must be refused");
        } catch (bytes memory err) {
            assertEq(err, abi.encodeWithSelector(FeeRules.InvalidConfig.selector));
        }
    }

    function test_config_validated() public {
        _refused(address(0), address(0), NONE);
        _refused(address(tok), address(tok), NONE);
        address[] memory ex = new address[](5);
        for (uint256 i; i < 5; ++i) ex[i] = address(uint160(0x1000 + i));
        _refused(address(tok), address(0), ex); // more than four
        address[] memory bad = new address[](1);
        bad[0] = address(0);
        _refused(address(tok), address(0), bad);
        bad[0] = DEAD;
        _refused(address(tok), address(0), bad);
        bad[0] = address(tok);
        _refused(address(tok), address(0), bad);
        address[] memory dup = new address[](2);
        dup[0] = alice;
        dup[1] = alice;
        _refused(address(tok), address(0), dup);
        // and four distinct holders are accepted
        address[] memory four = new address[](4);
        for (uint256 i; i < 4; ++i) four[i] = address(uint160(0x3000 + i));
        assertEq(new FeeRules(address(tok), address(0), four).excludedHolders().length, 4);
    }

    // ── excluded holders ──────────────────────────────────────────────────────

    /// A launch vault holds 200 unsold tokens (excluded); 1000 are in hands. Shares are of the 1000, and when all
    /// 1000 are handed in the pile is empty although the excluded holder still holds its 200.
    function test_excluded_sharesAndLastHolder() public {
        address engineVault = address(0x7A017);
        tok.mint(engineVault, 200 ether);
        address[] memory ex = new address[](1);
        ex[0] = engineVault;
        FeeRules f = new FeeRules(address(tok), address(0), ex);
        assertEq(f.excludedHolders().length, 1);
        assertEq(f.excludedHolders()[0], engineVault);
        assertTrue(f.isExcluded(engineVault));
        assertFalse(f.isExcluded(alice));
        assertEq(tok.totalSupply(), 1200 ether);
        assertEq(f.circulatingSupply(), 1000 ether);
        vm.deal(address(f), 1 ether + 1);
        address[3] memory who = [alice, bob, carol];
        uint256[3] memory amt = [uint256(600 ether), 300 ether, 100 ether];
        uint256[3] memory want = [uint256(600000000000000000), 300000000000000000, 100000000000000001];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(who[i]);
            tok.approve(address(f), type(uint256).max);
            assertEq(f.redeem(amt[i], 0), want[i]);
            vm.stopPrank();
        }
        assertEq(f.pile(), 0, "the last holder outside the excluded one emptied the pile");
        assertEq(f.circulatingSupply(), 0);
        assertEq(tok.balanceOf(engineVault), 200 ether);

        // the excluded holder may not redeem
        vm.deal(address(f), 1 ether);
        vm.startPrank(engineVault);
        tok.approve(address(f), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IFeeRules.ExcludedHolder.selector, engineVault));
        f.redeem(1 ether, 0);
        vm.stopPrank();

        // tokens it releases (sold to a buyer) join the circulating supply
        vm.prank(engineVault);
        tok.transfer(alice, 50 ether);
        assertEq(f.circulatingSupply(), 50 ether);
        assertEq(f.quoteRedeem(50 ether), 1 ether);
    }

    function test_excluded_fourHolders_andTokensSentHere() public {
        address[] memory ex = new address[](4);
        for (uint256 i; i < 4; ++i) {
            ex[i] = address(uint160(0x2000 + i));
            tok.mint(ex[i], 10 ether);
        }
        FeeRules f = new FeeRules(address(tok), address(0), ex);
        assertEq(f.circulatingSupply(), 1000 ether);
        vm.prank(alice);
        tok.transfer(address(f), 100 ether); // tokens sent to the pile itself are out of anyone's hands
        assertEq(f.circulatingSupply(), 900 ether);
    }

    /// The complete external surface, read from the compiled artifact: fifteen functions, three of them state-changing (redeem,
    /// redeemTo, sync), none of which writes `token` or `asset`; everything else is a view.
    function test_abi_hasNoSetterOwnerOrUpgrade() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/out/FeeRules.sol/FeeRules.json"));
        string[] memory sigs = vm.parseJsonKeys(json, ".methodIdentifiers");
        string[15] memory expected = [
            "DEAD()",
            "MAX_EXCLUDED()",
            "excludedHolders()",
            "isExcluded(address)",
            "asset()",
            "circulatingSupply()",
            "pile()",
            "quoteRedeem(uint256)",
            "redeem(uint256,uint256)",
            "redeemTo(uint256,uint256,address)",
            "sync()",
            "token()",
            "totalPaidOut()",
            "totalReceived()",
            "totalTokensRedeemed()"
        ];
        assertEq(sigs.length, 15, "exactly fifteen external functions");
        for (uint256 i; i < sigs.length; ++i) {
            bool known;
            for (uint256 j; j < 15; ++j) {
                if (keccak256(bytes(sigs[i])) == keccak256(bytes(expected[j]))) known = true;
            }
            assertTrue(known, sigs[i]);
        }
    }

    function test_unknownCalls_revert() public {
        bytes[6] memory calls = [
            abi.encodeWithSignature("owner()"),
            abi.encodeWithSignature("transferOwnership(address)", address(this)),
            abi.encodeWithSignature("upgradeToAndCall(address,bytes)", address(this), hex"1234"),
            abi.encodeWithSignature("pause()"),
            abi.encodeWithSignature("setToken(address)", address(this)),
            abi.encodeWithSignature("withdraw(uint256)", 1 ether)
        ];
        vm.deal(address(fr), 1 ether);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = address(fr).call(calls[i]);
            assertFalse(ok);
            assertEq(ret.length, 0, "no such function: no fallback answers it");
        }
        assertEq(fr.pile(), 1 ether);
    }

    // ── the payout is exact (review finding 2 and 7) ──────────────────────────

    /// An ERC-20 asset that taxes its own transfers would pay the holder less than `minOut`: refused.
    function test_erc20Payout_recipientCreditShort_isRefused() public {
        wbnb.mint(address(frErc), 100 ether);
        wbnb.setTransferFeeBps(1000); // debits 50, credits 45
        vm.prank(alice);
        vm.expectRevert(IFeeRules.InexactMovement.selector);
        frErc.redeem(500 ether, 50 ether);
        assertEq(wbnb.balanceOf(alice), 0);
        assertEq(frErc.totalPaidOut(), 0);
    }

    /// An asset that reports success and moves nothing: refused.
    function test_erc20Payout_noMovement_isRefused() public {
        wbnb.mint(address(frErc), 100 ether);
        wbnb.setNoop(true);
        vm.prank(alice);
        vm.expectRevert(IFeeRules.InexactMovement.selector);
        frErc.redeem(500 ether, 0);
    }

    /// The hand-in adds 10, the payout of 50 debits 60: refused (exact against the fresh snapshot).
    function test_erc20Payout_handInAdds10_payoutDebits60_isRefused() public {
        wbnb.mint(address(frErc), 100 ether);
        tok.setHook(address(wbnb), abi.encodeCall(MockToken.mint, (address(frErc), 10 ether)), 0);
        wbnb.setExtraDebit(10 ether);
        vm.prank(alice);
        vm.expectRevert(IFeeRules.InexactMovement.selector);
        frErc.redeem(500 ether, 0);
        // the same hand-in with an honest asset pays the fixed 50 and keeps the 10 for the others
        wbnb.setExtraDebit(0);
        vm.prank(alice);
        assertEq(frErc.redeem(500 ether, 50 ether), 50 ether);
        assertEq(wbnb.balanceOf(alice), 50 ether);
        assertEq(frErc.pile(), 60 ether);
    }

    /// A native recipient that pays the pile back during its own payment: refused (no revenue may arrive after the
    /// payout's numbers were fixed).
    function test_nativePayout_recipientPaysBack_isRefused() public {
        PayBack r = new PayBack(fr);
        vm.prank(alice);
        tok.transfer(address(r), 100 ether);
        vm.deal(address(fr), 1 ether);
        vm.expectRevert(IFeeRules.InexactMovement.selector);
        r.go(100 ether);
        assertEq(fr.pile(), 1 ether);
    }

    /// "At least" at DEAD: the token burns 50 of bob's tokens to DEAD during alice's hand-in. Alice is paid the
    /// fixed amount; the circulating supply drops by her 100 and the extra 50; nobody is paid wrongly.
    function test_extraBurnToDeadDuringHandIn_paysTheFixedAmount() public {
        vm.deal(address(fr), 1 ether);
        tok.setHook(address(tok), abi.encodeCall(MockToken.forceMove, (bob, DEAD, 50 ether)), 0);
        uint256 a0 = alice.balance;
        vm.prank(alice);
        assertEq(fr.redeem(100 ether, 0.1 ether), 0.1 ether);
        assertTrue(tok.hookOk());
        assertEq(alice.balance - a0, 0.1 ether);
        assertEq(fr.circulatingSupply(), 850 ether);
        assertEq(fr.pile(), 0.9 ether);
        tok.setHook(address(0), "", 0);
        // bob's next 250 of 850 is valued on the remaining pile: 0.9 * 250 / 850, rounded down
        vm.prank(bob);
        assertEq(fr.redeem(250 ether, 0), uint256(0.9 ether) * 250 / 850);
    }

    // ── revenue that arrives during the hand-in (a tax token doing its tax work inside the transfer) ──

    /// Native pile: 0.5 BNB arrives inside alice's hand-in. She is paid the old formula on the pile before it
    /// (0.6 of 1.000000000000000001), the 0.5 stays for the others, the events and sums say so.
    function test_payInDuringHandIn_native() public {
        vm.deal(address(fr), 1 ether + 1);
        vm.deal(address(tok), 10 ether);
        tok.setHook(address(fr), "", 0.5 ether); // a plain value transfer to the pile: receive() needs no guard
        uint256 a0 = alice.balance;
        vm.expectEmit(address(fr));
        emit IFeeRules.RevenueRecognised(1 ether + 1, 1 ether + 1);
        vm.expectEmit(address(fr));
        emit IFeeRules.RevenueRecognised(0.5 ether, 1.5 ether + 1);
        vm.expectEmit(address(fr));
        emit IFeeRules.Redeemed(alice, alice, 600 ether, 0.6 ether);
        vm.prank(alice);
        assertEq(fr.redeem(600 ether, 0.6 ether), 0.6 ether, "payout from the pile before the hand-in");
        assertTrue(tok.hookOk());
        assertEq(alice.balance - a0, 0.6 ether);
        assertEq(fr.pile(), 0.9 ether + 1, "the revenue stays for the remaining holders");
        assertEq(fr.totalPaidOut(), 0.6 ether);
        assertEq(fr.totalReceived(), 1.5 ether + 1, "every wei that arrived is counted once");
        vm.recordLogs();
        fr.sync(); // already recognised: nothing new
        assertEq(vm.getRecordedLogs().length, 0);

        // the next holder is paid on the larger pile: 900000000000000001 * 300 / 400, rounded down
        tok.setHook(address(0), "", 0);
        vm.prank(bob);
        assertEq(fr.redeem(300 ether, 0), 675000000000000000);
        assertEq(fr.pile(), 225000000000000001);
    }

    function test_payInDuringHandIn_erc20() public {
        wbnb.mint(address(frErc), 1 ether + 1);
        tok.setHook(address(wbnb), abi.encodeCall(MockToken.mint, (address(frErc), 0.5 ether)), 0);
        vm.prank(alice);
        assertEq(frErc.redeem(600 ether, 0), 0.6 ether);
        assertTrue(tok.hookOk());
        assertEq(wbnb.balanceOf(alice), 0.6 ether);
        assertEq(frErc.pile(), 0.9 ether + 1);
        assertEq(frErc.totalReceived(), 1.5 ether + 1);
    }

    /// A token whose transfer takes FROM the pile is still refused, and nothing moves.
    function test_takeFromPileDuringHandIn_isRefused() public {
        wbnb.mint(address(frErc), 1 ether);
        tok.setHook(address(wbnb), abi.encodeCall(MockToken.forceMove, (address(frErc), outsider, 1)), 0);
        vm.prank(alice);
        vm.expectRevert(IFeeRules.InexactMovement.selector);
        frErc.redeem(600 ether, 0);
        assertEq(frErc.pile(), 1 ether);
        assertEq(tok.balanceOf(alice), 600 ether);
    }

    /// A call back into redeem, redeemTo or sync from inside the hand-in is refused by the guard (the outer
    /// redemption goes on: plain revenue never needs a guarded function).
    function test_reentryDuringHandIn_isRefused() public {
        vm.deal(address(fr), 1 ether);
        vm.prank(alice);
        tok.transfer(address(tok), 10 ether); // the token holds some of itself, as a tax token does
        bytes[3] memory calls = [
            abi.encodeCall(FeeRules.redeem, (1, 0)),
            abi.encodeCall(FeeRules.redeemTo, (1, 0, outsider)),
            abi.encodeCall(FeeRules.sync, ())
        ];
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            tok.setHook(address(fr), calls[i], 0);
            vm.prank(who[i]);
            fr.redeem(10 ether, 0);
            assertFalse(tok.hookOk(), "the call back was refused");
            assertEq(bytes4(tok.hookReturn()), IFeeRules.Reentrancy.selector);
        }
    }

    /// The last holder takes revenue that arrives during its own hand-in too: nobody is left to redeem it.
    function test_payInDuringLastHandIn_goesToTheLastHolder() public {
        vm.deal(address(fr), 1 ether);
        vm.prank(alice);
        fr.redeem(600 ether, 0);
        vm.prank(bob);
        fr.redeem(300 ether, 0);
        uint256 left = fr.pile();
        vm.deal(address(tok), 1 ether);
        tok.setHook(address(fr), "", 0.25 ether);
        uint256 c0 = carol.balance;
        vm.prank(carol);
        assertEq(fr.redeem(100 ether, left), left + 0.25 ether);
        assertEq(carol.balance - c0, left + 0.25 ether);
        assertEq(fr.pile(), 0);
        assertEq(fr.totalReceived(), 1.25 ether);
    }

    // ── the second review's core findings (4, 7, 10, 12) ──────────────────────

    /// An extra burn that ENDS circulation: one unit with alice, one unit the token's own pending burn, pile 100.
    /// Alice hands in 1, the token burns its own 1 in the same transfer: nothing circulates after, so alice is the
    /// last and takes the whole pile (not 50 with 50 stranded).
    function test_extraBurnEndingCirculation_lastTakesAll() public {
        MockToken t2 = new MockToken();
        t2.mint(alice, 1 ether);
        t2.mint(address(t2), 1 ether);
        FeeRules f = new FeeRules(address(t2), address(0), NONE);
        vm.deal(address(f), 100 ether);
        assertEq(f.circulatingSupply(), 2 ether);
        assertEq(f.quoteRedeem(1 ether), 50 ether);
        t2.setHook(address(t2), abi.encodeCall(MockToken.forceMove, (address(t2), DEAD, 1 ether)), 0);
        uint256 a0 = alice.balance;
        vm.startPrank(alice);
        t2.approve(address(f), type(uint256).max);
        assertEq(f.redeem(1 ether, 100 ether), 100 ether);
        vm.stopPrank();
        assertTrue(t2.hookOk());
        assertEq(alice.balance - a0, 100 ether);
        assertEq(f.pile(), 0);
        assertEq(f.circulatingSupply(), 0);
    }

    /// The last holder's minOut is compared with its final payout: pile 10, one unit circulating, the hand-in adds
    /// 2: redeem(1, 11) pays 12.
    function test_lastHolder_minOutAgainstFinalPayout() public {
        MockToken t3 = new MockToken();
        t3.mint(alice, 1 ether);
        FeeRules f = new FeeRules(address(t3), address(0), NONE);
        vm.deal(address(f), 10 ether);
        vm.deal(address(t3), 2 ether);
        t3.setHook(address(f), "", 2 ether);
        vm.startPrank(alice);
        t3.approve(address(f), type(uint256).max);
        assertEq(f.redeem(1 ether, 11 ether), 12 ether);
        vm.stopPrank();
        assertEq(f.pile(), 0);
        // and a minOut above the final payout is refused with the final number
        MockToken t4 = new MockToken();
        t4.mint(bob, 1 ether);
        FeeRules g = new FeeRules(address(t4), address(0), NONE);
        vm.deal(address(g), 10 ether);
        vm.startPrank(bob);
        t4.approve(address(g), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IFeeRules.BelowMinimum.selector, 10 ether, 10 ether + 1));
        g.redeem(1 ether, 10 ether + 1);
        vm.stopPrank();
    }

    /// The three inner results of a native payout callback: re-entry is refused inside (the payment itself goes
    /// through), a pay-back fails the redemption with InexactMovement, a reverting recipient with PaymentFailed.
    function test_nativePayoutCallback_threeResults() public {
        vm.deal(address(fr), 1 ether);
        PayoutCallback c0 = new PayoutCallback(fr, 0);
        PayoutCallback c1 = new PayoutCallback(fr, 1);
        PayoutCallback c2 = new PayoutCallback(fr, 2);
        vm.startPrank(alice);
        tok.transfer(address(c0), 100 ether);
        tok.transfer(address(c1), 100 ether);
        tok.transfer(address(c2), 100 ether);
        vm.stopPrank();

        assertEq(c0.go(100 ether), 0.1 ether);
        assertEq(address(c0).balance, 0.1 ether);
        bytes memory reentry = abi.encodeWithSelector(IFeeRules.Reentrancy.selector);
        assertEq(c0.innerRedeem(), reentry);
        assertEq(c0.innerRedeemTo(), reentry);
        assertEq(c0.innerSync(), reentry);

        vm.expectRevert(IFeeRules.InexactMovement.selector);
        c1.go(100 ether);
        vm.expectRevert(IFeeRules.PaymentFailed.selector);
        c2.go(100 ether);
        assertEq(fr.pile(), 0.9 ether);
        assertEq(fr.totalPaidOut(), 0.1 ether);
    }

    // ── properties over random histories ──────────────────────────────────────

    function testFuzz_payoutsNeverExceedPile_lastEmpties(uint96 pileWei, uint256 aIn, uint256 bIn, uint96 extra)
        public
    {
        vm.deal(address(fr), pileWei);
        aIn = bound(aIn, 1, 600 ether);
        bIn = bound(bIn, 1, 300 ether);
        uint256 total;
        total += _redeem(alice, aIn);
        vm.deal(address(fr), address(fr).balance + extra); // revenue arrives between hand-ins
        total += _redeem(bob, bIn);
        assertLe(total, uint256(pileWei) + extra);
        // everyone left hands in everything: the last one empties the pile exactly
        if (600 ether - aIn > 0) total += _redeem(alice, 600 ether - aIn);
        if (300 ether - bIn > 0) total += _redeem(bob, 300 ether - bIn);
        total += _redeem(carol, 100 ether);
        assertEq(total, uint256(pileWei) + extra);
        assertEq(fr.pile(), 0);
        assertEq(fr.totalPaidOut(), total);
    }

    function testFuzz_quoteIsFloorOfShare(uint128 pileWei, uint256 amount) public {
        amount = bound(amount, 1, 1000 ether - 1);
        vm.deal(address(fr), pileWei);
        assertEq(fr.quoteRedeem(amount), uint256(pileWei) * amount / (1000 ether));
    }

    function test_mulDiv_productAbove256Bits() public {
        // pile * amount needs more than 256 bits; the 512-bit path must give the exact floor
        MockToken big = new MockToken();
        big.mint(alice, uint256(1) << 100);
        big.mint(bob, uint256(1) << 100);
        big.mint(carol, 1);
        FeeRules f = new FeeRules(address(big), address(0), NONE);
        uint256 p = uint256(1) << 200;
        vm.deal(address(f), p);
        uint256 c = (uint256(1) << 101) + 1;
        assertEq(f.circulatingSupply(), c);
        uint256 a = (uint256(1) << 100) - 12345;
        uint256 expected = (p / c) * a + ((p % c) * a) / c; // the same floor, computed without overflow
        assertEq(f.quoteRedeem(a), expected);
        assertEq(f.quoteRedeem(c), p);
    }
}
