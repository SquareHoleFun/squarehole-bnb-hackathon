// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {M363Base} from "../m3-63-fix-create/Fixture.sol";
import {BoxSpec} from "../../../src/box-v2/interfaces/SpecTypes.sol";
import {Branch} from "../../../src/box-v2/interfaces/RecipeTypes.sol";
import {IFeeModulesV21} from "../../../src/box-v2/interfaces/IFeeModulesV21.sol";
import {FeeModuleDirectoryV21} from "../../../src/box-v2/FeeModuleDirectoryV21.sol";
import {FeeActionV21, IPoolManager, ReceiverViews} from "../../../src/box-v2/modules/FeeActionV21.sol";

interface FutureReceiver {
    function modulePendingP(bool sellers) external view returns (uint256);
    function executeModule(bool sellers) external returns (uint256);
    function sideModule(bool sellers) external view returns (address, bytes32);
}
contract FutureDestination is FeeActionV21 {
    address private immutable _recipient;
    constructor(IPoolManager pm, ReceiverViews views, address recipient) FeeActionV21(pm, views) { _recipient = recipient; }
    function feeActionVersion() external pure returns (uint256) { return 1; }
    function execute(address manager, address asset, uint256 amount) external virtual {
        require(manager == address(_pm));
        _payClaims(asset, _recipient, amount);
    }
}
contract RefusingFuture {
    function feeActionVersion() external pure returns (uint256) { return 1; }
    function execute(address, address, uint256) external pure { revert("refused"); }
}
contract ExhaustingFuture {
    function feeActionVersion() external pure returns (uint256) { return 1; }
    function execute(address, address, uint256) external pure { assembly ("memory-safe") { for {} 1 {} {} } }
}
contract UnspentFuture {
    function feeActionVersion() external pure returns (uint256) { return 1; }
    function execute(address, address, uint256) external pure {}
}
contract ReenteringFuture is FutureDestination {
    constructor(IPoolManager pm, ReceiverViews views, address recipient) FutureDestination(pm, views, recipient) {}
    function execute(address manager, address asset, uint256 amount) external override {
        (bool ok,) = msg.sender.call(abi.encodeWithSignature("collect(address)", address(0)));
        require(!ok, "receiver lock failed");
        _payClaims(asset, address(0xbeef), amount);
        require(manager == address(_pm));
    }
}
contract FutureFeeModuleTest is M363Base {
    function createFuture(BoxSpec memory spec) external { _create(spec); }
    function _directory() private view returns (FeeModuleDirectoryV21 directory, ReceiverViews views) {
        (address v,, address d) = IFeeModulesV21(release.implementations[5]).receiverCode();
        return (FeeModuleDirectoryV21(d), ReceiverViews(v));
    }
    function test_FM08_changedCodeRefusesNewBoxAndOldExecutionWithoutLosingDebt() public {
        (FeeModuleDirectoryV21 directory, ReceiverViews views) = _directory();
        address module = address(new FutureDestination(pm, views, address(0xcafe)));
        uint32 id = directory.register(module); vm.warp(block.timestamp + 1 days);
        BoxSpec memory spec = _spec(); spec.buyers.a = Branch(1, 9, "", abi.encode(id));
        _start(spec); _fill(); box.graduate(); receiver.collect(address(0));
        FutureReceiver fees = FutureReceiver(address(receiver));
        uint256 pending = fees.modulePendingP(false); assertGt(pending, 0);
        bytes memory code = module.code; vm.etch(module, hex"00");
        spec.tokenName = "Changed module new box";
        vm.expectRevert(); this.createFuture(spec);
        assertEq(fees.executeModule(false), 0); assertEq(fees.modulePendingP(false), pending);
        vm.etch(module, code); assertEq(fees.executeModule(false), pending);
    }
    function test_FM09_refusedActionRollsBackFundingAndFailureExitsPendingToPot() public {
        (FeeModuleDirectoryV21 directory,) = _directory();
        uint32 id = directory.register(address(new RefusingFuture())); vm.warp(block.timestamp + 1 days);
        BoxSpec memory spec = _spec(); spec.buyers.a = Branch(1, 9, "", abi.encode(id));
        _start(spec); _buy(1 ether); receiver.collect(address(0));
        FutureReceiver fees = FutureReceiver(address(receiver));
        assertGt(fees.modulePendingP(false), 0);
        vm.warp(box.deadline() + 1); box.fail();
        assertEq(fees.modulePendingP(false), 0);
        assertEq(receiver.booked(address(0)), pm.balanceOf(address(receiver), 0));
    }
    function test_FM10_twoSidesAreIndependentAndReentryRemainsLocked() public {
        (FeeModuleDirectoryV21 directory, ReceiverViews views) = _directory();
        address good = address(new ReenteringFuture(pm, views, address(0xbeef)));
        address refused = address(new RefusingFuture());
        uint32 a = directory.register(good); uint32 b = directory.register(refused);
        vm.warp(block.timestamp + 1 days);
        BoxSpec memory spec = _spec(); spec.buyers.a = Branch(1, 9, "", abi.encode(a));
        spec.sellers.a = Branch(1, 9, "", abi.encode(b));
        _start(spec); _buy(1 ether); buyer.swap(hook.poolKey(), false, 100 ether, layout.sqrtPriceStartX96); _fill(); box.graduate(); receiver.collect(address(0));
        buyer.swap(hook.poolKey(), false, token.balanceOf(address(buyer)) / 4, layout.sqrtPriceStartX96);
        _sellFeeP(); receiver.collect(address(0));
        FutureReceiver fees = FutureReceiver(address(receiver));
        (address buyers,) = fees.sideModule(false); (address sellers,) = fees.sideModule(true);
        assertEq(buyers, good); assertEq(sellers, refused);
        uint256 pending = fees.modulePendingP(true); assertGt(pending, 0);
        uint256 claims = pm.balanceOf(address(receiver), 0);
        assertEq(fees.executeModule(true), 0); assertEq(fees.modulePendingP(true), pending);
        assertEq(pm.balanceOf(address(receiver), 0), claims); assertEq(pm.balanceOf(refused, 0), 0);
        assertGt(fees.executeModule(false), 0);
        assertEq(receiver.booked(address(0)), pm.balanceOf(address(receiver), 0));
    }
    function test_FM19_exhaustedFutureActionRetainsDebtAtExistingKeeperEnvelope() public {
        _futureRefusal(address(new ExhaustingFuture()));
    }
    function test_FM20_unspentFundedBudgetRollsBackTheWholeAction() public {
        _futureRefusal(address(new UnspentFuture()));
    }
    function _futureRefusal(address module) private {
        (FeeModuleDirectoryV21 directory,) = _directory();
        uint32 id = directory.register(module); vm.warp(block.timestamp + 1 days);
        BoxSpec memory spec = _spec(); spec.buyers.a = Branch(1, 9, "", abi.encode(id));
        _start(spec); _fill(); box.graduate(); receiver.collect(address(0));
        FutureReceiver fees = FutureReceiver(address(receiver));
        uint256 pending = fees.modulePendingP(false);
        uint256 backing = pm.balanceOf(address(receiver), 0);
        _coldRelease(); vm.cool(address(receiver)); vm.cool(address(box)); vm.cool(module); vm.cool(address(directory));
        (bool ok, bytes memory result) = address(fees).call{gas: 3_500_000 - 21_204}(abi.encodeCall(FutureReceiver.executeModule, (false)));
        assertTrue(ok, "outer reserve survives exhausted module"); assertEq(abi.decode(result, (uint256)), 0);
        assertGt(pending, 0); assertEq(fees.modulePendingP(false), pending);
        assertEq(pm.balanceOf(address(receiver), 0), backing); assertEq(pm.balanceOf(module, 0), 0);
        assertEq(receiver.booked(address(0)), backing);
    }
    function test_FM15_releaseActionsAreSharedAndWithdrawalNeverRewritesAnOldBox() public {
        (FeeModuleDirectoryV21 directory,) = _directory();
        (address module, bytes32 hash, uint64 readyAt,) = directory.record(0);
        BoxSpec memory spec = _spec(); spec.buyers.a = Branch(1, 1, "", "");
        vm.warp(readyAt - 1); vm.expectRevert(); this.createFuture(spec);
        vm.warp(readyAt); _start(spec);
        address oldReceiver = address(receiver);
        (address snapshot, bytes32 snapshotHash) = IFeeModulesV21(oldReceiver).sideModule(false);
        assertEq(snapshot, module); assertEq(snapshotHash, hash);
        assertEq(oldReceiver.code.length, 45 + 267, "existing eat clone bytes unchanged");
        assertEq(vm.getNonce(oldReceiver), 1, "no per-box module creation");
        spec.tokenName = "Second shared action box";
        address second = _create(spec).receiver();
        (snapshot, snapshotHash) = IFeeModulesV21(second).sideModule(false);
        assertEq(snapshot, module); assertEq(snapshotHash, hash);
        directory.withdraw(0); spec.tokenName = "Withdrawn action box"; vm.expectRevert(); this.createFuture(spec);
        _fill(); box.graduate(); receiver.collect(address(0));
        uint256 before_ = address(0xdEaD).balance;
        (bool ok, bytes memory result) = oldReceiver.call(abi.encodeWithSignature("eatPriceCoin()"));
        assertTrue(ok); uint256 amount = abi.decode(result, (uint256)); assertGt(amount, 0);
        assertEq(address(0xdEaD).balance - before_, amount);
    }
    function test_FM07_futureModuleHasFixedSnapshotAndOldBoxSurvivesWithdrawal() public {
        (address views,, address directory_) = IFeeModulesV21(release.implementations[5]).receiverCode();
        FeeModuleDirectoryV21 directory = FeeModuleDirectoryV21(directory_);
        address module = address(new FutureDestination(pm, ReceiverViews(views), address(0xcafe)));
        uint32 id = directory.register(module);
        BoxSpec memory spec = _spec();
        spec.buyers.a = Branch(1, 9, "", abi.encode(id));
        uint256 ready = vm.getBlockTimestamp() + 1 days;
        vm.expectRevert(); this.createFuture(spec);
        vm.warp(ready - 1); vm.expectRevert(); this.createFuture(spec);
        vm.warp(ready);
        _start(spec);
        FutureReceiver fees = FutureReceiver(address(receiver));
        (address snap, bytes32 hash) = fees.sideModule(false);
        assertEq(snap, module); assertEq(hash, module.codehash);
        _buy(1 ether); receiver.collect(address(0));
        uint256 pending = fees.modulePendingP(false);
        assertGt(pending, 0);
        vm.expectRevert(); fees.executeModule(false);
        directory.withdraw(id);
        spec.tokenName = "Withdrawn future new box";
        vm.expectRevert(); this.createFuture(spec);
        _fill(); box.graduate(); receiver.collect(address(0));
        pending = fees.modulePendingP(false);
        uint256 before_ = address(0xcafe).balance;
        assertEq(fees.executeModule(false), pending);
        assertEq(address(0xcafe).balance - before_, pending);
        assertEq(fees.modulePendingP(false), 0);
        assertEq(receiver.booked(address(0)), pm.balanceOf(address(receiver), 0));
    }
}
