// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {BackedSourcePins} from "../../../src/box/randomness/BackedSourcePins.sol";
import {S0StateDiff} from "../../spikes/S0StateDiff.sol";
import {BoxS7Base} from "./BoxS7Base.sol";

/// @notice BC-068 (creation gas measured) and the version's deployment gas (slice S7), today (Osaka) and under
/// Glamsterdam (`vm.setEvmVersion("amsterdam")`, Foundry 1.8.3's snapshot of EIP-8037/8038, no state-gas reservoir;
/// SH-S0-spikes § 2.4). Method as SH-core-wave-2's CoreBox0Gas: `gasleft()` deltas in the caller's frame (under
/// `amsterdam` they include the state gas), the new accounts, code bytes and slots counted beside each (S0StateDiff),
/// state gas = slots × 97,920 + accounts × 183,600 + code bytes × 1,530 (EIP-8037). Each transaction's intrinsic cost
/// is added from its calldata (21,000, 32,000 for a creation, 4 per zero and 16 per other byte, 2 per init-code word;
/// today's rules; Glamsterdam's intrinsic changes, EIP-2780, are not modelled). Lines are logged as
/// `S7|<what>|<today|glamsterdam>|...` and collected in docs/evidence/SH-S7-factory.md.
/// forge-config: default.evm_version = "osaka"
contract BoxFactoryV1GasTest is BoxS7Base {
    uint256 internal constant TX_GAS_CAP = 16_777_216;
    uint256 internal constant STATE_GAS_PER_SLOT = 97_920;
    uint256 internal constant STATE_GAS_PER_ACCOUNT = 183_600;
    uint256 internal constant STATE_GAS_PER_CODE_BYTE = 1_530;

    // ============================================================================================================
    // BC-068: box 0's creation with the smallest and the largest box data, under both schedules

    function test_BC068_creationGas_today() public {
        _creations(false);
    }

    function test_BC068_creationGas_glamsterdam() public {
        _creations(true);
    }

    /// @dev Box 0's fixture (with its per-item stream since the S7 × S8 integration), the full Misfit trait table (F75
    /// W1), the smallest data and the largest (a 24,575-byte table, every text and the hidden SVG at its limit, eight
    /// add-ons, the most validate() takes). Under Glamsterdam every one's
    /// execution gas (the total less the state gas, which EIP-8037 keeps outside the cap) stays under EIP-7825's cap.
    /// Today box 0's three stay within the cap with 1,000,000 to spare; **the largest does not** (finding, measured:
    /// 16.33M with its intrinsic cost, inside the cap but not with the margin; `test_BC068_largestTableThatFitsToday`
    /// finds the largest table that does): version 1 creates only box 0, so this binds version 2 (S11) before
    /// Glamsterdam reaches mainnet.
    function _creations(bool glamsterdam) internal {
        bool enteredAmsterdam = keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
        BoxSpecV1.BoxSpec[4] memory specs;
        string[4] memory labels = [
            "box 0, the fixture",
            "box 0, every Misfit trait (3,341-byte table)",
            "smallest box data",
            "largest box data"
        ];
        specs[0] = _box0Spec();
        specs[1] = _box0Spec();
        specs[1].metadataTable =
            vm.parseJsonBytes(vm.readFile("test/vectors/box/misfits-trait-table-r7.json"), ".table");
        specs[2] = _smallest();
        specs[3] = _largest();
        for (uint256 i; i < specs.length; ++i) {
            assertEq(factory.refusal(specs[i], address(this)).length, 0, labels[i]);
            uint256 snap = vm.snapshotState();
            bytes32 salt = _salt(specs[i]);
            bytes memory callData = abi.encodeCall(factory.createBox, (specs[i], salt, _executorCode()));
            vm.deal(address(this), 1 ether);
            vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
            vm.cool(address(factory));
            vm.cool(address(registry));
            vm.cool(address(planner));
            vm.cool(address(pm));
            vm.startStateDiffRecording();
            uint256 g = this.measureCreate(callData);
            S0StateDiff.Counts memory c = S0StateDiff.count(vm.stopAndReturnStateDiff());
            uint256 intrinsic = 21_000 + _calldataGas(callData);
            uint256 state = _stateGas(c);
            _log(string.concat("createBox: ", labels[i]), glamsterdam, g, intrinsic, c, state);
            if (i == 3) {
                assertEq(specs[i].metadataTable.length, 24_575, "the full table in both schedules");
                // Pin the two schedules beside each other; only execution gas is capped after EIP-8037.
                // Foundry 1.8.3 retains the higher CREATE word charge when switching down from
                // CLI Amsterdam to Osaka: 9,222 extra gas here. Pin that harness variant too.
                uint256 beforeFork = enteredAmsterdam ? 16_575_741 : 16_566_519;
                assertEq(g + intrinsic, glamsterdam ? 86_683_091 : beforeFork, "largest-data total gas");
                if (glamsterdam) assertEq(g - state + intrinsic, 6_243_341, "largest-data execution gas");
            }
            if (!glamsterdam && i < 3) {
                assertLe(g + intrinsic, TX_GAS_CAP - 1_000_000, "today: within EIP-7825 with 1M to spare");
            } else if (!glamsterdam) {
                // Finding: inside the cap, but not with the 1,000,000 margin BC-068 asks for (and forge's default 130%
                // estimate multiplier would set a limit above the cap).
                assertGt(g + intrinsic, TX_GAS_CAP - 1_000_000, "finding: the largest data leaves less than 1M");
                assertLe(g + intrinsic, TX_GAS_CAP, "the largest data still fits the cap itself");
            } else {
                assertLe(g - state + intrinsic, TX_GAS_CAP, "Glamsterdam: execution gas under EIP-7825's cap");
            }
            vm.setEvmVersion("osaka");
            vm.revertToState(snap);
        }
    }

    /// BC-068 (finding): the largest metadata table a creation takes today within EIP-7825's cap with 1,000,000 to
    /// spare, (a) with box 0's own texts and add-ons, (b) with every text, the hidden SVG and the add-ons at their limits
    /// (a table of only a description, its length searched). With box 0's texts the whole 24,575 bytes fit; with every
    /// text at its limit they do not (a version-2 matter, S11, while Glamsterdam is not on mainnet).
    function test_BC068_largestTableThatFitsToday() public {
        bool enteredAmsterdam = keccak256(bytes(vm.getEvmVersion())) == keccak256("amsterdam");
        vm.setEvmVersion("osaka"); // The pre-EIP-8037 bound; _creations(true) checks Amsterdam separately.
        uint256 withBox0Texts = _largestFitting(false);
        uint256 withLargestTexts = _largestFitting(true);
        emit log_string(string.concat(
                "S7|largest table that fits today with 1M to spare|box 0's texts ",
                vm.toString(withBox0Texts),
                "|every text at its limit ",
                vm.toString(withLargestTexts)
            ));
        assertEq(withBox0Texts, 24_575, "with box 0's texts any table fits");
        // The down-switched runner retains CREATE's higher word charge (see _creations).
        assertEq(withLargestTexts, enteredAmsterdam ? 23_253 : 23_279, "before EIP-8037: 1M margin");
        // _creations(true) pins the full 24,575-byte table at 6,243,341 execution gas after the fork.
    }

    function _largestFitting(bool largestTexts) internal returns (uint256 lo) {
        // The hook's salt follows openAt only (BC-064), the same in every round: mined once here.
        bytes32 salt = _salt(_box0Spec());
        // The largest table first: when it fits there is nothing to search.
        if (_fitsToday(24_575, largestTexts, salt)) return 24_575;
        lo = 4;
        uint256 hi = 24_574;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (_fitsToday(mid, largestTexts, salt)) lo = mid;
            else hi = mid - 1;
        }
    }

    function _fitsToday(uint256 tableBytes, bool largestTexts, bytes32 salt) internal returns (bool fits) {
        // Every round's spec and calldata are dropped at its end: reset the free memory pointer (nothing is kept).
        uint256 fmp;
        assembly ("memory-safe") {
            fmp := mload(0x40)
        }
        uint256 snap = vm.snapshotState();
        // The search replaces the table, so the largest data is built without its 24,575-byte table here.
        BoxSpecV1.BoxSpec memory s = largestTexts ? _largestData(false) : _box0Spec();
        bytes memory desc = bytes(_text(tableBytes - 4));
        s.metadataTable = abi.encodePacked(uint8(1), uint16(desc.length), desc, uint8(0));
        bytes memory callData = abi.encodeCall(factory.createBox, (s, salt, _executorCode()));
        vm.deal(address(this), 1 ether);
        fits = this.measureCreate(callData) + 21_000 + _calldataGas(callData) <= TX_GAS_CAP - 1_000_000;
        vm.revertToState(snap);
        assembly ("memory-safe") {
            mstore(0x40, fmp)
        }
    }

    // ============================================================================================================
    // The version's deployment (the script's steps), under both schedules

    function test_versionDeploymentGas_today() public {
        _deployment(false);
    }

    function test_versionDeploymentGas_glamsterdam() public {
        _deployment(true);
    }

    /// @dev A second, fresh deployment of the version (both sources removed first, so their deterministic deployments
    /// are measured too), then box 0 through it; every step logged with its init code's intrinsic cost.
    function _deployment(bool glamsterdam) internal {
        (address pinned,) = DrandSourcePins.pinned(1);
        vm.etch(pinned, "");
        vm.resetNonce(pinned);
        (address backed,) = BackedSourcePins.pinned(1);
        vm.etch(backed, "");
        vm.resetNonce(backed);
        uint256 first = _coreV1Steps.length;
        vm.setEvmVersion(glamsterdam ? "amsterdam" : "osaka");
        CoreV1Version memory v = _deployCoreV1(_config());
        factory = BoxFactoryV1(v.factory);
        _create(_box0Spec());
        vm.setEvmVersion("osaka");
        uint256 total;
        uint256 totalIntrinsic;
        for (uint256 i = first; i < _coreV1Steps.length; ++i) {
            CoreV1Step memory s = _coreV1Steps[i];
            uint256 intrinsic =
                s.initCodeBytes == 0 ? 0 : 21_000 + 32_000 + s.initCodeBytes * 16 + ((s.initCodeBytes + 31) / 32) * 2;
            total += s.gas;
            totalIntrinsic += intrinsic;
            emit log_string(string.concat(
                    "S7|deploy: ",
                    s.label,
                    glamsterdam ? "|glamsterdam total " : "|today ",
                    vm.toString(s.gas),
                    "|intrinsic (upper bound) ",
                    vm.toString(intrinsic),
                    "|code bytes ",
                    vm.toString(s.at.code.length)
                ));
        }
        emit log_string(string.concat(
                "S7|deploy: all steps",
                glamsterdam ? "|glamsterdam total " : "|today ",
                vm.toString(total),
                "|intrinsic (upper bound) ",
                vm.toString(totalIntrinsic)
            ));
    }

    // ------------------------------------------------------------------------------------------------------------
    // Box data at its smallest and largest

    /// @dev Box 0 with the least data: a 4-byte table (version, empty description, no types), one-byte names, empty
    /// texts, a one-byte hidden picture, no royalties, specials or collection page; template 0's two add-ons only (the
    /// placeholders and the per-item stream, which takes no parameter).
    function _smallest() internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = _box0Spec();
        s.tokenName = "M";
        s.tokenSymbol = "M";
        s.collectionName = "M";
        s.collectionSymbol = "M";
        s.description = "";
        s.metadataTable = hex"01000000";
        BoxSpecV1.AddOn[] memory addOns = new BoxSpecV1.AddOn[](2);
        addOns[0] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_PLACEHOLDERS, params: abi.encode("M", "M", "", "", "x")});
        addOns[1] = _streamAddOn();
        s.addOns = addOns;
    }

    /// @dev Box 0 with the most data: a 24,575-byte table (16 types), every text and the hidden SVG at its limit, the
    /// per-item stream, four edition specials, royalties and the collection page with four teasers and a 128-byte link
    /// (eight add-ons, BoxSpecV1.MAX_ADD_ONS; before the S7 × S8 integration five specials and no stream).
    function _largest() internal view returns (BoxSpecV1.BoxSpec memory) {
        return _largestData(true);
    }

    function _largestData(bool withTable) internal view returns (BoxSpecV1.BoxSpec memory s) {
        s = _box0Spec();
        s.tokenName = _text(32);
        s.tokenSymbol = _text(11);
        s.collectionName = _text(32);
        s.collectionSymbol = _text(11);
        s.description = _text(1024);
        if (withTable) s.metadataTable = _largestTable();
        BoxSpecV1.AddOn[] memory addOns = new BoxSpecV1.AddOn[](8);
        addOns[0] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_PLACEHOLDERS,
            params: abi.encode(_text(32), _text(11), _text(1024), _text(1024), _text(4096))
        });
        addOns[1] = _streamAddOn();
        for (uint256 i = 1; i <= 4; ++i) {
            addOns[i + 1] =
                BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_EDITION_SPECIALS, params: abi.encode(_text(32), uint32(i))});
        }
        addOns[6] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_ROYALTIES, params: abi.encode(uint16(500), BoxSpecV1.ROYALTY_DESTINATION_FEE_HANDLING)
        });
        bytes32[] memory teasers = new bytes32[](4);
        for (uint256 i; i < 4; ++i) {
            teasers[i] = keccak256(abi.encode("teaser", i));
        }
        addOns[7] = BoxSpecV1.AddOn({
            id: BoxSpecV1.ADD_ON_COLLECTION_METADATA,
            params: abi.encode(keccak256("banner"), teasers, string.concat("https://", _text(120)))
        });
        s.addOns = addOns;
    }

    /// @dev Box 0's per-item-stream add-on as the fixture carries it.
    function _streamAddOn() internal view returns (BoxSpecV1.AddOn memory) {
        BoxSpecV1.BoxSpec memory f = _fixture();
        for (uint256 i; i < f.addOns.length; ++i) {
            if (f.addOns[i].id == BoxSpecV1.ADD_ON_PER_ITEM_STREAM) return f.addOns[i];
        }
        revert("s7: the fixture carries add-on 2");
    }

    /// @dev 0x01, a 411-byte description, 16 types named with 8 bytes, 375 values of 63 bytes (23 per type, 30 in the
    /// last): 4 + 411 + 16 × 10 + 375 × 64 = 24,575 bytes.
    function _largestTable() internal pure returns (bytes memory t) {
        bytes memory desc = bytes(_text(411));
        t = abi.encodePacked(uint8(1), uint16(desc.length), desc, uint8(16));
        bytes memory value = bytes(_text(63));
        for (uint256 i; i < 16; ++i) {
            uint256 count = i == 15 ? 30 : 23;
            bytes memory typ = abi.encodePacked(uint8(8), "TraitTy", bytes1(uint8(65 + i)), uint8(count));
            for (uint256 j; j < count; ++j) {
                typ = bytes.concat(typ, abi.encodePacked(uint8(63), value));
            }
            t = bytes.concat(t, typ);
        }
        require(t.length == 24_575, "the largest table");
    }

    function _text(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i; i < n; ++i) {
            b[i] = bytes1(uint8(97 + (i % 26)));
        }
        return string(b);
    }

    /// @notice The creation's gas in a frame of its own (fresh memory, the calldata as a transaction would carry it),
    /// less the call's value-transfer surcharge (9,000; a transaction's value is paid by its intrinsic cost).
    function measureCreate(bytes calldata callData) external returns (uint256 g) {
        address f = address(factory);
        uint256 g0 = gasleft();
        (bool ok,) = f.call{value: BoxSpecV1.BOOTSTRAP_ETH}(callData);
        g = g0 - gasleft() - 9_000;
        require(ok, "createBox");
    }

    function _calldataGas(bytes memory data) internal pure returns (uint256 g) {
        for (uint256 i; i < data.length; ++i) {
            g += data[i] == 0 ? 4 : 16;
        }
    }

    function _stateGas(S0StateDiff.Counts memory c) internal pure returns (uint256) {
        return
            c.newSlots * STATE_GAS_PER_SLOT + c.accounts * STATE_GAS_PER_ACCOUNT + c.codeBytes * STATE_GAS_PER_CODE_BYTE;
    }

    function _log(
        string memory label,
        bool glamsterdam,
        uint256 g,
        uint256 intrinsic,
        S0StateDiff.Counts memory c,
        uint256 state
    ) internal {
        emit log_string(string.concat(
                "S7|",
                label,
                glamsterdam ? "|glamsterdam total " : "|today ",
                vm.toString(g),
                "|intrinsic ",
                vm.toString(intrinsic),
                "|new slots ",
                vm.toString(c.newSlots),
                "|accounts ",
                vm.toString(c.accounts),
                "|code bytes ",
                vm.toString(c.codeBytes),
                glamsterdam ? string.concat("|of which state gas ", vm.toString(state)) : ""
            ));
    }
}
