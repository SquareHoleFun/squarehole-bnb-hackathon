// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {CoreBox0Kit, CoreBoxAddresses} from "../../conformance/core/CoreBox0Kit.sol";
import {EthClaimsMinter, MockWETH} from "../../s45/BoxS45Mocks.sol";
import {ClaimsFunder} from "../../../utils/ClaimsFunder.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxReceiver} from "../../../../src/box/BoxReceiver.sol";
import {BoxCoordinator} from "../../../../src/box/BoxCoordinator.sol";
import {BoxToken} from "../../../../src/box/BoxToken.sol";
import {BoxHook} from "../../../../src/box/BoxHook.sol";
import {BoxRoyaltyRouter} from "../../../../src/box/BoxRoyaltyRouter.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";
import {FeeBatch, ModuleProceedsTo, RoyaltyDestination} from "../../../../src/box/interfaces/BoxTypes.sol";

/// @notice Factory/mainnet box 0; no replacement receiver, coordinator, hook, token or PoolManager.
/// Claims helpers deposit real ETH/FIT into the real PoolManager; they do not overwrite its balances.
/// CoreBox0Kit's local WETH is the only routine external-asset stand-in. No fork or network is used.
abstract contract AuditU4LaneBase is Test {
    using TransientStateLibrary for IPoolManager;

    CoreBox0Kit internal kit;
    CoreBoxAddresses internal a;
    IPoolManager internal pm;
    BoxReceiver internal r;
    BoxCoordinator internal coordinator;
    BoxToken internal token;
    BoxRoyaltyRouter internal royalty;
    EthClaimsMinter internal minter;
    ClaimsFunder internal funder;
    address internal tipper = address(0xA114);

    struct Totals {
        uint256 fit;
        uint256 platform;
        uint256 depthQ;
        uint256 depthT;
        uint256 burned;
        uint256 creatorQ;
        uint256 creatorT;
    }

    function setUp() public virtual {
        vm.pauseGasMetering();
        kit = new CoreBox0Kit();
        vm.resumeGasMetering();
        kit.setUpWorld();
        BoxSpecV1.BoxSpec memory spec = abi.decode(
            vm.parseJsonBytes(vm.readFile("test/vectors/box-spec/box-spec-v1.json"), ".columns.encoded[0]"),
            (BoxSpecV1.BoxSpec)
        );
        kit.build(spec);
        a = kit.addresses();
        pm = kit.pm();
        r = BoxReceiver(payable(a.receiver));
        coordinator = BoxCoordinator(a.coordinator);
        token = BoxToken(a.token);
        royalty = BoxRoyaltyRouter(payable(a.royaltyRouter));
        minter = new EthClaimsMinter(pm);
        funder = new ClaimsFunder(pm);
        vm.deal(address(this), 1e30);
    }

    function _closed() internal {
        kit.toClosed();
        r.collect(tipper);
        _balanced();
    }

    function _graduate() internal {
        _closed();
        coordinator.graduate();
        assertTrue(r.graduationSettled());
        _balanced();
    }

    function _q(uint256 amount) internal {
        minter.mintTo{value: amount}(a.receiver);
    }

    function _t(uint256 amount) internal {
        // These are existing issued FIT, bought by the kit's carol while filling the curve.
        assertEq(funder.deposit(a.token, kit.carol(), amount, a.receiver), amount);
    }

    function _totals() internal view returns (Totals memory t) {
        (t.fit, t.platform, t.depthQ, t.depthT, t.burned, t.creatorQ, t.creatorT) = r.totals();
    }

    function _balanced() internal view {
        (uint256 cq, uint256 ct) = r.carried();
        (uint256 dq, uint256 dt) = r.depthHeld();
        (uint256 bq, uint256 bt) = r.booked();
        assertEq(bq, r.fitOwed() + r.platformOwed() + r.platformHeld() + dq + cq, "Q ledger sum");
        assertEq(bt, dt + ct, "T ledger sum");
        assertGe(pm.balanceOf(a.receiver, 0), bq, "Q backing");
        assertGe(pm.balanceOf(a.receiver, uint256(uint160(a.token))), bt, "T backing");
        assertEq(token.balanceOf(a.receiver), r.tBurnPending(), "pending burns are real FIT");
        assertLt(cq, 15);
        assertLt(ct, 15);
        assertEq(pm.getNonzeroDeltaCount(), 0, "no open PM delta");
        assertFalse(pm.isUnlocked(), "PM relocked");
        assertEq(pm.currencyDelta(a.receiver, Currency.wrap(address(0))), 0);
        assertEq(pm.currencyDelta(a.receiver, Currency.wrap(a.token)), 0);
    }

    receive() external payable {}
}
