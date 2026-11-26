// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReceiverFixture, ReceiverArgs, ReceiverHook} from "../cq11-b/ReceiverFixture.sol";
import {BatchHookFixture, HistoryFixture} from "../m2-30/HolderFixture.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {IBoxReceiverItemsV2, ItemFundingV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {ItemLifecycleV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {BeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";

/// @dev Test source producer with the own-pool buy callback; production hook source activation is an owner handoff.
contract BookingHook is BatchHookFixture {
    uint256 public lastProtocolBlock;
    function beforeSwap(address, PoolKey calldata, SwapParams calldata params, bytes calldata)
        external returns (bytes4, BeforeSwapDelta, uint24)
    {
        require(params.zeroForOne && lastProtocolBlock != block.number);
        lastProtocolBlock = block.number;
        return (this.beforeSwap.selector, BeforeSwapDelta.wrap(0), uint24(10_000 | 0x400000));
    }
}

/// @dev Local lifecycle producer for receiver boundary cases; real vault composition is tested separately.
contract BookingVault {
    uint256 public constant firstId = 1;
    uint256 public collectionSize = 4;
    uint256 public inside = 4;
    uint256 public hiddenCount = 4;
    address public coordinator;
    address public receiver;
    mapping(uint256 => address) public ownerOf;
    ItemLifecycleV2[] private operations;

    constructor(address c) { coordinator = c; }
    function wire(address r) external { receiver = r; }
    function collection() external view returns (address) { return address(this); }
    function itemLifecycleCount() external view returns (uint256) { return operations.length; }
    function itemLifecycle(uint256 id) external view returns (ItemLifecycleV2 memory) { return operations[id - 1]; }
    function counts(uint256 n, uint256 i, uint256 h) external { collectionSize = n; inside = i; hiddenCount = h; }
    function request(bytes32 key) external { --inside; --hiddenCount; _record(key, 0, 1); }
    function deliver(bytes32 key, uint256 id, address to) external { ownerOf[id] = to; _record(key, id, 2); }
    function cancel(bytes32 key) external { ++inside; ++hiddenCount; _record(key, 0, 3); }
    function pick(uint256 id, address to) external { --inside; --hiddenCount; ownerOf[id] = to; _record(0, id, 4); }
    function back(uint256 id) external { ++inside; ownerOf[id] = address(this); _record(0, id, 5); }
    function repick(uint256 id, address to) external { --inside; ownerOf[id] = to; _record(0, id, 4); }
    function _record(bytes32 key, uint256 id, uint8 kind) private {
        operations.push(ItemLifecycleV2(key, id, IBoxReceiverItemsV2(receiver).itemFundingCount(), uint64(block.timestamp), kind));
    }
}

contract ItemCodeRefuses { fallback() external { revert("no item code on fee path"); } }
contract ItemCodeExhausts { fallback() external { assembly { for {} 1 {} {} } } }

abstract contract BookingFixture is ReceiverFixture {
    BatchHookFixture internal batches;
    BookingVault internal vault;
    ItemLedgerV2 internal items;
    IBoxReceiverItemsV2 internal funding;
    address internal holders;
    address internal constant ALICE = address(0xA11CE);

    function _items(uint8 b, uint8 s, uint8 bp, uint8 sp) internal {
        vm.etch(address(0x100080), address(new BookingHook()).code);
        batches = BatchHookFixture(address(0x100080));
        hook = ReceiverHook(address(batches));
        vault = new BookingVault(address(coord));
        ReceiverArgs memory a = _args(b, s, 1, address(p));
        a.itemLedger = address(0x1623);
        holders = address(0x1723);
        if (b == 4 || s == 4) a.holderLedger = holders;
        r = _clone(a);
        funding = IBoxReceiverItemsV2(address(r));
        vault.wire(address(r));
        _read("poolManager()", address(pm));
        _read("vault()", address(vault));
        _read("collection()", address(vault));
        _read("tickets()", address(0));
        _read("receiver()", address(r));
        _read("hook()", address(hook));
        _read("q()", address(p));
        vm.mockCall(address(coord), abi.encodeWithSignature("roleAddress(uint256)", 16), abi.encode(a.itemLedger));
        address code = deployCode("out/ItemLedgerV2.sol/ItemLedgerV2.json", abi.encode(pm, coordinatorCode));
        vm.etch(a.itemLedger, BoxClones.runtime(code, abi.encodePacked(
            address(coord), address(vault), address(vault), address(0), address(r), address(hook), address(p),
            bp, sp, uint256(1000), uint256(100)
        )));
        items = ItemLedgerV2(a.itemLedger);
        vm.prank(address(coord)); items.initialize();
        coord.initialize(r);
    }

    function _read(string memory signature, address value) private {
        vm.mockCall(address(coord), abi.encodeWithSignature(signature), abi.encode(value));
    }

    function _source(uint256 id, uint256 amount, uint256 backing) internal {
        batches.receipt(id, amount, false);
        driver.mintClaims(Currency.wrap(address(p)), address(r), backing);
    }

    function _record(uint256 id, uint8 side, uint8 source, uint256 batch, uint256 choice, uint256 paid) internal view {
        ItemFundingV2 memory f = funding.itemFunding(id);
        assertEq(f.side, side); assertEq(f.source, source); assertEq(f.batchId, batch);
        assertEq(f.choiceP, choice); assertEq(f.ledgerP, paid);
        assertEq(f.insideCount, vault.inside()); assertEq(f.hiddenCount, vault.hiddenCount());
        assertEq(f.lifecycleCursor, vault.itemLifecycleCount());
    }
}
