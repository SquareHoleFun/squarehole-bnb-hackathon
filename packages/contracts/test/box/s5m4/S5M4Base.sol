// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxHook} from "../../../src/box/BoxHook.sol";
import {BoxReceiver} from "../../../src/box/BoxReceiver.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {ClaimsFunder} from "../../utils/ClaimsFunder.sol";
import {BoxDrandVectors} from "../randomness/utils/BoxDrandVectors.sol";
import {CoreBoxAddresses, CoreImpls} from "../conformance/core/CoreBox0Kit.sol";
import {S5M4Kit} from "./S5M4Kit.sol";
import {OpenTime} from "../utils/OpenTime.sol";

/// @notice TEST ONLY: one CREATE or CREATE2 in its own call frame, so a test that measures it from its own frame counts
/// the new account's state gas under Glamsterdam (SH-S0-spikes § 2.4: a CREATE the measuring frame makes itself is not
/// fully counted there).
contract S5M4Creator {
    function create2(bytes memory code, bytes32 salt) external returns (address a) {
        assembly ("memory-safe") {
            a := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(a != address(0), "create2");
    }

    function create(bytes memory code) external returns (address a) {
        assembly ("memory-safe") {
            a := create(0, add(code, 0x20), mload(code))
        }
        require(a != address(0), "create");
    }
}

/// @title S5M4Base
/// @notice TEST ONLY (slice S5.M4). The world every S5.M4 suite starts from: core v1 deployed by `CoreV1Deployment`,
/// box 0 created by factory v1 from its fixture (with its per-item stream), and Standard boxes beside it on the same
/// version (`S5M4Kit`): `D`, the default box (BUYBACK_BURN_T, BURN_T: the module's BuyBurn and W4's SellForFit), and
/// `C`, a creator box (CREATOR_IN_T, CREATOR_IN_Q, payee carol, add-on 5 at the 32 ETH preset with a BURN excess: the
/// module's BuyForCreator, SellForCreator and SellForFit). The clock starts a day before the first local drand round of
/// the committed vectors, so box 0's graduation word and draws can use real quicknet rounds.
abstract contract S5M4Base is BoxDrandVectors {
    using StateLibrary for IPoolManager;

    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";
    uint128 internal constant CREATOR_CAP = 32 ether;

    S5M4Kit internal k;
    CoreBoxAddresses internal a;
    CoreImpls internal impls;
    IPoolManager internal pm;
    IDrandSource internal src;
    ClaimsFunder internal funder;
    S5M4Creator internal creator;
    uint256 internal r0;
    uint256 internal constant D = 0;
    uint256 internal constant C = 1;

    address internal alice = makeAddr("s5m4.alice");
    address internal bob = makeAddr("s5m4.bob");
    address internal carol = makeAddr("s5m4.carol");
    address internal dave = makeAddr("s5m4.dave");
    address internal keeper = makeAddr("s5m4.keeper");

    /// @dev The local world (chain id 1, the PoolManager from the pinned source).
    function _setUpLocal() internal {
        _loadBoxDrand();
        r0 = _localFirst();
        // The test kit embeds a whole version. Exclude only its code deposit from the harness
        // budget (200 gas/byte before Amsterdam, 1,530 after); all production setup stays metered.
        vm.pauseGasMetering();
        k = new S5M4Kit();
        vm.resumeGasMetering();
        k.setUpWorld();
        _afterWorld();
    }

    /// @dev On a fork: the chain's own PoolManager and WETH.
    function _setUpOn(IPoolManager pm_, address weth_) internal {
        _loadBoxDrand();
        r0 = _localFirst();
        // The test kit embeds a whole version. Exclude only its code deposit from the harness
        // budget (200 gas/byte before Amsterdam, 1,530 after); all production setup stays metered.
        vm.pauseGasMetering();
        k = new S5M4Kit();
        vm.resumeGasMetering();
        k.setUpWorldOn(pm_, weth_);
        _afterWorld();
    }

    function _afterWorld() internal {
        pm = k.pm();
        // Rounds are posted on the DrandSource; box 0 reads them through its BoxBackedSource (F143).
        src = IDrandSource(address(k.drand()));
        funder = new ClaimsFunder(pm);
        creator = new S5M4Creator();
        k.prepare(_fixture());
        a = k.addresses();
        impls = k.impls();
        k.deployStandardImpls();
    }

    function _fixture() internal view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]"), (BoxSpecV1.BoxSpec));
    }

    /// @dev Box 0 (createBox), then D and C (the kit), all launched.
    function _createAll() internal {
        // Box 0 opening an hour (300 slots) after its creation: the timeline these tests were written for (the fixture's
        // old openDelayBlocks 300; the fixture is Now since open-at-clock-time.md). Prepared again here, at the
        // creation's time, because setUp moves the clock after the world is built (the hook's salt follows openAt).
        BoxSpecV1.BoxSpec memory s = k.spec();
        s.openAt = OpenTime.inBlocks(300);
        k.prepare(s);
        a = k.addresses();
        k.create();
        k.buildStandard(_defaultParams());
        k.buildStandard(_creatorParams());
    }

    function _defaultParams() internal pure returns (S5M4Kit.StdParams memory) {
        return S5M4Kit.StdParams({
            qStream: BoxSpecV1.Q_STREAM_BUYBACK_BURN_T,
            tStream: BoxSpecV1.T_STREAM_BURN_T,
            payee: address(0),
            creatorCap: 0,
            capExcess: 0,
            n: 69,
            royalties: true
        });
    }

    function _creatorParams() internal view returns (S5M4Kit.StdParams memory) {
        return S5M4Kit.StdParams({
            qStream: BoxSpecV1.Q_STREAM_CREATOR_IN_T,
            tStream: BoxSpecV1.T_STREAM_CREATOR_IN_Q,
            payee: carol,
            creatorCap: CREATOR_CAP,
            capExcess: BoxSpecV1.CAP_EXCESS_BURN,
            n: 69,
            royalties: true
        });
    }

    // ------------------------------------------------------------------------------------------------ reads

    function _std(uint256 i) internal view returns (S5M4Kit.StdBox memory) {
        return k.std(i);
    }

    function _module(uint256 i) internal view returns (BoxSwapModule) {
        return BoxSwapModule(k.std(i).module);
    }

    function _claims(address owner, address asset) internal view returns (uint256) {
        return pm.balanceOf(owner, uint256(uint160(asset)));
    }

    function _sqrtP(PoolKey memory key) internal view returns (uint160 s) {
        (s,,,) = pm.getSlot0(key.toId());
    }

    function _tick(PoolKey memory key) internal view returns (int24) {
        return TickMath.getTickAtSqrtPrice(_sqrtP(key));
    }

    // ------------------------------------------------------------------------------------------------ life

    /// @dev Box 0 to graduation through the kit's phase drivers (a taxed window buy, the curve, a batch, the close,
    /// `graduate()` by the keeper, a buy and a sell after, a batch, the reward claimed, the tax swept, a royalty), then
    /// its FIT executor's average made ready (an hour of samples), so FIT is "graduated" for every other box.
    function _box0Graduated() internal {
        k.toGraduated();
        k.box0Hold(301);
    }

    /// @dev One taxed launch-router buy of 0.02 ETH in Standard box `i`'s window (its tax, swept after graduation,
    /// becomes Q-only depth: F76's conversions).
    function _stdWindowBuy(uint256 i) internal {
        S5M4Kit.StdBox memory x = _std(i);
        uint256 open = BoxHook(x.hook).openAt() + 12;
        if (block.timestamp < open) k.roll((open - block.timestamp + 11) / 12);
        vm.deal(dave, dave.balance + 0.02 ether);
        vm.prank(dave);
        (bool ok,) = x.launchRouter.call{value: 0.02 ether}(
            abi.encodeWithSignature("buy(uint256,uint256,address,uint256)", 0.02 ether, 1, dave, block.timestamp)
        );
        require(ok, "a window buy");
    }

    /// @dev A Standard box to graduation (`S5M4Kit.stdToGraduated`): the curve, a batch, the close, `graduate()`, the
    /// sampler's first poke and an hour of samples (its average ready).
    function _stdGraduated(uint256 i) internal {
        k.stdToGraduated(i);
    }

    /// @dev Round trips on a pool (a buy of `q` ETH, then the T it bought sold back, in a block each): fees on both
    /// sides, the price back near where it was.
    function _trade(PoolKey memory key, address token, uint256 q, uint256 rounds) internal {
        for (uint256 r; r < rounds; ++r) {
            k.roll(1);
            uint256 t = k.swapOn(key, token, dave, true, q, 0);
            k.roll(1);
            k.swapOn(key, token, dave, false, t, 0);
        }
    }

    /// @dev Q fees through a Standard box's ETH intake (split like a batch, no tip).
    function _fundFees(address receiver, uint256 q) internal {
        vm.deal(address(this), address(this).balance + q);
        BoxReceiver(payable(receiver)).fundFees{value: q}();
    }

    /// @dev The box's average poked every block for `blocks` blocks (box 0: FIT's executor; others: the sampler).
    function _hold(address average, uint256 blocks) internal {
        for (uint256 i; i < blocks; ++i) {
            k.roll(1);
            IBoxPriceAverage(average).poke();
        }
    }

    receive() external payable {}
}
