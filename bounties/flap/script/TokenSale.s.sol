// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {TokenCurveLauncher} from "../src/TokenCurveLauncher.sol";
import {PileVault} from "../src/PileVault.sol";

interface IERC20U {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface ITestUsdMint {
    function mint(address to, uint256 amount) external;
}

interface IRouterU {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

interface ITaxU {
    function taxProcessor() external view returns (address);
    function buyTaxRate() external view returns (uint256);
    function sellTaxRate() external view returns (uint256);
}

interface IProcU {
    function dispatch() external;
    function marketQuoteBalance() external view returns (uint256);
}

/// @notice One step of a token-quote sale, chosen by ACTION, on the Launcher in `deployments/<chainId>-usdt-sale.json`
/// (or LAUNCHER). Amounts are in the quote's base units (test USDT: 18 decimals). Each approval is for exactly what
/// the action is quoted to spend, its result is checked, and any allowance left is cleared and read as zero before the
/// action reports success. Each action asserts its own effect (balance, entitlement, phase, pile) from reads after the
/// broadcast calls; forge runs these on its simulation of the same transactions and stops on a failed receipt, and a
/// separate ACTION=status reads the mined state. The sender comes from a keystore. Chain 97 only. Run once, in order.
///   ACTION=status                         the sale and the reads that prove each step (no transaction)
///   ACTION=mint       AMOUNT_WEI=...      mint the quote of deployments/<chainId>-usdt.json (it must be the test USDT)
///                                         to the sender through its public mint; deploy first
///   ACTION=buy        MAX_COST_WEI=...    buy on the curve for at most that much (fee included); at least
///                     [MIN_TOKENS=...]    MIN_TOKENS (default: the quote for MAX_COST_WEI now)
///   ACTION=sell       TOKENS_WEI=...      sell back along the curve, for no less than the quote now
///   ACTION=complete                       buy the rest and launch, or revert; pulls exactly costToComplete()
///   ACTION=claim                          claim the bought tokens (refused unless launched)
///   ACTION=unwind                         take back the net after a missed deadline
///   ACTION=pool-buy   AMOUNT_WEI=...      quote -> token on the pool; least accepted: router quote less buy tax and
///                                         SLIPPAGE_BPS (default 200)
///   ACTION=pool-sell  TOKENS_WEI=...      token -> quote on the pool; least accepted likewise with the sell tax
///   ACTION=dispatch                       push waiting tax to the pile (asserting the pile grew by it); if none is
///                                         waiting, report the measured zero and the pile, and its growth since
///                                         PILE_BEFORE_WEI when given
///   ACTION=redeem     TOKENS_WEI=...      hand tokens in to the pile for no less than its quote now (paid in the quote)
contract TokenSale is Script {
    address constant ROUTER_97 = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;
    address constant TEST_USDT_97 = 0x190C989D5665a0e404B444b53CAE9AbCfb600157;

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        string memory action = vm.envOr("ACTION", string("status"));
        bytes32 a = keccak256(bytes(action));
        address me = msg.sender;
        if (a == keccak256("mint")) {
            // the token comes only from the deployment file, and must be the test network's test USDT
            string memory dep = vm.envOr("DEPLOYMENTS_FILE", string.concat("deployments/", vm.toString(block.chainid), "-usdt.json"));
            address mq = vm.parseJsonAddress(vm.readFile(string.concat(vm.projectRoot(), "/", dep)), ".quote");
            require(mq == TEST_USDT_97, "the deployment's quote is not the test USDT");
            uint256 amount = vm.envUint("AMOUNT_WEI");
            uint256 m0 = IERC20U(mq).balanceOf(me);
            vm.startBroadcast();
            ITestUsdMint(mq).mint(me, amount);
            vm.stopBroadcast();
            require(IERC20U(mq).balanceOf(me) == m0 + amount, "the balance did not grow by the amount");
            console.log(string.concat("minted ", vm.toString(amount), "; quote balance ", vm.toString(m0 + amount)));
            return;
        }
        TokenCurveLauncher l = TokenCurveLauncher(_launcher());
        address q = l.quote();
        if (a == keccak256("status")) return _status(l, me);

        vm.startBroadcast();
        if (a == keccak256("buy")) {
            uint256 maxCost = vm.envUint("MAX_COST_WEI");
            (uint256 n, uint256 cost, uint256 fee) = l.quoteBuy(maxCost);
            uint256 minTokens = vm.envOr("MIN_TOKENS", n);
            uint256 t0 = l.tokensOf(me);
            uint256 u0 = IERC20U(q).balanceOf(me);
            _approve(q, address(l), cost + fee); // the quoted spend, not the cap
            l.buy(maxCost, minTokens);
            require(l.tokensOf(me) >= t0 + minTokens, "the entitlement did not grow");
            require(u0 - IERC20U(q).balanceOf(me) == cost + fee, "the spend differs from the quote");
            _clear(q, address(l));
        } else if (a == keccak256("sell")) {
            uint256 n = vm.envUint("TOKENS_WEI");
            (,, uint256 paid) = l.quoteSell(n);
            uint256 u0 = IERC20U(q).balanceOf(me);
            l.sell(n, paid);
            require(IERC20U(q).balanceOf(me) == u0 + paid, "the sell did not pay its quote");
        } else if (a == keccak256("complete")) {
            uint256 cost = l.costToComplete();
            _approve(q, address(l), cost);
            l.complete(cost);
            require(l.phase() == 1, "not launched");
            _clear(q, address(l));
            console.log("launched");
        } else if (a == keccak256("claim")) {
            require(l.phase() == 1, "the sale has not launched");
            uint256 c = l.claimable(me);
            uint256 t0 = IERC20U(l.token()).balanceOf(me);
            l.claim();
            require(IERC20U(l.token()).balanceOf(me) == t0 + c, "the claim did not arrive");
        } else if (a == keccak256("unwind")) {
            uint256 u0 = IERC20U(q).balanceOf(me);
            uint256 paid = l.unwind();
            require(paid > 0 && IERC20U(q).balanceOf(me) == u0 + paid, "the refund did not arrive");
        } else if (a == keccak256("pool-buy")) {
            _swap(q, l.token(), vm.envUint("AMOUNT_WEI"), ITaxU(l.token()).buyTaxRate(), me);
        } else if (a == keccak256("pool-sell")) {
            _swap(l.token(), q, vm.envUint("TOKENS_WEI"), ITaxU(l.token()).sellTaxRate(), me);
        } else if (a == keccak256("dispatch")) {
            IProcU proc = IProcU(ITaxU(l.token()).taxProcessor());
            PileVault pv = PileVault(payable(l.pileVault()));
            uint256 waiting = proc.marketQuoteBalance();
            uint256 p0 = pv.pile();
            if (waiting > 0) {
                proc.dispatch();
                require(pv.pile() == p0 + waiting, "the pile did not grow by the waiting tax");
                console.log(string.concat("dispatched ", vm.toString(waiting), " to the pile"));
            } else {
                console.log(string.concat("measured: no tax waiting for the pile; the pile holds ", vm.toString(p0)));
                uint256 before = vm.envOr("PILE_BEFORE_WEI", uint256(0));
                if (before != 0 && p0 > before) {
                    console.log(string.concat("the pile grew by ", vm.toString(p0 - before), " since PILE_BEFORE_WEI: the tax already reached it"));
                }
            }
        } else if (a == keccak256("redeem")) {
            PileVault pv = PileVault(payable(l.pileVault()));
            uint256 n = vm.envUint("TOKENS_WEI");
            uint256 minOut = pv.quoteRedeem(n);
            require(minOut > 0, "this hand-in would be paid nothing");
            uint256 u0 = IERC20U(q).balanceOf(me);
            uint256 paidBefore = pv.totalPaidOut();
            _approve(l.token(), address(pv), n);
            uint256 out = pv.redeem(n, minOut);
            require(out >= minOut && IERC20U(q).balanceOf(me) == u0 + out, "the redemption did not pay");
            require(pv.totalPaidOut() == paidBefore + out, "the pile's paid-out total did not grow by it");
            _clear(l.token(), address(pv));
        } else {
            revert(string.concat("unknown ACTION ", action));
        }
        vm.stopBroadcast();
        _status(l, me);
    }

    function _swap(address from, address to, uint256 amount, uint256 taxBps, address me) internal {
        address[] memory path = new address[](2);
        path[0] = from;
        path[1] = to;
        uint256 slip = vm.envOr("SLIPPAGE_BPS", uint256(200));
        require(taxBps + slip < 10_000, "SLIPPAGE_BPS too large");
        uint256 minOut = IRouterU(ROUTER_97).getAmountsOut(amount, path)[1] * (10_000 - taxBps - slip) / 10_000;
        require(minOut > 0, "the least accepted output rounds to zero");
        console.log(string.concat("pool swap: least accepted ", vm.toString(minOut)));
        uint256 o0 = IERC20U(to).balanceOf(me);
        _approve(from, ROUTER_97, amount);
        IRouterU(ROUTER_97).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amount, minOut, path, me, block.timestamp + 600
        );
        uint256 got = IERC20U(to).balanceOf(me) - o0;
        require(got >= minOut, "the swap paid less than the least accepted");
        console.log(string.concat("pool swap: received ", vm.toString(got)));
        _clear(from, ROUTER_97);
    }

    /// @dev Approves exactly `amount`, checking the call's result and the allowance it left.
    function _approve(address t, address spender, uint256 amount) internal {
        require(IERC20U(t).approve(spender, amount), "approve returned false");
        require(IERC20U(t).allowance(msg.sender, spender) == amount, "the allowance is not the amount");
    }

    /// @dev Clears whatever allowance is left and reads it back as zero.
    function _clear(address t, address spender) internal {
        if (IERC20U(t).allowance(msg.sender, spender) != 0) {
            require(IERC20U(t).approve(spender, 0), "approve returned false");
        }
        require(IERC20U(t).allowance(msg.sender, spender) == 0, "an allowance is left");
    }

    function _launcher() internal view returns (address) {
        address fromEnv = vm.envOr("LAUNCHER", address(0));
        if (fromEnv != address(0)) return fromEnv;
        string memory f =
            vm.envOr("SALE_FILE", string.concat("deployments/", vm.toString(block.chainid), "-usdt-sale.json"));
        return vm.parseJsonAddress(vm.readFile(string.concat(vm.projectRoot(), "/", f)), ".launcher");
    }

    function _status(TokenCurveLauncher l, address me) internal view {
        TokenCurveLauncher.Progress memory p = l.progress();
        address q = l.quote();
        console.log(string.concat("phase (0 sale, 1 launched, 2 unwinding) ", vm.toString(uint256(p.phase))));
        console.log(string.concat("sold / for sale ", vm.toString(p.sold), " / ", vm.toString(p.saleTokens)));
        console.log(string.concat("curve quote / raise ", vm.toString(p.curveBalance), " / ", vm.toString(p.raiseTarget)));
        console.log(string.concat("fee pot ", vm.toString(p.feePot)));
        console.log(string.concat("cost to complete ", vm.toString(p.phase == 0 ? l.costToComplete() : 0)));
        console.log(string.concat("my tokens on the curve ", vm.toString(l.tokensOf(me))));
        console.log(string.concat("my net owed if it unwinds ", vm.toString(l.owed(me))));
        console.log(string.concat("my quote balance ", vm.toString(IERC20U(q).balanceOf(me))));
        console.log(string.concat("my quote allowance to the launcher ", vm.toString(IERC20U(q).allowance(me, address(l)))));
        if (p.phase == 1) {
            address t = l.token();
            PileVault pv = PileVault(payable(l.pileVault()));
            console.log(string.concat("token ", vm.toString(t)));
            console.log(string.concat("pool ", vm.toString(l.pool())));
            console.log(string.concat("pile vault ", vm.toString(address(pv))));
            console.log(string.concat("my claimable tokens ", vm.toString(l.claimable(me))));
            console.log(string.concat("my token balance ", vm.toString(IERC20U(t).balanceOf(me))));
            console.log(string.concat("my token allowance to the router ", vm.toString(IERC20U(t).allowance(me, ROUTER_97))));
            console.log(string.concat("my quote allowance to the router ", vm.toString(IERC20U(q).allowance(me, ROUTER_97))));
            console.log(string.concat("my token allowance to the pile ", vm.toString(IERC20U(t).allowance(me, address(pv)))));
            console.log(string.concat("tax waiting for the pile ", vm.toString(IProcU(ITaxU(t).taxProcessor()).marketQuoteBalance())));
            // a rules launch has a splitter in the vault slot: its pile and rules are read by RulesSale.s.sol
            try pv.pile() returns (uint256 pileNow) {
                console.log(string.concat("pile (quote) ", vm.toString(pileNow)));
                console.log(string.concat("pile paid out so far ", vm.toString(pv.totalPaidOut())));
                console.log(string.concat("circulating supply ", vm.toString(pv.circulatingSupply())));
            } catch {
                console.log("the vault is a rules splitter: ACTION=status forge script script/RulesSale.s.sol");
            }
        }
    }
}
