// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IBoxReceiverItemsV2, ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxVaultItemsV2, ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";

/// @dev Executable producer reference. The driver stands for authenticated receiver/coordinator/vault inputs.
/// Transfer counters stand for atomic PM claims transfers, never arbitrary ledger balance gifts.
contract ItemHistoryModel is IBoxReceiverItemsV2, IBoxVaultItemsV2 {
    address public immutable driver = msg.sender;
    uint32 public immutable n;
    uint8 public immutable buyers;
    uint8 public immutable sellers;
    uint32 public inside;
    uint32 public hidden;
    bool public graduated;
    bool public failed;
    bool private transferRefused;
    uint256 public received;
    uint256 public ledgerTransferred;
    uint256 public buyBackP;
    uint256 public pot;
    uint256 public fit;
    uint256[3] public held;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => bool) public known;
    mapping(bytes32 => uint8) private ticketState;
    ItemFundingV2[] private receipts;
    ItemLifecycleV2[] private operations;
    modifier upstream() { require(msg.sender == driver, "upstream"); _; }
    constructor(uint32 count, uint8 b, uint8 s) {
        require(count != 0 && b <= 2 && s <= 2 && b+s != 0, "parameters");
        n = count; inside = count; hidden = count; buyers = b; sellers = s;
    }
    /// @notice Anyone reads the single-entry limit; no funds move.
    function ITEM_BATCH_MAX() external pure returns (uint256) { return 1; }
    /// @notice Anyone reads the committed receipt count; no funds move.
    function itemFundingCount() public view returns (uint256) { return receipts.length; }
    /// @notice Anyone reads the committed operation count; no funds move.
    function itemLifecycleCount() public view returns (uint256) { return operations.length; }
    /// @notice Anyone reads a valid immutable receipt; invalid ids revert.
    function itemFunding(uint256 id) external view returns (ItemFundingV2 memory) {
        require(id != 0 && id <= receipts.length, "receipt"); return receipts[id-1];
    }
    /// @notice Anyone reads a valid immutable operation; invalid ids revert.
    function itemLifecycle(uint256 id) external view returns (ItemLifecycleV2 memory) {
        require(id != 0 && id <= operations.length, "operation"); return operations[id-1];
    }
    /// @notice Anyone reads the two held side balances, counted once.
    function itemsHeldP() external view returns (uint256) { return held[1] + held[2]; }
    /// @notice Anyone reads all received choice-P destinations, including unprocessed ledger backing.
    function accounted() external view returns (uint256) {
        return held[1]+held[2]+ledgerTransferred+buyBackP+pot+fit;
    }
    /// @notice Driver alone simulates refused claims transfers.
    function refuseTransfer(bool value) external upstream { transferRefused = value; }
    /// @notice Driver only supplies a net backed choice amount, after source deductions; failure routes late P to the pot.
    function fund(uint8 side, uint8 source, uint256 batch, uint256 amount) external upstream {
        require(side == 1 || side == 2, "side");
        require((side == 1 ? buyers : sellers) != 0, "not items");
        require(source == 1 || source == 2, "source");
        require(source == 1 ? batch != 0 && batch % 2 == side % 2 : batch == 0, "batch");
        received += amount;
        if (failed) { pot += amount; return; }
        if (!graduated) { held[side] += amount; return; }
        _fund(side, source, batch, amount);
    }
    function _fund(uint8 side, uint8 source, uint256 batch, uint256 amount) private {
        uint8 policy = side == 1 ? buyers : sellers;
        uint256 burn = policy == 2 ? (source == 3 ? amount : inside * (amount / n)) : 0;
        uint256 transferred = amount - burn;
        require(!transferRefused || transferred == 0, "claims transfer");
        buyBackP += burn; ledgerTransferred += transferred;
        receipts.push(ItemFundingV2(batch, operations.length, amount, transferred, inside, hidden, side, source));
        emit ItemFunded(receipts.length, batch, side, source, amount, transferred);
    }
    /// @notice Driver models coordinator graduation once; both side releases precede live funding, including zeros.
    function graduate() external upstream {
        require(!failed && !graduated, "phase"); graduated = true;
        if (buyers != 0) _fund(1, 3, 0, held[1]);
        if (sellers != 0) _fund(2, 3, 0, held[2]);
        held[1] = 0; held[2] = 0;
    }
    /// @notice Driver models coordinator failure; held items join the pot without a ledger call.
    function fail() external upstream {
        require(!failed && !graduated, "phase"); failed = true;
        pot += held[1] + held[2]; held[1] = 0; held[2] = 0;
    }
    function _record(bytes32 key, uint256 id, uint8 kind) private {
        operations.push(ItemLifecycleV2(key, id, receipts.length, uint64(block.timestamp), kind));
        emit ItemLifecycleRecorded(operations.length, key, id, receipts.length, uint64(block.timestamp), kind);
    }
    /// @notice Driver models one adapter-authenticated anonymous request; no eventual item id is accepted.
    function request(bytes32 key) external upstream {
        require(!failed && key != 0 && ticketState[key] == 0 && hidden != 0, "ticket");
        ticketState[key] = 1; --hidden; --inside; _record(key, 0, 1);
    }
    /// @notice Driver models authenticated assignment of one ticket to a hidden NFT.
    function deliver(bytes32 key, uint256 id, address to) external upstream {
        require(graduated && ticketState[key] == 1 && !known[id], "delivery"); _id(id, to);
        ticketState[key] = 2; known[id] = true; ownerOf[id] = to; _record(key, id, 2);
    }
    /// @notice Driver models authenticated cancellation of the named ticket only.
    function cancel(bytes32 key) external upstream {
        require(ticketState[key] == 1, "ticket"); ticketState[key] = 2; ++inside; ++hidden; _record(key, 0, 3);
    }
    /// @notice Driver models an authenticated withdrawal.
    function pick(uint256 id, address to) external upstream {
        require(graduated && ownerOf[id] == address(0), "pick"); _id(id, to);
        if (!known[id]) { require(hidden != 0, "reserved"); --hidden; known[id] = true; }
        --inside; ownerOf[id] = to; _record(0, id, 4);
    }
    /// @notice Driver models an authenticated return; old credits stay attached.
    function back(uint256 id) external upstream {
        require(ownerOf[id] != address(0), "outside"); ownerOf[id] = address(0); ++inside; _record(0, id, 5);
    }
    /// @notice Driver models an NFT transfer; all credit follows its current owner.
    function move(uint256 id, address to) external upstream {
        _id(id, to); require(ownerOf[id] != address(0), "outside"); ownerOf[id] = to;
    }
    function _id(uint256 id, address to) private view {
        require(id != 0 && id <= n && to != address(0) && to != address(this), "item/recipient");
    }
}
