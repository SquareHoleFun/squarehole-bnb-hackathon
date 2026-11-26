// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {IRuleSplitter} from "fee-rules/IRuleSplitter.sol";
import {IFeeRules} from "fee-rules/IFeeRules.sol";
import {CurveConfig} from "../src/CurveLauncher.sol";
import {PileVault} from "../src/PileVault.sol";
import {PileVaultFactory} from "../src/PileVaultFactory.sol";
import {TokenPileVaultFactory} from "../src/TokenPileVaultFactory.sol";
import {TokenCurveLauncherFactory} from "../src/TokenCurveLauncherFactory.sol";
import {RulesCurveLauncherFactory} from "../src/RulesCurveLauncherFactory.sol";
import {RulesTokenCurveLauncherFactory} from "../src/RulesTokenCurveLauncherFactory.sol";
import {RulesVault} from "../src/RulesVault.sol";
import {RulesVaultFactory} from "../src/RulesVaultFactory.sol";
import {MockHub, MockToken20, MockAntiScam} from "./CurveLauncher.t.sol";
import {MockHubT} from "./TokenCurveLauncher.t.sol";
import {WethRouter} from "./RulesVault.t.sol";

/// @dev Anti-scam modules that misbehave: each must make creation refuse (the Portal's launch asks the same module).
contract RevertingScam {
    function isScamWord(string calldata, string calldata) external pure returns (bool, bool) {
        revert("down");
    }
}

contract ShortScam {
    fallback() external {
        assembly {
            mstore(0, 0)
            return(0, 32) // one word where two are expected
        }
    }
}

contract NonBoolScam {
    fallback() external {
        assembly {
            mstore(0, 2) // 2 is not a boolean
            mstore(32, 0)
            return(0, 64)
        }
    }
}

contract GasHogScam {
    fallback() external {
        while (true) {}
    }
}

/// @dev Pays with Solidity's `transfer` (a 2,300-gas stipend).
contract Transferrer {
    constructor() payable {}

    function pay(address payable to) external {
        to.transfer(address(this).balance);
    }
}

/// @notice What a review of the pre-audit fixes found untested: R1 and the pairing check in the two generated Rules* launcher
/// factories; the anti-scam module's failure modes; the lock of a vault proxy before its initialization; the pinned
/// storage layout of both vault implementations.
contract HardeningTest is Test {
    address constant TOKEN_IMPL = address(0x7777c57ff7dc441c1715b2e36fa581c48B782222);
    MockAntiScam scam;
    MockHub hub;
    MockToken20 usd;
    MockHubT hubT;

    function setUp() public {
        scam = new MockAntiScam();
        hub = new MockHub();
        usd = new MockToken20();
        hubT = new MockHubT(address(usd));
        scam.list("USDT", "");
        scam.list("", "BNB");
    }

    function _next() internal view returns (address) {
        return vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
    }

    function _cfg() internal pure returns (CurveConfig memory c) {
        c.name = "Curve";
        c.symbol = "CRV";
        c.salt = bytes32(uint256(5));
        c.saleTokens = 600_000_000 ether;
        c.targetRaise = 2.6 ether;
        c.virtualBnb = 10 ether;
        c.duration = 1 days;
        c.tradeFeeBps = 100;
        c.buyTaxBps = 300;
        c.sellTaxBps = 500;
        c.burnShareBps = 2000;
        c.taxDuration = 365 days;
    }

    function _err(string memory reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(TokenCurveLauncherFactory.InvalidConfig.selector, reason);
    }

    string constant CHECK_SIG =
        "checkConfig((string,string,string,bytes32,uint256,uint256,uint256,uint64,uint16,uint16,uint16,uint16,uint32),bool)";

    /// checkConfig through the ABI (the generated copies declare their own CurveConfig type; the encoding is the same).
    function _check(address f, CurveConfig memory c) internal view returns (bytes memory err) {
        (bool ok, bytes memory ret) = f.staticcall(abi.encodeWithSignature(CHECK_SIG, c, true));
        assertFalse(ok, "checkConfig accepted");
        return ret;
    }

    /// The checks R1 adds, through any factory's checkConfig (all four share the selector and the reasons).
    function _r1(address f) internal view {
        CurveConfig memory c = _cfg();
        c.name = "USDT";
        assertEq(_check(f, c), _err("name on the Portal's anti-scam list"));
        c.name = "Curve";
        c.symbol = "BNB";
        assertEq(_check(f, c), _err("symbol on the Portal's anti-scam list"));
        c.symbol = "CRV"; // clean: judged by the next check (the unmined salt)
        assertEq(_check(f, c), _err("token address must end in 7777"));
    }

    // ── 1. the generated Rules* launcher factories carry R1 and the pairing check ──

    function test_rulesNative_r1_andPairing() public {
        PileVaultFactory wrong = new PileVaultFactory(address(hub), address(this));
        try new RulesCurveLauncherFactory(address(hub), address(wrong), TOKEN_IMPL, address(scam)) returns (
            RulesCurveLauncherFactory
        ) {
            revert("accepted a vault factory paired with another");
        } catch (bytes memory err) {
            assertEq(err, _err("vault factory is paired with another launcher factory"));
        }
        PileVaultFactory vf = new PileVaultFactory(address(hub), _next());
        RulesCurveLauncherFactory f = new RulesCurveLauncherFactory(address(hub), address(vf), TOKEN_IMPL, address(scam));
        assertEq(vf.pairedLauncherFactory(), address(f));
        _r1(address(f));
        // with the creation fee and a config: an entry that existed would succeed or revert WITH a reason; a
        // missing one reverts with no data at all (no fallback)
        (bool ok, bytes memory ret) = address(f).call{value: f.creationFee()}(abi.encodeWithSignature(
            "createLauncher((string,string,string,bytes32,uint256,uint256,uint256,uint64,uint16,uint16,uint16,uint16,uint32))",
            _cfg()
        ));
        assertFalse(ok, "no direct createLauncher");
        assertEq(ret.length, 0, "the selector does not exist");
    }

    function test_rulesToken_r1_andPairing() public {
        TokenPileVaultFactory wrong = new TokenPileVaultFactory(address(hubT), address(usd), address(this));
        try new RulesTokenCurveLauncherFactory(address(hubT), address(wrong), TOKEN_IMPL, address(scam)) returns (
            RulesTokenCurveLauncherFactory
        ) {
            revert("accepted a vault factory paired with another");
        } catch (bytes memory err) {
            assertEq(err, _err("vault factory is paired with another launcher factory"));
        }
        TokenPileVaultFactory vf = new TokenPileVaultFactory(address(hubT), address(usd), _next());
        RulesTokenCurveLauncherFactory f =
            new RulesTokenCurveLauncherFactory(address(hubT), address(vf), TOKEN_IMPL, address(scam));
        assertEq(vf.pairedLauncherFactory(), address(f));
        _r1(address(f));
        // with the creation fee and a config: an entry that existed would succeed or revert WITH a reason; a
        // missing one reverts with no data at all (no fallback)
        (bool ok, bytes memory ret) = address(f).call{value: f.creationFee()}(abi.encodeWithSignature(
            "createLauncher((string,string,string,bytes32,uint256,uint256,uint256,uint64,uint16,uint16,uint16,uint16,uint32))",
            _cfg()
        ));
        assertFalse(ok, "no direct createLauncher");
        assertEq(ret.length, 0, "the selector does not exist");
    }

    // ── 2. a module that misbehaves refuses creation ──────────────────────────

    function _withModule(address module) internal returns (TokenCurveLauncherFactory f) {
        TokenPileVaultFactory vf = new TokenPileVaultFactory(address(hubT), address(usd), _next());
        f = new TokenCurveLauncherFactory(address(hubT), address(vf), TOKEN_IMPL, module);
    }

    function test_module_reverts_shortData_nonBool_outOfGas_allRefuse() public {
        address[4] memory mods =
            [address(new RevertingScam()), address(new ShortScam()), address(new NonBoolScam()), address(new GasHogScam())];
        string[4] memory names = ["reverts", "short data", "not a boolean", "runs out of gas"];
        for (uint256 i; i < 4; ++i) {
            TokenCurveLauncherFactory f = _withModule(mods[i]);
            (bool ok, bytes memory ret) =
                address(f).call{gas: 3_000_000}(abi.encodeCall(TokenCurveLauncherFactory.checkConfig, (_cfg(), true)));
            assertFalse(ok, names[i]);
            // never the clean answer's next reason: the module's failure stopped it
            assertTrue(keccak256(ret) != keccak256(_err("token address must end in 7777")), names[i]);
            emit log_named_bytes(names[i], ret);
        }
    }

    // ── 3. a proxy that was never initialized refuses every guarded entry ──────

    function test_uninitializedProxies_refuseEveryEntry() public {
        PileVaultFactory pvf = new PileVaultFactory(address(hub), address(this));
        PileVault p = PileVault(payable(LibClone.deployERC1967BeaconProxy(pvf.beacon())));
        vm.expectRevert(IFeeRules.Reentrancy.selector);
        p.redeem(1, 0);
        vm.expectRevert(IFeeRules.Reentrancy.selector);
        p.redeemTo(1, 0, address(this));
        vm.expectRevert(IFeeRules.Reentrancy.selector);
        p.sync();
        RulesVaultFactory rvf =
            new RulesVaultFactory(address(new MockHubT(address(0))), address(0), address(new WethRouter(address(0xBB))), address(this));
        RulesVault v = RulesVault(payable(LibClone.deployERC1967BeaconProxy(rvf.beacon())));
        vm.expectRevert(IRuleSplitter.Reentrancy.selector);
        v.distribute();
    }

    // ── the native coin: a proxy takes it by a plain call, not by a 2,300-gas transfer; an implementation refuses it ──

    function test_nativeFunding_plainCall_notTransfer_andImplementationsRefuse() public {
        MockToken20 tok = new MockToken20();
        PileVaultFactory pvf = new PileVaultFactory(address(hub), address(this));
        PileVault p = PileVault(payable(LibClone.deployERC1967BeaconProxy(pvf.beacon())));
        p.initialize(address(tok), address(0));
        // a cold proxy: the beacon lookup and the delegatecall come before receive()
        (bool ok,) = address(p).call{value: 1 ether}("");
        assertTrue(ok, "a value-bearing call pays the pile");
        assertEq(p.pile(), 1 ether);
        PileVault p2 = PileVault(payable(LibClone.deployERC1967BeaconProxy(pvf.beacon())));
        p2.initialize(address(tok), address(0));
        Transferrer t = new Transferrer{value: 1 ether}();
        vm.expectRevert(); // the 2,300-gas stipend is not enough
        t.pay(payable(address(p2)));
        // a locked implementation refuses the coin (nothing could ever pay it out)
        address impl = pvf.beaconImplementation();
        (ok,) = impl.call{value: 1}("");
        assertFalse(ok, "the pile implementation refuses");
        RulesVaultFactory rvf =
            new RulesVaultFactory(address(new MockHubT(address(0))), address(0), address(new WethRouter(address(0xBB))), address(this));
        (ok,) = rvf.beaconImplementation().call{value: 1}("");
        assertFalse(ok, "the rules vault implementation refuses");
        (ok,) = rvf.pileBeaconImplementation().call{value: 1}("");
        assertFalse(ok, "the rules factory's pile implementation refuses");
        // a proxy before its initialization refuses too
        (ok,) = LibClone.deployERC1967BeaconProxy(pvf.beacon()).call{value: 1}("");
        assertFalse(ok, "an uninitialized proxy refuses");
    }

    // ── 4. the storage layout both implementations keep across upgrades ───────

    function test_storageLayout_pinned() public {
        MockToken20 tok = new MockToken20();
        // the rules vault: token 0, asset 1, the lock 16, then slot 57 packs Initializable (_initialized = 1 at byte 0,
        // _initializing at byte 1) and `factory` (bytes 2..21)
        RulesVaultFactory rvf =
            new RulesVaultFactory(address(new MockHubT(address(usd))), address(usd), address(new WethRouter(address(0xBB))), address(this));
        RulesVault v = RulesVault(payable(LibClone.deployERC1967BeaconProxy(rvf.beacon())));
        IRuleSplitter.Rule[] memory r = new IRuleSplitter.Rule[](1);
        r[0] = IRuleSplitter.Rule({kind: IRuleSplitter.Kind.CREATOR, bps: 10_000, target: address(0xC0FFEE)});
        v.initialize(address(tok), address(usd), r);
        assertEq(address(uint160(uint256(vm.load(address(v), bytes32(uint256(0)))))), address(tok), "token at 0");
        assertEq(address(uint160(uint256(vm.load(address(v), bytes32(uint256(1)))))), address(usd), "asset at 1");
        assertEq(uint256(vm.load(address(v), bytes32(uint256(16)))), 1, "the lock at 16");
        assertEq(
            uint256(vm.load(address(v), bytes32(uint256(57)))),
            (uint256(uint160(address(this))) << 16) | 1,
            "Initializable and factory packed at 57"
        );
        // the pile: token 0, asset 1, the lock 10, then slot 51 packs Initializable and `factory`
        PileVaultFactory pvf = new PileVaultFactory(address(hub), address(this));
        PileVault p = PileVault(payable(LibClone.deployERC1967BeaconProxy(pvf.beacon())));
        p.initialize(address(tok), address(0));
        assertEq(address(uint160(uint256(vm.load(address(p), bytes32(uint256(0)))))), address(tok), "token at 0");
        assertEq(uint256(vm.load(address(p), bytes32(uint256(1)))), 0, "asset (native) at 1");
        assertEq(uint256(vm.load(address(p), bytes32(uint256(10)))), 1, "the lock at 10");
        assertEq(
            uint256(vm.load(address(p), bytes32(uint256(51)))),
            (uint256(uint160(address(this))) << 16) | 1,
            "Initializable and factory packed at 51"
        );
    }
}
