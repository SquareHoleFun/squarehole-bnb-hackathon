// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPortal} from "src/flap/IPortal.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import {PileVault} from "../src/PileVault.sol";

interface IERC20F {
    function balanceOf(address) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
}

interface IPortalFloorLike {
    function launcherFactoryMultiplier(address factory) external view returns (bool enabled, uint16 multiplierBps);
}

interface IProxyAdminF {
    function owner() external view returns (address);
}

interface IRouterF {
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256, address[] calldata, address, uint256)
        external
        payable;
    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256,
        uint256,
        address[] calldata,
        address,
        uint256
    ) external;
}

interface ITaxTokenF {
    function taxProcessor() external view returns (address);
}

interface ITaxProcessorF {
    function dispatch() external;
    function feeQuoteBalance() external view returns (uint256);
    function marketQuoteBalance() external view returns (uint256);
    function pendingDividendQuoteTokenBalance() external view returns (uint256);
    function lpQuoteBalance() external view returns (uint256);
}

/// @notice What the fork tests share: the live test network Portal, plain accounts, salt mining, trading on the real
/// pool, and the post-launch check that the pile grows by exactly the vault slot's share and redeems to the last wei.
/// Set FORK_URL (an `anvil --fork-url` of the BNB test network, or the endpoint itself); skipped when it is unset.
abstract contract PileForkBase is Test {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant PORTAL_PROXY_ADMIN = 0x0000Ed588dfc01749C20bA69b5f8c77d706E0000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    address constant WBNB = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;
    address constant ROUTER = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;
    address constant GUARDIAN = 0x00004d58290854c5E9880F4b5B1993c6Ad8b0000;
    address constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // plain accounts without code on the test network (as Flap's own fork tests do)
    address creator = address(uint160(0xC0DE0001));
    address alice = address(uint160(0xC0DE0002));
    address bob = address(uint160(0xC0DE0003));
    address trader = address(uint160(0xC0DE0004));

    IPortal portal = IPortal(PORTAL);
    address admin;
    uint256 saltCounter;

    function _forkSetUp() internal returns (bool) {
        string memory url = vm.envOr("FORK_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(url);
        require(block.chainid == 97, "FORK_URL is not the BNB test network");
        admin = IProxyAdminF(PORTAL_PROXY_ADMIN).owner();
        vm.deal(creator, 10 ether);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(trader, 100 ether);
        require(creator.code.length + alice.code.length + bob.code.length + trader.code.length == 0, "accounts");
        return true;
    }

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

    /// @dev Trading, tax dispatch, the pile grown by exactly the vault's share, a redemption by `holder` to the last
    /// unit.
    function _tradeDispatchRedeem(address token, address vault, address holder) internal {
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
        emit log_named_uint("pile grown by", grown);
        assertGt(grown, 0, "the pile grew");
        assertEq(grown, vaultShare, "the pile grew by exactly the vault slot's share");

        uint256 amount = IERC20F(token).balanceOf(holder);
        uint256 pile = pv.pile();
        uint256 circ = pv.circulatingSupply();
        assertEq(
            circ,
            IERC20F(token).totalSupply() - IERC20F(token).balanceOf(DEAD) - IERC20F(token).balanceOf(address(0))
                - IERC20F(token).balanceOf(vault)
        );
        uint256 expected = pile * amount / circ;
        assertEq(pv.quoteRedeem(amount), expected);
        uint256 h0 = holder.balance;
        vm.startPrank(holder);
        IERC20F(token).approve(vault, amount);
        uint256 out = pv.redeem(amount, expected);
        vm.stopPrank();
        assertEq(out, expected);
        assertEq(holder.balance - h0, expected, "paid to the last unit");
        assertEq(pv.pile(), pile - expected);
        assertEq(IERC20F(token).balanceOf(holder), 0);
        assertEq(pv.circulatingSupply(), circ - amount);
        emit log_named_uint("pile before the redemption", pile);
        emit log_named_uint("redeemed tokens", amount);
        emit log_named_uint("redeemed for wei", expected);
        emit log_named_uint("tokens at DEAD (burn slot + hand-ins)", IERC20F(token).balanceOf(DEAD));
    }
}
