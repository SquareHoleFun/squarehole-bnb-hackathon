// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxPhase} from "../../../src/box/interfaces/BoxTypes.sol";
import {BoxS6Base} from "./BoxS6Base.sol";

contract BoxS6SmokeTest is BoxS6Base {
    function setUp() public {
        _setUpWorld();
    }

    function test_smoke_box0() public {
        Box memory b = _buildAndLaunch(_box0Params());
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Upcoming));
        _skipWindow(b);
        _close(b, carol);
        vm.prank(keeper);
        uint256 reward = b.coord.graduate();
        assertEq(reward, b.hook.reserveCap());
        assertEq(uint256(b.coord.phase()), uint256(BoxPhase.Graduated));
    }

    function test_smoke_standard() public {
        Box memory b = _buildAndLaunch(_creatorParams(carol));
        _skipWindow(b);
        _close(b, carol);
        vm.prank(keeper);
        b.coord.graduate();
        assertTrue(_recv(b).graduationSettled());
    }
}
