// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

// BNB MAIN NETWORK (chain 56) FORK BASE, pinned at block 135,830,000 (2026-11-26, 10:22:55 UTC).
//
// Endpoint: BSC_RPC_URL (the variable Flap's own BNB Chain fork tests read). Without it every test here SKIPS.
// The public endpoint these tests were run with, no key: https://bsc-mainnet.public.blastapi.io
// It served this block's state on 2026-11-26 and served state two million blocks back (archive), so the pin holds.
// The other public endpoints, measured the same day (eth_getStorageAt of the Portal, N blocks behind the head):
//   bsc-rpc.publicnode.com    2,000 and 5,081 back yes, 20,000 back "Archive requests require a personal token"
//   bsc-dataseed.bnbchain.org 10 back yes, 200 back "missing trie node"
//   1rpc.io/bnb               200 back yes, 2,000 back "historical state ... is not available"
//   bsc.meowrpc.com           20,000 back yes, 200,000 back "historical state ... is not available"
//   bsc.drpc.org              rate-limited after one call
// At 0.45 to 0.75 s a block, only an archive endpoint serves this block for longer than an hour or two after it.
// forge keeps what it fetched for the pinned block in ~/.foundry/cache/rpc/bsc/135830000, but that does NOT make a
// later run independent of an archive endpoint: measured on a warm cache with the probe off, a pruned endpoint
// (bsc-dataseed) still failed setUp on an account forge fetched again ("missing trie node"). So the base reads the
// block's state once through the endpoint BEFORE the fork (BSC_FORK_PROBE=0 leaves that out) and SKIPS with the line
// "SKIP: ..." when the endpoint cannot serve it; without BSC_RPC_URL it skips too. Neither case fails.
// Run (one test at a time, throttled: the public endpoints answer HTTP 429 to bursts, and forge turns a refused read
// into a plain revert):
//   BSC_RPC_URL=https://bsc-mainnet.public.blastapi.io FOUNDRY_COMPUTE_UNITS_PER_SECOND=200 FOUNDRY_FORK_RETRIES=12 \
//   FOUNDRY_FORK_RETRY_BACKOFF=3000 forge test -j 1 --match-path 'test/*Mainnet*' -vv
//
// What the fork shows at the pinned block (read by test_facts_atThePinnedBlock in CurvePileMainnet.fork.t.sol):
//   Portal 0x000042108465206185A077Edc3F3fd2b49060000 version "v1.2.0" (implementation 0xb0dAA34A...D124d9)
//   creation PAUSED: featureFlags() == 1 (bit 0 = creation paused)
//   SALT_LOCK_FEE 0.005 BNB
//   quotes enabled for kind 0 (launchQuoteConfig): native BNB at 700 USD, USDT 0x55d3... at 1 USD, USD1 0x8d0D...
//   at 1 USD; not enabled: WBNB, USDC, FDUSD, BUSD, ETH, Cake
//   creation floor (graduationFloorV2.createFloorUsdWad): 750 USD when the whole supply seeds the pool, 1,500 USD
//   when half does, at multiplierBps 10,000 for a vault factory that is not enabled
//   a launcher factory that is not enabled: launcherFactoryMultiplier == (false, 10_000), and Portal.newLauncher
//   through it reverts LauncherFactoryNotEnabled(factory) (0xa8a3c683) under the pause
//   tax-token implementation 0x7777c57ff7dc441c1715b2e36fa581c48B782222 (15,647 bytes of code)
//   Guardian 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b (= LaunchVaultAddresses.guardian() on chain 56)
//   the role we act as: the Portal's MANAGE_ROLE (and AUDITOR_ROLE), held by the proxy admin's owner
//   0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2; that account does NOT hold DEFAULT_ADMIN_ROLE on the main network.

import {Test} from "forge-std/Test.sol";
import {IPortal} from "src/flap/IPortal.sol";
import {LaunchVaultAddresses} from "src/flap/LaunchVaultAddresses.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import {IERC20F, IProxyAdminF, IRouterF, ITaxTokenF, ITaxProcessorF} from "./PileForkBase.sol";
import {PileVault} from "../src/PileVault.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {CurveLauncherFactory} from "../src/CurveLauncherFactory.sol";
import {CurveLauncher, CurveConfig} from "../src/CurveLauncher.sol";
import {RulesCurveLauncherFactory} from "../src/RulesCurveLauncherFactory.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";

/// @dev forge's `rpc(url, method, params)` cheatcode (in forge 1.8; the pinned forge-std predates its declaration).
interface VmRpcUrl {
    function rpc(string calldata urlOrAlias, string calldata method, string calldata params)
        external
        returns (bytes memory data);
}

interface IPortalAdminView {
    function version() external view returns (string memory);
    function hasRole(bytes32 role, address account) external view returns (bool);
    function MANAGE_ROLE() external view returns (bytes32);
}

/// @notice What the main-network fork tests share: the live BNB Chain Portal at a pinned block, creation paused as it
/// is there, plain accounts, salt mining, trading on the real PancakeSwap V2 pool, and the post-launch check that the
/// pile grows by exactly the vault slot's share and redeems to the last wei.
abstract contract MainnetForkBase is Test {
    uint256 constant FORK_BLOCK = 135_830_000;

    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant PORTAL_PROXY_ADMIN = 0x0000Ed588dfc01749C20bA69b5f8c77d706E0000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant GUARDIAN = 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant USD1 = 0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;
    /// @dev The Portal's anti-scam module on BNB Chain: the launch facet 0x60611752eB72f72d7013a63D65b828cB7F979bAd
    /// staticcalls isScamWord(string,string) (0xf2239487) on it inside launchTaxTokenV2 (read from a -vvvv trace at
    /// FORK_BLOCK); an ERC-1967 proxy to 0x88056BFe17e460E4B3240080dBCE849b97b984Dd. Not the test network's.
    address constant ANTI_SCAM = 0xfFb69d59f62454f3B8322Bc1a9FCE6E171a5264f;
    /// @dev The account that holds the Portal's MANAGE_ROLE at FORK_BLOCK (checked in `_forkSetUp`).
    address constant FLAP_MANAGER = 0xc68f29BfE2f6c3D95AdB5685592B9F86680968f2;

    /// @dev `PortalErrorsLib.CreationPaused()`.
    bytes4 constant CREATION_PAUSED = bytes4(keccak256("CreationPaused()"));

    // plain accounts without code on BNB Chain (as Flap's own fork tests use)
    address creator = address(uint160(0xC0DE0001));
    address alice = address(uint160(0xC0DE0002));
    address bob = address(uint160(0xC0DE0003));
    address trader = address(uint160(0xC0DE0004));
    address carol = address(uint160(0xC0DE0005));

    IPortal portal = IPortal(PORTAL);
    /// @dev Who we act as to stand in for Flap: the proxy admin's owner, the MANAGE_ROLE holder.
    address manager;
    uint256 saltCounter;

    function _forkSetUp() internal returns (bool) {
        string memory url = vm.envOr("BSC_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            emit log("SKIP: BSC_RPC_URL is not set (a BNB Chain endpoint that serves block 135830000)");
            vm.skip(true);
            return false;
        }
        if (vm.envOr("BSC_FORK_PROBE", uint256(1)) != 0) {
            // one read of the pinned block's state, BEFORE the fork: a pruned endpoint answers "missing trie node" or
            // asks for a key, and a fork on it would fail in forge's own account loading, where no try can catch it
            try VmRpcUrl(address(vm)).rpc(
                url, "eth_getStorageAt", '["0x000042108465206185A077Edc3F3fd2b49060000","0x0","0x81899f0"]'
            ) returns (bytes memory) {}
            catch {
                emit log("SKIP: the endpoint in BSC_RPC_URL does not serve the state of block 135830000 (not archive)");
                vm.skip(true);
                return false;
            }
        }
        try vm.createSelectFork(url, FORK_BLOCK) {}
        catch {
            emit log("SKIP: the endpoint in BSC_RPC_URL did not open a fork at block 135830000");
            vm.skip(true);
            return false;
        }
        if (block.chainid != 56) {
            emit log("SKIP: BSC_RPC_URL is not BNB Chain (chain 56)");
            vm.skip(true);
            return false;
        }
        manager = IProxyAdminF(PORTAL_PROXY_ADMIN).owner();
        require(manager == FLAP_MANAGER, "the Portal's proxy admin has another owner at this block");
        IPortalAdminView pv = IPortalAdminView(PORTAL);
        require(pv.hasRole(pv.MANAGE_ROLE(), manager), "the proxy admin's owner holds MANAGE_ROLE");
        require(GUARDIAN == LaunchVaultAddresses.guardian(), "Guardian table drift");
        require(PORTAL == LaunchVaultAddresses.hub(), "hub table drift");
        require(portal.featureFlags() & 1 == 1, "creation is paused on the main network");
        vm.deal(creator, 10 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.deal(trader, 100 ether);
        require(
            creator.code.length + alice.code.length + bob.code.length + carol.code.length + trader.code.length == 0,
            "accounts"
        );
        return true;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // THE ONE PLACE that knows how our factories are constructed and paired.
    // Since the pre-audit fixes R3, R4 and R1 (39cbf9ef, fcbac812): each vault factory names its one launcher
    // factory, predicted as the deployer's next CREATE address; the launcher factory deployed in the very next CREATE
    // checks it; vaults are beacon proxies; there is no createLauncher; each launcher factory carries the Portal's
    // anti-scam module.
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev The CREATE address of this test contract after the next one (the vault factory is the next).
    function _pairedNext() internal view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
    }

    /// @dev The BNB curve pair: the vault factory naming the next address, then the launcher factory there.
    function _deployCurvePair() internal returns (CurveLauncherFactory lf, PileVaultFactory vf) {
        vf = new PileVaultFactory(PORTAL, _pairedNext());
        lf = new CurveLauncherFactory(PORTAL, address(vf), TOKEN_IMPL, ANTI_SCAM);
        require(vf.pairedLauncherFactory() == address(lf), "the pair holds");
    }

    /// @dev The BNB rules pair: the rules vault factory naming the next address, then the rules launcher factory.
    function _deployRulesPairBnb() internal returns (RulesCurveLauncherFactory lf, RulesVaultFactory vf) {
        vf = new RulesVaultFactory(PORTAL, address(0), ROUTER, _pairedNext());
        lf = new RulesCurveLauncherFactory(PORTAL, address(vf), TOKEN_IMPL, ANTI_SCAM);
        require(vf.pairedLauncherFactory() == address(lf), "the pair holds");
    }

    /// @dev The vault a launch of `token` gets from `vf`.
    function _predictPileVault(PileVaultFactory vf, address token) internal view returns (address) {
        return vf.predictVault(token, address(0));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Standing in for Flap
    // ═════════════════════════════════════════════════════════════════════════

    /// @dev `Portal.setLauncherFactoryMultiplier(factory, multiplierBps, true)` as the MANAGE_ROLE holder.
    function _enableLauncherFactory(address factory, uint16 multiplierBps) internal {
        vm.prank(manager);
        portal.setLauncherFactoryMultiplier(factory, multiplierBps, true);
    }

    function _createViaPortal(address lf, bytes memory data, uint256 value) internal returns (address l) {
        vm.prank(creator);
        l = portal.newLauncher{value: value}(lf, data);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Helpers
    // ═════════════════════════════════════════════════════════════════════════

    function _mineSalt(bytes32 seed) internal returns (bytes32 salt) {
        uint256 start = ++saltCounter << 128;
        for (uint256 i = start;; ++i) {
            assembly ("memory-safe") {
                mstore(0x00, seed)
                mstore(0x20, i)
                salt := keccak256(0x00, 0x40)
            }
            if (uint16(uint160(ClonesUpgradeable.predictDeterministicAddress(TOKEN_IMPL, salt, PORTAL))) == 0x7777) {
                return salt;
            }
        }
    }

    function _buy(address token, uint256 bnb) internal {
        address[] memory path = new address[](2);
        path[0] = WBNB;
        path[1] = token;
        IRouterF(ROUTER).swapExactETHForTokensSupportingFeeOnTransferTokens{value: bnb}(
            0, path, trader, block.timestamp + 600
        );
    }

    function _sell(address token, uint256 amount) internal {
        IERC20F(token).approve(ROUTER, amount);
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = WBNB;
        IRouterF(ROUTER).swapExactTokensForETHSupportingFeeOnTransferTokens(amount, 0, path, trader, block.timestamp + 600);
    }

    function _liquidated(address proc) internal view returns (bool) {
        ITaxProcessorF t = ITaxProcessorF(proc);
        return t.feeQuoteBalance() > 0 || t.marketQuoteBalance() > 0 || t.pendingDividendQuoteTokenBalance() > 0
            || t.lpQuoteBalance() > 0;
    }

    function _assertLpBurned(address pool) internal view {
        uint256 lpSupply = IERC20F(pool).totalSupply();
        assertGt(lpSupply, 0);
        assertEq(IERC20F(pool).balanceOf(DEAD) + IERC20F(pool).balanceOf(address(0)), lpSupply, "LP all burned");
    }

    /// @dev Third-party trading on the pool until tax is liquidated into the processor; the dispatch; the pile grown
    /// by exactly the vault slot's share; a redemption by `holder` to the last unit. Returns the redemption's gas.
    function _tradeDispatchRedeem(address token, address vault, address holder) internal returns (uint256 redeemGas) {
        _tradeAndDispatch(token, vault);
        redeemGas = _redeemAll(token, vault, holder);
    }

    function _tradeAndDispatch(address token, address vault) internal {
        PileVault pv = PileVault(payable(vault));
        address proc = ITaxTokenF(token).taxProcessor();
        vm.warp(block.timestamp + 601);
        vm.startPrank(trader);
        _buy(token, 0.3 ether);
        for (uint256 i; i < 80 && !_liquidated(proc); ++i) {
            uint256 amt = IERC20F(token).balanceOf(trader) * 30 / 100;
            if (amt == 0) break;
            uint256 before_ = trader.balance;
            _sell(token, amt);
            uint256 got = trader.balance - before_;
            if (got > 0) _buy(token, got * 90 / 100);
        }
        vm.stopPrank();
        assertTrue(_liquidated(proc), "tax liquidated into the processor");

        uint256 pileBefore = pv.pile();
        uint256 vaultShare = ITaxProcessorF(proc).marketQuoteBalance();
        emit log_named_uint("processor fee bucket (protocol)", ITaxProcessorF(proc).feeQuoteBalance());
        emit log_named_uint("processor market bucket (the vault slot)", vaultShare);
        ITaxProcessorF(proc).dispatch();
        uint256 grown = pv.pile() - pileBefore;
        emit log_named_uint("pile grown by the dispatch", grown);
        assertGt(grown, 0, "the pile grew");
        assertEq(grown, vaultShare, "the pile grew by exactly the vault slot's share");
    }

    /// @dev `holder` redeems its whole balance from the pile; paid to the last unit. Returns the redemption's gas.
    function _redeemAll(address token, address vault, address holder) internal returns (uint256 redeemGas) {
        PileVault pv = PileVault(payable(vault));
        uint256 amount = IERC20F(token).balanceOf(holder);
        uint256 pile = pv.pile();
        uint256 circ = pv.circulatingSupply();
        IERC20F t = IERC20F(token);
        assertEq(circ, t.totalSupply() - t.balanceOf(DEAD) - t.balanceOf(address(0)) - t.balanceOf(vault));
        uint256 expected = pile * amount / circ;
        assertEq(pv.quoteRedeem(amount), expected);
        uint256 h0 = holder.balance;
        vm.prank(holder);
        IERC20F(token).approve(vault, amount);
        vm.prank(holder);
        uint256 g = gasleft();
        uint256 out = pv.redeem(amount, expected);
        redeemGas = g - gasleft();
        assertEq(out, expected);
        assertEq(holder.balance - h0, expected, "paid to the last unit");
        assertEq(pv.pile(), pile - expected);
        assertEq(IERC20F(token).balanceOf(holder), 0);
        assertEq(pv.circulatingSupply(), circ - amount);
        emit log_named_uint("redeemed tokens", amount);
        emit log_named_uint("redeemed for wei", expected);
    }
}
