// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetConversionFixture} from "./SetConversionFixture.sol";
import {SetPricingVectors} from "./SetPricingVectors.sol";

contract SetConversionOracleTest is SetConversionFixture {
    function test_bigintTraceOnePercent() public {
        _trace(0, 100);
    }

    function test_bigintTraceFivePercent() public {
        _trace(1, 500);
    }

    function test_bigintTraceTwentyFivePercent() public {
        _trace(2, 2500);
    }

    function _trace(uint256 index, uint16 bps) private {
        preset = bps;
        _ready(33, 100003, false);
        uint256[11][] memory rows = SetPricingVectors.trace(index);
        for (uint256 i; i < rows.length; ++i) {
            uint256[11] memory r = rows[i];
            uint256[] memory list = new uint256[](r[1]);
            uint256 found;
            for (uint256 j; j < 33 && found < r[1]; ++j) {
                if (vault.isOutside(ids[j]) == (r[0] == 1)) list[found++] = ids[j];
            }
            assertEq(found, r[1]);
            assertEq(r[0] == 1 ? conversion.quoteReturn(r[1]) : conversion.quoteWithdraw(r[1]), r[2]);
            bytes32 beforeState = _stateHash();
            vm.prank(ALICE);
            (bool ok, bytes memory result) = address(vault)
                .call(
                    r[0] == 1
                        ? abi.encodeCall(conversion.returnItems, (list, r[2] - r[3], block.timestamp))
                        : abi.encodeCall(conversion.withdrawBatch, (list, r[2] + r[3], block.timestamp))
                );
            assertEq(ok, r[4] == 1);
            if (ok) {
                (uint256 p, uint256 f) = abi.decode(result, (uint256, uint256));
                assertEq(p, r[2]);
                assertEq(f, r[3]);
            } else {
                assertEq(_stateHash(), beforeState);
            }
            vm.prank(ALICE);
            token.burn(r[5]);
            assertEq(token.totalSupply(), r[6]);
            assertEq(vault.escrowPrincipal(), r[7]);
            assertEq(vault.inside(), r[8]);
            (uint256 floor, uint256 remainder) = vault.escrowSurplus();
            assertEq(floor, r[9]);
            assertEq(remainder, r[10]);
            _invariants(0);
        }
    }

    function test_bigintFullWidthIntermediateProduct() public {
        _ready(10, 100003, false);
        uint256[4][] memory rows = SetPricingVectors.wide();
        // Quote-only boundary test: the release issues 1e27, so uint256-max supply is intentionally synthetic.
        vm.mockCall(address(token), abi.encodeWithSignature("totalSupply()"), abi.encode(type(uint256).max));
        for (uint256 i; i < rows.length; ++i) {
            assertEq(conversion.quoteWithdraw(rows[i][2]), rows[i][3]);
        }
    }
}
