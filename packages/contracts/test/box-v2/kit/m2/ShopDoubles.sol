// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ERC721} from "solmate/src/tokens/ERC721.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HostileToken} from "../HostileToken.sol";
import {IStarterSetLoaderV2, ShopLimitsV2 as S} from "../../../../src/box-v2/interfaces/IShopVaultV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {M2OptionalCall} from "./LedgerTokenMock.sol";

/// @dev TEST ONLY issuer switches are deliberately public: refusal, gas sink, seizure, extra mint and reentry.
contract HostileCollection is ERC721 {
    mapping(uint256 => bool) public blocked;
    bool public sink;
    address public reenter;
    bytes public reentry;
    constructor() ERC721("M2 collection", "M2NFT") {}
    function tokenURI(uint256) public pure override returns (string memory) { return ""; }
    function mint(address to, uint256 id) external { _mint(to, id); }
    function seize(uint256 id, address to) external { _burn(id); _mint(to, id); }
    function setBlocked(uint256 id, bool value) external { blocked[id] = value; }
    function setSink(bool value) external { sink = value; }
    function arm(address target, bytes calldata data) external { reenter = target; reentry = data; }
    function transferFrom(address from, address to, uint256 id) public override {
        require(!blocked[id], "NFT blocked");
        if (sink) { assembly ("memory-safe") { for {} 1 {} {} } }
        super.transferFrom(from, to, id);
        if (reenter != address(0)) { (bool ok,) = reenter.call(reentry); require(ok, "NFT reentry refused"); }
    }
}

/// @dev TEST ONLY combined gate/lifecycle double. Owner scripts chunks/failure/graduation; loader alone notifies.
/// No curve, deadline or failure-denominator simulation. Those remain the real coordinator's responsibility.
contract ShopGateDouble {
    address private immutable owner = msg.sender;
    address public immutable creator;
    uint256 public immutable openAt;
    address public loader;
    ShopDouble public shop;
    bool public chunks;
    bool public starterDone;
    bool public gateOpen;
    bool public failed;
    bool public graduated;
    bool public refuseOpen;
    uint256 public effectiveOpenAt;
    modifier upstream() { require(msg.sender == owner, "fixture owner"); _; }
    constructor(address c, uint256 at) { creator = c; openAt = at; }
    function wire(ShopDouble s, address l) external upstream { require(loader == address(0)); shop = s; loader = l; }
    function setRefuseOpen(bool value) external upstream { refuseOpen = value; }
    function chunksReady() external upstream { require(!failed && !chunks); chunks = true; _open(); }
    function starterSetLoaded() external {
        require(msg.sender == loader && !failed && !starterDone, "loader/phase"); starterDone = true; _open();
    }
    function _open() private {
        if (!chunks || !starterDone) return;
        require(!refuseOpen, "setOpen refused"); gateOpen = true;
        effectiveOpenAt = openAt > block.timestamp ? openAt : block.timestamp + 1;
    }
    function graduate() external upstream { require(gateOpen && block.timestamp >= effectiveOpenAt && !failed); graduated = true; }
    function fail() external upstream { require(!failed && !graduated); failed = true; gateOpen = false; shop.enterFailure(); }
}

/// @dev TEST ONLY shop custody subset of IShopVaultV2. Does not implement give/pick economics or curator rules.
/// Fixed creator owns the starter exit; all failed T can only burn. Constructor substitutes for clone args.
contract ShopDouble {
    struct Item { address collection; uint256 id; bool returned; }
    ShopGateDouble public immutable coordinator;
    HostileToken public immutable token;
    IPoolManager public immutable pm;
    uint256 public immutable seed;
    bool public seedReady;
    bool public failed;
    bool private locked;
    mapping(bytes32 => bool) private seen;
    Item[] private items;
    modifier lock() { require(!locked, "locked"); locked = true; _; locked = false; }
    constructor(ShopGateDouble c, HostileToken t, IPoolManager manager, uint256 amount) {
        coordinator = c; token = t; pm = manager; seed = amount; seedReady = amount == 0;
    }
    function budgetT() external view returns (uint256) { return failed ? 0 : token.balanceOf(address(this)); }
    function failedT() public view returns (uint256) {
        return failed ? token.balanceOf(address(this)) + pm.balanceOf(address(this), uint256(uint160(address(token)))) : 0;
    }
    function fundSeed() external lock {
        require(!seedReady && !failed && !coordinator.starterDone() && !coordinator.graduated(), "seed phase");
        uint256 beforeBalance = token.balanceOf(address(this));
        require(token.transferFrom(coordinator.creator(), address(this), seed));
        require(token.balanceOf(address(this)) == beforeBalance + seed, "exact seed"); seedReady = true;
    }
    function loadStarter(address collection, uint256 id, uint8 tier) external lock {
        require(msg.sender == coordinator.loader() && !failed && !coordinator.starterDone(), "loader/phase");
        require(tier <= 3, "tier"); bytes32 key = keccak256(abi.encode(collection, id)); require(!seen[key], "duplicate");
        seen[key] = true; ERC721(collection).transferFrom(coordinator.creator(), address(this), id);
        require(ERC721(collection).ownerOf(id) == address(this), "custody"); items.push(Item(collection, id, false));
    }
    function enterFailure() external { require(msg.sender == address(coordinator) && !failed, "coordinator"); failed = true; }
    function returnStarter(uint256[] calldata indexes) external lock returns (uint256 returned) {
        require(failed && indexes.length != 0 && indexes.length <= S.MAX_STARTER_BATCH, "return page");
        for (uint256 i; i < indexes.length; ++i) {
            Item storage item = items[indexes[i]];
            if (!item.returned && M2OptionalCall.run(address(this), abi.encodeCall(this.returnOne, (indexes[i])),
                S.NFT_RETURN_GAS, S.NFT_RETURN_RESERVE_GAS)) { item.returned = true; ++returned; }
        }
    }
    function returnOne(uint256 index) external {
        require(msg.sender == address(this), "self"); Item storage item = items[index];
        ERC721(item.collection).safeTransferFrom(address(this), coordinator.creator(), item.id);
        require(ERC721(item.collection).ownerOf(item.id) == coordinator.creator(), "return custody");
    }
    function burnFailedT() external lock returns (uint256 burned) {
        require(failed, "failed"); uint256 amount = failedT();
        if (amount != 0 && M2OptionalCall.run(address(this), abi.encodeCall(this.burnAll, ()), C.BURN_GAS, S.NFT_RETURN_RESERVE_GAS)) burned = amount;
    }
    function burnAll() external {
        require(msg.sender == address(this), "self");
        uint256 claims = pm.balanceOf(address(this), uint256(uint160(address(token))));
        if (claims != 0) pm.unlock(abi.encode(claims));
        token.burn(token.balanceOf(address(this)));
    }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm"); uint256 n = abi.decode(data, (uint256));
        Currency currency = Currency.wrap(address(token)); pm.burn(address(this), currency.toId(), n); pm.take(currency, address(this), n); return "";
    }
    function starterCount() external view returns (uint256) { return items.length; }
    function supplyFloor() external pure returns (uint256) { return 0; }
}

/// @dev TEST ONLY frozen loader ABI, ordered commitment and bounded creator pulls; no initialization step.
contract StarterLoaderDouble is IStarterSetLoaderV2 {
    ShopGateDouble public immutable coordinator;
    ShopDouble public immutable shop;
    uint32 public immutable count;
    uint32 private loaded;
    bytes32 private remaining;
    bool private notified;
    bool private locked;
    mapping(bytes32 => bool) private seen;
    modifier lock() { require(!locked, "locked"); locked = true; _; locked = false; }
    constructor(ShopGateDouble c, ShopDouble s, bytes32 root, uint32 n) {
        require((n == 0 && root == 0) || (n >= 10 && n <= 10000 && root != 0), "commitment");
        coordinator = c; shop = s; remaining = root; count = n;
    }
    function load(address[] calldata collections, uint256[] calldata ids, uint8[] calldata tiers, bytes32 nextHash) external lock {
        require(msg.sender == coordinator.creator() && !coordinator.failed() && !notified, "creator/phase");
        uint256 n = ids.length;
        require(n != 0 && n <= S.MAX_STARTER_BATCH && n == collections.length && n == tiers.length && loaded + n <= count, "page");
        require(loaded + n != count || nextHash == 0, "terminal");
        bytes32 hash = nextHash;
        for (uint256 i = n; i != 0;) { --i; hash = keccak256(abi.encode(collections[i], ids[i], tiers[i], hash)); }
        require(hash == remaining, "hash");
        for (uint256 i; i < n; ++i) {
            bytes32 key = keccak256(abi.encode(collections[i], ids[i])); require(!seen[key], "duplicate"); seen[key] = true;
        }
        for (uint256 i; i < n; ++i) shop.loadStarter(collections[i], ids[i], tiers[i]);
        loaded += uint32(n); remaining = nextHash;
    }
    function complete() external lock {
        require(!coordinator.failed() && !notified && loaded == count && remaining == 0 && shop.seedReady(), "ready");
        notified = true; coordinator.starterSetLoaded();
    }
    function progress() external view returns (uint32, bytes32, bool) { return (loaded, remaining, notified); }
}
