// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IAntiScam: the Pool Launch Portal's anti-scam word list, as its launch calls it
/// @notice Not in Flap's example interfaces. Measured on the BNB test network (26 Nov 2026, Portal v1.2.0): inside
/// `launchTaxTokenV2` the Portal's launch facet calls `isScamWord(name, symbol)` (selector 0xf2239487) on the module at
/// 0x5CfbE713d070e87F67D1bc84312B7eB8Fe4F2B5E (an ERC-1967 proxy), which answers two booleans: the name is listed, the
/// symbol is listed (("USDT", "CPILE") -> (true, false); ("Curve", "USDT") -> (false, true); "BNB" listed; "Tether"
/// not). On BNB Chain (fork at block 135830000) the launch facet 0x60611752eB72f72d7013a63D65b828cB7F979bAd calls
/// the module at 0xfFb69d59f62454f3B8322Bc1a9FCE6E171a5264f (USDT and BNB listed). The address is a constant in Flap's
/// launch facet, with no getter on the Portal, and differs per network: each launcher factory takes its network's
/// module at construction. A listed name or symbol makes the launch revert, so our launcher factories ask the same
/// module at creation (Flap's pre-audit R1).
interface IAntiScam {
    function isScamWord(string calldata name, string calldata symbol)
        external
        view
        returns (bool nameListed, bool symbolListed);
}
