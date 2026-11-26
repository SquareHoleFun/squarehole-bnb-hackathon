// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {ClonesUpgradeable} from "@openzeppelin-contracts-upgradeable/proxy/ClonesUpgradeable.sol";
import {IPortal} from "src/flap/IPortal.sol";
import {TokenCurveLauncherFactory} from "../src/TokenCurveLauncherFactory.sol";
import {CurveConfig} from "../src/CurveLauncher.sol";

/// @notice Creates one curve sale quoted in the token-quote factories' ERC-20 (Flap's test USDT) and writes
/// `deployments/<chainId>-usdt-sale.json`. Reads the factory from `deployments/<chainId>-usdt.json` (or
/// DEPLOYMENTS_FILE). Settings from the environment, each with a default, amounts in the quote's base units:
/// NAME, SYMBOL, META, SALE_TOKENS (whole tokens), TARGET_WEI, VIRTUAL_WEI, DURATION (seconds), TRADE_FEE_BPS,
/// BUY_TAX_BPS, SELL_TAX_BPS, BURN_SHARE_BPS, TAX_DURATION (seconds), SALT_SEED, VIA_PORTAL (1 = through
/// Portal.newLauncher, the default; 0 = the factory's direct createLauncher). The value sent is exactly the Portal's
/// salt-lock fee in the native coin; nothing else is spent. Defaults: a 1,700 USDT raise with 11,600 USDT virtual
/// (the price rises 31% along the curve), above the Portal's floor of about 1,610 USDT for it.
///   forge script script/CreateTokenSale.s.sol --rpc-url <endpoint> --account <keystore> --sender <address> --broadcast
contract CreateTokenSale is Script {
    address constant PORTAL = 0x000042108465206185A077Edc3F3fd2b49060000;
    address constant TOKEN_IMPL = 0x7777c57ff7dc441c1715b2e36fa581c48B782222;

    function _deployments() internal view returns (string memory) {
        return vm.envOr("DEPLOYMENTS_FILE", string.concat("deployments/", vm.toString(block.chainid), "-usdt.json"));
    }

    function _config() internal view returns (CurveConfig memory c) {
        c.name = vm.envOr("NAME", string("Pile Curve USD"));
        c.symbol = vm.envOr("SYMBOL", string("UPILE"));
        c.meta = vm.envOr("META", string(""));
        c.saleTokens = vm.envOr("SALE_TOKENS", uint256(600_000_000)) * 1 ether;
        c.targetRaise = vm.envOr("TARGET_WEI", uint256(1_700 ether));
        c.virtualBnb = vm.envOr("VIRTUAL_WEI", uint256(11_600 ether));
        c.duration = uint64(_env("DURATION", 2 days, type(uint64).max));
        c.tradeFeeBps = uint16(_env("TRADE_FEE_BPS", 100, type(uint16).max));
        c.buyTaxBps = uint16(_env("BUY_TAX_BPS", 300, type(uint16).max));
        c.sellTaxBps = uint16(_env("SELL_TAX_BPS", 500, type(uint16).max));
        c.burnShareBps = uint16(_env("BURN_SHARE_BPS", 2000, type(uint16).max));
        c.taxDuration = uint32(_env("TAX_DURATION", 365 days, type(uint32).max));
    }

    /// @dev Reads a number and refuses one that would not fit its field (65536 must not become 0).
    function _env(string memory name, uint256 fallback_, uint256 max) internal view returns (uint256 v) {
        v = vm.envOr(name, fallback_);
        require(v <= max, string.concat(name, " does not fit its field"));
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
        CurveConfig memory c = _config(); // settings checked before anything else is read
        uint256 route = vm.envOr("VIA_PORTAL", uint256(1));
        require(route <= 1, "VIA_PORTAL must be 0 or 1");
        bool viaPortal = route == 1;
        string memory dep = vm.readFile(string.concat(vm.projectRoot(), "/", _deployments()));
        TokenCurveLauncherFactory clf = TokenCurveLauncherFactory(vm.parseJsonAddress(dep, ".tokenCurveLauncherFactory"));

        bytes32 seed = keccak256(abi.encode(vm.envOr("SALT_SEED", string("pile")), block.number));
        c.salt = _mineSalt(seed);
        clf.checkConfig(c, viaPortal); // reverts with the reason before anything is sent
        uint256 value = clf.creationFee();
        // Printed before sending: if the run stops after the transaction, the Launcher is found from these.
        console.log(string.concat("salt ", vm.toString(c.salt)));
        console.log(string.concat("launcher (predicted) ", vm.toString(clf.predictLauncher(msg.sender, c.salt))));
        console.log(string.concat("value (wei) ", vm.toString(value)));

        vm.startBroadcast();
        address launcher = viaPortal
            ? IPortal(PORTAL).newLauncher{value: value}(address(clf), abi.encode(c))
            : clf.createLauncher{value: value}(c);
        vm.stopBroadcast();

        console.log(string.concat("launcher ", vm.toString(launcher)));
        console.log(string.concat("via Portal ", vm.toString(viaPortal)));
        _report(clf, c, launcher, viaPortal);
    }

    function _report(TokenCurveLauncherFactory clf, CurveConfig memory c, address launcher, bool viaPortal) internal {
        (, uint256 raise, uint256 poolToken, uint256 total, uint256 p0, uint256 p1) =
            clf.curveFor(c.saleTokens, c.targetRaise, c.virtualBnb);
        console.log(string.concat("token (to come) ", vm.toString(clf.predictToken(c.salt))));
        console.log(string.concat("raise (wei) ", vm.toString(raise)));
        console.log(string.concat("pool tokens ", vm.toString(poolToken)));
        console.log(string.concat("total supply ", vm.toString(total)));
        console.log(string.concat("start price ", vm.toString(p0)));
        console.log(string.concat("final price ", vm.toString(p1)));

        string memory k = "sale";
        vm.serializeAddress(k, "launcher", launcher);
        vm.serializeBool(k, "viaPortal", viaPortal);
        vm.serializeBytes32(k, "salt", c.salt);
        vm.serializeUint(k, "raiseWei", raise);
        vm.serializeAddress(k, "quote", clf.quote());
        string memory json = vm.serializeAddress(k, "token", clf.predictToken(c.salt));
        string memory out = vm.envOr("SALE_FILE", string.concat("deployments/", vm.toString(block.chainid), "-usdt-sale.json"));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/", out));
    }
}
