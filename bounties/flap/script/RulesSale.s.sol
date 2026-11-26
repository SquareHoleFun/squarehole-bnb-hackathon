// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {PileVault} from "../src/PileVault.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";

interface ILaunchedLike {
    function phase() external view returns (uint8);
    function token() external view returns (address);
    function pileVault() external view returns (address);
}

interface IERC20R {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

interface ITaxR {
    function taxProcessor() external view returns (address);
}

interface IProcR {
    function dispatch() external;
    function marketQuoteBalance() external view returns (uint256);
}

/// @notice The rules part of a rules launch, chosen by ACTION, on the Launcher in
/// `deployments/<chainId>-rules-<variant>-sale.json` (VARIANT=usdt, the default, or native; or LAUNCHER). The sale
/// itself (buy, sell, complete, claim, pool trades) runs with TokenSale.s.sol or Sale.s.sol and that SALE_FILE.
///   ACTION=status                    the rules, what each was owed, delivered and burned, the pile (no transaction)
///   ACTION=dispatch                  push the processor's waiting vault share to the splitter (asserts it arrived);
///                                    with nothing waiting, report the measured zero
///   ACTION=distribute                share the splitter's income among the rules (asserts every unit went to a rule)
///   ACTION=redeem  TOKENS_WEI=...    hand tokens in to the pile for no less than its quote now
/// Each action asserts its effect on forge's simulation of the same transaction; status reads the mined state.
/// Chain 97 only. Run once, in order.
contract RulesSale is Script {
    function run() external {
        require(block.chainid == 97, "chain 97 only");
        ILaunchedLike l = ILaunchedLike(_launcher());
        require(l.phase() == 1, "the sale has not launched");
        RulesVault s = RulesVault(payable(l.pileVault()));
        address t = l.token();
        PileVault pile = PileVault(payable(RulesVaultFactory(s.factory()).pileOf(t)));
        string memory action = vm.envOr("ACTION", string("status"));
        bytes32 a = keccak256(bytes(action));
        address me = msg.sender;
        if (a == keccak256("status")) return _status(s, pile, t);

        vm.startBroadcast();
        if (a == keccak256("dispatch")) {
            IProcR proc = IProcR(ITaxR(t).taxProcessor());
            uint256 waiting = proc.marketQuoteBalance();
            if (waiting > 0) {
                uint256 p0 = s.pending();
                proc.dispatch();
                require(s.pending() == p0 + waiting, "the splitter did not receive the waiting share");
                console.log(string.concat("dispatched ", vm.toString(waiting), " to the splitter"));
            } else {
                console.log(string.concat("measured: no share waiting; the splitter's pending income is ", vm.toString(s.pending())));
            }
        } else if (a == keccak256("distribute")) {
            uint256 income = s.pending();
            uint256 before = _sum(s);
            uint256 owedBefore = s.totalOwed();
            s.distribute();
            require(_sum(s) + s.totalOwed() == before + owedBefore + income, "a unit went nowhere");
            console.log(string.concat("shared ", vm.toString(income), "; still owed ", vm.toString(s.totalOwed())));
        } else if (a == keccak256("redeem")) {
            uint256 n = vm.envUint("TOKENS_WEI");
            uint256 minOut = pile.quoteRedeem(n);
            require(minOut > 0, "this hand-in would be paid nothing");
            uint256 u0 = _assetBalance(pile.asset(), me);
            require(IERC20R(t).approve(address(pile), n), "approve returned false");
            uint256 out = pile.redeem(n, minOut);
            require(out >= minOut && _assetBalance(pile.asset(), me) == u0 + out, "the redemption did not pay");
            require(IERC20R(t).allowance(me, address(pile)) == 0, "an allowance is left");
        } else {
            revert(string.concat("unknown ACTION ", action));
        }
        vm.stopBroadcast();
        _status(s, pile, t);
    }

    function _sum(RulesVault s) internal view returns (uint256 d) {
        uint256 n = s.ruleCount();
        for (uint256 i; i < n; ++i) d += s.delivered(i);
    }

    function _assetBalance(address asset, address who) internal view returns (uint256) {
        return asset == address(0) ? who.balance : IERC20R(asset).balanceOf(who);
    }

    function _launcher() internal view returns (address) {
        address fromEnv = vm.envOr("LAUNCHER", address(0));
        if (fromEnv != address(0)) return fromEnv;
        string memory variant = vm.envOr("VARIANT", string("usdt"));
        string memory f = vm.envOr(
            "SALE_FILE", string.concat("deployments/", vm.toString(block.chainid), "-rules-", variant, "-sale.json")
        );
        return vm.parseJsonAddress(vm.readFile(string.concat(vm.projectRoot(), "/", f)), ".launcher");
    }

    function _printRule(RulesVault s, uint256 i) internal view {
        (IRuleSplitter.Kind k, uint16 bps, address target) = s.rule(i);
        console.log(
            string.concat("rule ", vm.toString(i), " kind ", vm.toString(uint256(k)), " bps ", vm.toString(uint256(bps)))
        );
        console.log(string.concat("  target ", vm.toString(target), " owed ", vm.toString(s.owed(i))));
        console.log(string.concat("  delivered ", vm.toString(s.delivered(i)), " burned ", vm.toString(s.burned(i))));
    }

    function _status(RulesVault s, PileVault pile, address t) internal view {
        console.log(string.concat("splitter ", vm.toString(address(s))));
        console.log(string.concat("pending income ", vm.toString(s.pending())));
        uint256 n = s.ruleCount();
        for (uint256 i; i < n; ++i) _printRule(s, i);
        console.log(string.concat("pile ", vm.toString(address(pile)), " holds ", vm.toString(pile.pile())));
        console.log(string.concat("pile paid out so far ", vm.toString(pile.totalPaidOut())));
        console.log(string.concat("tokens at the dead address ", vm.toString(IERC20R(t).balanceOf(0x000000000000000000000000000000000000dEaD))));
        console.log(string.concat("tax waiting for the splitter ", vm.toString(IProcR(ITaxR(t).taxProcessor()).marketQuoteBalance())));
    }
}
