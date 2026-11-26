// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice One receiver choice per side; the factory encodes it, no money moves through this type.
enum FeeChoice { None, Keep, Burn, Grow, Holders, Items, EatPriceCoin, HoldersT, ItemsT, Pile, Module, ShopT }
/// @notice Wire leg ids; reserved values are refused. Both sides receive P. No calls or money movement.
enum Leg { None, AsPaid, BuyT, RESERVED_3, RESERVED_4, RESERVED_5 }
/// @notice Wire destination ids; Creator/Depth/Eat, Holders/Items and same-P BudgetOrPile are offered. No money movement.
enum Dest { None, Eat, Creator, RESERVED_3, Depth, RESERVED_5, Holders, BudgetOrPile, Items, Module }
/// @notice Wire split ids; only NoSplit is accepted, b is empty. No money movement.
enum Split { None, NoSplit, RESERVED_2, RESERVED_3, RESERVED_4 }
/// @notice Both fee sides are P; readers and encoders move no funds.
enum FeeSide { None, Buyers, Sellers }
/// @notice Holders select P or bought T; no movement by this type.
enum HoldersCurrency { None, P, T }
/// @notice Existing wire branch, consumed by the menu validator; no money moves.
struct Branch {
    /// @notice Factory/validator reads leg id; no money moves.
    uint8 leg;
    /// @notice Factory/validator reads destination id; no money moves.
    uint8 dest;
    /// @notice Factory/validator requires empty leg parameters; no money moves.
    bytes legParams;
    /// @notice Factory/validator reads canonical holder/item parameters; no money moves.
    bytes destParams;
}
/// @notice Existing wire side; factory/validator requires NoSplit, zero b and empty splitParams; no funds move.
struct Side {
    /// @notice Factory/validator reads the single choice; no funds move.
    Branch a;
    /// @notice Factory/validator requires an empty unused branch; no funds move.
    Branch b;
    /// @notice Factory/validator requires NoSplit; no funds move.
    uint8 split;
    /// @notice Factory/validator requires empty bytes; no funds move.
    bytes splitParams;
}
/// @notice Canonical holder currency parameters; readers move no money.
struct HoldersDestParams {
    /// @notice Factory/validator reads P id 1 or T id 2; no money moves.
    uint8 currency;
}

/// @notice M3 inside-item policy ids; encoders/readers move no funds. None marks a non-Items side only.
enum ItemsInsidePolicy { None, Keep, BuyBackBurn, Depth }

/// @notice S1: canonical abi.encode tuple in Branch.destParams, exactly 32 bytes; no new Branch field.
/// @dev Validators accept only explicit Keep (1), BuyBackBurn (2) or Depth (3) on the own NEW_COLLECTION's Items choice.
/// Missing bytes, None, other values, nonzero padding and trailing bytes are refused, never defaulted.
struct ItemsDestParams {
    /// @notice Encoders/readers select the immutable inside policy per side; no funds move through this field.
    uint8 insidePolicy;
}

/// @notice Canonical module directory id. Factory resolves and snapshots its immutable address and codehash.
struct ModuleDestParams { uint32 id; }

/// @notice Creator selects the immutable fee-budget ceiling, 2/4/8 times the shop seed; no funds move.
struct ShopDestParams { uint8 ceilingPreset; }
