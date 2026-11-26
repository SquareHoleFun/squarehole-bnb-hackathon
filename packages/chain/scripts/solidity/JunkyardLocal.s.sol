// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC721} from "solmate/src/tokens/ERC721.sol";
import {LocalPriceCoin, LocalERC20} from "script/local/LocalQuoteMocks.sol";
import {LocalTwin} from "script/local/LocalTwin.sol";
import {IListingRegistry, ListingClass} from "src/box-v2/interfaces/IListingRegistry.sol";

/// @notice LOCAL ONLY, valueless Test Gold stand-in with explicit issuer powers.
contract JunkyardGold is LocalPriceCoin {
    string public constant name = "Test Gold (local mock)";
    // TEST_GOLD is the recipe key; preparation requires the real Test Gold symbol.
    string public constant symbol = "tGOLD";
    uint8 public constant decimals = 18;
    address public immutable issuer;
    bool public paused;
    mapping(address => bool) public frozen;
    uint16 public feeBps;
    constructor(address issuer_) { require(issuer_ != address(0), "issuer required"); issuer = issuer_; }
    modifier onlyIssuer() { require(msg.sender == issuer, "issuer only"); _; }
    /// @notice Fixed test issuer pauses all transfers; faucet minting remains available locally.
    function setPaused(bool value) external onlyIssuer { paused = value; }
    /// @notice Fixed test issuer freezes senders, recipients or spenders without moving their funds.
    function setFrozen(address account, bool value) external onlyIssuer { frozen[account] = value; }
    /// @notice Fixed test issuer sets a transfer fee, credited to itself; total supply stays constant.
    function setFeeBps(uint16 value) external onlyIssuer { require(value <= 10000, "fee bounds"); feeBps = value; }
    function _move(address from, address to, uint256 amount) internal override {
        require(!paused && !frozen[from] && !frozen[to] && !frozen[msg.sender], "issuer restriction");
        // Decompose before multiplying to avoid overflow even with uint256-sized test balances.
        uint256 fee = amount / 10000 * feeBps + (amount % 10000) * feeBps / 10000;
        super._move(from, issuer, fee);
        super._move(from, to, amount - fee);
    }
}

/// @notice LOCAL ONLY contract-holder double. No Safe signatures, threshold or production security simulated.
contract JunkyardSafeDouble {
    address public immutable owner;
    constructor(address owner_) { require(owner_ != address(0), "owner required"); owner = owner_; }
    /// @notice Only the fixture owner can make this contract create, approve, load, curate or claim for itself.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory result) {
        require(msg.sender == owner, "owner only");
        bool ok; (ok, result) = target.call{value: value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
    /// @notice Receives the owner's test NFTs, including safe transfers from the shop.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) { return 0x150b7a02; }
    receive() external payable {}
}

/// @notice LOCAL ONLY ERC-721 faucet, distinct deployments model unrelated listed collections.
contract JunkyardCollection is ERC721 {
    constructor() ERC721("Junkyard local collection", "SCRAP") {}
    function tokenURI(uint256) public pure override returns (string memory) { return ""; }
    /// @notice Anyone mints valueless test items. ERC-721 refuses duplicate ids.
    function mint(address to, uint256 id) external { _mint(to, id); }
}
interface IJunkyardFactory { function listingRegistry() external view returns (address); function implementation(uint256) external view returns (address); }
interface IJunkyardReceiver { function PLATFORM_SAFE() external view returns (address); }
interface IJunkyardLister { function listPriceCoin(IListingRegistry registry, LocalERC20 coin, ListingClass class, uint256 raise) external returns (uint32); }

/// @notice Fresh loopback anvil fixtures only. Guard precedes broadcasting; there is no key handling.
contract JunkyardLocalSetup is Script {
    function runLocal(address factory, address actor, address backup) external {
        LocalTwin.check(block.chainid, abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        IJunkyardFactory f = IJunkyardFactory(factory);
        IListingRegistry registry = IListingRegistry(f.listingRegistry());
        address platform = IJunkyardReceiver(f.implementation(5)).PLATFORM_SAFE();
        vm.startBroadcast(msg.sender);
        JunkyardGold gold = new JunkyardGold(msg.sender);
        JunkyardSafeDouble safe = new JunkyardSafeDouble(actor);
        // Match the shared Junkyard row independently of the local native listing.
        uint256 raise = 1000000000000000000;
        gold.mint(platform, 10000);
        uint32 listingId = IJunkyardLister(platform).listPriceCoin(registry, gold, ListingClass.OTHER, raise);
        gold.mint(address(safe), raise * 10); gold.mint(actor, raise * 10); gold.mint(backup, raise * 10);
        console.log(string.concat("LOCALV2|junkyardGold|", vm.toString(address(gold))));
        console.log(string.concat("LOCALV2|junkyardSafe|", vm.toString(address(safe))));
        console.log(string.concat("JUNKYARD_LISTING|", vm.toString(listingId)));
        // Five Test Junk bindings start listed; a sixth fixture exercises curator admission and its delay.
        for (uint256 c; c < 6; ++c) {
            JunkyardCollection nft = new JunkyardCollection();
            if (c < 5) for (uint256 id = 1; id <= 2; ++id) nft.mint(address(safe), id);
            for (uint256 id = 100; id < 108; ++id) nft.mint(actor, id);
            for (uint256 id = 200; id < 208; ++id) nft.mint(backup, id);
            string memory key = c < 5 ? string.concat("scrap", vm.toString(c)) : "junkyardUnlisted";
            console.log(string.concat("LOCALV2|", key, "|", vm.toString(address(nft))));
        }
        vm.stopBroadcast();
    }
}
