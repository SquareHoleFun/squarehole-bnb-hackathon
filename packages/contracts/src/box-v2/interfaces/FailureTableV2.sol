// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Receiver failure ledger identifiers, read internally; old ids stay reserved, no funds move through enum.
enum HeldKind {
    NONE,
    CURVE_AND_TAX,
    POOL_SHARE,
    CREATOR_BRANCH,
    DEPTH_BRANCH,
    ROYALTIES,
    RESERVED_EAT_FIT_BOX_OR_LEG_BRANCH,
    ITEMS_CREDITS,
    HOLDERS_CREDITS,
    BUDGET_OR_PILE,
    RESERVED_GIFTS_RECEIVED,
    RESERVED_GIFTS_WAITING_AT_GIVER,
    FIT_SHARE,
    PLATFORM_SHARE,
    BURN_BRANCH,
    GRADUATION_RESERVE,
    EAT_PRICE_COIN,
    HOLDERS_T_PENDING,
    ITEMS_T_PENDING,
    PILE_FEES_PENDING,
    MODULE_PENDING,
    SHOP_FEES_PENDING,
    SIDE_CARRY
}

/// @notice Receiver reads failure destinations; ids 0-6 frozen. CLOSING_POOL means coordinator claim pot in P.
enum FailRoute {
    NONE,
    CLOSING_POOL,
    FIT,
    STAY_CLAIMABLE,
    BACK_TO_SEEDER,
    AS_BOOKED,
    PLATFORM,
    RESERVED_CONVERSION_SAFE,
    // F136: stays where it is for good; no claim, Safe or wallet can take it.
    LOCKED,
    CREATOR_PAYEE
}

/// @notice Failure routing pins; no token calls. Non-P royalties remain in the royalty router for its payee (RC5 C).
library FailureTableV2 {
    /// @notice Receiver/tests only: read route for a held ledger; inPriceCoin distinguishes P from any foreign coin.
    /// Does not move funds. The receiver only accepts P; foreign royalty claims remain available at the router.
    /// @dev Internal callers may read routeOf; no funds move.
    function routeOf(HeldKind kind, bool inPriceCoin) internal pure returns (FailRoute) {
        if (kind == HeldKind.ROYALTIES) return inPriceCoin ? FailRoute.CLOSING_POOL : FailRoute.CREATOR_PAYEE;
        if (kind == HeldKind.SHOP_FEES_PENDING || kind == HeldKind.MODULE_PENDING || kind == HeldKind.PILE_FEES_PENDING || kind == HeldKind.CURVE_AND_TAX || kind == HeldKind.POOL_SHARE || kind == HeldKind.CREATOR_BRANCH
            || kind == HeldKind.HOLDERS_T_PENDING || kind == HeldKind.ITEMS_T_PENDING || kind == HeldKind.BURN_BRANCH || kind == HeldKind.EAT_PRICE_COIN || kind == HeldKind.ITEMS_CREDITS) return FailRoute.CLOSING_POOL;
        if (kind == HeldKind.DEPTH_BRANCH || kind == HeldKind.SIDE_CARRY) return FailRoute.CLOSING_POOL;
        if (kind == HeldKind.FIT_SHARE) return FailRoute.FIT;
        if (kind == HeldKind.PLATFORM_SHARE) return FailRoute.PLATFORM;
        if (kind == HeldKind.HOLDERS_CREDITS) return FailRoute.STAY_CLAIMABLE;
        if (kind == HeldKind.BUDGET_OR_PILE) return FailRoute.BACK_TO_SEEDER;
        if (kind == HeldKind.GRADUATION_RESERVE) return FailRoute.AS_BOOKED;
        return FailRoute.NONE;
    }
}
