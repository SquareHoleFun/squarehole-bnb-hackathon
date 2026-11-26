// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {HostileToken} from "../HostileToken.sol";
import {PoolDriver} from "../BoxV2TestBase.sol";
import {HolderModel} from "../../m2-00/HolderModel.sol";
import {SourceModel} from "../../m2-00/SourceModel.sol";
import {LedgerTokenMock, HostileLedger} from "./LedgerTokenMock.sol";
import {BatchDriver, NetFundingMock} from "./BatchDriver.sol";
import {HolderLedgerDouble} from "./HolderLedgerDouble.sol";

/// @dev TEST ONLY fixture/oracle helpers. Each scripted step checks token state, source ledgers or holder credit.
/// Oracles are imported unchanged; do not use these doubles as evidence that the production M2 parts are built.
abstract contract HolderKit is Test {
    address internal constant SYSTEM = address(0x1000);
    address internal constant ALICE = address(0xa11ce);
    address internal constant BOB = address(0xb0b);
    address internal constant FIT = address(0xf17);
    address internal constant PLATFORM = address(0xf18);
    IPoolManager internal pm; uint256 internal pId;
    HostileToken internal p; LedgerTokenMock internal token; BatchDriver internal batches;
    NetFundingMock internal funding; HolderLedgerDouble internal ledger; HolderModel internal model; SourceModel internal sources;
    function _holderBox(uint8 decimals) internal {
        require(decimals == 6 || decimals == 8 || decimals == 18);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        p = new HostileToken("M2 price", "P", decimals); pId = uint256(uint160(address(p)));
        PoolDriver driver = new PoolDriver(pm); batches = new BatchDriver();
        funding = new NetFundingMock(pm, batches, p, driver, FIT, PLATFORM, SYSTEM);
        address[] memory systems = new address[](5);
        systems[0] = SYSTEM; systems[1] = address(pm); systems[2] = address(batches); systems[3] = address(funding);
        systems[4] = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        token = new LedgerTokenMock(systems);
        ledger = new HolderLedgerDouble(token, batches, funding, pm, address(p));
        token.wire(address(ledger)); batches.wire(address(ledger)); funding.wire(address(ledger));
        token.mint(SYSTEM, type(uint128).max);
        model = new HolderModel(SYSTEM); sources = new SourceModel();
    }
    function _move(address from, address to, uint256 amount, bool callbackOK) internal {
        token.setSkipCallbacks(!callbackOK && token.callbackTarget() == address(ledger));
        vm.prank(from); token.transfer(to, amount); model.move(from, to, amount, callbackOK);
        assertEq(token.balanceOf(from), model.balances(from)); assertEq(token.balanceOf(to), model.balances(to));
        assertEq(token.eligibleSupplyAt(token.holderCheckpoint()), model.eligibleSupply());
    }
    function _trade(bool buy, uint256 units, bool protocol, bool notice) internal {
        uint256 id = batches.currentTradeBatch(buy);
        bool ok = batches.trade(buy, address(0xdead), units, protocol, notice);
        assertEq(ok, notice && !protocol && units != 0, "unexpected notice result");
        model.trade(id, units, protocol, notice);
        assertEq(ledger.claimable(id, ALICE), 0); assertEq(ledger.claimable(id, BOB), 0);
    }
    function _receipt(uint256 id, uint256 gross, uint256 reserve, uint256 backed) internal {
        batches.receipt(id, gross - reserve); funding.receipt(id, backed); sources.receipt(id, gross, reserve, backed); _assertSources();
    }
    function _fund(uint256 id, uint256 tip) internal {
        funding.allocate(id, tip); sources.allocate(id, tip, funding.failed());
        model.close(id, sources.funding(id)); _assertSources();
        assertEq(funding.holderBatchPaid(id), sources.funding(id)); assertTrue(funding.holderBatchClosed(id));
    }
    function _settle(uint256 id) internal {
        while (!ledger.settleBatch(id, 64)) {} while (!model.finalized(id)) model.settle(id, 64);
    }
    function _assertCredits(uint256 id, uint256 a, uint256 b, uint256 dust) internal view {
        assertEq(ledger.claimable(id, ALICE), a); assertEq(ledger.claimable(id, BOB), b);
        assertEq(model.credit(id, ALICE), a); assertEq(model.credit(id, BOB), b);
        (,,, uint256 residue) = ledger.batchState(id); assertEq(residue, dust); assertEq(residue, model.residue(id));
    }
    function _claim(uint256 id, address who) internal {
        vm.prank(who); uint256 paid = ledger.claim(id, who);
        vm.prank(who); assertEq(model.claim(id, who), paid);
        assertEq(p.balanceOf(who), model.paidTo(who));
    }
    function _assertSources() internal view {
        assertEq(funding.fit(), sources.fit()); assertEq(funding.platform(), sources.platform());
        assertEq(funding.depth(), sources.depth()); assertEq(funding.pot(), sources.pot());
        assertEq(funding.debt(), sources.debt()); assertEq(funding.tips(), sources.tips());
        assertEq(pm.balanceOf(address(funding), pId), sources.balance());
    }
    function _ready(uint256 gross) internal {
        _move(SYSTEM, ALICE, 10, true); _trade(true, 100, false, true);
        _receipt(1, gross, 0, gross); batches.close(); _fund(1, 0); _settle(1);
    }
}
