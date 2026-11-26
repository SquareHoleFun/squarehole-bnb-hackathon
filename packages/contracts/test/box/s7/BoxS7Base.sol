// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxFactoryV1Planner} from "../../../src/box/BoxFactoryV1Planner.sol";
import {BoxRegistry} from "../../../src/box/BoxRegistry.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {FitBuybackExecutor} from "../../../src/box/FitBuybackExecutor.sol";
import {IBoxFactoryV1} from "../../../src/box/interfaces/IBoxFactoryV1.sol";
import {CoreV1Deployment} from "../../../script/lib/CoreV1Deployment.sol";
import {PinnedBackedSource} from "../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../randomness/utils/PinnedDrandSource.sol";
import {MockWETH} from "../s45/BoxS45Mocks.sol";

/// @notice TEST ONLY: mints ERC-6909 ETH claims on the PoolManager to any address (BC-011's dust at predicted
/// addresses: anyone can do this before a box exists).
contract ClaimsDuster is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function dust(address to, uint256 amount) external payable {
        pm.unlock(abi.encode(to, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "only pm");
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.mint(to, 0, amount);
        pm.settle{value: amount}();
        return "";
    }
}

/// @title BoxS7Base
/// @notice TEST ONLY. The S7 tests' world: chain id 1 (the DrandSource pin), the PoolManager from the pinned source,
/// WETH, and core v1 deployed by `CoreV1Deployment` (the steps `script/DeployCoreV1.s.sol` sends) with this contract as
/// box 0's creator and the platform Safe of the spec. Box 0's spec is the fixture (vector 0 of the shared BoxSpec
/// vectors) as it is: since the S7 × S8 integration factory v1 creates box 0 with its per-item stream (tStream
/// PER_ITEM_STREAM, add-on 2), so core v1 has no declared gap left.
abstract contract BoxS7Base is Test, CoreV1Deployment {
    string internal constant BOX_SPEC_VECTORS = "test/vectors/box-spec/box-spec-v1.json";
    address internal constant SAFE = BoxSpecV1.PLATFORM_SAFE_MAINNET;

    IPoolManager internal pm;
    MockWETH internal weth;
    CoreV1Version internal version;
    BoxFactoryV1 internal factory;
    BoxRegistry internal registry;
    BoxFactoryV1Planner internal planner;
    /// @dev Box 0's fixture, ABI-encoded, read once (the vectors file is 1.4 MB).
    bytes internal _fixtureEncoded;

    function setUp() public virtual {
        _fixtureEncoded = vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]");
        _world();
        version = _deployCoreV1(_config());
        factory = BoxFactoryV1(version.factory);
        registry = BoxRegistry(version.registry);
        planner = BoxFactoryV1Planner(version.planner);
    }

    function _world() internal {
        vm.chainId(1);
        vm.roll(100);
        vm.warp(1_800_000_000);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(makeAddr("s7.pmOwner"))));
        weth = new MockWETH();
    }

    function _config() internal view returns (CoreV1Config memory) {
        // Foundry counts each call the test contract makes at the top level as a transaction of its own (its nonce rises),
        // so here the source's deployment call uses a nonce, as a wallet's does in the script.
        return CoreV1Config({
            deployer: address(this),
            callsTakeNonce: true,
            poolManager: pm,
            weth: address(weth),
            platformSafe: SAFE,
            box0Creator: address(this)
        });
    }

    /// @dev The source through the canonical CREATE2 deployer (its code put in place when the test EVM lacks it).
    function _deployDrandSource(address pinned) internal virtual override {
        require(address(PinnedDrandSource.deploy(vm)) == pinned, "s7: the pinned source");
    }

    /// @dev Box 0's source through the canonical CREATE2 deployer (F143), the same way.
    function _deployBackedSource(address pinned) internal virtual override {
        require(address(PinnedBackedSource.deploy(vm)) == pinned, "s7: the pinned backed source");
    }

    /// @dev Box 0's fixture as the repository has it (tStream PER_ITEM_STREAM, add-on 2).
    function _fixture() internal view returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(_fixtureEncoded, (BoxSpecV1.BoxSpec));
    }

    /// @dev Box 0's spec as the core harness checks it: the fixture as it is (no declared gap since S8).
    function _box0Spec() internal view returns (BoxSpecV1.BoxSpec memory) {
        return _fixture();
    }

    /// @dev The fixture without its per-item stream (tStream BURN_T, add-on 2 dropped): core v1's former S8 gap, which
    /// template 0 no longer accepts.
    function _withoutStream() internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = _fixture();
        s.tStream = BoxSpecV1.T_STREAM_BURN_T;
        _dropAddOn(s, BoxSpecV1.ADD_ON_PER_ITEM_STREAM);
    }

    function _dropAddOn(BoxSpecV1.BoxSpec memory s, uint16 id) internal pure {
        uint256 kept;
        BoxSpecV1.AddOn[] memory addOns = new BoxSpecV1.AddOn[](s.addOns.length);
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id != id) addOns[kept++] = s.addOns[i];
        }
        assembly ("memory-safe") {
            mstore(addOns, kept)
        }
        s.addOns = addOns;
    }

    /// @dev The params of the spec's first add-on `id` (empty without it).
    function _addOnParams(BoxSpecV1.BoxSpec memory s, uint16 id) internal pure returns (bytes memory) {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id) return s.addOns[i].params;
        }
        return "";
    }

    function _setAddOnParams(BoxSpecV1.BoxSpec memory s, uint16 id, bytes memory params) internal pure {
        for (uint256 i; i < s.addOns.length; ++i) {
            if (s.addOns[i].id == id) {
                s.addOns[i].params = params;
                return;
            }
        }
        revert("s7: no such add-on");
    }

    function _copy(BoxSpecV1.BoxSpec memory s) internal pure returns (BoxSpecV1.BoxSpec memory) {
        return abi.decode(abi.encode(s), (BoxSpecV1.BoxSpec));
    }

    function _executorCode() internal pure returns (bytes memory) {
        return type(FitBuybackExecutor).creationCode;
    }

    function _salt(BoxSpecV1.BoxSpec memory s) internal view returns (bytes32) {
        return _mineHookSalt(factory.box0Addresses().coordinator, factory.hookInitCodeHash(s.openAt));
    }

    /// @dev createBox as the box-0 creator with a mined salt and the bootstrap.
    function _create(BoxSpecV1.BoxSpec memory s) internal returns (uint256 boxId, address coordinator, address hook) {
        bytes32 salt = _salt(s);
        vm.deal(address(this), address(this).balance + BoxSpecV1.BOOTSTRAP_ETH);
        return factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, salt, _executorCode());
    }

    /// @dev `refusal` gives exactly `err`, and createBox reverts with it (the salt and value are valid, so the refusal is
    /// the spec's or the caller's).
    function _assertRefused(BoxSpecV1.BoxSpec memory s, bytes memory err) internal {
        assertEq(factory.refusal(s, address(this)), err, "refusal()");
        vm.deal(address(this), address(this).balance + BoxSpecV1.BOOTSTRAP_ETH);
        vm.expectRevert(err);
        // The spec's and the caller's checks come first: the salt is never reached.
        factory.createBox{value: BoxSpecV1.BOOTSTRAP_ETH}(s, bytes32(0), _executorCode());
    }

    function _invalid(uint16 reason, uint16 field) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IBoxFactoryV1.InvalidSpec.selector, reason, field);
    }

    function _notTemplate0(uint16 field) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IBoxFactoryV1.NotTemplate0.selector, field);
    }

    /// @dev Nothing of box 0 exists: no code at any address the factory fixed, no record, the factory's nonce where its
    /// constructor left it, no pool.
    function _assertNothingCreated() internal view {
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        address[11] memory list = [
            a.coordinator,
            a.table,
            a.token,
            a.vault,
            a.collection,
            a.receiver,
            a.launchRouter,
            a.executor,
            a.tickets,
            a.itemStream,
            a.royaltyRouter
        ];
        for (uint256 i; i < list.length; ++i) {
            assertEq(list[i].code.length, 0, "nothing created");
        }
        assertEq(registry.boxCount(), 0, "no record");
        assertEq(vm.getNonce(address(factory)), 2, "the factory created only its registry");
    }

    receive() external payable {}
}
