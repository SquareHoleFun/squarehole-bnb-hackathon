// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {AuditU7LaneBase, BoxSpecV1, ItemReveal} from "./AuditU7LaneBase.sol";

/// @notice Maximum accepted table byte length, N=10,000, every hidden and every revealed id. The table deliberately
/// spends the byte budget on 16 maximal names, 255 values/type and the remaining description. This is one extreme
/// table shape, not a proof over every permitted table grammar. Transfer authority is impersonated solely to make
/// every id revealable for rendering; no vault solvency claim is made about this metadata-only setup.
/// One hundred bounded test shards cover 20,000 render calls per fork; each call remains fully gas-metered.
/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneMetadataGas is AuditU7LaneBase {
    function _auditN() internal pure override returns (uint256) {
        return 10_000;
    }

    function _auditSpec() internal view override returns (BoxSpecV1.BoxSpec memory s) {
        s = super._auditSpec();
        bytes memory table = new bytes(24_575);
        uint256 descriptionLength = 24_575 - 4 - 16 * (1 + 255 + 1 + 255 * 2);
        table[0] = 0x01;
        table[1] = bytes1(uint8(descriptionLength >> 8));
        table[2] = bytes1(uint8(descriptionLength & 255));
        uint256 cursor = 3;
        for (uint256 i; i < descriptionLength; ++i) {
            table[cursor++] = "D";
        }
        table[cursor++] = 0x10;
        for (uint256 t; t < 16; ++t) {
            table[cursor++] = 0xff;
            for (uint256 i; i < 255; ++i) {
                table[cursor++] = "T";
            }
            table[cursor++] = 0xff;
            for (uint256 i; i < 255; ++i) {
                table[cursor++] = 0x01;
                table[cursor++] = "V";
            }
        }
        require(cursor == table.length);
        s.metadataTable = table;
    }

    function setUp() public virtual override {
        super.setUp();
        _cacheTree();
    }

    function _renderRange(uint256 first, uint256 last) private {
        assertEq(collection.metadataTableBytes().length, 24_575);
        assertEq(collection.metadataTable().code.length, 24_576);
        assertEq(creationEvents, 2);
        assertEq(creationIds, 10_000);
        uint256 maxHidden;
        uint256 maxRevealed;
        for (uint256 id = first; id <= last; ++id) {
            // External helper bounds memory per iteration; all rendering and state writes are metered.
            (uint256 hiddenGas, uint256 revealedGas) = this.measureId(id);
            if (hiddenGas > maxHidden) maxHidden = hiddenGas;
            if (revealedGas > maxRevealed) maxRevealed = revealedGas;
        }
        emit log_named_uint("tokenURI max hidden gas in 100-id shard", maxHidden);
        emit log_named_uint("tokenURI max revealed gas in 100-id shard", maxRevealed);
        assertLt(maxHidden, 225_000);
        assertLt(maxRevealed, 7_600_000);
        assertEq(collection.revealedCount(), last - first + 1);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00001_00100() public {
        _renderRange(1, 100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00101_00200() public {
        _renderRange(101, 200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00201_00300() public {
        _renderRange(201, 300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00301_00400() public {
        _renderRange(301, 400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00401_00500() public {
        _renderRange(401, 500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00501_00600() public {
        _renderRange(501, 600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00601_00700() public {
        _renderRange(601, 700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00701_00800() public {
        _renderRange(701, 800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00801_00900() public {
        _renderRange(801, 900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_00901_01000() public {
        _renderRange(901, 1000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01001_01100() public {
        _renderRange(1001, 1100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01101_01200() public {
        _renderRange(1101, 1200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01201_01300() public {
        _renderRange(1201, 1300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01301_01400() public {
        _renderRange(1301, 1400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01401_01500() public {
        _renderRange(1401, 1500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01501_01600() public {
        _renderRange(1501, 1600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01601_01700() public {
        _renderRange(1601, 1700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01701_01800() public {
        _renderRange(1701, 1800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01801_01900() public {
        _renderRange(1801, 1900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_01901_02000() public {
        _renderRange(1901, 2000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02001_02100() public {
        _renderRange(2001, 2100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02101_02200() public {
        _renderRange(2101, 2200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02201_02300() public {
        _renderRange(2201, 2300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02301_02400() public {
        _renderRange(2301, 2400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02401_02500() public {
        _renderRange(2401, 2500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02501_02600() public {
        _renderRange(2501, 2600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02601_02700() public {
        _renderRange(2601, 2700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02701_02800() public {
        _renderRange(2701, 2800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02801_02900() public {
        _renderRange(2801, 2900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_02901_03000() public {
        _renderRange(2901, 3000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03001_03100() public {
        _renderRange(3001, 3100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03101_03200() public {
        _renderRange(3101, 3200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03201_03300() public {
        _renderRange(3201, 3300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03301_03400() public {
        _renderRange(3301, 3400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03401_03500() public {
        _renderRange(3401, 3500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03501_03600() public {
        _renderRange(3501, 3600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03601_03700() public {
        _renderRange(3601, 3700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03701_03800() public {
        _renderRange(3701, 3800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03801_03900() public {
        _renderRange(3801, 3900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_03901_04000() public {
        _renderRange(3901, 4000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04001_04100() public {
        _renderRange(4001, 4100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04101_04200() public {
        _renderRange(4101, 4200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04201_04300() public {
        _renderRange(4201, 4300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04301_04400() public {
        _renderRange(4301, 4400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04401_04500() public {
        _renderRange(4401, 4500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04501_04600() public {
        _renderRange(4501, 4600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04601_04700() public {
        _renderRange(4601, 4700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04701_04800() public {
        _renderRange(4701, 4800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04801_04900() public {
        _renderRange(4801, 4900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_04901_05000() public {
        _renderRange(4901, 5000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05001_05100() public {
        _renderRange(5001, 5100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05101_05200() public {
        _renderRange(5101, 5200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05201_05300() public {
        _renderRange(5201, 5300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05301_05400() public {
        _renderRange(5301, 5400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05401_05500() public {
        _renderRange(5401, 5500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05501_05600() public {
        _renderRange(5501, 5600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05601_05700() public {
        _renderRange(5601, 5700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05701_05800() public {
        _renderRange(5701, 5800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05801_05900() public {
        _renderRange(5801, 5900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_05901_06000() public {
        _renderRange(5901, 6000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06001_06100() public {
        _renderRange(6001, 6100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06101_06200() public {
        _renderRange(6101, 6200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06201_06300() public {
        _renderRange(6201, 6300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06301_06400() public {
        _renderRange(6301, 6400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06401_06500() public {
        _renderRange(6401, 6500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06501_06600() public {
        _renderRange(6501, 6600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06601_06700() public {
        _renderRange(6601, 6700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06701_06800() public {
        _renderRange(6701, 6800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06801_06900() public {
        _renderRange(6801, 6900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_06901_07000() public {
        _renderRange(6901, 7000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07001_07100() public {
        _renderRange(7001, 7100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07101_07200() public {
        _renderRange(7101, 7200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07201_07300() public {
        _renderRange(7201, 7300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07301_07400() public {
        _renderRange(7301, 7400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07401_07500() public {
        _renderRange(7401, 7500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07501_07600() public {
        _renderRange(7501, 7600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07601_07700() public {
        _renderRange(7601, 7700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07701_07800() public {
        _renderRange(7701, 7800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07801_07900() public {
        _renderRange(7801, 7900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_07901_08000() public {
        _renderRange(7901, 8000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08001_08100() public {
        _renderRange(8001, 8100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08101_08200() public {
        _renderRange(8101, 8200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08201_08300() public {
        _renderRange(8201, 8300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08301_08400() public {
        _renderRange(8301, 8400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08401_08500() public {
        _renderRange(8401, 8500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08501_08600() public {
        _renderRange(8501, 8600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08601_08700() public {
        _renderRange(8601, 8700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08701_08800() public {
        _renderRange(8701, 8800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08801_08900() public {
        _renderRange(8801, 8900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_08901_09000() public {
        _renderRange(8901, 9000);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09001_09100() public {
        _renderRange(9001, 9100);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09101_09200() public {
        _renderRange(9101, 9200);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09201_09300() public {
        _renderRange(9201, 9300);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09301_09400() public {
        _renderRange(9301, 9400);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09401_09500() public {
        _renderRange(9401, 9500);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09501_09600() public {
        _renderRange(9501, 9600);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09601_09700() public {
        _renderRange(9601, 9700);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09701_09800() public {
        _renderRange(9701, 9800);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09801_09900() public {
        _renderRange(9801, 9900);
    }

    function testProperty_AUDIT_U7_tokenURI_ids_09901_10000() public {
        _renderRange(9901, 10000);
    }

    function measureId(uint256 id) external returns (uint256 hiddenGas, uint256 revealedGas) {
        require(msg.sender == address(this));
        hiddenGas = _measure(id);
        vm.prank(a.vault);
        collection.transferFrom(a.vault, eoa[0], id);
        ItemReveal memory r = _data(id);
        collection.reveal(id, r.traitsPacked, r.imageHash, r.avatarHash, r.modelHash, r.salt, r.proof);
        revealedGas = _measure(id);
    }

    function _measure(uint256 id) private returns (uint256 used) {
        address table = collection.metadataTable();
        vm.cool(table);
        vm.cool(a.collection);
        uint256 g = gasleft();
        string memory uri = collection.tokenURI(id);
        used = g - gasleft();
        bytes memory b = bytes(uri);
        assertGt(b.length, 29);
        assertEq(bytes1(b[0]), bytes1("d"));
        assertEq(bytes1(b[28]), bytes1(",")); // data:application/json;base64,
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU7LaneMetadataGasAmsterdam is AuditU7LaneMetadataGas {}

/// @notice Batch gas with the actual stream, measured on the identical starting state at k=1,2,4,8,16,32.
/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneBatchGas is AuditU7LaneBase {
    uint256[] internal batchIds;

    function setUp() public virtual override {
        super.setUp();
        _cacheTree();
        _toBonding();
        uint256 first = _take(eoa[0], 32);
        _toGraduated();
        _advance(1);
        _post(r0);
        tickets.acceptGraduationWord();
        for (uint256 i; i < 32; ++i) {
            uint256 ticket = first + i;
            uint256 id = tickets.numberOf(ticket);
            ItemReveal memory r = _data(id);
            vm.prank(eoa[0]);
            tickets.open(ticket, r);
            batchIds.push(id);
        }
        vm.prank(eoa[0]);
        collection.setApprovalForAll(a.vault, true);
        _approveT(eoa[0], a.vault);
    }

    function testProperty_AUDIT_U7_batchGasLinearEnvelope() public {
        uint256 snapshot = vm.snapshotState();
        uint256 previousReturn;
        uint256 previousPick;
        uint256 previousK;
        uint256 largestReturnSlope;
        uint256 largestPickSlope;
        for (uint256 k = 1; k <= 32; k *= 2) {
            uint256[] memory ids = new uint256[](k);
            for (uint256 i; i < k; ++i) {
                ids[i] = batchIds[i];
            }
            vm.prank(eoa[0]);
            uint256 start = gasleft();
            vault.returnItems(ids, 0, block.timestamp);
            uint256 returnGas = start - gasleft();
            vm.prank(eoa[0]);
            start = gasleft();
            vault.withdrawBatch(ids, type(uint256).max, block.timestamp);
            uint256 pickGas = start - gasleft();
            emit log_named_uint(string.concat("return gas k=", vm.toString(k)), returnGas);
            emit log_named_uint(string.concat("pick gas k=", vm.toString(k)), pickGas);
            assertLt(returnGas, 400_000 + 100_000 * k);
            assertLt(pickGas, 400_000 + 160_000 * k);
            if (previousK != 0) {
                assertGt(returnGas, previousReturn);
                assertGt(pickGas, previousPick);
                uint256 rs = (returnGas - previousReturn + k - previousK - 1) / (k - previousK);
                uint256 ps = (pickGas - previousPick + k - previousK - 1) / (k - previousK);
                if (rs > largestReturnSlope) largestReturnSlope = rs;
                if (ps > largestPickSlope) largestPickSlope = ps;
            }
            previousK = k;
            previousReturn = returnGas;
            previousPick = pickGas;
            assertTrue(vm.revertToState(snapshot));
        }
        emit log_named_uint("maximum measured return slope gas/item", largestReturnSlope);
        emit log_named_uint("maximum measured pick slope gas/item", largestPickSlope);
        assertLt(largestReturnSlope, 100_000);
        assertLt(largestPickSlope, 160_000);
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU7LaneBatchGasAmsterdam is AuditU7LaneBatchGas {}
