// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCollection} from "../../../src/box/BoxCollection.sol";
import {BoxRoyaltyRouter} from "../../../src/box/BoxRoyaltyRouter.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {BoxToken} from "../../../src/box/BoxToken.sol";
import {BoxVault} from "../../../src/box/BoxVault.sol";
import {RoyaltyDestination} from "../../../src/box/interfaces/BoxTypes.sol";
import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {BoxCloneArgs} from "../../../src/box/libraries/BoxCloneArgs.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {BoxData} from "../../../src/box/libraries/BoxData.sol";

/// @notice TEST ONLY: one deployment of each S3 implementation (once per version in production, S7), and of the
/// coordinator stand-in (`BoxItemsKit`) whose clones alone may initialise them (BC-100; review of sh-core-v1).
struct BoxImpls {
    address coordinator;
    address collection;
    address vault;
    address tickets;
    address router;
}

/// @notice TEST ONLY: what one test box is built from (a BoxSpec's S3 part plus its outside wiring).
struct ItemsConfig {
    uint32 n;
    uint256 firstId;
    bool tickets;
    /// REVEAL_ON_EXIT 1 | REVEAL_ON_UNLOCK 2 | REVEAL_ALWAYS 4 (UNLOCK wires the tickets add-on as the unlocker).
    uint8 revealTriggers;
    bytes32 revealRoot;
    bytes metadataTable;
    bytes32 generatorHash;
    /// The collection cover (BoxSpec field 28, F74 U3): contractURI's image.
    bytes32 collectionCoverSha256;
    bytes32 bannerSha256;
    address marketplaceOwner;
    /// 0 without the royalties add-on (then bps must be 0).
    uint8 royaltyDestination;
    uint16 royaltyBps;
    address receiver;
    address transferObserver;
    address vaultObserver;
    address source;
    address weth;
    uint32 openAt;
    string tokenName;
    string tokenSymbol;
    string name;
    string symbol;
    string description;
    string hiddenDescription;
    string hiddenSvg;
    string placeholderName;
    string placeholderSymbol;
    string placeholderDescription;
    uint16 drawFeeBps;
    uint16 pickFeeBps;
    uint16 returnFeeBps;
    /// Add-on 6's link (contractURI's external_link), empty for none.
    string externalLink;
}

/// @notice TEST ONLY: a box's addresses on the S3 side.
struct ItemsBox {
    address coordinator;
    address table;
    address token;
    address collection;
    address vault;
    address tickets;
    address router;
}

/// @notice TEST ONLY: the clone arguments of a test box (BoxCloneArgs from an ItemsConfig and the box's addresses).
library BoxItemsArgs {
    function collection(ItemsConfig memory c, ItemsBox memory b) internal pure returns (bytes memory) {
        return BoxCloneArgs.collection(
            BoxCloneArgs.CollectionArgs({
                coordinator: b.coordinator,
                vault: b.vault,
                token: b.token,
                receiver: c.receiver,
                revealUnlocker: c.revealTriggers & 2 != 0 ? b.tickets : address(0),
                transferObserver: c.transferObserver,
                royaltyRouter: b.router,
                marketplaceOwner: c.marketplaceOwner,
                metadataTable: b.table,
                collectionSize: c.n,
                revealTriggers: c.revealTriggers,
                royaltyBps: c.royaltyBps,
                royaltyDestination: c.royaltyDestination,
                firstId: c.firstId,
                revealRoot: c.revealRoot,
                metadataTableHash: keccak256(c.metadataTable),
                generatorHash: c.generatorHash,
                collectionCoverSha256: c.collectionCoverSha256,
                bannerSha256: c.bannerSha256,
                name: c.name,
                symbol: c.symbol,
                description: c.description,
                hiddenDescription: c.hiddenDescription,
                hiddenSvg: c.hiddenSvg,
                externalLink: c.externalLink
            })
        );
    }

    function vault(ItemsConfig memory c, ItemsBox memory b) internal pure returns (bytes memory) {
        return BoxCloneArgs.vault(
            BoxCloneArgs.VaultArgs({
                coordinator: b.coordinator,
                token: b.token,
                collection: b.collection,
                ticketAdapter: b.tickets,
                observer: c.vaultObserver,
                collectionSize: c.n,
                drawFeeBps: c.drawFeeBps,
                pickFeeBps: c.pickFeeBps,
                returnFeeBps: c.returnFeeBps,
                firstId: c.firstId
            })
        );
    }

    function tickets(ItemsConfig memory c, ItemsBox memory b) internal pure returns (bytes memory) {
        return BoxCloneArgs.tickets(
            BoxCloneArgs.TicketsArgs({
                coordinator: b.coordinator,
                vault: b.vault,
                collection: b.collection,
                token: b.token,
                source: c.source,
                openAt: c.openAt,
                collectionSize: c.n,
                firstId: c.firstId,
                name: c.placeholderName,
                symbol: c.placeholderSymbol,
                description: c.placeholderDescription
            })
        );
    }
}

/// @notice TEST ONLY: stands in for the box's coordinator (S6) and its deployment by the factory (S7): it creates the
/// metadata table, T and the S3 clones by nonce, in a fixed order, so every address is known before any exists
/// (SH-S0-spikes § 2.2), then initialises collection, vault and tickets in that order (core-v1-interfaces § 2). It holds
/// the issuance, hands T out, opens the vault's gate (graduation) and answers `graduated()` for the royalty router.
/// Each test box's kit is a clone of one kit implementation (`BoxItemsBase._newKit`), as each box's coordinator is a
/// clone of the version's BoxCoordinator: the S3 implementations accept `initialize` only from such a clone.
contract BoxItemsKit {
    bool public graduated;
    ItemsBox internal _box;
    /// @dev CREATEs made so far (a clone's storage starts at zero; its own nonce starts at 1, EIP-161).
    uint256 internal _nonce;

    function box() external view returns (ItemsBox memory) {
        return _box;
    }

    /// @notice Deploys and initialises one box (`init` false: deploy only, so a test can call `initialize` itself).
    function build(BoxImpls memory impls, ItemsConfig memory c, bool init) public returns (ItemsBox memory b) {
        b = prepare(impls, c);
        deployTable();
        deployToken();
        deployCollection();
        deployVault();
        if (c.tickets) deployTickets();
        if (b.router != address(0)) deployRouter();
        if (init) initialiseAll();
    }

    BoxImpls internal _impls;
    ItemsConfig internal _cfg;

    /// @notice Fixes every address of the box from this kit's nonces (SH-S0-spikes § 2.2) and keeps the config, so the
    /// deploy steps can run (and be measured) one call at a time.
    function prepare(BoxImpls memory impls, ItemsConfig memory c) public returns (ItemsBox memory b) {
        b.coordinator = address(this);
        b.table = _next();
        b.token = _next();
        b.collection = _next();
        b.vault = _next();
        b.tickets = c.tickets ? _next() : address(0);
        // A router for every royalty destination (the Creator one too, review of sh-core-v1).
        b.router = c.royaltyDestination >= uint8(RoyaltyDestination.FeeHandling)
            && c.royaltyDestination <= uint8(RoyaltyDestination.PoolDepth)
            ? _next()
            : address(0);
        _box = b;
        _impls = impls;
        _cfg = c;
    }

    function deployTable() public {
        require(BoxData.write(_cfg.metadataTable) == _box.table, "table address");
    }

    function deployToken() public {
        require(
            address(new BoxToken(_cfg.tokenName, _cfg.tokenSymbol, address(this), _box.vault)) == _box.token,
            "token address"
        );
    }

    function deployCollection() public {
        bytes memory code = BoxClones.initCode(_impls.collection, BoxItemsArgs.collection(_cfg, _box));
        require(BoxClones.create(code) == _box.collection, "collection address");
    }

    function deployVault() public {
        require(
            BoxClones.create(BoxClones.initCode(_impls.vault, BoxItemsArgs.vault(_cfg, _box))) == _box.vault, "vault"
        );
    }

    function deployTickets() public {
        require(
            BoxClones.create(BoxClones.initCode(_impls.tickets, BoxItemsArgs.tickets(_cfg, _box))) == _box.tickets, "t"
        );
    }

    function deployRouter() public {
        bytes memory args = BoxCloneArgs.router(
            BoxCloneArgs.RouterArgs({
                coordinator: address(this),
                receiver: _cfg.receiver,
                weth: _cfg.weth,
                destination: _cfg.royaltyDestination
            })
        );
        require(BoxClones.create(BoxClones.initCodeReceiving(_impls.router, args)) == _box.router, "router");
    }

    function initCollection() external {
        BoxCollection(_box.collection).initialize();
    }

    function initVault() external {
        BoxVault(_box.vault).initialize();
    }

    function initTickets() external {
        BoxTickets(_box.tickets).initialize();
    }

    function initialiseAll() public {
        BoxCollection(_box.collection).initialize();
        BoxVault(_box.vault).initialize();
        if (_box.tickets != address(0)) BoxTickets(_box.tickets).initialize();
    }

    /// @notice Hands out T from the issuance (the curve stands in for every buyer).
    function give(address to, uint256 amount) external {
        BoxToken(_box.token).transfer(to, amount);
    }

    /// @notice Burns T held here (the bootstrap burn, BC-004).
    function burn(uint256 amount) external {
        BoxToken(_box.token).burn(amount);
    }

    /// @notice Graduation's S3 part: the vault's gate opens, the router may flush.
    function graduate() external {
        graduated = true;
        BoxVault(_box.vault).openGate();
    }

    function waiveHandBackFee() external {
        BoxVault(_box.vault).waiveHandBackFee();
    }

    /// @notice Any call as the coordinator (tests of the coordinator-only paths).
    function exec(address target, bytes calldata data) external payable returns (bytes memory result) {
        bool ok;
        (ok, result) = target.call{value: msg.value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }

    function _next() internal returns (address a) {
        a = createAddress(address(this), ++_nonce);
    }

    /// @dev CREATE addresses of a contract deployer, nonces 1 … 127 (contracts start at nonce 1, EIP-161;
    /// test/spikes/SpikeBoxFactory.sol:280-287).
    function createAddress(address deployer, uint256 nonce) public pure returns (address) {
        require(nonce >= 1 && nonce <= 0x7f, "nonce");
        return address(
            // forge-lint: disable-next-line(unsafe-typecast)
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce)))))
        );
    }

    receive() external payable {}
}

/// @notice TEST ONLY: the box receiver's S3-facing parts (S5 builds the real one): the current creator payee and the
/// ETH intake the royalty router flushes into (fees, depth, and the creator for Creator royalties, F72 (3)).
contract MockBoxReceiver {
    address public creatorPayee;
    bool public refuse;
    uint256 public feesFunded;
    uint256 public depthFunded;
    uint256 public creatorFunded;
    uint256 public calls;

    error Refused();

    function setPayee(address p) external {
        creatorPayee = p;
    }

    function setRefuse(bool r) external {
        refuse = r;
    }

    function fundFees() external payable {
        if (refuse) revert Refused();
        feesFunded += msg.value;
        ++calls;
    }

    function fundDepth() external payable {
        if (refuse) revert Refused();
        depthFunded += msg.value;
        ++calls;
    }

    function fundCreator() external payable {
        if (refuse) revert Refused();
        creatorFunded += msg.value;
        ++calls;
    }
}

/// @notice TEST ONLY: a drand source with the IDrandSource request/word surface (S9 builds the real one). Requests are
/// free and record the bounty; the test posts words with their `readyAt`.
contract MockDrandSource {
    struct Request {
        uint64 requestedAt;
        uint64 round;
    }

    mapping(address => mapping(uint256 => Request)) public requestOf;
    mapping(address => mapping(uint256 => bytes32)) internal _word;
    mapping(address => mapping(uint256 => uint64)) internal _readyAt;
    mapping(uint256 => uint256) public bountyOf;
    uint256 public requests;
    bool public revertWords;

    error AlreadyRequested(address consumer, uint256 key);

    function request(uint256 key) external payable returns (uint256 round) {
        if (requestOf[msg.sender][key].requestedAt != 0) revert AlreadyRequested(msg.sender, key);
        round = roundAt(block.timestamp + 12);
        // forge-lint: disable-next-line(unsafe-typecast)
        requestOf[msg.sender][key] = Request(uint64(block.timestamp), uint64(round));
        bountyOf[round] += msg.value;
        ++requests;
    }

    /// @notice Anyone adds to a round's pot (IDrandSource.addBounty; our keeper funding a round ahead of the draws).
    function addBounty(uint256 round) external payable {
        bountyOf[round] += msg.value;
    }

    function roundAt(uint256 timestamp) public pure returns (uint256) {
        return timestamp <= 1692803367 ? 1 : (timestamp - 1692803367 + 2) / 3 + 1;
    }

    function post(address consumer, uint256 key, bytes32 word) external {
        _word[consumer][key] = word;
        // forge-lint: disable-next-line(unsafe-typecast)
        _readyAt[consumer][key] = uint64(block.timestamp);
    }

    function postAt(address consumer, uint256 key, bytes32 word, uint64 readyAt) external {
        _word[consumer][key] = word;
        _readyAt[consumer][key] = readyAt;
    }

    function setRevertWords(bool on) external {
        revertWords = on;
    }

    function wordOf(address consumer, uint256 key) external view returns (bytes32 word, uint64 readyAt) {
        require(!revertWords, "words off");
        return (_word[consumer][key], _readyAt[consumer][key]);
    }

    function isRequested(address consumer, uint256 key) external view returns (bool) {
        return requestOf[consumer][key].requestedAt != 0;
    }
}

/// @notice TEST ONLY: WETH9's relevant behaviour: `withdraw` pays with `transfer` (2,300 gas), as WETH9 does.
contract MockWeth {
    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        payable(msg.sender).transfer(amount);
    }
}

/// @notice TEST ONLY: a plain ERC-20 a marketplace might pay royalties in (BC-114's "another ERC-20").
contract MockErc20 {
    mapping(address => uint256) public balanceOf;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }
}

/// @notice TEST ONLY: the commitment tree at depth ⌈log₂ N⌉ over positions id − firstId (BoxCollection's), sparse: only
/// the listed ids carry a leaf (test/v2/utils/MisfitsTestKit.sol:226-293 generalised to any depth and first id).
library SparseBoxTree {
    function leaf(uint256 id, uint128 traits, bytes32 image, bytes32 avatar, bytes32 model, bytes32 salt)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(id, traits, image, avatar, model, salt));
    }

    function depthOf(uint256 n) internal pure returns (uint256 d) {
        while ((uint256(1) << d) < n) ++d;
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(a, b));
    }

    function zero(uint256 level) internal pure returns (bytes32 z) {
        for (uint256 i; i < level; ++i) {
            z = hashPair(z, z);
        }
    }

    /// @param positions 0-based positions (id − firstId), distinct; @param leaves the leaf at each.
    function node(uint256 level, uint256 position, uint256[] memory positions, bytes32[] memory leaves)
        internal
        pure
        returns (bytes32)
    {
        uint256 lo = position << level;
        uint256 hi = (position + 1) << level;
        bool any;
        for (uint256 i; i < positions.length; ++i) {
            uint256 p = positions[i];
            if (p >= lo && p < hi) {
                if (level == 0) return leaves[i];
                any = true;
                break;
            }
        }
        if (!any) return zero(level);
        return hashPair(
            node(level - 1, position * 2, positions, leaves), node(level - 1, position * 2 + 1, positions, leaves)
        );
    }

    function root(uint256 depth, uint256[] memory positions, bytes32[] memory leaves) internal pure returns (bytes32) {
        return node(depth, 0, positions, leaves);
    }

    function proof(uint256 depth, uint256 position, uint256[] memory positions, bytes32[] memory leaves)
        internal
        pure
        returns (bytes32[] memory siblings)
    {
        siblings = new bytes32[](depth);
        uint256 index = position;
        for (uint256 level; level < depth; ++level) {
            siblings[level] = node(level, index ^ 1, positions, leaves);
            index >>= 1;
        }
    }
}
