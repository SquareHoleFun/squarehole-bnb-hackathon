// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IPortalFloor: the Pool Launch Portal's read-only liquidity-floor views
/// @notice Not in Flap's example interfaces; taken from their indexer page (docs.flap.sh, "build-an-indexer",
/// "Graduation preview: graduationFloorV2") and checked against the test network's Portal v1.2.0 on 25 Nov 2026:
/// `graduationFloorV2` answers 750e18 as the creation floor in USD (WAD) when the whole supply seeds the pool.
interface IPortalFloor {
    struct GraduationFloorParams {
        address quoteToken;
        uint256 quotePriceUsd; // 18-decimal USD price of one quote unit
        uint256 poolQuote;
        uint256 poolToken;
        uint256 totalSupply;
        address vaultFactory;
    }

    struct GraduationFloorResultV2 {
        bool meetsFloor;
        uint256 floorUsdWad;
        uint256 quoteUsdWad;
        uint256 multiplierBps;
        bool meetsCreateFloor;
        uint256 createFloorUsdWad;
    }

    function graduationFloorV2(GraduationFloorParams calldata params)
        external
        view
        returns (GraduationFloorResultV2 memory);

    function launchQuoteConfig(uint8 kind, address quoteToken)
        external
        view
        returns (bool enabled, uint256 quotePriceUsd);

    function launcherFactoryMultiplier(address factory) external view returns (bool enabled, uint16 multiplierBps);
}
