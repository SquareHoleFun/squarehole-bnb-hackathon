// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IRewardLedger} from "../../src/interfaces/IRewardLedger.sol";
import {SquareHoleLauncher} from "../../src/SquareHoleLauncher.sol";
import {SquareHoleRegistry} from "../../src/SquareHoleRegistry.sol";
import {DeploySquareHole, SquareHoleSystemDeployer} from "../../script/DeploySquareHole.s.sol";
import {MockERC20} from "../utils/MockTokens.sol";

/// @notice The Stage C deployment script, executed in-process (recorded broadcasts only; nothing is sent anywhere):
/// the nonce plan holds, the hook lands at a mined address through the canonical CREATE2 deployer, and the deployed
/// system launches a pair.
contract DeploySquareHoleTest is Test {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function test_deployScript_wiresTheSystemAndLaunches() public {
        if (CREATE2_DEPLOYER.code.length == 0) {
            // Arachnid's deterministic deployment proxy (the same code on Sepolia and mainnet).
            vm.etch(
                CREATE2_DEPLOYER,
                hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3"
            );
        }
        address deployer = makeAddr("deployer");
        address admin = makeAddr("admin");
        address treasury = makeAddr("treasury");
        IPoolManager pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(deployer)));
        DeploySquareHole script = new DeploySquareHole();
        SquareHoleSystemDeployer.Deployment memory d = script.deploy(
            SquareHoleSystemDeployer.Params({poolManager: pm, admin: admin, treasury: treasury, withConverter: true}),
            deployer
        );

        assertEq(vm.getNonce(deployer), 7, "seven transactions from the deployer");
        assertEq(uint160(address(d.hook)) & 0x3FFF, 0x2A60);
        assertEq(d.hook.launcher(), address(d.launcher));
        assertEq(d.registry.launcher(), address(d.launcher));
        assertEq(d.registry.admin(), admin);
        assertEq(d.launcher.treasury(), treasury);
        assertEq(d.launcher.converter(), address(d.converter));
        assertEq(address(d.converter.registry()), address(d.registry));
        assertGt(d.hookMiningIterations, 0);

        MockERC20 weth = new MockERC20("Wrapped Ether (test)", "WETH");
        vm.prank(admin);
        uint32 v = d.registry.addTemplate(address(weth), 1e18, 1e14, 60, 69_060);
        vm.prank(makeAddr("creator"));
        (bytes32 pairId, address token) = d.launcher
            .createLaunch(
                SquareHoleLauncher.LaunchParams({
                    kind: SquareHoleRegistry.AssetKind.Collection,
                    name: "The Misfits (test)",
                    symbol: "MISFIT",
                    units: 1_000,
                    fractionsPerNft: 0, // F10: derived, 1e9 / 1,000 = 1,000,000 tokens per NFT
                    templateVersion: v,
                    payoutAsset: IRewardLedger.PayoutAsset.T,
                    baseURI: "ipfs://misfits/",
                    metadataManifestHash: keccak256("manifest")
                })
            );
        assertEq(d.registry.pair(pairId).token, token);
        assertEq(d.registry.pair(pairId).converter, address(d.converter));
        assertEq(d.registry.pair(pairId).fractionsPerNft, 1e6);
        assertEq(d.registry.pair(pairId).initialSupply, 1e27);
    }

    /// Review round A: outside the local chain the script never falls back to the broadcaster for the registry admin
    /// or the treasury (it stops before any broadcast when SH_ADMIN / SH_TREASURY are missing).
    function test_run_requiresExplicitAdminAndTreasuryOffTheLocalChain() public {
        if (vm.envOr("SH_ADMIN", address(0)) != address(0) || vm.envOr("SH_TREASURY", address(0)) != address(0)) {
            vm.skip(true); // the developer's environment already sets them
        }
        address pm = deployCode("PoolManager.sol:PoolManager", abi.encode(makeAddr("owner")));
        vm.setEnv("SH_POOL_MANAGER", vm.toString(pm));
        vm.chainId(11_155_111);
        DeploySquareHole script = new DeploySquareHole();
        try script.run() {
            fail("must not deploy without SH_ADMIN");
        } catch (bytes memory reason) {
            assertTrue(_contains(string(reason), "SH_ADMIN"), "stopped at the missing SH_ADMIN");
        }
        assertEq(vm.getNonce(address(script)), 1, "nothing deployed or broadcast");
    }

    function _contains(string memory haystack, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        for (uint256 i; i + n.length <= h.length; ++i) {
            bool ok = true;
            for (uint256 j; j < n.length && ok; ++j) {
                ok = h[i + j] == n[j];
            }
            if (ok) return true;
        }
        return false;
    }

    function test_mineHookSalt_isDeterministic() public {
        DeploySquareHole script = new DeploySquareHole();
        (bytes32 a, uint256 i) = script.mineHookSalt(keccak256("init"));
        (bytes32 b, uint256 j) = script.mineHookSalt(keccak256("init"));
        assertEq(a, b);
        assertEq(i, j);
        address hookAddr = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, a, keccak256("init")))))
        );
        assertEq(uint160(hookAddr) & 0x3FFF, 0x2A60);
    }
}
