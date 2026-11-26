// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {M244Base} from "../../m2-44/Fixture.sol";
import {IHolderLedgerV2} from "../../../../src/box-v2/interfaces/IHolderLedgerV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";

/// F130 permits any trigger; custody and the whole payout remain with the fixed Safe.
abstract contract M263SafeCallerProperties is M244Base {
    function test_R01_F130_anyCallerPaysOnlyFixedFitSafe() public { _safeCaller(true); }
    function test_R01_F130_anyCallerPaysOnlyFixedPlatformSafe() public { _safeCaller(false); }

    function _safeCaller(bool fit) private {
        _createShop(0, 40 ether, false, true);
        _trade(); receiver.collect(address(0));
        address safe = fit ? receiver.FIT_SAFE() : receiver.PLATFORM_SAFE();
        address other = fit ? receiver.PLATFORM_SAFE() : receiver.FIT_SAFE();
        uint256 owed = fit ? receiver.fitOwed() : receiver.platformOwed();
        uint256 otherOwed = fit ? receiver.platformOwed() : receiver.fitOwed();
        uint256 backing = _pClaims(address(receiver));
        uint256 safeP = safe.balance;
        uint256 otherP = other.balance;
        uint256 callerP = ALICE.balance;
        assertEq(safe, fit ? fitSafe : address(this));
        assertTrue(ALICE != safe && ALICE != other);
        assertGt(owed, 0, "fund the permissionless entry before probing it");
        vm.prank(ALICE);
        assertEq(fit ? receiver.payFit() : receiver.payPlatform(), owed);
        assertEq(safe.balance - safeP, owed, "F130: whole payout to fixed Safe");
        assertEq(ALICE.balance, callerP, "no caller payout or tip");
        assertEq(other.balance, otherP);
        assertEq(fit ? receiver.fitOwed() : receiver.platformOwed(), 0);
        assertEq(fit ? receiver.platformOwed() : receiver.fitOwed(), otherOwed);
        assertEq(_pClaims(address(receiver)) + owed, backing);
        vm.prank(ALICE);
        assertEq(fit ? receiver.payFit() : receiver.payPlatform(), 0);
        assertEq(safe.balance - safeP, owed);
        assertEq(_pClaims(address(receiver)) + owed, backing);
    }
}

contract M263RulesFindingsTest is M263SafeCallerProperties {
    function test_R02_productionNoticeCapHasTwiceColdHistoryHeadroom() public {
        _noticeHeadroom(C.HOLDER_NOTICE_GAS);
    }

    function _noticeHeadroom(uint256 cap) private {
        _createShop(0, 40 ether, false, true);
        vm.prank(CREATOR); token.transfer(ALICE, 10000);
        for (uint256 i; i < 1024; ++i) {
            vm.prank(i % 2 == 0 ? ALICE : CREATOR);
            token.transfer(i % 2 == 0 ? CREATOR : ALICE, 1);
        }
        vm.cool(address(ledger)); vm.cool(address(token));
        vm.cool(release.implementations[17]); vm.cool(release.implementations[20]);
        // The hook is the authenticated caller double. Fresh batch storage, real ledger/history code.
        vm.prank(address(hook));
        (bool ok,) = address(ledger).call{gas: cap / 2}(
            abi.encodeCall(ledger.onTradeFeeBatch, (101, ALICE, true, 1000))
        );
        assertTrue(ok, "M2-60: cold successful notice must fit half the named production stipend");
    }
}
