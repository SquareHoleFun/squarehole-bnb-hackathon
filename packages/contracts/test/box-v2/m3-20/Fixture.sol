// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {ItemHistoryModel} from "../m3-00/ItemHistoryModel.sol";

/// @dev Test-only coordinator implementation, cloned just like the release coordinator.
contract ItemCoordinatorDouble {
    address public poolManager;
    address public vault;
    address public collection;
    address public tickets;
    address public receiver;
    address public hook;
    address public q;
    address public ledger;

    function setPrice(address p) external {
        q = p;
    }

    function configure(address pm, address history, address depth, address l) external {
        poolManager = pm;
        vault = history;
        collection = history;
        tickets = history;
        receiver = history;
        hook = depth;
        ledger = l;
    }

    function roleAddress(uint256 role) external view returns (address) {
        return role == 16 ? ledger : address(0);
    }

    function graduated() external view returns (bool) {
        return JournalDouble(payable(receiver)).history().graduated();
    }

    function failed() external view returns (bool) {
        return JournalDouble(payable(receiver)).history().failed();
    }

    function initializeLedger() external {
        IItemLedgerV2(ledger).initialize();
    }
}

/// @dev Test-only S2/S3 producers. The unchanged oracle is the history owner. Real PM claims back receipts;
/// recording and transfer share one transaction. No method calls ledger code to fund it.
contract JournalDouble is IUnlockCallback {
    ItemHistoryModel public immutable history;
    IPoolManager public immutable pm;
    address public coordinator;
    address public ledger;
    uint256 public firstId = 1;
    uint256 private backed;
    uint256 public badReceipt;
    ItemFundingV2 private replacement;
    uint256 public badOperation;
    ItemLifecycleV2 private opReplacement;
    bool public skipBacking;
    address public price;

    function setPrice(address p) external {
        price = p;
    }

    constructor(IPoolManager manager, uint32 n, uint8 b, uint8 s) {
        pm = manager;
        history = new ItemHistoryModel(n, b, s);
    }

    function wire(address c, address l, uint256 first) external {
        coordinator = c;
        ledger = l;
        firstId = first;
    }

    function collection() external view returns (address) {
        return address(this);
    }

    function collectionSize() external view returns (uint256) {
        return history.n();
    }

    // Initialization now authenticates the initial custody counts instead of assuming all ids are hidden.
    function inside() external view returns (uint256) {
        return history.inside();
    }

    function hiddenCount() external view returns (uint256) {
        return history.hidden();
    }

    function itemFundingCount() external view returns (uint256) {
        return history.itemFundingCount();
    }

    function itemFunding(uint256 i) external view returns (ItemFundingV2 memory) {
        return i == badReceipt ? replacement : history.itemFunding(i);
    }

    function itemLifecycleCount() external view returns (uint256) {
        return history.itemLifecycleCount();
    }

    function itemLifecycle(uint256 i) external view returns (ItemLifecycleV2 memory r) {
        if (i == badOperation) return opReplacement;
        r = history.itemLifecycle(i);
        if (r.kind == 2 || r.kind == 4 || r.kind == 5 || r.kind == 6) r.itemId += firstId - 1;
    }

    function corrupt(uint256 i, ItemFundingV2 calldata r) external {
        badReceipt = i;
        replacement = r;
    }

    function corruptOperation(uint256 i, ItemLifecycleV2 calldata r) external {
        badOperation = i;
        opReplacement = r;
    }

    function setSkipBacking(bool value) external {
        skipBacking = value;
    }

    function fund(uint8 side, uint8 source, uint256 batch, uint256 p) external {
        history.fund(side, source, batch, p);
        _back();
    }

    function graduate() external {
        history.graduate();
        _back();
    }

    function fail() external {
        history.fail();
    }

    function request(bytes32 key) external {
        history.request(key);
    }

    function deliver(bytes32 key, uint256 id, address to) external {
        history.deliver(key, id, to);
    }

    function cancel(bytes32 key) external {
        history.cancel(key);
    }

    function pick(uint256 id, address to) external {
        history.pick(id, to);
    }

    function back(uint256 id) external {
        history.back(id);
    }

    function move(uint256 id, address to) external {
        history.move(id, to);
    }

    function ownerOf(uint256 id) external view returns (address) {
        return history.ownerOf(id - firstId + 1);
    }

    function notice(bytes calldata data) external returns (bool ok) {
        (ok,) = ledger.call(data);
    }

    function cappedNotice(bytes calldata data) external returns (bool ok, uint256 used) {
        uint256 cap = 1_000_000;
        require(gasleft() >= cap + cap / 63 + 30_000, "gas floor");
        uint256 beforeGas = gasleft();
        (ok,) = ledger.call{gas: cap}(data);
        used = beforeGas - gasleft();
    }

    function gift(uint256 amount) external {
        pm.unlock(abi.encode(amount));
    }

    function _back() private {
        if (skipBacking) return;
        uint256 amount = history.ledgerTransferred() - backed;
        backed += amount;
        if (amount != 0) pm.unlock(abi.encode(amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        uint256 amount = abi.decode(data, (uint256));
        if (price == address(0)) {
            pm.settle{value: amount}();
        } else {
            pm.sync(Currency.wrap(price));
            require(IERC20Minimal(price).transfer(address(pm), amount));
            pm.settle();
        }
        pm.mint(address(this), uint160(price), amount);
        require(pm.transfer(ledger, uint160(price), amount));
        return "";
    }
    receive() external payable {}
}

/// @dev Token pause affects actual ERC-20 transport, never internal PM claims transfers.
contract ItemPriceDouble {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;
    bool public paused;

    constructor(uint8 d) {
        decimals = d;
    }

    function mint(address to, uint256 p) external {
        balanceOf[to] += p;
    }

    function pause() external {
        paused = true;
    }

    function transfer(address to, uint256 p) external returns (bool) {
        require(!paused);
        balanceOf[msg.sender] -= p;
        balanceOf[to] += p;
        return true;
    }
}

/// @dev Only exposes accounting for differential checks; no state mutation or behavior override.
contract ItemLedgerProbe is ItemLedgerV2 {
    constructor(IPoolManager pm, address c) ItemLedgerV2(pm, c) {}

    function totals() external view returns (uint256, uint256, uint256, uint256, uint256, uint256) {
        return (_hidden, _hiddenStash, _baseUnassigned, _basePerItem, _residue, _liability);
    }

    function ticketStash(bytes32 key) external view returns (uint256) {
        return _tickets[key].stash;
    }
}
