// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {console2} from "forge-std/console2.sol";
import {PileForkBase, IERC20F, ITaxTokenF, ITaxProcessorF} from "./PileForkBase.sol";
import {CurveConfig} from "../src/RulesCurveLauncher.sol";
import {RulesTokenCurveLauncher as TokenCurveLauncher} from "../src/RulesTokenCurveLauncher.sol";
import {RulesTokenCurveLauncherFactory as TokenCurveLauncherFactory} from "../src/RulesTokenCurveLauncherFactory.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {PileVault} from "../src/PileVault.sol";
import {PileDeployer, RulesVaultDeployer} from "../src/RulesDeployers.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {RailStake} from "fee-rules/RailStake.sol";
import {RailStakeFactory} from "fee-rules/RailStakeFactory.sol";

interface IMintableS {
    function mint(address to, uint256 amount) external;
}

interface IRouterS {
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @notice Holder payouts on their token, on the live test network Portal: the creator creates its RailStake for the
/// token to come, names it as the payee of a rule (creator 10%, pile 30%, holders 40%, buy and burn 20% last),
/// launches in Flap's test dollar; trades raise income, the share-out pays the stake exactly its 40%, two holders
/// stake, time passes, their claims add up to what arrived and follow stake times seconds; both unstake in full.
contract RailStakeForkTest is PileForkBase {
    address constant USD = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;
    uint256 constant PERIOD = 1 days;
    address payee = address(uint160(0xC0DE0099));

    RulesVaultFactory rvf;
    TokenCurveLauncherFactory lf;
    RailStakeFactory sf;

    function setUp() public {
        if (!_forkSetUp()) return;
        rvf = new RulesVaultFactory(PORTAL, USD, ROUTER, new PileDeployer(), new RulesVaultDeployer());
        lf = new TokenCurveLauncherFactory(PORTAL, address(rvf), TOKEN_IMPL);
        sf = new RailStakeFactory();
        address[4] memory who = [creator, alice, bob, trader];
        for (uint256 i; i < 4; ++i) IMintableS(USD).mint(who[i], 100_000 ether);
    }

    function _cfg(bytes32 salt) internal pure returns (CurveConfig memory c) {
        c.name = "Holders Paid";
        c.symbol = "HOLD";
        c.salt = salt;
        c.saleTokens = 600_000_000 ether;
        c.targetRaise = 1_700 ether;
        c.virtualBnb = 11_600 ether;
        c.duration = 1 days;
        c.tradeFeeBps = 100;
        c.buyTaxBps = 300;
        c.sellTaxBps = 500;
        c.burnShareBps = 2000;
        c.taxDuration = 365 days;
    }

    function _swap(address from, address to, uint256 amount) internal {
        IERC20F(from).approve(ROUTER, amount);
        address[] memory path = new address[](2);
        path[0] = from;
        path[1] = to;
        IRouterS(ROUTER).swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, 0, path, trader, block.timestamp + 600);
    }

    function _tradeAndDispatch(address token, address splitter) internal returns (uint256 share) {
        address proc = ITaxTokenF(token).taxProcessor();
        vm.warp(block.timestamp + 601);
        vm.startPrank(trader);
        _swap(USD, token, 200 ether);
        for (uint256 i; i < 80 && ITaxProcessorF(proc).marketQuoteBalance() == 0; ++i) {
            uint256 amt = IERC20F(token).balanceOf(trader) * 30 / 100;
            if (amt == 0) break;
            uint256 u0 = IERC20F(USD).balanceOf(trader);
            _swap(token, USD, amt);
            uint256 got = IERC20F(USD).balanceOf(trader) - u0;
            if (got > 0) _swap(USD, token, got * 90 / 100);
        }
        vm.stopPrank();
        share = ITaxProcessorF(proc).marketQuoteBalance();
        assertGt(share, 0, "the vault slot's share is waiting");
        ITaxProcessorF(proc).dispatch();
    }

    /// The launch: stake first (for the token to come), rules naming it, then the sale; returns the launched parts.
    function _launch() internal returns (address token, RulesVault splitter, RailStake st, TokenCurveLauncher l) {
        bytes32 salt = _mineSalt(keccak256("rail-stake"));
        address tokenToCome = lf.predictToken(salt);
        assertEq(tokenToCome.code.length, 0, "the token does not exist yet");
        address named = sf.stakeAddress(creator, tokenToCome, USD, PERIOD);
        vm.prank(creator);
        st = RailStake(payable(sf.create(tokenToCome, USD, PERIOD)));
        assertEq(address(st), named);

        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](4);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 1000, target: payee});
        r[1] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: 3000, target: address(0)});
        r[2] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 4000, target: address(st)});
        r[3] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: 2000, target: address(0)}); // the heaviest call last
        vm.prank(creator);
        rvf.setRules(address(lf), salt, r);
        uint256 fee = lf.creationFee();
        vm.prank(creator);
        l = TokenCurveLauncher(portal.newLauncher{value: fee}(address(lf), abi.encode(_cfg(salt))));

        vm.startPrank(alice);
        IERC20F(USD).approve(address(l), 300 ether);
        l.buy(300 ether, 0);
        vm.stopPrank();
        uint256 need = l.costToComplete();
        vm.startPrank(bob);
        IERC20F(USD).approve(address(l), need);
        l.complete(need);
        vm.stopPrank();
        address vault;
        (token,, vault) = l.launchInfo();
        assertEq(token, tokenToCome);
        splitter = RulesVault(payable(vault));
        vm.prank(alice);
        l.claim();
        vm.prank(bob);
        l.claim();
        // what a page checks: the creator's stake for this token, and the fourth rule pays it
        assertEq(sf.stakeOf(creator, token), address(st));
        assertTrue(sf.isStake(address(st)));
        assertEq(st.token(), token);
        assertEq(st.factory(), address(sf));
        (,, address target) = splitter.rule(2);
        assertEq(target, address(st));
    }

    function _stakeAs(RailStake st, address who, uint256 amount) internal returns (uint256 credited) {
        vm.startPrank(who);
        IERC20F(st.token()).approve(address(st), amount);
        credited = st.stake(amount);
        vm.stopPrank();
        assertEq(credited, amount, "a wallet transfer of their token is not taxed: credited in full");
    }

    function test_usd_holdersPaid_twoStakers_claimsAddUp() public {
        (address token, RulesVault splitter, RailStake st,) = _launch();
        uint256 a0 = IERC20F(token).balanceOf(alice);
        uint256 b0 = IERC20F(token).balanceOf(bob);
        uint256 aStake = a0 / 2;
        uint256 bStake = b0;
        _stakeAs(st, alice, aStake);
        _stakeAs(st, bob, bStake);
        uint256 toStake = _shareOut(token, splitter, st);
        _claimsAddUp(st, toStake, aStake, bStake);
        vm.prank(alice);
        st.unstake(aStake);
        vm.prank(bob);
        st.unstake(bStake);
        assertEq(IERC20F(token).balanceOf(alice), a0, "alice's tokens back in full");
        assertEq(IERC20F(token).balanceOf(bob), b0, "bob's tokens back in full");
        assertEq(IERC20F(token).balanceOf(address(st)), 0);
    }

    /// Trades, the dispatch and the share-out: each rule gets exactly its part, the stake 40%, uncounted until a sync.
    function _shareOut(address token, RulesVault splitter, RailStake st) internal returns (uint256 toStake) {
        _tradeAndDispatch(token, address(splitter));
        uint256 income = splitter.pending();
        uint256 pay0 = IERC20F(USD).balanceOf(payee);
        address pile = rvf.pileOf(token);
        uint256 pile0 = PileVault(payable(pile)).pile();
        uint256 dead0 = IERC20F(token).balanceOf(DEAD);
        splitter.distribute();
        toStake = splitter.delivered(2);
        assertEq(toStake, _part(income, 4000), "40% to the holders");
        assertEq(st.unsynced(), toStake, "the stake holds exactly its part, uncounted");
        assertEq(IERC20F(USD).balanceOf(payee) - pay0, splitter.delivered(0), "creator 10%");
        assertEq(PileVault(payable(pile)).pile() - pile0, splitter.delivered(1), "pile 30%");
        assertGt(IERC20F(token).balanceOf(DEAD), dead0, "buy and burn 20%");
        console2.log("income", income);
        console2.log("to the stake", toStake);
    }

    function _part(uint256 income, uint256 bps) internal pure returns (uint256) {
        return income / 10_000 * bps + income % 10_000 * bps / 10_000;
    }

    function _claimsAddUp(RailStake st, uint256 toStake, uint256 aStake, uint256 bStake) internal {
        assertEq(st.sync(), toStake);
        vm.warp(block.timestamp + PERIOD / 4);
        vm.prank(alice);
        uint256 aPaid = st.claim(); // a claim in the middle of the stream
        vm.warp(block.timestamp + PERIOD);
        vm.prank(alice);
        aPaid += st.claim();
        vm.prank(bob);
        uint256 bPaid = st.claim();
        console2.log("alice", aPaid);
        console2.log("bob", bPaid);
        assertLe(aPaid + bPaid, toStake, "never more than arrived");
        assertGe(aPaid + bPaid + 2, toStake, "all of it, but rounding");
        assertApproxEqRel(aPaid * (aStake + bStake), toStake * aStake, 1e12, "stake x seconds");
        assertEq(st.claimed(), aPaid + bPaid);
        assertEq(IERC20F(USD).balanceOf(address(st)), toStake - aPaid - bPaid);
    }

    /// A staker who arrives after the share-out earns only from its first second.
    function test_usd_lateStaker_earnsFromItsFirstSecond() public {
        (address token, RulesVault splitter, RailStake st,) = _launch();
        _stakeAs(st, alice, IERC20F(token).balanceOf(alice) / 2);
        _shareOut(token, splitter, st);
        uint256 toStake = st.sync();
        vm.warp(block.timestamp + PERIOD / 2);
        uint256 bStake = IERC20F(token).balanceOf(bob);
        _stakeAs(st, bob, bStake); // half the stream already went to alice
        vm.warp(block.timestamp + PERIOD);
        vm.prank(alice);
        uint256 aPaid = st.claim();
        vm.prank(bob);
        uint256 bPaid = st.claim();
        assertGe(aPaid, toStake / 2, "the first half was alice's alone");
        assertLe(bPaid, toStake / 2, "bob shares only the second half");
        assertLe(aPaid + bPaid, toStake);
        assertGe(aPaid + bPaid + 2, toStake);
    }
}
