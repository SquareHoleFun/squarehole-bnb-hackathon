// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CurveLauncher} from "../src/CurveLauncher.sol";
import {PileVault} from "../src/PileVault.sol";

interface IERC20S {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface IRouterS {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
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

interface ITaxS {
    function taxProcessor() external view returns (address);
    function buyTaxRate() external view returns (uint256);
    function sellTaxRate() external view returns (uint256);
}

interface IProcS {
    function dispatch() external;
    function marketQuoteBalance() external view returns (uint256);
}

/// @notice One step of a sale's life, chosen by ACTION, on the Launcher in `deployments/<chainId>-sale.json` (or
/// LAUNCHER). The sender comes from a keystore. Chain 97 only.
///   ACTION=status                       print the sale and the reads that prove each step (no transaction)
///   ACTION=buy       AMOUNT_WEI=...     buy on the curve with that much BNB (fee included)
///   ACTION=sell      TOKENS_WEI=...     sell back along the curve before the launch
///   ACTION=complete                     buy the rest of the sale and launch, or revert (sends costToComplete()
///                                       plus COMPLETE_MARGIN_WEI, default 0.01 BNB; the unused part comes back)
///   ACTION=claim                        claim the bought tokens (refused unless the sale launched)
///   ACTION=unwind                       take back the net BNB after a missed deadline
///   ACTION=pool-buy  AMOUNT_WEI=...     buy on the pool; the least accepted is the router's quote less the buy tax
///                                       and SLIPPAGE_BPS (default 200)
///   ACTION=pool-sell TOKENS_WEI=...     sell on the pool; the least accepted is the quote less the sell tax and
///                                       SLIPPAGE_BPS (approves exactly TOKENS_WEI to the router)
///   ACTION=dispatch                     push the token's collected tax to its fee slots; if nothing is waiting
///                                       (someone else dispatched, e.g. a keeper) it sends nothing and prints the
///                                       pile, and its growth since PILE_BEFORE_WEI when given
///   ACTION=redeem    TOKENS_WEI=...     hand tokens in to the pile, accepting no less than its quote now
///   forge script script/Sale.s.sol --rpc-url <endpoint> --account <keystore> --sender <address> --broadcast
contract Sale is Script {
    address constant WBNB_97 = 0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd;
    address constant ROUTER_97 = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        CurveLauncher l = CurveLauncher(payable(_launcher()));
        string memory action = vm.envOr("ACTION", string("status"));
        bytes32 a = keccak256(bytes(action));
        address me = msg.sender;

        if (a == keccak256("status")) return _status(l, me);
        vm.startBroadcast();
        if (a == keccak256("buy")) {
            l.buy{value: vm.envUint("AMOUNT_WEI")}(0);
        } else if (a == keccak256("sell")) {
            l.sell(vm.envUint("TOKENS_WEI"), 0);
        } else if (a == keccak256("complete")) {
            l.complete{value: l.costToComplete() + vm.envOr("COMPLETE_MARGIN_WEI", uint256(0.01 ether))}();
        } else if (a == keccak256("claim")) {
            require(l.phase() == 1, "the sale has not launched");
            l.claim();
        } else if (a == keccak256("unwind")) {
            l.unwind();
        } else if (a == keccak256("pool-buy")) {
            _poolBuy(l.token(), vm.envUint("AMOUNT_WEI"), me);
        } else if (a == keccak256("pool-sell")) {
            _poolSell(l.token(), vm.envUint("TOKENS_WEI"), me);
        } else if (a == keccak256("dispatch")) {
            IProcS proc = IProcS(ITaxS(l.token()).taxProcessor());
            if (proc.marketQuoteBalance() > 0) {
                proc.dispatch();
            } else {
                // Not a failure: dispatch() is public, and on the test network a keeper contract called it for this
                // token within a few blocks of the liquidation (measured on the real run). Nothing is sent.
                uint256 pileNow = PileVault(payable(l.pileVault())).pile();
                uint256 before = vm.envOr("PILE_BEFORE_WEI", uint256(0));
                console.log(string.concat("nothing waiting: the tax is already in the pile, which holds ", vm.toString(pileNow), " wei"));
                if (before != 0 && pileNow >= before) {
                    console.log(string.concat("the pile grew by ", vm.toString(pileNow - before), " wei since PILE_BEFORE_WEI"));
                }
            }
        } else if (a == keccak256("redeem")) {
            PileVault pv = PileVault(payable(l.pileVault()));
            uint256 n = vm.envUint("TOKENS_WEI");
            uint256 minOut = pv.quoteRedeem(n);
            require(minOut > 0, "this hand-in would be paid nothing");
            IERC20S(l.token()).approve(address(pv), n);
            pv.redeem(n, minOut);
        } else {
            revert(string.concat("unknown ACTION ", action));
        }
        vm.stopBroadcast();
        _status(l, me);
    }

    function _bounded(uint256 quote, uint256 taxBps) internal view returns (uint256 minOut) {
        uint256 slip = vm.envOr("SLIPPAGE_BPS", uint256(200));
        require(taxBps + slip < 10_000, "SLIPPAGE_BPS too large");
        minOut = quote * (10_000 - taxBps - slip) / 10_000;
        require(minOut > 0, "the least accepted output rounds to zero");
    }

    function _poolBuy(address token, uint256 amount, address me) internal {
        address[] memory path = new address[](2);
        path[0] = WBNB_97;
        path[1] = token;
        uint256 minOut = _bounded(IRouterS(ROUTER_97).getAmountsOut(amount, path)[1], ITaxS(token).buyTaxRate());
        console.log(string.concat("pool buy: least accepted tokens ", vm.toString(minOut)));
        IRouterS(ROUTER_97).swapExactETHForTokensSupportingFeeOnTransferTokens{value: amount}(
            minOut, path, me, block.timestamp + 600
        );
    }

    function _poolSell(address token, uint256 tokens, address me) internal {
        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = WBNB_97;
        uint256 minOut = _bounded(IRouterS(ROUTER_97).getAmountsOut(tokens, path)[1], ITaxS(token).sellTaxRate());
        console.log(string.concat("pool sell: least accepted wei ", vm.toString(minOut)));
        IERC20S(token).approve(ROUTER_97, tokens);
        IRouterS(ROUTER_97).swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokens, minOut, path, me, block.timestamp + 600
        );
    }

    function _launcher() internal view returns (address) {
        address fromEnv = vm.envOr("LAUNCHER", address(0));
        if (fromEnv != address(0)) return fromEnv;
        string memory f = vm.envOr("SALE_FILE", string.concat("deployments/", vm.toString(block.chainid), "-sale.json"));
        return vm.parseJsonAddress(vm.readFile(string.concat(vm.projectRoot(), "/", f)), ".launcher");
    }

    function _status(CurveLauncher l, address me) internal view {
        CurveLauncher.Progress memory p = l.progress();
        console.log(string.concat("phase (0 sale, 1 launched, 2 unwinding) ", vm.toString(uint256(p.phase))));
        console.log(string.concat("sold / for sale (wei) ", vm.toString(p.sold), " / ", vm.toString(p.saleTokens)));
        console.log(string.concat("curve BNB / raise (wei) ", vm.toString(p.curveBalance), " / ", vm.toString(p.raiseTarget)));
        console.log(string.concat("fee pot (wei) ", vm.toString(p.feePot)));
        console.log(string.concat("cost to complete (wei) ", vm.toString(p.phase == 0 ? l.costToComplete() : 0)));
        console.log(string.concat("my tokens on the curve ", vm.toString(l.tokensOf(me))));
        console.log(string.concat("my net owed if it unwinds (wei) ", vm.toString(l.owed(me))));
        if (p.phase == 1) {
            address t = l.token();
            PileVault pv = PileVault(payable(l.pileVault()));
            console.log(string.concat("token ", vm.toString(t)));
            console.log(string.concat("pool ", vm.toString(l.pool())));
            console.log(string.concat("pile vault ", vm.toString(address(pv))));
            console.log(string.concat("my claimable tokens ", vm.toString(l.claimable(me))));
            console.log(string.concat("my token balance ", vm.toString(IERC20S(t).balanceOf(me))));
            console.log(string.concat("my allowance to the router ", vm.toString(IERC20S(t).allowance(me, ROUTER_97))));
            console.log(string.concat("my allowance to the pile ", vm.toString(IERC20S(t).allowance(me, address(pv)))));
            console.log(
                string.concat(
                    "tax waiting for the pile (wei) ",
                    vm.toString(IProcS(ITaxS(t).taxProcessor()).marketQuoteBalance())
                )
            );
            // a rules launch has a splitter in the vault slot: its pile and rules are read by RulesSale.s.sol
            try pv.pile() returns (uint256 pileNow) {
                console.log(string.concat("pile (wei) ", vm.toString(pileNow)));
                console.log(string.concat("pile paid out so far ", vm.toString(pv.totalPaidOut())));
                console.log(string.concat("circulating supply ", vm.toString(pv.circulatingSupply())));
            } catch {
                console.log("the vault is a rules splitter: ACTION=status forge script script/RulesSale.s.sol");
            }
        }
    }
}
