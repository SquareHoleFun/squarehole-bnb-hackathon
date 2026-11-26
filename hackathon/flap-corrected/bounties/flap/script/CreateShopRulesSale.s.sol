// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import {IPortal} from "src/flap/IPortal.sol";
import {CurveConfig} from "../src/CurveLauncher.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {RailShopFactory} from "fee-rules/RailShopFactory.sol";

interface ICurveLauncherFactoryShop {
    function checkConfig(CurveConfig memory c, bool viaPortal) external view;
    function creationFee() external view returns (uint256);
    function predictToken(bytes32 salt) external view returns (address);
    function predictLauncher(address creator, bytes32 salt) external view returns (address);
    function curveFor(uint256 saleTokens, uint256 targetRaise, uint256 virtualBnb)
        external
        pure
        returns (uint256 virtualTokens, uint256 raise, uint256 poolToken, uint256 totalSupply, uint256 startPrice, uint256 finalPrice);
}

/// @notice SH-288: one Flap sale whose rules feed a card shop, in three transactions in this order, all from the creator:
/// the shop for the token to come (`RailShopFactory.create`, at an address that commits to all its parameters), the
/// rules naming it (`setRules`, while the sale does not exist), the sale (`Portal.newLauncher`). Beside the plain rules
/// sale script CreateRulesSale (unchanged). Reads `deployments/97-rules-usdt.json` (RULES_FILE overrides) and the shop factory
/// from RAIL_SHOP_FACTORY. Rules from the environment, in this order: CREATOR_BPS (default 1000) to PAYEE (default the
/// sender), PILE_BPS (3000), SHOP_BPS (4000), BURN_BPS (2000) last (the rules factory accepts a buy and burn only as the
/// last rule); the parts sum to 10,000. The shop: our four test card collections
/// with give prices GIVE_COMMON, GIVE_UNCOMMON, GIVE_RARE, GIVE_LEGENDARY in whole tokens (defaults 100, 200, 400, 800),
/// PICK_BPS (10000: a pick costs twice the give price), CAP in whole tokens (10000), router Flap's DEX router; its
/// asset is the sale's quote (Flap's test dollar). Refuses, before anything is sent, a give price, a pick price or a cap
/// above the launch's fixed supply (`curveFor`): a shop priced above the supply takes stock nobody can ever pick. Writes `deployments/97-shop-rules-usdt-sale.json`. Without
/// `--broadcast` it only simulates. Reads no key.
///   RAIL_SHOP_FACTORY=<address> forge script script/CreateShopRulesSale.s.sol --rpc-url <endpoint> --sender <creator> \
///     [--account <keystore> --password-file <path> --broadcast] --legacy --with-gas-price 100000000
contract CreateShopRulesSale is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;
    address constant FLAP_ROUTER = 0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3;
    address constant COMMON = 0x675A3eCDd3e46eC716Af19179B36e6f4d6a2A174;
    address constant UNCOMMON = 0xF4F372F7c73D0D6D85da691856B24B9ea1f2B577;
    address constant RARE = 0xf7204bC0D744E4cF466c89fC7260e9506a50eBFC;
    address constant LEGENDARY = 0x26C4f9298F88f203c7BC84e4eE3d9eA45680B143;

    struct Shop {
        address[] nfts;
        uint256[] prices;
        uint16 pickBps;
        uint256 cap;
    }

    function _env(string memory name, uint256 fallback_, uint256 max) internal view returns (uint256 v) {
        v = vm.envOr(name, fallback_);
        require(v <= max, string.concat(name, " does not fit its field"));
    }

    function _config() internal view returns (CurveConfig memory c) {
        c.name = vm.envOr("NAME", string("Card Rail"));
        c.symbol = vm.envOr("SYMBOL", string("CRAIL"));
        c.meta = vm.envOr("META", string(""));
        c.saleTokens = _env("SALE_TOKENS", 600_000_000, 1e15) * 1 ether;
        c.targetRaise = vm.envOr("TARGET_WEI", uint256(1_700 ether));
        c.virtualBnb = vm.envOr("VIRTUAL_WEI", uint256(11_600 ether));
        c.duration = uint64(_env("DURATION", 2 days, type(uint64).max));
        c.tradeFeeBps = uint16(_env("TRADE_FEE_BPS", 100, type(uint16).max));
        c.buyTaxBps = uint16(_env("BUY_TAX_BPS", 300, type(uint16).max));
        c.sellTaxBps = uint16(_env("SELL_TAX_BPS", 500, type(uint16).max));
        c.burnShareBps = uint16(_env("BURN_SHARE_BPS", 2000, type(uint16).max));
        c.taxDuration = uint32(_env("TAX_DURATION", 365 days, type(uint32).max));
    }

    function _shop() internal view returns (Shop memory s) {
        s.nfts = new address[](4);
        (s.nfts[0], s.nfts[1], s.nfts[2], s.nfts[3]) = (COMMON, UNCOMMON, RARE, LEGENDARY);
        s.prices = new uint256[](4);
        s.prices[0] = _env("GIVE_COMMON", 100, 1e15) * 1 ether;
        s.prices[1] = _env("GIVE_UNCOMMON", 200, 1e15) * 1 ether;
        s.prices[2] = _env("GIVE_RARE", 400, 1e15) * 1 ether;
        s.prices[3] = _env("GIVE_LEGENDARY", 800, 1e15) * 1 ether;
        s.pickBps = uint16(_env("PICK_BPS", 10_000, 50_000));
        s.cap = _env("CAP", 10_000, 1e15) * 1 ether;
    }

    /// A price or a cap above the token's whole supply can never be paid: refused here, with the reason (the shop itself
    /// cannot check it, as the token may not exist yet when the shop is created).
    function _refuseAboveSupply(Shop memory s, uint256 supply) internal pure {
        require(s.cap <= supply, "CAP is above the launch's fixed supply: no period could ever use it");
        for (uint256 i; i < s.prices.length; ++i) {
            uint256 g = s.prices[i];
            uint256 pick = g + (g * s.pickBps + 9_999) / 10_000;
            require(g <= supply, "a give price is above the launch's fixed supply: the shop could never pay it");
            require(pick <= supply, "a pick price is above the launch's fixed supply: a card given in could never be picked");
        }
    }

    function _supply(ICurveLauncherFactoryShop lf, CurveConfig memory c) internal view returns (uint256 supply) {
        (,,, supply,,) = lf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
    }

    function _rules(address shop) internal view returns (IRuleSplitter.Rule[] memory r) {
        uint256 cb = _env("CREATOR_BPS", 1000, 10_000);
        uint256 pb = _env("PILE_BPS", 3000, 10_000);
        uint256 bb = _env("BURN_BPS", 2000, 10_000);
        uint256 sb = _env("SHOP_BPS", 4000, 10_000);
        require(cb + pb + bb + sb == 10_000 && sb > 0, "the four parts must sum to 10000, the shop's above 0");
        r = new IRuleSplitter.Rule[]((cb > 0 ? 1 : 0) + (pb > 0 ? 1 : 0) + (bb > 0 ? 1 : 0) + 1);
        uint256 i;
        if (cb > 0) r[i++] = IRuleSplitter.Rule(IRuleSplitter.Kind.CREATOR, uint16(cb), vm.envOr("PAYEE", msg.sender));
        if (pb > 0) r[i++] = IRuleSplitter.Rule(IRuleSplitter.Kind.PILE, uint16(pb), address(0));
        r[i++] = IRuleSplitter.Rule(IRuleSplitter.Kind.CREATOR, uint16(sb), shop); // the shop: a second CREATOR rule
        // The rules factory accepts a buy and burn only as the LAST rule.
        if (bb > 0) r[i++] = IRuleSplitter.Rule(IRuleSplitter.Kind.BUY_BURN, uint16(bb), address(0));
    }

    function _mineSalt(bytes32 seed) internal pure returns (bytes32 salt) {
        for (uint256 i;; ++i) {
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

    function run() external {
        require(block.chainid == 97, "chain 97 only");
        CurveConfig memory c = _config();
        string memory dep = vm.readFile(
            string.concat(vm.projectRoot(), "/", vm.envOr("RULES_FILE", string("deployments/97-rules-usdt.json")))
        );
        RulesVaultFactory rvf = RulesVaultFactory(vm.parseJsonAddress(dep, ".rulesVaultFactory"));
        ICurveLauncherFactoryShop lf = ICurveLauncherFactoryShop(vm.parseJsonAddress(dep, ".launcherFactory"));
        address quote = vm.parseJsonAddress(dep, ".quote");
        RailShopFactory shops = RailShopFactory(vm.envAddress("RAIL_SHOP_FACTORY"));

        c.salt = _mineSalt(keccak256(abi.encode(vm.envOr("SALT_SEED", string("shop-rules")), block.number)));
        lf.checkConfig(c, true);
        address token = lf.predictToken(c.salt);
        require(token.code.length == 0, "the token exists already");
        Shop memory s = _shop();
        _refuseAboveSupply(s, _supply(lf, c));
        address shop = shops.shopAddress(msg.sender, token, quote, FLAP_ROUTER, s.nfts, s.prices, s.pickBps, s.cap);
        IRuleSplitter.Rule[] memory rules = _rules(shop);
        address predicted = lf.predictLauncher(msg.sender, c.salt);
        console.log(string.concat("token (to come) ", vm.toString(token)));
        console.log(string.concat("shop (to come) ", vm.toString(shop)));
        console.log(string.concat("launcher (to come) ", vm.toString(predicted)));

        vm.startBroadcast();
        require(shops.create(token, quote, FLAP_ROUTER, s.nfts, s.prices, s.pickBps, s.cap) == shop, "the shop's address");
        rvf.setRules(address(lf), c.salt, rules);
        address launcher = IPortal(PORTAL).newLauncher{value: lf.creationFee()}(address(lf), abi.encode(c));
        vm.stopBroadcast();

        require(launcher == predicted && rvf.rulesSet(launcher), "the sale and its rules");
        for (uint256 i; i < rules.length; ++i) {
            console.log(string.concat("rule ", vm.toString(i), ": kind ", vm.toString(uint256(rules[i].kind)), ", bps ",
                vm.toString(uint256(rules[i].bps)), ", target ", vm.toString(rules[i].target)));
        }
        string memory k = "shopSale";
        vm.serializeAddress(k, "launcher", launcher);
        vm.serializeBytes32(k, "salt", c.salt);
        vm.serializeAddress(k, "shop", shop);
        vm.serializeAddress(k, "railShopFactory", address(shops));
        vm.serializeAddress(k, "quote", quote);
        string memory json = vm.serializeAddress(k, "token", token);
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", vm.envOr("SALE_FILE", string("deployments/97-shop-rules-usdt-sale.json"))));
    }
}
