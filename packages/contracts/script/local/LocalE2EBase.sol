// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FeeCollector} from "../../src/FeeCollector.sol";
import {RewardLedger} from "../../src/RewardLedger.sol";
import {SquareHoleClaimConverter} from "../../src/SquareHoleClaimConverter.sol";
import {SquareHoleHook} from "../../src/SquareHoleHook.sol";
import {SquareHoleLauncher} from "../../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";

/// @notice Shared by the local end-to-end scripts (chain 31337 only): reads `deployments/31337.json` written by
/// `script/Deploy.s.sol`, derives anvil's PUBLIC default test accounts from its well-known mnemonic (Foundry's default
/// anvil keys; never used anywhere but the local chain), and rebuilds each pair's PoolKey from the registry.
abstract contract LocalE2EBase is Script {
    using stdJson for string;

    /// @dev anvil's default, public test mnemonic (every Foundry user has the same accounts; local chain only).
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    uint256 internal constant LOCAL_CHAIN_ID = 31_337;

    struct Actor {
        string name;
        uint256 key;
        address addr;
    }

    struct Stack {
        SquareHoleRegistry registry;
        SquareHoleLauncher launcher;
        SquareHoleClaimConverter converter;
        SquareHoleHook hook;
        address poolManager;
        address weth;
        address usdt;
        address treasury;
        bytes32 misfitsPairId; // The Misfits: T = FIT, quote WETH, R = Q
        bytes32 orchardPairId; // ORCHARD: T = ORCH, quote FIT, R = T (zero when the deployment has no ORCHARD)
    }

    struct Pair {
        SquareHoleRegistry.PairRecord r;
        PoolKey key;
        bool tIsCurrency0;
        RewardLedger ledger;
        FeeCollector collector;
    }

    function _requireLocal() internal view {
        require(block.chainid == LOCAL_CHAIN_ID, "local E2E: chain 31337 only");
    }

    function _actor(string memory name, uint32 index) internal view returns (Actor memory a) {
        a.name = name;
        a.key = vm.deriveKey(ANVIL_MNEMONIC, index);
        a.addr = vm.addr(a.key);
    }

    function _loadStack() internal view returns (Stack memory s) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/deployments/31337.json"));
        require(json.readUint(".chainId") == LOCAL_CHAIN_ID, "local E2E: manifest chain id");
        require(
            keccak256(bytes(json.readString(".status"))) == keccak256("deployed"),
            "local E2E: deployments/31337.json is not finalized (script/WriteManifest.s.sol)"
        );
        s.registry = SquareHoleRegistry(json.readAddress(".contracts.registry.address"));
        s.launcher = SquareHoleLauncher(json.readAddress(".contracts.launcher.address"));
        s.converter = SquareHoleClaimConverter(json.readAddress(".contracts.claimConverter.address"));
        s.hook = SquareHoleHook(json.readAddress(".contracts.hook.address"));
        s.poolManager = json.readAddress(".contracts.poolManager.address");
        s.weth = json.readAddress(".contracts.WETH.address");
        s.usdt = json.readAddress(".contracts.USDT.address");
        s.treasury = json.readAddress(".treasury");
        s.misfitsPairId = json.readBytes32(".launches.THE_MISFITS.pairId");
        if (vm.keyExistsJson(json, ".launches.ORCHARD")) {
            s.orchardPairId = json.readBytes32(".launches.ORCHARD.pairId");
        }
        require(
            address(s.registry).code.length != 0, "local E2E: registry has no code (is anvil running the deployment?)"
        );
    }

    function _pair(SquareHoleRegistry registry, bytes32 pairId) internal view returns (Pair memory p) {
        p.r = registry.pair(pairId);
        require(p.r.token != address(0), "local E2E: unknown pair");
        p.tIsCurrency0 = p.r.token < p.r.quote;
        p.key = PoolKey({
            currency0: Currency.wrap(p.tIsCurrency0 ? p.r.token : p.r.quote),
            currency1: Currency.wrap(p.tIsCurrency0 ? p.r.quote : p.r.token),
            fee: SquareHoleHook(p.r.hook).LP_FEE(),
            tickSpacing: p.r.tickSpacing,
            hooks: IHooks(p.r.hook)
        });
        p.ledger = RewardLedger(p.r.ledger);
        p.collector = FeeCollector(p.r.collector);
    }

    /// @dev Raw units per whole NFT of a collection pair (F10: 1e27 / N, exact).
    function _nftUnit(Pair memory p) internal pure returns (uint256) {
        return p.r.initialSupply / p.r.units;
    }

    function _balance(address token, address account) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, account));
        require(ok && ret.length == 32, "balanceOf");
        return abi.decode(ret, (uint256));
    }
}
