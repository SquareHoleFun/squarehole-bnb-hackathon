// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

/// @notice TEST ONLY. Stands in for the first move of the migration (ADR-0013 § 2.3 M1; T16/T17, not built): once the
/// curve is complete, a test places this code at the hook's address (`vm.etch`, so the position's owner is the
/// caller) and removes the whole curve position, taking what it holds to `to`. The PoolManager calls no hook for a
/// hook's own `modifyLiquidity` (v4 `Hooks.noSelfCall`), so the measurement is the pool's own accounting: the
/// position's principal at the current price plus any fees still owed to it. The production hook has no removal
/// path; nothing here exists on chain.
contract CurvePositionProbe is IUnlockCallback {
    struct Removal {
        IPoolManager pm;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        bytes32 salt;
        uint128 liquidity;
        address to;
    }

    /// @return principal0 ETH (currency0) the removal paid, fees included.
    /// @return principal1 FIT (currency1) the removal paid, fees included.
    /// @return fees0 ETH fees still owed at the removal.
    /// @return fees1 FIT fees still owed at the removal.
    function removeAll(Removal calldata r)
        external
        returns (uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1)
    {
        return abi.decode(r.pm.unlock(abi.encode(r)), (uint256, uint256, uint256, uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        Removal memory r = abi.decode(data, (Removal));
        require(msg.sender == address(r.pm), "only the PoolManager");
        (BalanceDelta delta, BalanceDelta fees) = r.pm
            .modifyLiquidity(
                r.key,
                ModifyLiquidityParams({
                    tickLower: r.tickLower,
                    tickUpper: r.tickUpper,
                    liquidityDelta: -int256(uint256(r.liquidity)),
                    salt: r.salt
                }),
                ""
            );
        // A removal only pays out: both amounts are ≥ 0 (casts safe).
        uint256 a0 = uint256(int256(delta.amount0()));
        uint256 a1 = uint256(int256(delta.amount1()));
        if (a0 != 0) r.pm.take(r.key.currency0, r.to, a0);
        if (a1 != 0) r.pm.take(r.key.currency1, r.to, a1);
        return abi.encode(a0, a1, uint256(int256(fees.amount0())), uint256(int256(fees.amount1())));
    }
}
