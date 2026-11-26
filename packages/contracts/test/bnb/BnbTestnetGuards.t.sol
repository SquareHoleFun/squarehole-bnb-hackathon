// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {TestFrog, TestGold, TestLINK, TestNVDA, TestPEPE, TestUSDC} from "../../src/test-coins/TestCoins.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TestETH} from "../../src/test-coins/TestETH.sol";
import {TestPairLiquidity} from "../../src/test-coins/TestPairLiquidity.sol";
import {TestPoolLiquidity} from "../../src/test-coins/TestPoolLiquidity.sol";
import {BnbTestnet, BnbTestnetCustody} from "../../script/bnb/BnbTestnet.sol";
import {BnbTestnetGenesis} from "../../script/bnb/BnbTestnetGenesis.s.sol";
import {DeployCoreV2Bnb} from "../../script/bnb/DeployCoreV2Bnb.s.sol";
import {BnbTestnetSetup} from "../../script/bnb/BnbTestnetSetup.s.sol";
import {DeployCoreV2} from "../../script/DeployCoreV2.s.sol";
import {LocalTwin} from "../../script/local/LocalTwin.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {Math} from "v4-core/lib/openzeppelin-contracts/contracts/utils/math/Math.sol";

/// @notice SH-260: the test coins and their pool helpers deploy on BNB Chain testnet (97) as on Sepolia and the local
/// chain, and still nowhere else; the chain-97 scripts and holding contract refuse every other chain.
/// @notice Exposes the setup script's pool prices to the test.
contract BnbTestnetSetupPrices is BnbTestnetSetup {
    function prices() external pure returns (uint160 nvda, uint160 gold) {
        return (NVDA_PER_BNB_SQRT_X96, GOLD_PER_BNB_SQRT_X96);
    }
}

/// @notice The setup script as a node that is not anvil answers it (pins the box proofs' refusal at their call site).
contract BnbTestnetSetupOnGeth is BnbTestnetSetup {
    function _client() internal pure override returns (string memory) { return "Geth/v1.8.1"; }
}

/// @notice The two local guards the inherited release entry points call first.
contract LocalTwinProbe {
    function alpha(uint256 chainId) external pure { LocalTwin.checkAlpha(chainId, "anvil/v1.8.3"); }
    function twin(uint256 chainId) external pure { LocalTwin.check(chainId, "anvil/v1.8.3"); }
}

contract BnbTestnetGuardsTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256[5] internal refused = [uint256(1), 56, 204, 5611, 424242];
    uint256[3] internal allowed = [uint256(97), 11_155_111, 31337];
    IPoolManager internal pm;

    function setUp() public {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
    }

    function test_coinsDeployOnBnbTestnetSepoliaAndLocal() public {
        for (uint256 i; i < allowed.length; ++i) {
            vm.chainId(allowed[i]);
            TestUSDC usdc = new TestUSDC(address(this), 1_000e6);
            TestNVDA nvda = new TestNVDA(address(this), 1 ether);
            TestGold gold = new TestGold(address(this), 1 ether);
            TestPEPE pepe = new TestPEPE(address(this), 1 ether);
            TestETH teth = new TestETH(address(this));
            assertEq(new TestLINK(address(this), 1 ether).symbol(), "tLINK");
            assertEq(new TestFrog(address(this), 1 ether).symbol(), "tFROG");
            assertEq(usdc.decimals(), 6);
            assertEq(nvda.decimals(), 18);
            assertEq(nvda.symbol(), "tNVDA");
            assertEq(gold.balanceOf(address(this)), 1 ether);
            assertEq(pepe.totalSupply(), 1 ether);
            assertEq(teth.totalSupply(), 1_000_000e18);
        }
    }

    function test_coinsRefuseEveryOtherChain() public {
        for (uint256 i; i < refused.length; ++i) {
            vm.chainId(refused[i]);
            vm.expectRevert("testnet only");
            new TestUSDC(address(this), 1_000e6);
            vm.expectRevert("testnet only");
            new TestNVDA(address(this), 1 ether);
            vm.expectRevert("testnet only");
            new TestGold(address(this), 1 ether);
            vm.expectRevert("testnet only");
            new TestPEPE(address(this), 1 ether);
            vm.expectRevert("testnet only");
            new TestLINK(address(this), 1 ether);
            vm.expectRevert("testnet only");
            new TestFrog(address(this), 1 ether);
            vm.expectRevert("testnet only");
            new TestETH(address(this));
        }
    }

    /// @notice On 97 the helpers take the profile's own PoolManager (no pinned manager there); Sepolia keeps its pin.
    function test_poolHelpersTakeAnyManagerOnBnbTestnet() public {
        vm.chainId(97);
        TestPoolLiquidity pools = new TestPoolLiquidity(pm, address(this));
        TestPairLiquidity pairs = new TestPairLiquidity(pm, address(this));
        assertEq(address(pools.manager()), address(pm));
        assertEq(address(pairs.manager()), address(pm));
        vm.chainId(11_155_111);
        vm.expectRevert("Sepolia manager");
        new TestPoolLiquidity(pm, address(this));
        vm.expectRevert("Sepolia manager");
        new TestPairLiquidity(pm, address(this));
    }

    function test_poolHelpersRefuseEveryOtherChain() public {
        for (uint256 i; i < refused.length; ++i) {
            vm.chainId(refused[i]);
            vm.expectRevert("testnet only");
            new TestPoolLiquidity(pm, address(this));
            vm.expectRevert("testnet only");
            new TestPairLiquidity(pm, address(this));
        }
    }

    function test_custodyOnlyOnBnbTestnetAndOnlyItsOwnerCalls() public {
        address[] memory owners = new address[](1);
        owners[0] = address(this);
        vm.chainId(97);
        BnbTestnetCustody custody = new BnbTestnetCustody(owners);
        assertEq(custody.getOwners()[0], address(this));
        assertEq(custody.getThreshold(), 1);
        TestNVDA nvda = new TestNVDA(address(custody), 1 ether);
        custody.execute(address(nvda), 0, abi.encodeCall(nvda.transfer, (address(0xBEEF), 1)));
        assertEq(nvda.balanceOf(address(0xBEEF)), 1);
        vm.prank(address(0xBAD));
        vm.expectRevert("local owner only");
        custody.execute(address(nvda), 0, abi.encodeCall(nvda.transfer, (address(0xBAD), 1)));
        vm.expectRevert();
        custody.execute(address(nvda), 0, abi.encodeCall(nvda.transfer, (address(0xBEEF), 2 ether)));
        address[] memory two = new address[](2);
        two[0] = address(this);
        two[1] = address(0xB0B);
        vm.expectRevert("one owner");
        new BnbTestnetCustody(two);
        for (uint256 i; i < 3; ++i) {
            uint256 id = i == 0 ? 31337 : i == 1 ? 11_155_111 : 56;
            vm.chainId(id);
            vm.expectRevert(abi.encodeWithSelector(BnbTestnet.NotBnbTestnet.selector, id));
            new BnbTestnetCustody(owners);
        }
    }

    function test_scriptsRefuseEveryChainButBnbTestnet() public {
        BnbTestnetGenesis genesis = new BnbTestnetGenesis();
        DeployCoreV2Bnb release = new DeployCoreV2Bnb();
        BnbTestnetSetup setup = new BnbTestnetSetup();
        BnbTestnetSetup.Coins memory k;
        BnbTestnetSetup.Raises memory r;
        BnbTestnetSetup.Helpers memory h;
        uint256[3] memory ids = [uint256(31337), 11_155_111, 56];
        for (uint256 i; i < ids.length; ++i) {
            vm.chainId(ids[i]);
            bytes memory refusal = abi.encodeWithSelector(BnbTestnet.NotBnbTestnet.selector, ids[i]);
            vm.expectRevert(refusal);
            genesis.run();
            vm.expectRevert(refusal);
            release.run(address(pm), address(1), address(2), address(3), address(4));
            vm.expectRevert(refusal);
            setup.runCoins();
            vm.expectRevert(refusal);
            setup.runRoutes(address(1), k, address(2), 7, new address[](0));
            vm.expectRevert(refusal);
            setup.runListings(address(1), k, r);
            vm.expectRevert(refusal);
            setup.runHelpers(address(pm), h);
            vm.expectRevert(refusal);
            setup.runPools(h, k, 1, 1);
            vm.expectRevert(refusal);
            setup.runFaucet(address(1));
            vm.expectRevert(refusal);
            setup.runBox(address(1), address(2), 0);
            vm.expectRevert(refusal);
            setup.runTrade(address(1), address(2));
        }
    }

    /// @notice The release script inherits the local and production entry points (`runAlpha`, `runLocal`, `run()`).
    /// On chain 97: `run()` stops at the production chain check (chains 1 and 11155111 only); `runAlpha` and `runLocal`
    /// first ask the node for its client and then call LocalTwin's guards, which refuse 97 (pinned on the guards
    /// themselves, since a test has no node to answer).
    function test_inheritedReleaseEntryPointsRefuseBnbTestnet() public {
        DeployCoreV2Bnb release = new DeployCoreV2Bnb();
        vm.chainId(97);
        vm.expectRevert(DeployCoreV2.BadReleaseInput.selector);
        release.run();
        LocalTwinProbe probe = new LocalTwinProbe();
        vm.expectRevert(abi.encodeWithSelector(LocalTwin.NotLocalTwin.selector, 97));
        probe.alpha(97);
        vm.expectRevert(abi.encodeWithSelector(LocalTwin.NotLocalTwin.selector, 97));
        probe.twin(97);
        vm.expectRevert();
        release.runAlpha(address(pm), address(1), address(2), address(3), address(4));
        vm.expectRevert();
        release.runLocal(address(1), address(2));
    }

    /// @notice The box and trade proofs are rehearsal-only: on 97 a node that is not anvil gets NotAnvil.
    function test_boxProofsNeedAnvil() public {
        BnbTestnetSetup setup = new BnbTestnetSetupOnGeth();
        vm.chainId(97);
        bytes memory refusal = abi.encodeWithSelector(BnbTestnet.NotAnvil.selector, "Geth/v1.8.1");
        vm.expectRevert(refusal);
        setup.runBox(address(1), address(2), 0);
        vm.expectRevert(refusal);
        setup.runTrade(address(1), address(2));
    }

    struct World { BnbTestnetSetupPrices setup; BnbTestnetSetup.Coins k; BnbTestnetSetup.Helpers h; }

    function _world() private returns (World memory w) {
        vm.chainId(97);
        w.setup = new BnbTestnetSetupPrices();
        w.k = BnbTestnetSetup.Coins(address(new TestUSDC(address(this), 1_000_000_000e6)),
            address(new TestNVDA(address(this), 1_000_000 ether)), address(new TestGold(address(this), 1_000_000 ether)),
            address(new TestPEPE(address(this), 1_000_000_000_000 ether)), address(new TestETH(address(this))));
        w.h = BnbTestnetSetup.Helpers(address(new TestPairLiquidity(pm, address(this))),
            address(new TestPoolLiquidity(pm, address(this))));
    }

    function _pairPriceAt(World memory w, address a, address b) private view returns (uint160 price) {
        (price,,,) = pm.getSlot0(TestPairLiquidity(w.h.pairs).key(a, b).toId());
    }

    /// @notice SH-260 review finding 8 and second review 10 and 11, through `runPools` itself: both native pools open
    /// at exactly 2 * 2^96 and 2^95 (4 tNVDA and 0.25 tGOLD per BNB); each of the five pairs at the floor of
    /// sqrt(amount1 / amount0) * 2^96 for its budgets (exact for four of them; tNVDA/tETH rounds down). A second run
    /// adds nothing and no allowance is left.
    function test_runPoolsOpensEveryPoolAtItsStatedPrice() public {
        World memory w = _world();
        (uint160 nvdaPrice, uint160 goldPrice) = w.setup.prices();
        assertEq(uint256(nvdaPrice) * nvdaPrice, 4 << 192);
        assertEq(uint256(goldPrice) * goldPrice * 4, 1 << 192);
        w.setup.runPools(w.h, w.k, 1e14, 10 ether);
        TestPoolLiquidity pools = TestPoolLiquidity(w.h.nativePools);
        (uint160 p0,,,) = pm.getSlot0(pools.key(w.k.nvda).toId());
        (uint160 p1,,,) = pm.getSlot0(pools.key(w.k.gold).toId());
        assertEq(p0, 2 << 96);
        assertEq(p1, 1 << 95);
        address[5] memory a = [w.k.nvda, w.k.teth, w.k.teth, w.k.teth, w.k.teth];
        address[5] memory b = [w.k.usdc, w.k.usdc, w.k.nvda, w.k.gold, w.k.pepe];
        uint256[5] memory amountA = [uint256(10 ether), 1000 ether, 1000 ether, 1000 ether, 200 ether];
        uint256[5] memory amountB = [uint256(10e6), 100_000e6, 100_000 ether, 1000 ether, 200_000_000 ether];
        for (uint256 i; i < 5; ++i) _checkPair(w, a[i], b[i], amountA[i], amountB[i]);
        assertEq(TestNVDA(w.k.nvda).allowance(address(this), w.h.nativePools), 0);
        assertEq(TestGold(w.k.gold).allowance(address(this), w.h.nativePools), 0);
        uint128 before = TestPairLiquidity(w.h.pairs).liquidity(w.k.teth, w.k.usdc);
        uint256 nvdaBefore = TestNVDA(w.k.nvda).balanceOf(address(this));
        w.setup.runPools(w.h, w.k, 1e14, 10 ether);
        assertEq(TestPairLiquidity(w.h.pairs).liquidity(w.k.teth, w.k.usdc), before);
        assertEq(TestNVDA(w.k.nvda).balanceOf(address(this)), nvdaBefore);
    }

    /// @dev The floor of the exact square root of amount1 * 2^192 / amount0 (whether it is exact depends on which coin
    /// sorts first; on the real chain all but tNVDA/tETH are). The helper holds the position and no allowance is left.
    function _checkPair(World memory w, address a, address b, uint256 amountA, uint256 amountB) private view {
        uint160 price = _pairPriceAt(w, a, b);
        assertEq(price, w.setup.pairPrice(a, b, amountA, amountB));
        (uint256 x0, uint256 x1) = a < b ? (amountA, amountB) : (amountB, amountA);
        uint256 target = FullMath.mulDiv(x1, uint256(1) << 192, x0);
        assertEq(price, Math.sqrt(target));
        assertLe(uint256(price) * price, target);
        assertGt(TestPairLiquidity(w.h.pairs).liquidity(a, b), 0);
        assertEq(TestUSDC(a).allowance(address(this), w.h.pairs), 0);
        assertEq(TestUSDC(b).allowance(address(this), w.h.pairs), 0);
    }

    /// @notice A native pool someone else initialized at another price stops the step.
    function test_runPoolsRefusesANativePoolAtAnotherPrice() public {
        World memory w = _world();
        pm.initialize(TestPoolLiquidity(w.h.nativePools).key(w.k.nvda), 1 << 96);
        vm.expectRevert(bytes("native pool at another price"));
        w.setup.runPools(w.h, w.k, 1e14, 10 ether);
    }

    /// @notice A native pool at the right price but without the helper's position stops the step.
    function test_runPoolsRefusesANativePoolWithoutTheHelpersPosition() public {
        World memory w = _world();
        pm.initialize(TestPoolLiquidity(w.h.nativePools).key(w.k.nvda), 2 << 96);
        vm.expectRevert(bytes("native pool initialized without the helper's position"));
        w.setup.runPools(w.h, w.k, 1e14, 10 ether);
    }

    /// @notice A pair at the right price but without the helper's position stops the step.
    function test_runPoolsRefusesAPairWithoutTheHelpersPosition() public {
        World memory w = _world();
        pm.initialize(TestPairLiquidity(w.h.pairs).key(w.k.teth, w.k.gold),
            w.setup.pairPrice(w.k.teth, w.k.gold, 1000 ether, 1000 ether));
        vm.expectRevert(bytes("pair initialized without the helper's position"));
        w.setup.runPools(w.h, w.k, 1e14, 10 ether);
    }

    /// @notice A pair at another price stops the step.
    function test_runPoolsRefusesAPairAtAnotherPrice() public {
        World memory w = _world();
        pm.initialize(TestPairLiquidity(w.h.pairs).key(w.k.teth, w.k.gold), 3 << 96);
        vm.expectRevert(bytes("pair at another price"));
        w.setup.runPools(w.h, w.k, 1e14, 10 ether);
    }

    /// @notice Allowances a stopped attempt left behind are cleared by the run that completes.
    function test_runPoolsClearsLeftoverAllowances() public {
        World memory w = _world();
        TestNVDA(w.k.nvda).approve(w.h.nativePools, 123);
        TestETH(w.k.teth).approve(w.h.pairs, 456);
        w.setup.runPools(w.h, w.k, 1e14, 10 ether);
        assertEq(TestNVDA(w.k.nvda).allowance(address(this), w.h.nativePools), 0);
        assertEq(TestETH(w.k.teth).allowance(address(this), w.h.pairs), 0);
    }

    /// @notice The faucet coin on 97: only its owner opens the public phase; a drip is one tETH; one drip per address
    /// per day; at most 500 tETH a UTC day. The four issued coins have no mint after their one issuance.
    function test_faucetRulesOnBnbTestnet() public {
        vm.chainId(97);
        TestETH teth = new TestETH(address(this));
        vm.prank(address(0xBAD));
        vm.expectRevert(TestETH.NotOwner.selector);
        teth.setOpen(true);
        vm.prank(address(0xBEEF));
        vm.expectRevert(TestETH.NotAdmitted.selector);
        teth.drip();
        teth.setOpen(true);
        assertTrue(teth.open());
        vm.prank(address(0xBEEF));
        teth.drip();
        assertEq(teth.balanceOf(address(0xBEEF)), 1 ether);
        vm.prank(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(TestETH.CooldownActive.selector, block.timestamp + 1 days));
        teth.drip();
        vm.warp(block.timestamp + 1 days);
        vm.prank(address(0xBEEF));
        teth.drip();
        assertEq(teth.balanceOf(address(0xBEEF)), 2 ether);
        vm.warp((block.timestamp / 1 days + 1) * 1 days);
        for (uint160 i = 1; i <= 500; ++i) {
            vm.prank(address(0x10000 + i));
            teth.drip();
        }
        vm.prank(address(0x20000));
        vm.expectRevert(TestETH.DailyCapReached.selector);
        teth.drip();
        address[4] memory issued = [address(new TestUSDC(address(this), 1e6)), address(new TestNVDA(address(this), 1)),
            address(new TestGold(address(this), 1)), address(new TestPEPE(address(this), 1))];
        for (uint256 i; i < 4; ++i) {
            (bool ok,) = issued[i].call(abi.encodeWithSignature("mint(address,uint256)", address(this), 1));
            assertFalse(ok);
            assertEq(TestUSDC(issued[i]).totalSupply(), i == 0 ? 1e6 : 1);
        }
    }

    receive() external payable {}
}
