// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRuleSplitter: one token's income shared among up to four rules fixed at construction
/// @notice One instance per token. Income is pushed to it in one asset (`asset()`: address(0) = the native coin,
/// otherwise an ERC-20 such as WBNB or a test dollar) and recognised by balance, like the pile: a plain transfer is
/// enough and `receive()` does no work. Anyone calls `distribute()`: income that arrived since the last call is shared
/// among the rules by their fixed parts (basis points summing to 10,000; the rounding units go to the last rule),
/// then each rule's owed amount is delivered. A rule that cannot be served now keeps its amount owed and is tried
/// again on a later call; it never holds back the others.
/// Configuration is fixed at construction: `constructor(address token, address asset, Rule[] memory rules)`, 1 to 4
/// rules, each with bps > 0, summing to 10,000. No owner, no setter, no pause, no upgrade.
interface IRuleSplitter {
    /// @notice The rule kinds.
    ///   CREATOR:  paid to `target` (an address fixed at construction).
    ///   PILE:     forwarded to `target`, a FeeRules pile of the same token and asset.
    ///   BUY_BURN: buys the token with the income on the PancakeSwap V2 router `target` (fee-on-transfer calls; path
    ///             asset -> token, or the router's WETH -> token for the native coin) and sends what it gets to DEAD.
    enum Kind {
        NONE,
        CREATOR,
        PILE,
        BUY_BURN
    }

    struct Rule {
        Kind kind;
        uint16 bps;
        address target;
    }

    /// @notice Income that arrived since the last recognition (by balance).
    event IncomeRecognised(uint256 amount);
    /// @notice Rule `rule` was given `part` of the recognised income; it is now owed `owedNow`.
    event PartOwed(uint256 indexed rule, uint256 part, uint256 owedNow);
    /// @notice Rule `rule` was served `amount` of the asset; `tokensBurned` is what a BUY_BURN sent to DEAD (else 0).
    event Delivered(uint256 indexed rule, uint256 amount, uint256 tokensBurned);
    /// @notice Rule `rule` could not be served now; `owed` stays owed to it for a later call.
    event LeftOwed(uint256 indexed rule, uint256 owed);

    error InvalidRules();
    error Reentrancy();

    /// @notice 0x000000000000000000000000000000000000dEaD.
    function DEAD() external view returns (address);

    /// @notice The token whose income this is (the token a BUY_BURN buys and a PILE redeems).
    function token() external view returns (address);

    /// @notice The income's asset: address(0) = the native coin, otherwise an ERC-20.
    function asset() external view returns (address);

    /// @notice How many rules (1 to 4).
    function ruleCount() external view returns (uint256);

    /// @notice Rule `i` as fixed at construction.
    function rule(uint256 i) external view returns (Kind kind, uint16 bps, address target);

    /// @notice What rule `i` is owed now and could not yet be served.
    function owed(uint256 i) external view returns (uint256);

    /// @notice Lifetime amount of the asset delivered to rule `i`.
    function delivered(uint256 i) external view returns (uint256);

    /// @notice Lifetime tokens a BUY_BURN rule `i` sent to DEAD (0 for other kinds).
    function burned(uint256 i) external view returns (uint256);

    /// @notice The sum of `owed` over all rules (the part of the balance already assigned).
    function totalOwed() external view returns (uint256);

    /// @notice Income that arrived and is not yet assigned: the asset balance minus `totalOwed()`.
    function pending() external view returns (uint256);

    /// @notice Anyone: assign pending income to the rules by their parts, then try to deliver every rule's owed
    /// amount. Never reverts because one rule cannot be served.
    function distribute() external;
}
