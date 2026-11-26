// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetVaultFixture, SetStandardERC721} from "./SetVaultFixture.sol";
import {HostileERC721} from "./fixtures/HostileERC721.sol";

// The red tests deliberately compile against an independent ABI, before production has these selectors.
interface ConversionVault {
    function quoteWithdraw(uint256 count) external view returns (uint256);
    function quoteReturn(uint256 count) external view returns (uint256);
    function withdrawBatch(uint256[] calldata ids, uint256 maxTokenIn, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
    function returnItems(uint256[] calldata ids, uint256 minTokenOut, uint256 deadline)
        external
        returns (uint256 principal, uint256 fee);
}

abstract contract SetConversionFixture is SetVaultFixture {
    address internal constant BOB = address(0xB0B);
    uint16 internal preset = 500;
    ConversionVault internal conversion;

    function _vaultArgs() internal view override returns (bytes memory) {
        return abi.encodePacked(
            address(box), address(token), address(loader), CREATOR, collection, uint32(ids.length), hashes[0], preset
        );
    }

    function _ready(uint256 count, uint256 supply, bool hostile) internal {
        if (hostile) _hostile(count);
        else _standard(count);
        _deploy(true);
        conversion = ConversionVault(address(vault));
        for (uint256 i; i < count; i += 32) {
            _page(i, count - i > 32 ? 32 : count - i);
        }
        loader.complete();
        // Give the desired remaining supply to one actor; real graduation burns coordinator dust.
        vm.prank(address(box));
        token.transfer(ALICE, supply);
        hook.fill();
        box.graduate();
        assertEq(token.totalSupply(), supply);
        vm.startPrank(ALICE);
        token.approve(address(vault), type(uint256).max);
        HostileERC721(collection).setApprovalForAll(address(vault), true);
        vm.stopPrank();
    }

    function _list(uint256 start, uint256 count) internal view returns (uint256[] memory list) {
        list = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            list[i] = ids[start + i];
        }
    }

    function _pick(uint256 start, uint256 count) internal returns (uint256 principal, uint256 fee) {
        uint256[] memory list = _list(start, count);
        vm.prank(ALICE);
        return conversion.withdrawBatch(list, type(uint256).max, block.timestamp);
    }

    function _return(uint256 start, uint256 count) internal returns (uint256 principal, uint256 fee) {
        uint256[] memory list = _list(start, count);
        vm.prank(ALICE);
        return conversion.returnItems(list, 0, block.timestamp);
    }

    function _ceil(uint256 a, uint256 b) internal pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    function _stateHash() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                token.totalSupply(),
                token.balanceOf(ALICE),
                token.balanceOf(BOB),
                token.balanceOf(address(vault)),
                token.allowance(ALICE, address(vault)),
                vault.escrowPrincipal(),
                vault.inside(),
                vault.supplyFloor()
            )
        );
    }

    function _invariants(uint256 surplusGift) internal view {
        uint256 n = vault.inside();
        uint256 e = vault.escrowPrincipal();
        uint256 s = token.totalSupply();
        uint256 m = ids.length - n;
        uint256 a = s - e;
        assertGe(n, 1);
        assertGe(s, e + n);
        assertEq(vault.supplyFloor(), e + n);
        assertGe(e * n, m * a); // fixture supplies bounded to the real 1e27 issuance
        assertEq(token.balanceOf(address(vault)), e + surplusGift);
        assertEq(s, token.balanceOf(ALICE) + token.balanceOf(BOB) + token.balanceOf(address(vault)));
        assertEq(s + token.totalBurned(), token.initialSupply());
        (uint256 floor, uint256 remainder) = vault.escrowSurplus();
        assertEq(floor * n + remainder, e * n - m * a);
        assertLt(remainder, n);
    }
}
