// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {SepoliaAllRehearsal} from "../../../script/sepolia-v2/SepoliaAllRehearsal.sol";
import {Vm} from "forge-std/Vm.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IListingRegistry, ListingKind, ListingClass} from "../../../src/box-v2/interfaces/IListingRegistry.sol";

// RC7: the additive receiver selector changes creation-time dispatch; pins are measured on both EVMs.
contract SepoliaAllLifeTest is SepoliaAllRehearsal {
    function test_oneReleaseAllFamiliesHatchAndFailureExits() public {
        vm.recordLogs();
        _rehearse();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _transactionEnvelopes(logs);
        BoxCoordinatorV2 priced = _step(logs, "graduated box-coin price trades harvest graduate claims");
        assertTrue(priced.graduated());
        IListingRegistry listings = IListingRegistry(localFactory.listingRegistry());
        (bool listed, uint32 id) = listings.newestListingOf(priced.q());
        assertTrue(listed);
        assertEq(uint8(listings.listing(id).kind), uint8(ListingKind.BOX_TOKEN));
        _fiveOwners(logs, _step(logs, "native holders five owners trade transfer claim"));
        BoxCoordinatorV2 stock = _step(logs, "stock holders five owners trade transfer claim");
        (, id) = listings.newestListingOf(stock.q());
        assertEq(uint8(listings.listing(id).class), uint8(ListingClass.STOCK));
        _fiveOwners(logs, stock);
        BoxCoordinatorV2 eight = _step(logs, "8-decimal holders five owners trade transfer claim");
        (, id) = listings.newestListingOf(eight.q());
        assertEq(listings.listing(id).decimals, 8);
        _fiveOwners(logs, eight);
        assertTrue(_step(logs, "failed shop starter recovery and owner claim").failed());
        assertTrue(_step(logs, "7d hatch and owner claim").failed());
        assertTrue(_step(logs, "365d simulated: claims stay open").failed());
    }

    /// XR-SH-TA-33 F1: the rehearsal's every-item boxes commit the Sepolia preparation's synthetic item art
    /// (`bytes32(id)`, PrepareCoreV2Box), never the local stack's catalogue pictures (CoreV2LocalPictures).
    function test_everyItemBoxesKeepTheSepoliaPreparationArt() public pure {
        for (uint256 id = 1; id <= 10; ++id) {
            assertEq(_localItemImage(id), bytes32(id));
        }
    }

    function _transactionEnvelopes(Vm.Log[] memory logs) private {
        uint256 creations;
        uint256 starterCalls;
        uint256[13] memory creationGas;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("SepoliaTransactionGas(address,bytes4,uint256,uint256)")) continue;
            (,, uint256 envelope, uint256 gross) = abi.decode(logs[i].data, (address, bytes4, uint256, uint256));
            assertLe(envelope, 16_777_216);
            assertLe(gross, envelope);
            if (envelope > 16_500_000) {
                // Both values include the same conservative intrinsic allowance.
                uint256 used = gross - (envelope - 16_500_000);
                emit log_named_uint("release creation recipe", creations);
                emit log_named_uint("creation gas", used);
                creationGas[creations++] = used;
            }
            if (envelope == 2_000_000) ++starterCalls;
        }
        assertEq(creations, 13, "all specimens use the creation envelope");
        assertEq(starterCalls, 20, "ten single-item returns and ten exact-once retries");
        for (uint256 i; i < creationGas.length; ++i) {
            uint256 used = creationGas[i];
            assertGe(16_500_000 - used, used / 10, "release creation needs ten percent headroom");
            assertLe(used, 15_000_000, "RC6-CREATION-GAS: release creation execution ceiling");
        }
        _creationPins(creationGas);
    }

    /// RC6-CREATION-GAS: exact frame execution plus positive state charge, excluding intrinsic/refunds.
    /// Order follows _rehearse: hatch, plain, burn, box-coin P, three holders, items, pile, two shops,
    /// failed items and failed pile. Probe the EVM only after the measured chronology is complete.
    /// RC7-INBOX-PAYLOAD: removing signedCoin(bytes) makes every creation 44 gas cheaper on both EVMs.
    /// RC7-RECEIVER-QUOTA: the additive receiver selector changes creation dispatch; both rc7 changes measured together (SH-V21-RC7-INT part 3).
    function _creationPins(uint256[13] memory measured) private {
        uint256[13] memory pinned = _codeByteGas() >= STATE_GAS_PER_CODE_BYTE_MIN
            ? [uint256(7_648_551), 7_553_332, 7_555_514, 7_681_345, 12_319_643, 12_542_792, 12_552_791,
                11_019_955, 8_147_233, 14_929_015, 14_929_015, 11_020_007, 8_147_285]
            : [uint256(2_455_079), 2_440_680, 2_442_762, 2_633_093, 3_477_145, 3_684_474, 3_694_473,
                3_190_437, 2_571_221, 4_024_047, 4_024_047, 3_190_489, 2_571_273];
        for (uint256 i; i < measured.length; ++i) assertEq(measured[i], pinned[i], "release creation gas pin");
    }

    function _step(Vm.Log[] memory logs, string memory name) private pure returns (BoxCoordinatorV2) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != keccak256("RehearsalStep(string,address,uint256)")) continue;
            (string memory label, address b,) = abi.decode(logs[i].data, (string, address, uint256));
            if (keccak256(bytes(label)) == keccak256(bytes(name))) return BoxCoordinatorV2(b);
        }
        revert(string.concat("mandatory specimen missing: ", name));
    }

    function _fiveOwners(Vm.Log[] memory logs, BoxCoordinatorV2 b) private view {
        // Inspect real ledger/token events: every wallet pays itself and sends T to the next wallet.
        address ledger = b.roleAddress(17);
        address token = b.token();
        for (uint160 owner = 0xA11CE; owner < 0xA11CE + 5; ++owner) {
            bool paid;
            bool transferred;
            for (uint256 i; i < logs.length; ++i) {
                Vm.Log memory e = logs[i];
                if (e.topics[0] == keccak256("HolderPaid(uint256,address,address,uint256,uint256)")) {
                    (uint256 amount, uint256 tip) = abi.decode(e.data, (uint256, uint256));
                    if (
                        e.emitter == ledger && e.topics[2] == bytes32(uint256(owner))
                            && e.topics[3] == bytes32(uint256(owner)) && amount > 0 && tip == 0
                    ) paid = true;
                }
                if (e.emitter == token && e.topics[0] == keccak256("Transfer(address,address,uint256)")) {
                    uint160 next = owner == 0xA11CE + 4 ? 0xA11CE : owner + 1;
                    if (
                        e.topics[1] == bytes32(uint256(owner)) && e.topics[2] == bytes32(uint256(next))
                            && abi.decode(e.data, (uint256)) > 0
                    ) transferred = true;
                }
            }
            require(paid, "wallet did not claim its own P");
            require(transferred, "wallet did not transfer T");
        }
    }
}
