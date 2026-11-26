// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BoxHookV2Base} from "../../../src/box-v2/BoxHookV2Base.sol";
import {BoxHookV2Args} from "../../../src/box-v2/libraries/BoxHookV2Args.sol";
import {ReleaseConstantsV2 as C} from "../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IListingRegistry} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {IBoxVaultV2} from "../../../src/box-v2/interfaces/IBoxVaultV2.sol";

contract PoolKeyProbe is BoxHookV2Base {
    using PoolIdLibrary for PoolKey;
    constructor() BoxHookV2Base(IPoolManager(address(1))) {}
    function ids(address q_, address t_) external view returns (bytes32 fast, bytes32 canonical, uint24 fee) {
        Args memory a;
        a.q = q_;
        a.token = t_;
        PoolKey memory key = _key(a);
        return (_poolIdOf(q_, t_), PoolId.unwrap(key.toId()), key.fee);
    }
}

contract CQ110ShapesTest is Test {
    function test_reservedVaultPayoutTopic() public pure {
        assertEq(IBoxVaultV2.ItemPayoutForwarded.selector, keccak256("ItemPayoutForwarded(address,uint256,address)"));
    }

    function testFuzz_poolIdMatchesPlainKey(address p, address t) public {
        PoolKeyProbe probe = new PoolKeyProbe();
        (bytes32 fast, bytes32 canonical, uint24 fee) = probe.ids(p, t);
        assertEq(fast, canonical);
        assertEq(fee, 10_000);
    }
    function test_releasePins() public pure {
        assertEq(C.V2_HOOK_FLAGS, 0x2AE0);
        assertEq(C.V2_POOL_FEE, 10_000);
        assertEq(C.DEPTH_BUY_SHARE_BPS, 4975);
        assertEq(C.STEP_TICKS, 49);
        assertEq(C.GRADUATION_ESCAPE_DELAY, 7 days);
    }
    function test_selectorsAndEvents() public pure {
        assertEq(IBoxHookV2.closedTResidue.selector, bytes4(keccak256("closedTResidue()")) );
        assertEq(IBoxHookV2.close.selector, bytes4(keccak256("close()")));
        assertEq(IBoxHookV2.harvest.selector, bytes4(keccak256("harvest()")));
        assertEq(IBoxHookV2.deepen.selector, bytes4(keccak256("deepen(address)")));
        assertEq(IBoxCoordinatorV2.claim.selector, bytes4(keccak256("claim(uint256,address)")));
        assertEq(IBoxReceiverV2.buyBack.selector, bytes4(keccak256("buyBack(address)")));
        assertEq(IListingRegistry.add.selector, bytes4(keccak256("add(address,uint8,uint256)")));
        assertEq(IListingRegistry.updateRaise.selector, bytes4(keccak256("updateRaise(uint32,uint256)")));
        assertEq(IBoxHookV2.PartialExactOutSale.selector, bytes4(keccak256("PartialExactOutSale()")));
        assertEq(IBoxHookV2.ReceiverCannotSell.selector, bytes4(keccak256("ReceiverCannotSell()")));
        assertEq(IBoxHookV2.ProtocolStepTaken.selector, bytes4(keccak256("ProtocolStepTaken()")));
        assertEq(IBoxHookV2.BoxFailed.selector, bytes4(keccak256("BoxFailed()")));
        assertEq(IBoxHookV2.HarvestedV2.selector, keccak256("HarvestedV2(bytes32,uint256,uint256,uint256)"));
        assertEq(IBoxHookV2.MigratedV2.selector, keccak256("MigratedV2(bytes32,uint128,uint256,uint256)"));
        assertEq(IBoxHookV2.Closed.selector, keccak256("Closed(bytes32,uint256,uint256)"));
        assertEq(IBoxHookV2.FeesSold.selector, keccak256("FeesSold(bytes32,address,uint256,uint256,uint256)"));
        assertEq(IBoxCoordinatorV2.PotFixed.selector, keccak256("PotFixed(uint256,uint256,uint256,address)"));
    }
    function test_hookArgumentsAre211Bytes() public pure {
        BoxHookV2Args.Args memory a;
        a.coordinator = address(11);
        a.receiver = address(12);
        a.tipMaxQ = 123;
        a.stepMinQ = 456;
        bytes memory encoded = BoxHookV2Args.encode(a);
        assertEq(encoded.length, 211);
        assertEq(BoxHookV2Args.TIP_MAX_Q, 179);
        assertEq(BoxHookV2Args.STEP_MIN_Q, 195);
    }
}
