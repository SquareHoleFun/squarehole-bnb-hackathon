// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IBoxTokenV2, BoxTokenV2Args} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {IHolderLedgerV2, IHolderTokenHistoryV2} from "../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {KitSupplyFloor} from "../kit/mocks/MockBoxTokenV2.sol";

// Local doubles only; the production ledger is built independently in M2-30.
contract LedgerProbe is IHolderLedgerV2 {
    IHolderTokenHistoryV2 public token;
    address public hook;
    uint256 public mode;
    uint256 public hints;
    uint256 public notices;
    uint256 public at;
    uint256 public supply;
    uint256 public count;
    uint256 public batch;
    uint256 public weight;
    function wire(address t, address h) external { token = IHolderTokenHistoryV2(t); hook = h; }
    function setMode(uint256 m) external { mode = m; }
    function _hostile() private view {
        if (mode == 1) revert InvalidRequest();
        if (mode == 2) assembly { for {} 1 {} {} }
        if (mode == 3) assembly { revert(0, 0x40000) }
    }
    function register() external { token.registerHolder(msg.sender); }
    function onTokenCheckpoint(uint256 cp, address from, address to) external {
        if (msg.sender != address(token)) revert Unauthorized(msg.sender);
        _hostile();
        require(cp == token.holderCheckpoint(), "uncommitted checkpoint");
        require(token.eligibleBalanceAt(from, cp) <= IBoxTokenV2(msg.sender).balanceOf(from));
        require(token.eligibleBalanceAt(to, cp) <= IBoxTokenV2(msg.sender).balanceOf(to));
        ++hints;
    }
    function onTradeFeeBatch(uint256 b, address, bool, uint256 u) external {
        if (msg.sender != hook) revert Unauthorized(msg.sender);
        _hostile();
        ++notices; batch = b; weight = u; at = token.holderCheckpoint();
        supply = token.eligibleSupplyAt(at); count = token.holderCount();
    }
    function settleBatch(uint256, uint256) external pure returns (bool) { revert InvalidRequest(); }
    function claim(uint256, address) external pure returns (uint256) { revert InvalidRequest(); }
    function flushResidue(uint256) external pure returns (uint256) { revert InvalidRequest(); }
    function claimable(uint256, address) external pure returns (uint256) { return 0; }
    function batchState(uint256) external pure returns (bool, uint256, uint256, uint256) { return (false, 0, 0, 0); }
}
contract TokenCoordinator {
    address public poolManager;
    mapping(uint256 => address) public roleAddress;
    function wire(address pm, uint256 role, address part) external { poolManager = pm; roleAddress[role] = part; }
}
abstract contract TokenFixture is Test {
    IBoxTokenV2 internal token;
    IHolderTokenHistoryV2 internal history;
    LedgerProbe internal ledger;
    TokenCoordinator internal coordinator;
    address internal implementation;
    address internal constant ALICE = address(0xa11ce);
    address internal constant BOB = address(0xb0b);
    address internal constant PM = address(0x10000);
    uint256 internal constant SUPPLY = 1e36;
    function setUp() public virtual {
        ledger = new LedgerProbe();
        TokenCoordinator ci = new TokenCoordinator();
        coordinator = TokenCoordinator(BoxClones.create(BoxClones.initCode(address(ci), "")));
        for (uint256 i; i < 24; ++i) coordinator.wire(PM, i, address(uint160(0x20000 + i)));
        coordinator.wire(PM, 0, address(coordinator)); coordinator.wire(PM, 17, address(ledger));
        implementation = deployCode("BoxTokenV2Ledger.sol:BoxTokenV2Ledger", abi.encode(address(ci)));
        token = IBoxTokenV2(BoxClones.create(BoxClones.initCode(implementation,
            BoxTokenV2Args.encode(address(coordinator), address(0), address(ledger), SUPPLY, "Ledger T", "LT"))));
        history = IHolderTokenHistoryV2(address(token)); ledger.wire(address(token), address(this));
        vm.prank(address(coordinator)); token.initialize();
    }
    function give(address to, uint256 amount) internal { vm.prank(address(coordinator)); token.transfer(to, amount); }
}
