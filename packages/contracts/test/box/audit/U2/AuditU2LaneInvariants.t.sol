// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AuditU2LaneBase} from "./AuditU2LaneBase.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";

/// @notice Total actions against the real factory world; failed calls are caught, unexpected outcomes are sticky.
contract AuditU2LaneHandler is AuditU2LaneBase {
    uint256 public buys;
    uint256 public partialBuys;
    uint256 public grossIn;
    uint256 public poolSpent;
    uint256 public taxKept;
    uint256 public refunds;
    uint256 public forced;
    uint256 public swept;
    uint256 public graduations;
    uint256 public successfulBurns;
    uint256 public successfulTransfers;
    uint256 public refusedSends;
    uint256 public previousSupply;
    bool public badAccounting;
    bool public badSupply;
    bool public badRestriction;
    bool public badSweep;
    bool public blockedGraduation;

    function setUp() public override {
        super.setUp();
        vm.warp(hook.openAt());
        previousSupply = token.totalSupply();
    }

    function buy(uint256 raw, uint8 actor) external {
        if (hook.closed() || block.timestamp >= hook.openAt() + 384) return;
        uint256 amount = bound(raw, 1, 20 * raise);
        address who = eoa[actor % 8];
        vm.deal(who, who.balance + amount);
        uint256 e0 = who.balance;
        uint256 p0 = address(pm).balance;
        uint256 r0_ = a.launchRouter.balance;
        uint256 safe0 = safe.balance;
        vm.prank(who);
        try launchRouter.buy{value: amount}(amount, 0, who, block.timestamp) {
            uint256 spent = address(pm).balance - p0;
            uint256 tax = a.launchRouter.balance - r0_;
            uint256 refund = who.balance + amount - e0;
            ++buys;
            if (refund != 0) ++partialBuys;
            grossIn += amount;
            poolSpent += spent;
            taxKept += tax;
            refunds += refund;
            if (amount != spent + tax + refund || safe.balance != safe0) badAccounting = true;
            uint256 pips = launchRouter.taxPips((block.timestamp - hook.openAt()) / 12);
            uint256 expected =
                refund == 0 ? (amount * pips + 999999) / 1e6 : (spent * pips + (1e6 - pips) - 1) / (1e6 - pips);
            if (tax != expected) badAccounting = true;
            if (refund != 0 && (!hook.closed() || _priceLane() != curve.sqrtPriceLowerX96)) badAccounting = true;
        } catch {}
        _observe();
    }

    function advance(uint8 seconds_) external {
        vm.warp(block.timestamp + uint256(seconds_ % 25));
        vm.roll(block.number + 1);
        _observe();
    }

    function force(uint96 amount) external {
        uint256 value = bound(amount, 0, raise);
        vm.deal(a.launchRouter, a.launchRouter.balance + value);
        forced += value;
        _observe();
    }

    function graduate() external {
        bool due = hook.closed() && !coordinator.graduated();
        try coordinator.graduate{gas: 15_000_000}() {
            ++graduations;
        } catch {
            if (due) blockedGraduation = true;
        }
        _observe();
    }

    function sweep() external {
        uint256 r = a.launchRouter.balance;
        uint256 q = pm.balanceOf(a.hook, 0);
        uint256 m = address(pm).balance;
        uint256 other = pm.balanceOf(a.receiver, 0) + pm.balanceOf(a.coordinator, 0) + safe.balance + a.executor.balance;
        try launchRouter.sweep() returns (uint256 amount) {
            swept += amount;
            if (
                !coordinator.graduated() || amount != r || a.launchRouter.balance != 0
                    || pm.balanceOf(a.hook, 0) != q + r || address(pm).balance != m + r
                    || pm.balanceOf(a.receiver, 0) + pm.balanceOf(a.coordinator, 0) + safe.balance + a.executor.balance
                        != other
            ) {
                badSweep = true;
            }
        } catch {
            if (coordinator.graduated() && r > 0) badSweep = true;
        }
        _observe();
    }

    function transfer(uint8 from, uint8 to, uint256 raw) external {
        address who = eoa[from % 8];
        uint256 amount = bound(raw, 0, token.balanceOf(who));
        vm.prank(who);
        try token.transfer(eoa[to % 8], amount) {
            ++successfulTransfers;
        } catch {
            badSupply = true;
        }
        _observe();
    }

    function burn(uint8 actor, uint256 raw) external {
        address who = eoa[actor % 8];
        uint256 amount = bound(raw, 0, token.balanceOf(who));
        vm.prank(who);
        try token.burn(amount) {
            ++successfulBurns;
        } catch {}
        _observe();
    }

    function prohibitedSend(uint8 actor, bool toVault, bool delegated, uint256 raw) external {
        address who = eoa[actor % 8];
        address to = toVault ? a.vault : a.token;
        uint256 amount = bound(raw, 0, token.balanceOf(who));
        bytes memory err;
        bool ok;
        if (delegated) {
            vm.prank(who);
            token.approve(address(this), amount);
            (ok, err) = a.token.call(abi.encodeCall(token.transferFrom, (who, to, amount)));
        } else {
            vm.prank(who);
            (ok, err) = a.token.call(abi.encodeCall(token.transfer, (to, amount)));
        }
        if (ok || bytes4(err) != IBoxToken.DirectSendRefused.selector) badRestriction = true;
        else ++refusedSends;
        _observe();
    }

    function _observe() internal {
        uint256 supply = token.totalSupply();
        if (supply > previousSupply || supply < vault.supplyFloor() || supply + token.totalBurned() != 1e27) {
            badSupply = true;
        }
        previousSupply = supply;
    }

    function accountingHolds() external view returns (bool) {
        return !badAccounting && grossIn == poolSpent + taxKept + refunds
            && a.launchRouter.balance + swept == taxKept + forced && launchRouter.totalTaxCollected() == taxKept
            && launchRouter.totalSwept() == swept;
    }

    function tokenHolds() external view returns (bool) {
        return !badSupply && !badRestriction && _ghostSystemT() + _ghostOutsideT() == token.totalSupply()
            && token.totalSupply() + token.totalBurned() == 1e27 && token.totalSupply() >= vault.supplyFloor();
    }

    function graduationHolds() external view returns (bool) {
        return !badSweep && !blockedGraduation && graduations <= 1 && coordinator.graduated() == (graduations == 1)
            && coordinator.graduated() == (hook.migratedAtBlock() != 0);
    }
}

/// @notice BC-022/024/096/110/140, BC-004/005/043, F24(d), F77, IBoxToken supply invariants.
/// forge-config: default.evm_version = "osaka"
contract AuditU2LaneInvariants is Test {
    AuditU2LaneHandler internal h;

    function setUp() public {
        vm.pauseGasMetering();
        h = new AuditU2LaneHandler();
        vm.resumeGasMetering();
        h.setUp();
        targetContract(address(h));
        bytes4[] memory selectors = new bytes4[](8);
        selectors[0] = h.buy.selector;
        selectors[1] = h.advance.selector;
        selectors[2] = h.force.selector;
        selectors[3] = h.graduate.selector;
        selectors[4] = h.sweep.selector;
        selectors[5] = h.transfer.selector;
        selectors[6] = h.burn.selector;
        selectors[7] = h.prohibitedSend.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: selectors}));
    }

    function invariant_AUDIT_U2_windowWeiConservation() public view {
        assertTrue(h.accountingHolds());
    }

    function invariant_AUDIT_U2_supplyBalancesFloorAndRefusedSends() public view {
        assertTrue(h.tokenHolds());
    }

    function invariant_AUDIT_U2_sweepAndGraduation() public view {
        assertTrue(h.graduationHolds());
    }

    /// @dev Non-vacuity: every tax step, transfers, burns, refused sends, a partial close and a real sweep.
    function testProperty_AUDIT_U2_handlerReachesAllPhases() public {
        h.force(123456789);
        for (uint256 i; i < 32; ++i) {
            h.buy(0.01 ether, 0);
            if (i != 31) h.advance(12);
        }
        h.transfer(0, 1, 1 ether);
        h.burn(1, 1e12);
        h.prohibitedSend(0, true, false, 1);
        h.prohibitedSend(0, false, true, 1);
        h.buy(100 ether, 0);
        h.graduate();
        h.sweep();
        assertEq(h.buys(), 33);
        assertEq(h.partialBuys(), 1);
        assertEq(h.graduations(), 1);
        assertGt(h.swept(), 0);
        assertGt(h.successfulBurns(), 0);
        assertEq(h.refusedSends(), 2);
        invariant_AUDIT_U2_windowWeiConservation();
        invariant_AUDIT_U2_supplyBalancesFloorAndRefusedSends();
        invariant_AUDIT_U2_sweepAndGraduation();
    }
}
