// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import {IPortal} from "src/flap/IPortal.sol";
import {CurveConfig} from "../src/CurveLauncher.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {RailStakeFactory} from "fee-rules/RailStakeFactory.sol";

interface ICurveLauncherFactoryLike {
    function checkConfig(CurveConfig memory c, bool viaPortal) external view;
    function creationFee() external view returns (uint256);
    function predictToken(bytes32 salt) external view returns (address);
    function predictLauncher(address creator, bytes32 salt) external view returns (address);
}

/// @notice Creates one sale with the creator's rules, in two transactions in this order: `setRules` (while the sale
/// does not exist), then `Portal.newLauncher` (the sale). Reads `deployments/<chainId>-rules-<variant>.json`
/// (VARIANT=usdt, the default, or native; RULES_FILE overrides the path). The rules from the environment: CREATOR_BPS (default 2000) paid to PAYEE
/// (default the sender), PILE_BPS (default 5000), BURN_BPS (default 3000); a part of 0 leaves that rule out; the parts
/// must sum to 10,000. HOLDERS_BPS (default 0) adds a fourth rule paying a RailStake for the token to come: the
/// creator's stake is created first (factory from STAKE_FILE, default `deployments/<chainId>-stake.json`; asset the
/// sale's quote; STAKE_PERIOD seconds, default 7 days), then the rules name it, then the sale: three transactions.
/// The sale's settings as in CreateSale / CreateTokenSale (defaults: 1,700 test USDT, or 2.35 BNB).
/// Writes `deployments/<chainId>-rules-<variant>-sale.json` (with `stake` when there is one). Chain 97 only.
///   forge script script/CreateRulesSale.s.sol --rpc-url <endpoint> --account <keystore> --sender <address> --broadcast
contract CreateRulesSale is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;

    function _env(string memory name, uint256 fallback_, uint256 max) internal view returns (uint256 v) {
        v = vm.envOr(name, fallback_);
        require(v <= max, string.concat(name, " does not fit its field"));
    }

    function _config(bool usd) internal view returns (CurveConfig memory c) {
        c.name = vm.envOr("NAME", string(usd ? "Rules Pile USD" : "Rules Pile"));
        c.symbol = vm.envOr("SYMBOL", string(usd ? "RULEU" : "RULE"));
        c.meta = vm.envOr("META", string(""));
        c.saleTokens = _env("SALE_TOKENS", 600_000_000, 1e15) * 1 ether;
        c.targetRaise = vm.envOr("TARGET_WEI", usd ? uint256(1_700 ether) : uint256(2.35 ether));
        c.virtualBnb = vm.envOr("VIRTUAL_WEI", usd ? uint256(11_600 ether) : uint256(16 ether));
        c.duration = uint64(_env("DURATION", 2 days, type(uint64).max));
        c.tradeFeeBps = uint16(_env("TRADE_FEE_BPS", 100, type(uint16).max));
        c.buyTaxBps = uint16(_env("BUY_TAX_BPS", 300, type(uint16).max));
        c.sellTaxBps = uint16(_env("SELL_TAX_BPS", 500, type(uint16).max));
        c.burnShareBps = uint16(_env("BURN_SHARE_BPS", 2000, type(uint16).max));
        c.taxDuration = uint32(_env("TAX_DURATION", 365 days, type(uint32).max));
    }

    function _rules(address stake) internal view returns (IRuleSplitter.Rule[] memory r) {
        uint256 cb = _env("CREATOR_BPS", 2000, 10_000);
        uint256 pb = _env("PILE_BPS", 5000, 10_000);
        uint256 bb = _env("BURN_BPS", 3000, 10_000);
        uint256 hb = _env("HOLDERS_BPS", 0, 10_000);
        require(cb + pb + bb + hb == 10_000, "CREATOR_BPS + PILE_BPS + BURN_BPS + HOLDERS_BPS must be 10000");
        uint256 n = (cb > 0 ? 1 : 0) + (pb > 0 ? 1 : 0) + (bb > 0 ? 1 : 0) + (hb > 0 ? 1 : 0);
        r = new IRuleSplitter.Rule[](n);
        uint256 i;
        if (cb > 0) {
            r[i++] = IRuleSplitter.Rule({
                kind: IRuleSplitter.Kind.CREATOR, bps: uint16(cb), target: vm.envOr("PAYEE", msg.sender)
            });
        }
        if (pb > 0) r[i++] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.PILE, bps: uint16(pb), target: address(0)});
        if (hb > 0) r[i++] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: uint16(hb), target: stake});
        // the buy and burn last: it makes the heaviest outside call
        if (bb > 0) r[i++] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.BUY_BURN, bps: uint16(bb), target: address(0)});
    }

    RailStakeFactory internal sf;
    address internal stake;
    address internal quote;
    uint256 internal period;

    /// With HOLDERS_BPS > 0: the stake factory and the address the creator's stake for this token will have.
    function _stakePlan(address token, address asset) internal {
        quote = asset;
        if (vm.envOr("HOLDERS_BPS", uint256(0)) == 0) return;
        string memory file =
            vm.envOr("STAKE_FILE", string.concat("deployments/", vm.toString(block.chainid), "-stake.json"));
        sf = RailStakeFactory(vm.parseJsonAddress(vm.readFile(string.concat(vm.projectRoot(), "/", file)), ".factory"));
        period = vm.envOr("STAKE_PERIOD", uint256(7 days));
        require(sf.stakeOf(msg.sender, token) == address(0), "this creator already has a stake for that token");
        stake = sf.stakeAddress(msg.sender, token, asset, period);
        console.log(string.concat("holders' stake (to create) ", vm.toString(stake)));
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
        string memory variant = vm.envOr("VARIANT", string("usdt"));
        bool usd = keccak256(bytes(variant)) == keccak256("usdt");
        require(usd || keccak256(bytes(variant)) == keccak256("native"), "VARIANT must be usdt or native");
        CurveConfig memory c = _config(usd);

        string memory depFile = vm.envOr(
            "RULES_FILE", string.concat("deployments/", vm.toString(block.chainid), "-rules-", variant, ".json")
        );
        string memory dep = vm.readFile(string.concat(vm.projectRoot(), "/", depFile));
        RulesVaultFactory rvf = RulesVaultFactory(vm.parseJsonAddress(dep, ".rulesVaultFactory"));
        ICurveLauncherFactoryLike lf = ICurveLauncherFactoryLike(vm.parseJsonAddress(dep, ".launcherFactory"));

        c.salt = _mineSalt(keccak256(abi.encode(vm.envOr("SALT_SEED", string("rules")), block.number)));
        _stakePlan(lf.predictToken(c.salt), usd ? vm.parseJsonAddress(dep, ".quote") : address(0));
        IRuleSplitter.Rule[] memory rules = _rules(stake);
        lf.checkConfig(c, true); // reverts with the reason before anything is sent
        address predicted = lf.predictLauncher(msg.sender, c.salt);
        require(rvf.launcherFor(address(lf), msg.sender, c.salt) == predicted, "the factories disagree on the Launcher");
        console.log(string.concat("salt ", vm.toString(c.salt)));
        console.log(string.concat("launcher (predicted) ", vm.toString(predicted)));

        vm.startBroadcast();
        if (stake != address(0)) {
            // the holders' stake first, for the token to come, at the address the rules name
            require(sf.create(lf.predictToken(c.salt), quote, period) == stake, "stake address");
        }
        rvf.setRules(address(lf), c.salt, rules); // then the rules, while the sale does not exist
        address launcher = IPortal(PORTAL).newLauncher{value: lf.creationFee()}(address(lf), abi.encode(c));
        vm.stopBroadcast();

        require(launcher == predicted, "the sale is not the Launcher the rules were stored for");
        require(rvf.rulesSet(launcher), "the rules are not stored");
        console.log(string.concat("launcher ", vm.toString(launcher)));
        console.log(string.concat("token (to come) ", vm.toString(lf.predictToken(c.salt))));
        for (uint256 i; i < rules.length; ++i) {
            console.log(
                string.concat(
                    "rule ", vm.toString(i), ": kind ", vm.toString(uint256(rules[i].kind)), ", bps ",
                    vm.toString(uint256(rules[i].bps)), ", target ", vm.toString(rules[i].target)
                )
            );
        }

        _write(variant, launcher, c.salt, address(rvf), lf.predictToken(c.salt));
    }

    function _write(string memory variant, address launcher, bytes32 salt, address rvf, address token) internal {
        string memory k = "rulesSale";
        vm.serializeAddress(k, "launcher", launcher);
        vm.serializeBytes32(k, "salt", salt);
        vm.serializeAddress(k, "rulesVaultFactory", rvf);
        vm.serializeAddress(k, "quote", quote);
        if (stake != address(0)) {
            vm.serializeAddress(k, "stake", stake);
            vm.serializeAddress(k, "stakeFactory", address(sf));
        }
        string memory json = vm.serializeAddress(k, "token", token);
        string memory out = vm.envOr(
            "SALE_FILE", string.concat("deployments/", vm.toString(block.chainid), "-rules-", variant, "-sale.json")
        );
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", out));
    }
}
