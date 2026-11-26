// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {VmSafe} from "forge-std/Vm.sol";
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {CoreV1Deployment} from "../lib/CoreV1Deployment.sol";
import {BoxFactoryV1} from "../../src/box/BoxFactoryV1.sol";
import {BoxSpecV1} from "../../src/box/BoxSpecV1.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PriceLimitSwapper} from "../../test/research/hookgas/HookGasKit.sol";
import {HostileCollection} from "../../test/box-v2/kit/m2/ShopDoubles.sol";
import {LocalV2Custody} from "./DeployCoreV2Local.s.sol";
import {LocalTwin} from "./LocalTwin.sol";
import {LocalBoxArt} from "./LocalBoxArt.sol";
import {LocalWETH9} from "./LocalQuoteMocks.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {DrandSource} from "../../src/box/randomness/DrandSource.sol";
import {AlphaLocalCustody} from "./AlphaLocalCustody.sol";

/// @notice Fresh-anvil dependencies only: real genesis contracts, pinned drand and PoolManager; local WETH/NFT/custody.
/// Same CoreV1Deployment routine as DeployCoreV1Local; local platform, immediate open and catalogued PNG art differ.
contract CoreV2LocalGenesis is Script, CoreV1Deployment {
    struct AlphaDependencies {
        address manager;
        address weth;
        address drand;
        address fit;
        address platform;
        address swapper;
        address poolSwapTest;
    }

    /// @notice Explicit 31337 entry. V1 genesis pins intentionally do not support this chain.
    /// Deploy real v2 dependencies separately; no v1 genesis or pinned public address is fabricated.
    function runAlpha() external returns (AlphaDependencies memory d) {
        LocalTwin.checkAlpha(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        return _bootstrapAlpha(msg.sender);
    }

    function _bootstrapAlpha(address deployer) internal returns (AlphaDependencies memory d) {
        require(block.chainid == 31337, "alpha local only");
        address[] memory owners = new address[](1); owners[0] = deployer;
        vm.startBroadcast(deployer);
        d.fit = address(new LocalV2Custody(owners, 1));
        d.platform = address(new AlphaLocalCustody(owners));
        d.manager = vm.deployCode("PoolManager.sol:PoolManager", abi.encode(deployer));
        d.weth = address(new LocalWETH9());
        d.drand = address(new DrandSource());
        d.swapper = address(new PriceLimitSwapper(IPoolManager(d.manager)));
        d.poolSwapTest = address(new PoolSwapTest(IPoolManager(d.manager)));
        vm.stopBroadcast();
        console.log(string.concat("ALPHA|dependencies|", vm.toString(abi.encode(d))));
    }

    /// @notice Anvil-only unlocked deployer. No production chain, key, Safe signing or box-0 life is touched.
    function run() external {
        LocalTwin.check(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        _bootstrap(msg.sender, vm.envAddress("SH_CORE_V2_LOCAL_ACTOR"), vm.envAddress("SH_CORE_V2_LOCAL_BACKUP"));
    }

    /// @notice Offline-only rehearsal of the identical bootstrap; refuses broadcast and resume contexts.
    function rehearse() external {
        require(vm.isContext(VmSafe.ForgeContext.ScriptDryRun), "dry run only");
        vm.chainId(11_155_111); vm.warp(1_790_000_000); vm.roll(16);
        vm.deal(msg.sender, 100 ether);
        _bootstrap(msg.sender, address(0xA11CE), address(0xB0B));
    }

    function _bootstrap(address deployer, address actor, address backup) internal {
        address[] memory owners = new address[](3);
        owners[0] = deployer;
        owners[1] = actor;
        owners[2] = backup;
        vm.startBroadcast(deployer);
        address fit = address(new LocalV2Custody(owners, 2));
        address conversion = address(new LocalV2Custody(owners, 2));
        address[] memory founder = new address[](1); founder[0] = deployer;
        address platform = address(new LocalV2Custody(founder, 1));
        IPoolManager pm = IPoolManager(vm.deployCode("PoolManager.sol:PoolManager", abi.encode(deployer)));
        // SH-RC7 item 14: an ERC-20 like WETH9 (approve, allowance, transferFrom, receive), so an income inbox's WETH
        // order can register here (refreshOrder reads and sets its VaultRelayer allowance). The fifth CREATE, as before.
        address weth = address(new LocalWETH9());
        CoreV1Version memory v = _deployCoreV1(CoreV1Config(deployer, true, pm, weth, platform, deployer));
        _createBox0(BoxFactoryV1(v.factory), _localGenesisSpec(platform));
        address swapper = address(new PriceLimitSwapper(pm));
        address nft = address(new HostileCollection());
        vm.stopBroadcast();
        console.log(string.concat("LOCALV2|genesisFactory|", vm.toString(v.factory)));
        console.log(string.concat("LOCALV2|fit|", vm.toString(fit)));
        console.log(string.concat("LOCALV2|conversion|", vm.toString(conversion)));
        console.log(string.concat("LOCALV2|swapper|", vm.toString(swapper)));
        console.log(string.concat("LOCALV2|nft|", vm.toString(nft)));
    }

    /// @dev Local fixture only. The FIT PNG is the existing raster logo; production box-0 inputs stay frozen.
    function _localGenesisSpec(address platform) internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = abi.decode(vm.parseJsonBytes(vm.readFile("test/vectors/box-spec/box-spec-v1.json"),
            ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
        s.marketplaceOwner = platform; s.openAt = 0;
        s.coverSha256 = LocalBoxArt.MISFITS_LOGO;
        s.collectionCoverSha256 = LocalBoxArt.MISFITS_COVER;
        // The frozen vector already commits the real banner through collection-metadata (add-on 6).
    }
}
