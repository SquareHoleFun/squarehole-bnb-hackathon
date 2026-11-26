// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxKind, BoxPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {FeeBatch} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxS45Base} from "./BoxS45Base.sol";

/// @notice A whole life, box 0 and a standard box: launch, window, bonding, the closing buy, graduation, batches.
contract BoxLifecycleTest is BoxS45Base {
    using StateLibrary for IPoolManager;

    function setUp() public {
        _setUpWorld();
    }

    function test_lifecycle_box0() public {
        Params memory p = _box0Params();
        Box memory b = _buildAndLaunch(p);
        assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Upcoming), "upcoming");
        assertEq(_sqrtP(b) < b.curve.sqrtPriceUpperX96, true, "bootstrap moved the price");
        assertGt(b.coord.bootstrapTokensBurned(), 0, "bootstrap T burned");
        _roll(1);
        assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Window), "window");
        _skipWindow(b);
        assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Bonding), "bonding");
        (uint256 tOut,) = _buy(b, alice, 1 ether, 0);
        assertGt(tOut, 0, "bought");
        _sell(b, alice, tOut / 2);
        FeeBatch memory fb = b.receiver.collect(keeper);
        assertGt(fb.q, 0, "batch");
        assertEq(fb.qToReserve, b.hook.reserveCap(), "reserve topped up first");
        _close(b, bob);
        assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Closed), "closed");
        b.coord.graduate();
        assertEq(uint256(b.hook.phase()), uint256(BoxPhase.Graduated), "graduated");
        assertEq(_sqrtP(b), b.curve.sqrtPriceLowerX96, "at P1");
        assertTrue(b.receiver.graduationSettled(), "settled");
        (uint128 ask, uint128 bid, uint128 sentinel) = b.hook.graduatedLayout();
        assertGt(ask, 0);
        assertGt(bid, 0);
        assertGt(sentinel, 0);
        _buy(b, alice, 1 ether, 0);
        b.receiver.collect(keeper);
        assertGt(b.receiver.fitOwed(), 0, "FIT share");
        b.receiver.payFit();
        assertGt(b.receiver.platformOwed(), 0, "platform share");
        b.receiver.payPlatform();
        assertGt(safe.balance, 0, "Safe paid");
    }

    function test_lifecycle_standard() public {
        Params memory p = _creatorParams(address(0), carol);
        Box memory b = _buildAndLaunch(p);
        _skipWindow(b);
        (uint256 tOut,) = _buy(b, alice, 1 ether, 0);
        _sell(b, alice, tOut / 2);
        b.receiver.collect(keeper);
        (uint256 hq, uint256 ht) = b.receiver.creatorHeld();
        assertGt(hq, 0, "held Q");
        assertGt(ht, 0, "held T");
        // The 2/15 depth parts wait in the receiver until graduation (BC-109), then move to the hook's claims.
        (uint256 dq, uint256 dt) = b.receiver.depthHeld();
        assertGt(dq, 0, "depth Q held");
        assertGt(dt, 0, "depth T held");
        (uint256 hq0, uint256 ht0) = b.hook.depthBudget();
        assertEq(hq0 | ht0, 0, "nothing in the hook's depth budget before graduation");
        _closeAndGraduate(b);
        (uint256 hq1, uint256 ht1) = b.hook.depthBudget();
        assertGe(hq1, dq, "the held Q moved at the settlement");
        assertGe(ht1, dt, "the held T moved at the settlement");
        (dq, dt) = b.receiver.depthHeld();
        assertEq(dq | dt, 0, "nothing held after the settlement");
        (uint256 oq, uint256 ot) = b.receiver.creatorOwed();
        assertGe(oq, hq, "released");
        assertGe(ot, ht, "released T");
        vm.prank(carol);
        b.receiver.claimCreator(carol);
        assertGt(carol.balance, 0, "creator paid in Q");
        assertGt(b.t.balanceOf(carol), 0, "creator paid in T");
    }
}
