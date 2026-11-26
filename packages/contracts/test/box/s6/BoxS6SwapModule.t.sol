// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {BoxSwapModule} from "../../../src/box/BoxSwapModule.sol";
import {IBoxPriceAverage} from "../../../src/box/interfaces/IBoxHook.sol";
import {IBoxSwapModule} from "../../../src/box/interfaces/IBoxSwapModule.sol";
import {BoxS6Base} from "./BoxS6Base.sol";
import {HostileModule} from "./BoxS6Mocks.sol";

/// @notice S5.M2 on the assembled core the way S7's factory will build it (swap-module § 6, § 12 row S7): the real
/// coordinator CREATEs the module clone at the nonce after the last role, the factory (this test) names its predicted
/// address in the receiver's arguments, and the box's own price sampler is the coordinator's clone too. A Standard box
/// with the default buyers' side (BUYBACK_BURN_T) then launches, graduates through the coordinator's own pokes, trades,
/// collects, and the module buys and burns T and sells FIT's T share, its Q paid to FIT's executor. What S7 adds is
/// the factory computing these codes and the registry recording the module's code hash; no core change is needed.
contract BoxS6SwapModuleTest is BoxS6Base {
    function setUp() public {
        _setUpWorld();
    }

    function test_S5M2_theCoordinatorCreatesTheModuleAndTheCoreRunsItEndToEnd() public {
        Params memory p = _standardParams();
        (p.qStream, p.realModule) = (BoxSpecV1.Q_STREAM_BUYBACK_BURN_T, true);
        Box memory b = _buildAndLaunch(p);
        BoxSwapModule m = BoxSwapModule(b.module);
        assertEq(b.module.code.length, 45 + 102, "the coordinator created the module clone");
        assertEq(_recv(b).swapModule(), b.module, "named in the receiver's arguments");
        assertTrue(m.lastStepBlock() == 0 && !m.graduationSeen());
        (address r,,, address h) = m.wiring();
        assertEq(r, b.receiver);
        assertEq(h, address(b.hook));
        _skipWindow(b);
        _close(b, carol);
        b.coord.graduate();
        assertTrue(_recv(b).graduationSettled(), "the coordinator's poke settled the receiver");
        // Our keeper pokes the sampler right after graduation (swap-module § 4.6): its window starts at P1.
        IBoxPriceAverage(b.average).poke();
        // Trades after graduation make both fee sides.
        for (uint256 i; i < 3; ++i) {
            (uint256 tOut,) = _buy(b, alice, 3 ether, 0);
            _sell(b, alice, tOut);
        }
        _recv(b).collect(keeper);
        // An hour of samples: the average follows the price the trades left.
        for (uint256 i; i < 301; ++i) {
            _roll(1);
            IBoxPriceAverage(b.average).poke();
        }
        uint256 supply0 = b.t.totalSupply();
        (IBoxSwapModule.Stop stop,, uint256 bought,) = m.step(IBoxSwapModule.Action.BuyBurn, keeper);
        assertEq(uint256(stop), uint256(IBoxSwapModule.Stop.None), "the buy-back step ran");
        assertEq(supply0 - b.t.totalSupply(), bought - 1, "bought T burned (1 raw unit kept)");
        _roll(1);
        uint256 fit0 = _recv(b).fitOwed();
        (IBoxSwapModule.Stop stop2,, uint256 qOut, uint256 tip) = m.step(IBoxSwapModule.Action.SellForFit, keeper);
        assertEq(uint256(stop2), uint256(IBoxSwapModule.Stop.None), "the W4 sell step ran");
        assertEq(_recv(b).fitOwed() - fit0, qOut - tip, "its Q booked to FIT");
        HostileModule ex = HostileModule(payable(b.executor));
        uint256 paid = _recv(b).payFit();
        assertEq(ex.fundedBudget(), paid, "FIT's executor's fundBudget() received it");
    }
}
