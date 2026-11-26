// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IListingRegistry, ListingRefusal} from "../../../src/box-v2/interfaces/IListingRegistry.sol";
import {IListingChecksProbe, IBoxTokenProofProbe} from "./M1_20cProbes.sol";
import {M1_20cDeployHook} from "./M1_20cDeployHook.sol";

/// @notice What the tests fund and read on every test token.
interface IKitToken {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

/// @title M1_20cBase
/// @notice TEST ONLY. The kit's base with M1-20-c's two probes, each deployed through the hook on first use inside a
/// test (never in `setUp`), so each red test fails on its own with `NotBuilt()`.
abstract contract M1_20cBase is Test, M1_20cDeployHook {
    /// What the funder holds of each test token: far above any probe amount [P].
    uint256 internal constant FUNDS = 1e30;

    IListingChecksProbe private _checksProbe;
    address internal bob = address(0xB0B);
    address internal lister = address(0xD);
    IPoolManager internal pm;
    function _deployPoolManager() internal {
        pm = IPoolManager(deployCode("PoolManager.sol:PoolManager", abi.encode(address(this))));
    }
    function _checks() internal returns (IListingChecksProbe) {
        if (address(_checksProbe) == address(0)) _checksProbe = _deployListingChecksProbe(address(pm));
        return _checksProbe;
    }

    function _gasAtAmsterdam(address target, uint256 value, bytes memory data) internal returns (uint256 used, uint256) {
        vm.setEvmVersion("amsterdam");
        uint256 start = gasleft();
        (bool ok, bytes memory answer) = target.call{value: value}(data);
        used = start - gasleft();
        if (!ok) assembly ("memory-safe") { revert(add(answer, 32), mload(answer)) }
        return (used, 0);
    }
    function _refusal(ListingRefusal reason) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IListingRegistry.ListingRefused.selector, reason);
    }

    /// `FUNDS` of `token` to the lister, approved to the probe for any amount.
    function _fund(IListingChecksProbe c, address token) internal {
        IKitToken(token).mint(lister, FUNDS);
        vm.prank(lister);
        IKitToken(token).approve(address(c), type(uint256).max);
    }

    /// The token passes with `decimals`, and the check moved nothing for good.
    function _assertAdmitted(address token, uint8 decimals) internal {
        IListingChecksProbe c = _checks();
        _fund(c, token);
        uint256 held = IKitToken(token).balanceOf(lister);
        uint256 supply = IKitToken(token).totalSupply();
        assertEq(c.checkToken(token, lister), decimals, "admitted with its decimals");
        assertEq(IKitToken(token).balanceOf(lister), held, "the funder's balance is back");
        assertEq(IKitToken(token).balanceOf(address(c)), 0, "the probe keeps nothing");
        assertEq(IKitToken(token).totalSupply(), supply, "the supply did not move");
    }

    /// The token is refused for `reason`.
    function _assertRefused(address token, ListingRefusal reason) internal {
        IListingChecksProbe c = _checks();
        if (token.code.length != 0) _fund(c, token);
        vm.expectRevert(_refusal(reason));
        c.checkToken(token, lister);
    }
}
