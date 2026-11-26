// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC721} from "solmate/src/tokens/ERC721.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {BoxTokenV2} from "../../../src/box-v2/BoxTokenV2.sol";
import {BoxRegistryV2} from "../../../src/box-v2/BoxRegistryV2.sol";
import {StarterSetLoaderV2} from "../../../src/box-v2/StarterSetLoaderV2.sol";
import {BoxFactoryV2Parts} from "../../../src/box-v2/BoxFactoryV2Parts.sol";
import {BoxSpec, BoxType, AddOn} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {CoordinatorV2Config, BoxCoordinatorV2Args} from "../../../src/box-v2/libraries/BoxCoordinatorV2Args.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {SetReuseHook, SetReuseRouter} from "./ReuseFixture.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";

// Independent test ABI/packed-argument oracle; the initial red run needs no production vault source.
interface CustodyVault {
    error InvalidRequest();
    error Unauthorized(address caller);
    error ReceiptRefused();
    error TransferRefused();
    error TransferGas();
    event SetLoaded(uint256 indexed index, address indexed collection, uint256 indexed id);
    function initialize() external;
    function loadStarter(address nft, uint256 id, uint8 tier) external;
    function onERC721Received(address operator, address from, uint256 id, bytes calldata data) external returns (bytes4);
    function openGate() external;
    function enterFailure() external;
    function seedReady() external view returns (bool);
    function initialized() external view returns (bool);
    function gateOpen() external view returns (bool);
    function failed() external view returns (bool);
    function coordinator() external view returns (address);
    function coordinatorImplementation() external view returns (address);
    function starterSetLoaderImplementation() external view returns (address);
    function token() external view returns (address);
    function creator() external view returns (address);
    function collection() external view returns (address);
    function starterSetLoader() external view returns (address);
    function collectionSize() external view returns (uint256);
    function setHash() external view returns (bytes32);
    function pickFeeBps() external view returns (uint256);
    function inside() external view returns (uint256);
    function loaded() external view returns (uint256);
    function memberAt(uint256 index) external view returns (uint256);
    function eligible(uint256 id) external view returns (bool);
    function isOutside(uint256 id) external view returns (bool);
    function supplyFloor() external view returns (uint256);
    function escrowPrincipal() external view returns (uint256);
    function escrowSurplus() external view returns (uint256, uint256);
}

contract SetStandardERC721 is ERC721 {
    constructor() ERC721("Standard set", "SET") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        revert("metadata not needed");
    }
}

/// Log-only telemetry avoids adding artificial fresh persistent writes to a standard ERC-721 transfer.
contract SetMeasuredERC721 is SetStandardERC721 {
    event TransferGasMeasured(uint256 entry, uint256 used);

    function safeTransferFrom(address from, address to, uint256 id) public override {
        uint256 entry = gasleft();
        super.safeTransferFrom(from, to, id);
        emit TransferGasMeasured(entry, entry - gasleft());
    }
}

/// Successful but expensive issuer code: consume almost the whole transfer cap after the valid receipt.
contract SetSpendingERC721 is SetStandardERC721 {
    function safeTransferFrom(address from, address to, uint256 id) public override {
        super.safeTransferFrom(from, to, id);
        assembly { for {} gt(gas(), 5000) {} {} }
    }
}

/// Records a caught callback refusal so tests distinguish the shared lock from ordinary caller authentication.
contract SetReentryRecorder {
    bytes4 public refusal;

    function attempt(address target, bytes calldata data) external {
        (bool ok, bytes memory reason) = target.call(data);
        require(!ok && reason.length == 4, "expected guard refusal");
        refusal = bytes4(reason);
    }
}

abstract contract SetVaultFixture is Test {
    address internal constant CREATOR = address(0xC0FFEE);
    address internal constant ALICE = address(0xA11CE);
    IPoolManager internal pm;
    BoxCoordinatorV2 internal box;
    BoxTokenV2 internal token;
    StarterSetLoaderV2 internal loader;
    CustodyVault internal vault;
    SetReuseHook internal hook;
    address internal coordinatorImpl;
    address internal loaderImpl;
    address internal vaultImpl;
    address internal receiverImpl;
    address internal registry;
    address internal collection;
    uint256[] internal ids;
    address[] internal collections;
    uint8[] internal tiers;
    bytes32[] internal hashes;

    function isPileVault(address) external pure returns (bool) {
        return false;
    }

    function setUp() public virtual {
        vm.warp(1_000_000);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        coordinatorImpl = deployCode("BoxCoordinatorV2.sol:BoxCoordinatorV2", abi.encode(pm, address(this)));
        registry = address(new BoxRegistryV2(address(this), new address[](0)));
        loaderImpl = address(new StarterSetLoaderV2(coordinatorImpl));
        vaultImpl = deployCode("SetVaultV2.sol:SetVaultV2", abi.encode(coordinatorImpl, loaderImpl));
        receiverImpl = deployCode(
            "BoxReceiverV2.sol:BoxReceiverV2", ReceiverDeploy.args(pm, coordinatorImpl, address(0xF17), address(0xF18))
        );
    }

    function _standard(uint256 count) internal returns (SetStandardERC721 nft) {
        nft = new SetStandardERC721();
        _configure(address(nft), count);
        for (uint256 i; i < count; ++i) {
            nft.mint(CREATOR, ids[i]);
        }
    }

    function _hostile(uint256 count) internal returns (HostileERC721 nft) {
        nft = new HostileERC721();
        _configure(address(nft), count);
        for (uint256 i; i < count; ++i) {
            nft.mint(CREATOR, ids[i]);
        }
    }

    function _configure(address nft, uint256 count) internal {
        collection = nft;
        ids = new uint256[](count);
        collections = new address[](count);
        tiers = new uint8[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = i == 0 ? 0 : i == 1 ? type(uint256).max : i * 101;
            collections[i] = nft;
        }
    }

    function _deploy(bool launch) internal {
        uint256 count = ids.length;
        hashes = new bytes32[](count + 1);
        for (uint256 i = count; i != 0;) {
            --i;
            hashes[i] = keccak256(abi.encode(collections[i], ids[i], tiers[i], hashes[i + 1]));
        }
        CoordinatorV2Config memory c;
        c.creator = CREATOR;
        c.registry = registry;
        c.raise = 4.206980085 ether;
        c.deadlineDays = 30;
        bytes memory nonces = new bytes(24);
        nonces[1] = 0x01;
        nonces[5] = 0x02;
        nonces[6] = 0x03;
        nonces[3] = 0x04;
        nonces[19] = 0x05;
        c.nonces = bytes24(nonces);
        box = BoxCoordinatorV2(BoxClones.create(BoxClones.initCode(coordinatorImpl, BoxCoordinatorV2Args.encode(c))));
        token = BoxTokenV2(vm.computeCreateAddress(address(box), 1));
        vault = CustodyVault(vm.computeCreateAddress(address(box), 4));
        loader = StarterSetLoaderV2(vm.computeCreateAddress(address(box), 5));
        _parts();
        if (launch) box.launch();
        vm.prank(CREATOR);
        // Same selector for both conventional and adversarial collections.
        HostileERC721(collection).setApprovalForAll(address(vault), true);
    }

    function _vaultArgs() internal view virtual returns (bytes memory) {
        return abi.encodePacked(
            address(box),
            address(token),
            address(loader),
            CREATOR,
            collection,
            uint32(ids.length),
            hashes[0],
            uint16(500)
        );
    }

    function _parts() private {
        address receiver = vm.computeCreateAddress(address(box), 2);
        bytes memory hookCode =
            abi.encodePacked(type(SetReuseHook).creationCode, abi.encode(pm, address(box), receiver, address(token)));
        address ha = vm.computeCreate2Address(bytes32(0), keccak256(hookCode), address(box));
        BoxFactoryV2Parts.Box memory b;
        b.roles[0] = address(box);
        b.roles[1] = address(token);
        b.roles[2] = ha;
        b.roles[3] = address(vault);
        b.roles[5] = receiver;
        b.roles[6] = vm.computeCreateAddress(address(box), 3);
        b.roles[19] = address(loader);
        b.creator = CREATOR;
        b.registry = registry;
        b.q.batchMinQ = 1;
        b.q.swapStepMinQ = 1;
        b.nonces = hex"01050613";
        BoxSpec memory s;
        s.boxType = uint8(BoxType.EXISTING);
        s.tokenName = "Custody test";
        s.tokenSymbol = "SET";
        s.buyers.split = 1;
        s.buyers.a.leg = 1;
        s.buyers.a.dest = 4;
        s.sellers = s.buyers;
        s.addOns = new AddOn[](1);
        s.addOns[0] = AddOn(8, abi.encode(hashes[0], uint32(ids.length)));
        (bytes[] memory args,) = (new BoxFactoryV2Parts()).partArgs(b, s);
        bytes[] memory codes = new bytes[](5);
        codes[0] = BoxClones.initCode(address(new BoxTokenV2(coordinatorImpl)), args[0]);
        codes[1] = BoxClones.initCode(receiverImpl, args[1]);
        codes[2] = type(SetReuseRouter).creationCode;
        codes[3] = BoxClones.initCode(vaultImpl, _vaultArgs());
        codes[4] = BoxClones.initCode(loaderImpl, args[3]);
        box.deploy(codes, hookCode, bytes32(0), 0, [bytes32(0), bytes32(0)], [uint256(0), uint256(0)]);
        hook = SetReuseHook(ha);
    }

    function _page(uint256 start, uint256 count) internal {
        (address[] memory cs, uint256[] memory ns, uint8[] memory ts) = _pageData(start, count);
        vm.prank(CREATOR);
        loader.load(cs, ns, ts, hashes[start + count]);
    }

    function _pageData(uint256 start, uint256 count)
        internal
        view
        returns (address[] memory cs, uint256[] memory ns, uint8[] memory ts)
    {
        cs = new address[](count);
        ns = new uint256[](count);
        ts = new uint8[](count);
        for (uint256 i; i < count; ++i) {
            cs[i] = collections[start + i];
            ns[i] = ids[start + i];
            ts[i] = tiers[start + i];
        }
    }

    function _progress(uint256 count, bool notified) internal view {
        (uint32 n, bytes32 rest, bool done) = loader.progress();
        assertEq(n, count);
        assertEq(rest, hashes[count]);
        assertEq(done, notified);
        assertEq(vault.loaded(), count);
        assertEq(vault.inside(), count);
    }
}
