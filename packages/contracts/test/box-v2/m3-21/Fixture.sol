// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxClones} from "../../../src/box/libraries/BoxClones.sol";
import {IItemLedgerV2} from "../../../src/box-v2/interfaces/IItemLedgerV2.sol";
import {ItemLedgerV2} from "../../../src/box-v2/ItemLedgerV2.sol";
import {HostileToken} from "../kit/HostileToken.sol";
import {ItemCoordinatorDouble, JournalDouble, ItemLedgerProbe} from "../m3-20/Fixture.sol";
import {ItemModel} from "../m3-00/ItemModel.sol";
import {ItemHistoryModel} from "../m3-00/ItemHistoryModel.sol";

/// @dev Real ledger clone and real PM custody; only the frozen S2/S3 producers are doubles.
abstract contract ItemClaimFixture is Test {
    IPoolManager internal pm;
    ItemCoordinatorDouble internal c;
    JournalDouble internal j;
    ItemLedgerProbe internal ledger;
    ItemModel internal model;
    HostileToken internal token;
    address internal price;
    uint256 internal paid;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant KEEPER = address(0xCA11);
    address internal constant DEPTH = address(0xD3);
    bytes4 internal constant INVALID_CLAIM = bytes4(keccak256("InvalidClaim()"));
    bytes4 internal constant PAYOUT_FAILED = bytes4(keccak256("PayoutFailed()"));

    function setUp() public virtual {
        _setup(address(0), 100, 30);
    }

    function _setup(address p, uint256 legacyMinimum, uint256 legacyTipCap) internal {
        price = p;
        paid = 0;
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        address ci = address(new ItemCoordinatorDouble());
        c = ItemCoordinatorDouble(BoxClones.create(BoxClones.initCode(ci, "")));
        j = new JournalDouble(pm, 4, 1, 2);
        model = new ItemModel(j.history());
        address implementation = deployCode("ItemLedgerProbe", abi.encode(pm, ci));
        bytes memory args = abi.encodePacked(
            address(c),
            address(j),
            address(j),
            address(j),
            address(j),
            DEPTH,
            p,
            uint8(1),
            uint8(2),
            legacyMinimum,
            legacyTipCap
        );
        ledger = ItemLedgerProbe(BoxClones.create(BoxClones.initCode(implementation, args)));
        c.configure(address(pm), address(j), DEPTH, address(ledger));
        c.setPrice(p);
        j.wire(address(c), address(ledger), 1);
        j.setPrice(p);
        vm.etch(DEPTH, hex"00");
        if (p == address(0)) vm.deal(address(j), type(uint128).max);
        else HostileToken(p).mint(address(j), type(uint128).max);
        c.initializeLedger();
    }

    function _erc20(uint8 decimals) internal {
        token = new HostileToken("Price", "P", decimals);
        _setup(address(token), 100, 30);
    }

    function _ids(uint256 id) internal pure returns (uint256[] memory ids) {
        ids = new uint256[](1);
        ids[0] = id;
    }

    function _sync() internal {
        ledger.sync(32);
        model.sync(32);
    }

    function _funded(uint256 gross) internal {
        j.graduate();
        j.pick(1, ALICE);
        j.fund(1, 2, 0, gross * 4);
        _sync();
    }

    function _balance(address account) internal view returns (uint256) {
        return price == address(0) ? account.balance : HostileToken(price).balanceOf(account);
    }

    function _credit(uint256 id) internal view returns (uint256) {
        (uint256 a, uint256 b) = ledger.itemCredit(id);
        return a + b;
    }

    function _debitModel(uint256 id, address owner, uint256 gross) internal {
        vm.prank(owner);
        assertEq(model.claim(_ids(id), owner), gross);
        paid += gross;
    }

    function _conserved() internal view {
        (uint256 hidden, uint256 stash, uint256 base,, uint256 residue, uint256 liability) = ledger.totals();
        assertEq(hidden, model.hidden());
        assertEq(stash, model.hiddenStash());
        assertEq(base, model.baseUnassigned());
        assertEq(residue, model.residue());
        for (uint256 id = 1; id <= 4; ++id) {
            (uint256 a, uint256 b) = ledger.itemCredit(id);
            (uint256 x, uint256 y) = model.itemCredit(id);
            assertEq(a, x, "outside by id");
            assertEq(b, y, "stash by id");
        }
        uint256 pending;
        for (uint256 i = ledger.fundingCursor() + 1; i <= j.itemFundingCount(); ++i) {
            pending += j.itemFunding(i).ledgerP;
        }
        uint256 backing = pm.balanceOf(address(ledger), uint160(price));
        uint256 depth = pm.balanceOf(DEPTH, uint160(price));
        assertEq(backing, liability + pending, "all liabilities backed");
        assertEq(backing + depth + paid, j.history().ledgerTransferred(), "actual money exits");
        assertEq(model.accounted(), j.history().ledgerTransferred(), "independent allocation");
    }
}

contract ItemOwner {
    function claim(IItemLedgerV2 ledger, uint256 id, address to) external returns (uint256) {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        return ledger.claim(ids, to);
    }
    receive() external payable {}
}
