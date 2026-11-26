// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Mutate production only; preserve the independent per-account behavioral oracle.
import {HostileItemClaimsTest, ClaimActor} from "../m3-21/HostileClaims.t.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

contract M362Hostile is HostileItemClaimsTest {
    function test_insufficientOuterGasPreservesCreditBeforePayout() public {
        _funded(100);
        ClaimActor recipient = new ClaimActor();
        recipient.configure(0, true, address(0), "");
        vm.prank(ALICE);
        vm.expectRevert(bytes4(keccak256("GasTooLow()")));
        ledger.claim{gas: 700_000}(_ids(1), address(recipient));
        assertEq(_credit(1), 100);
        assertEq(address(recipient).balance, 0);
        _conserved();
    }

    function test_exhaustingRecipientCannotReceiveMoreThanNamedClaimGas() public {
        _funded(100);
        ClaimActor recipient = new ClaimActor();
        recipient.configure(0, true, address(0), "");
        uint64 stipend = uint64(ledger.CLAIM_GAS());
        vm.expectCall(
            address(pm), 0, stipend,
            abi.encodeCall(IPoolManager.unlock, (abi.encode(address(recipient), uint256(100), false))), uint64(1)
        );
        vm.prank(ALICE);
        vm.expectRevert(PAYOUT_FAILED);
        // Entry/replay work precedes the cap + EIP-150 + overhead + retained-reserve check.
        // Supply the measured owner-claim envelope so this case reaches the exhausting recipient.
        ledger.claim{gas: 3_500_000}(_ids(1), address(recipient));
        assertEq(_credit(1), 100);
        assertEq(address(recipient).balance, 0);
        _conserved();
        // A refused recipient cannot strand the owner's credit.
        vm.prank(ALICE);
        assertEq(ledger.claim(_ids(1), ALICE), 100);
        _debitModel(1, ALICE, 100);
        assertEq(_credit(1), 0);
        _conserved();
    }
}
