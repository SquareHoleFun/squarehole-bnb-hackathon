// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {BoxReceiverV2} from "../../../src/box-v2/BoxReceiverV2.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {BoxSpec, BoxType, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {CoordinatorV2Config, BoxCoordinatorV2Args} from "../../../src/box-v2/libraries/BoxCoordinatorV2Args.sol";
import {M2SeamArgs} from "../../../src/box-v2/libraries/M2SeamArgs.sol";
import {PricingToken} from "../../../src/box-v2/libraries/PricingToken.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {FailureHook} from "../m1-31/FailureShells.sol";

/// TEST ONLY. Strict ABI witness, deliberately not an NFT vault or an economic implementation.
/// No fallback, collectionSize, NFT receiver, shop pricing, tickets, item ledger or reveal functions.
contract MinimalSetVault {
    address public immutable coordinator;
    address public immutable loader;
    address public immutable collection;
    uint256 public immutable count;
    uint256 public loaded;
    bool public initialized;
    bool public opened;
    bool public failed;
    bool public rejectFailure;
    uint256 public supplyFloor;
    uint256 public excluded;
    mapping(uint256 => bool) public listed;

    constructor(address c, address l, address nft, uint256 n) {
        coordinator = c;
        loader = l;
        collection = nft;
        count = n;
    }

    function initialize() external {
        require(msg.sender == coordinator && !initialized);
        initialized = true;
    }

    function loadStarter(address nft, uint256 id, uint8 tier) external {
        require(msg.sender == loader && initialized && !failed);
        require(nft == collection && tier == 0 && !listed[id]);
        listed[id] = true;
        ++loaded;
    }

    function seedReady() external view returns (bool) {
        return initialized && !failed && loaded == count;
    }

    function openGate() external {
        require(msg.sender == coordinator && loaded == count && !failed && !opened);
        opened = true;
    }

    function enterFailure() external {
        require(msg.sender == coordinator && !rejectFailure && !failed);
        failed = true;
    }

    function escrowSurplus() external view returns (uint256, uint256) {
        require(failed);
        return (excluded, 0);
    }

    // Test controls: exercise the generic K branch without pretending pre-graduation picks are offered.
    function setFailureProbe(uint256 k, uint256 floor, bool reject) external {
        excluded = k;
        supplyFloor = floor;
        rejectFailure = reject;
    }

    function pull(BoxTokenV2 t, address from, uint256 amount) external {
        require(t.transferFrom(from, address(this), amount));
    }
}

/// Strict hook boundary: real failure settlement in the shared test double, no pool swaps simulated.
contract SetReuseHook is FailureHook {
    uint256 public openAt;
    bool public rejectOpen;
    constructor(IPoolManager pm, address c, address r, address t) FailureHook(pm, c, r, t, address(0)) {}

    function initialize() external view {
        require(msg.sender == coordinator);
    }

    function launch() external view {
        require(msg.sender == coordinator);
    }

    function setOpen(uint256 at) external {
        require(msg.sender == coordinator && !rejectOpen, "open refused");
        openAt = at;
    }

    function setRejectOpen(bool on) external {
        rejectOpen = on;
    }

    function harvest() external view returns (uint256, uint256, uint256) {
        require(msg.sender == receiver);
        return (0, 0, 0);
    }

    function poolId() external pure returns (bytes32) {
        return keccak256("existing-nfts-test-pool");
    }
}

contract SetReuseRouter {
    uint256 public openAt;
    function initialize() external {}

    function bootstrap() external payable returns (uint256) {
        return 0;
    }

    function setOpen(uint256 at) external {
        openAt = at;
    }

    function sweep() external pure returns (uint256) {
        return 0;
    }
}

abstract contract ReuseFixture is Test {
    IPoolManager internal pm;
    BoxCoordinatorV2 internal box;
    BoxTokenV2 internal token;
    BoxReceiverV2 internal receiver;
    BoxRegistryV2 internal registry;
    BoxFactoryV2Parts internal parts;
    StarterSetLoaderV2 internal loader;
    MinimalSetVault internal vault;
    SetReuseHook internal hook;
    address internal coordinatorImpl;
    address internal receiverImpl;
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant ALICE = address(0xA11CE);
    address internal constant NFT = address(0x721);
    uint256 internal constant COUNT = 33;
    bytes32[] internal hashes;
    bytes internal encodedSpec;

    receive() external payable {}

    // CoordinatorViews requires this factory selector even for a non-pile vault.
    function isPileVault(address) external pure returns (bool) {
        return false;
    }

    function setUp() public virtual {
        vm.warp(1_000_000);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        coordinatorImpl = deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(pm, address(this)));
        registry = new BoxRegistryV2(address(this), new address[](0));
        parts = new BoxFactoryV2Parts();
        receiverImpl = deployCode(
            "BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(pm, coordinatorImpl, address(0xF17), address(0xF18))
        );
        hashes = new bytes32[](COUNT + 1);
        for (uint256 i = COUNT; i != 0;) {
            --i;
            hashes[i] = keccak256(abi.encode(NFT, _id(i), uint8(0), hashes[i + 1]));
        }
        // Opaque new-release spec bytes: the old registry records their hash without validating their schema.
        encodedSpec = abi.encode("existing-nfts-e00-test", NFT, COUNT, hashes[0]);
        CoordinatorV2Config memory c;
        c.creator = CREATOR;
        c.raise = 4.206980085 ether;
        c.deadlineDays = 30;
        c.registry = address(registry);
        c.specHash = keccak256(encodedSpec);
        bytes memory nonces = new bytes(24);
        nonces[1] = 0x01;
        nonces[5] = 0x02;
        nonces[6] = 0x03;
        nonces[3] = 0x04;
        nonces[19] = 0x05;
        c.nonces = bytes24(nonces);
        box = BoxCoordinatorV2(BoxClones.create(BoxClones.initCode(coordinatorImpl, BoxCoordinatorV2Args.encode(c))));
        token = BoxTokenV2(vm.computeCreateAddress(address(box), 1));
        receiver = BoxReceiverV2(payable(vm.computeCreateAddress(address(box), 2)));
        vault = MinimalSetVault(vm.computeCreateAddress(address(box), 4));
        loader = StarterSetLoaderV2(vm.computeCreateAddress(address(box), 5));
        _deploy();
        box.launch();
    }

    function _deploy() private {
        bytes memory hookCode = abi.encodePacked(
            type(SetReuseHook).creationCode, abi.encode(pm, address(box), address(receiver), address(token))
        );
        address ha = vm.computeCreate2Address(bytes32(0), keccak256(hookCode), address(box));
        BoxFactoryV2Parts.Box memory b;
        b.roles[0] = address(box);
        b.roles[1] = address(token);
        b.roles[2] = ha;
        b.roles[3] = address(vault);
        b.roles[5] = address(receiver);
        b.roles[6] = vm.computeCreateAddress(address(box), 3);
        b.roles[19] = address(loader);
        b.registry = address(registry);
        b.creator = CREATOR;
        b.q.batchMinQ = 1;
        b.q.swapStepMinQ = 1;
        b.nonces = hex"01050613"; // Reuse encoders only for token, receiver, router and loader.
        BoxSpec memory s;
        s.boxType = uint8(BoxType.EXISTING);
        s.tokenName = "Set test";
        s.tokenSymbol = "SET";
        s.buyers.split = 1;
        s.buyers.a.leg = 1;
        s.buyers.a.dest = 4; // Grow: no creator/holder/item payout branch.
        s.sellers = s.buyers;
        s.addOns = new AddOn[](1);
        s.addOns[0] = AddOn(8, abi.encode(hashes[0], uint32(COUNT)));
        (bytes[] memory args, bytes memory texts) = parts.partArgs(b, s);
        assertEq(texts.length, 0);
        assertEq(args[3], M2SeamArgs.starter(address(box), address(vault), hashes[0], uint32(COUNT)));
        bytes[] memory codes = new bytes[](5);
        codes[0] = BoxClones.initCode(address(new BoxTokenV2(coordinatorImpl)), args[0]);
        codes[1] = BoxClones.initCode(receiverImpl, args[1]);
        codes[2] = type(SetReuseRouter).creationCode;
        codes[3] =
            abi.encodePacked(type(MinimalSetVault).creationCode, abi.encode(address(box), address(loader), NFT, COUNT));
        codes[4] = BoxClones.initCode(address(new StarterSetLoaderV2(coordinatorImpl)), args[3]);
        address deployed =
            box.deploy(codes, hookCode, bytes32(0), 0, [bytes32(0), bytes32(0)], [uint256(0), uint256(0)]);
        assertEq(deployed, ha);
        hook = SetReuseHook(ha);
        assertEq(registry.record(address(box), keccak256("set-template-test"), encodedSpec), 0);
    }

    function _id(uint256 index) internal pure returns (uint256) {
        return index == 0 ? type(uint256).max : index * 101; // No consecutive-id or id+1 assumption.
    }

    function _page(uint256 start, uint256 n) internal {
        address[] memory collections = new address[](n);
        uint256[] memory ids = new uint256[](n);
        uint8[] memory tiers = new uint8[](n);
        for (uint256 i; i < n; ++i) {
            collections[i] = NFT;
            ids[i] = _id(start + i);
        }
        vm.prank(CREATOR);
        loader.load(collections, ids, tiers, hashes[start + n]);
    }

    function _loadAll() internal {
        _page(0, 32);
        _page(32, 1);
    }

    function _give(address to, uint256 amount) internal {
        vm.prank(address(box));
        token.transfer(to, amount);
    }

    function _fund(address to, uint256 amount) internal {
        vm.deal(address(this), amount);
        pm.unlock(abi.encode(to, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        PricingToken.settle(pm, address(0), amount);
        pm.mint(to, 0, amount);
        return "";
    }
}
