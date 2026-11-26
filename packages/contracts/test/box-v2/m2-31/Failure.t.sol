// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FailureTestBase, IPoolManager, HostileToken, CoordinatorHarness, BoxClones, CoordinatorV2Config,
    BoxCoordinatorV2Args, BoxTokenV2, BoxTokenV2Args, FailureHook, FailureReceiver, FailureRouter} from "../m1-31/FailureTestBase.sol";
import {LedgerProbe, IHolderTokenHistoryV2} from "./Fixture.sol";

// Real coordinator claim/PoolManager/P payout, local lifecycle doubles and the real ledger token.
contract LedgerFailureTest is FailureTestBase {
    LedgerProbe internal ledger;
    function setUp() public override {
        vm.warp(1_000_000);
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
        priceToken = new HostileToken("Price", "P", 6); p = address(priceToken);
        implementation = new CoordinatorHarness(pm);
        bytes memory nonces = new bytes(24); nonces[1] = 0x01; nonces[5] = 0x02; nonces[6] = 0x03; nonces[17] = 0x04;
        CoordinatorV2Config memory config;
        config.p = p; config.creator = CREATOR; config.raise = 1e18; config.deadlineDays = 30; config.nonces = bytes24(nonces);
        box = CoordinatorHarness(BoxClones.create(BoxClones.initCode(address(implementation), BoxCoordinatorV2Args.encode(config))));
        t = BoxTokenV2(vm.computeCreateAddress(address(box), 1));
        receiver = FailureReceiver(vm.computeCreateAddress(address(box), 2));
        router = FailureRouter(payable(vm.computeCreateAddress(address(box), 3)));
        ledger = LedgerProbe(vm.computeCreateAddress(address(box), 4));
        vm.etch(address(ledger), address(new LedgerProbe()).code);
        address ti = deployCode("BoxTokenV2Ledger.sol:BoxTokenV2Ledger", abi.encode(address(implementation)));
        vm.etch(address(t), BoxClones.runtime(ti,
            BoxTokenV2Args.encode(address(box), address(0), address(ledger), SUPPLY, "T", "T")));
        hook = new FailureHook(pm, address(box), address(receiver), address(t), p);
        vm.etch(address(receiver), address(new FailureReceiver(pm, address(box), address(hook), p)).code);
        receiver.configure(1, 0);
        vm.etch(address(router), address(new FailureRouter(pm, address(box), p)).code);
        box.seed(address(hook), block.timestamp, true); ledger.wire(address(t), address(hook));
        vm.prank(address(box)); t.initialize();
        vm.prank(address(box)); t.approve(address(hook), type(uint256).max);
    }
    function test_revertingAndGasBurningLedgerCannotLockFailureClaim() public {
        for (uint256 m = 1; m <= 3; ++m) {
            uint256 saved = vm.snapshotState(); ledger.setMode(m);
            _fail(1200, 100);
            assertEq(_left(), 100); assertEq(_claim(ALICE, 100, ALICE), 1200);
            assertEq(_balance(ALICE), 1200); assertEq(_pot(), 0); assertEq(_left(), 0);
            IHolderTokenHistoryV2 h = IHolderTokenHistoryV2(address(t));
            assertEq(h.eligibleSupplyAt(h.holderCheckpoint()), 0);
            assertEq(h.eligibleBalanceAt(ALICE, h.holderCheckpoint()), 0);
            assertTrue(vm.revertToState(saved));
        }
    }
    function test_pausedPPayoutRollsBackTokenHistoryForRetry() public {
        _fail(1200, 100);
        IHolderTokenHistoryV2 h = IHolderTokenHistoryV2(address(t)); uint256 cp = h.holderCheckpoint();
        priceToken.setPaused(true);
        vm.prank(ALICE); vm.expectRevert(); box.claim(100, ALICE);
        assertEq(h.holderCheckpoint(), cp); assertEq(t.balanceOf(ALICE), 100); assertEq(_left(), 100);
        priceToken.setPaused(false); assertEq(_claim(ALICE, 100, ALICE), 1200);
    }
}
