// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Classes of ETH that enters box 0's contracts from outside (plan § 3.1 X01's sources).
enum EthIn {
    /// createBox's value (the burned bootstrap buy).
    Bootstrap,
    /// A launch-router buy's gross `msg.value` (the partial-close refund is `EthOut.Refund`).
    WindowBuy,
    /// A public swap's Q input (through the router stand-in or any other caller of the PoolManager).
    SwapIn,
    FundFees,
    FundDepth,
    /// FIT's executor's `fundBudget` / `receive` from anyone but the receiver.
    FundBudget,
    /// ETH paid to the royalty router (ERC-2981 receiver).
    Royalty,
    /// WETH paid to the royalty router (counted as ETH: the system's WETH is part of its holdings).
    RoyaltyWeth,
    /// A draw's `msg.value` (the refund to the drawer is `EthOut.Refund`).
    DrawValue,
    /// `requestGraduationWord`'s `msg.value`.
    WordValue,
    /// `addBounty` on either source, or a direct `request`'s value (a round's pot).
    Bounty,
    /// ETH forced in (`vm.deal` on top of a system address's balance; SELFDESTRUCT).
    Forced,
    Other
}

/// @notice Classes of ETH that leaves box 0's contracts to an outside address (X01's named exits).
enum EthOut {
    /// A seller's Q proceeds (any route).
    SwapOut,
    /// A launch-router partial-close refund, a draw's refund, a refund of any other unspent input.
    Refund,
    /// `payPlatform` to the Safe.
    Platform,
    /// A keeper's tip (`collect`, `deepen`).
    Tip,
    /// `claimReward` to its `to`.
    Reward,
    /// `withdrawBounty` to its `to`.
    BountyWithdraw,
    Other
}

/// @notice Classes of T that leaves outside holders (into box 0's contracts, or burned by its holder).
enum TIn {
    /// A swap's T input.
    Sell,
    /// `take`: principal and fee.
    Take,
    /// `draw`: principal and fee.
    Draw,
    /// The vault's named pick (`withdraw`): principal and fee.
    Pick,
    /// `takeByNumber`: principal and fee.
    TakeByNumber,
    /// A plain transfer to a box address (the accepted M01/M25 class).
    Direct,
    /// A holder's own `burn`.
    OwnBurn,
    Other
}

/// @notice Classes of T that reaches outside holders from box 0's contracts.
enum TOut {
    /// A swap's T output (any route, the launch router's included).
    Buy,
    HandBack,
    /// `cancelDraw`'s principal.
    Cancel,
    /// The vault's `returnItem(s)`.
    Return,
    StreamClaim,
    Other
}

/// @title AuditGhostLedger
/// @notice TEST ONLY (SH-AUDIT-B0 R0-A). The ghost-ledger base: ETH and T that cross the boundary of box 0's system, by
/// class, measured on the OUTSIDE party's side (a payer's balance before and after, a recipient's gain), never as the
/// system's own difference, so a wei or a T unit that leaves to an address no rule names, or appears from nowhere,
/// breaks `_ghostEthBalanced` / `_ghostTBalanced` instead of being booked. Inside moves (fee batches, `payFit`,
/// `sweep`, `flush`, the executor's buys, migrations) are not booked: the holdings stay inside.
/// - **System** (`_ghostAddSystem`): every address whose ETH (and WETH) and T count as box 0's holdings: the
///   PoolManager (box 0's pool is its only pool in the local world: its ETH is pool reserves plus ERC-6909 claims), the
///   box's contracts, the two randomness sources, the factory and its registry. Their ETH must equal Σ in − Σ out.
/// - **Outside holders** (`_ghostAddOutside`): every actor that can hold T; their T must equal Σ T out − Σ T in.
/// No `Test` dependency, so an invariant handler (plan § 3.2) can inherit it as well as `AuditBox0World` does.
abstract contract AuditGhostLedger {
    uint256 internal constant ETH_IN_CLASSES = uint256(type(EthIn).max) + 1;
    uint256 internal constant ETH_OUT_CLASSES = uint256(type(EthOut).max) + 1;
    uint256 internal constant T_IN_CLASSES = uint256(type(TIn).max) + 1;
    uint256 internal constant T_OUT_CLASSES = uint256(type(TOut).max) + 1;

    mapping(EthIn => uint256) internal _ghostEthIn;
    mapping(EthOut => uint256) internal _ghostEthOut;
    mapping(TIn => uint256) internal _ghostTIn;
    mapping(TOut => uint256) internal _ghostTOut;
    uint256 internal _ghostEthInTotal;
    uint256 internal _ghostEthOutTotal;
    uint256 internal _ghostTInTotal;
    uint256 internal _ghostTOutTotal;

    address[] internal _ghostSystem;
    address[] internal _ghostOutside;
    mapping(address => bool) internal _ghostIsSystem;
    mapping(address => bool) internal _ghostIsOutside;
    /// @dev The T whose holdings are booked, and the WETH counted as ETH (zero: none).
    address internal _ghostToken;
    address internal _ghostWeth;

    // ------------------------------------------------------------------------------------------------ booking

    function _noteEthIn(EthIn c, uint256 amount) internal {
        _ghostEthIn[c] += amount;
        _ghostEthInTotal += amount;
    }

    function _noteEthOut(EthOut c, uint256 amount) internal {
        _ghostEthOut[c] += amount;
        _ghostEthOutTotal += amount;
    }

    function _noteTIn(TIn c, uint256 amount) internal {
        _ghostTIn[c] += amount;
        _ghostTInTotal += amount;
    }

    function _noteTOut(TOut c, uint256 amount) internal {
        _ghostTOut[c] += amount;
        _ghostTOutTotal += amount;
    }

    /// @notice Books an outside party's ETH change across one action: a fall is ETH in (`inClass`), a rise ETH out
    /// (`outClass`). `before` is read after any funding of the party.
    function _noteEthChange(uint256 before, uint256 after_, EthIn inClass, EthOut outClass) internal {
        if (after_ < before) _noteEthIn(inClass, before - after_);
        else if (after_ > before) _noteEthOut(outClass, after_ - before);
    }

    /// @notice The same for an outside holder's T: a fall is T in (`inClass`), a rise T out (`outClass`).
    function _noteTChange(uint256 before, uint256 after_, TIn inClass, TOut outClass) internal {
        if (after_ < before) _noteTIn(inClass, before - after_);
        else if (after_ > before) _noteTOut(outClass, after_ - before);
    }

    // ------------------------------------------------------------------------------------------------ places

    function _ghostAddSystem(address a) internal {
        if (a == address(0) || _ghostIsSystem[a]) return;
        _ghostIsSystem[a] = true;
        _ghostSystem.push(a);
    }

    function _ghostAddOutside(address a) internal {
        if (a == address(0) || _ghostIsOutside[a]) return;
        _ghostIsOutside[a] = true;
        _ghostOutside.push(a);
    }

    /// @notice Σ ETH (and WETH, counted 1:1) of the system addresses.
    function _ghostSystemEth() internal view returns (uint256 s) {
        for (uint256 i; i < _ghostSystem.length; ++i) {
            s += _ghostSystem[i].balance;
            if (_ghostWeth != address(0)) s += _balanceOf(_ghostWeth, _ghostSystem[i]);
        }
    }

    /// @notice Σ T of the system addresses.
    function _ghostSystemT() internal view returns (uint256 s) {
        for (uint256 i; i < _ghostSystem.length; ++i) {
            s += _balanceOf(_ghostToken, _ghostSystem[i]);
        }
    }

    /// @notice Σ T of the outside holders.
    function _ghostOutsideT() internal view returns (uint256 s) {
        for (uint256 i; i < _ghostOutside.length; ++i) {
            s += _balanceOf(_ghostToken, _ghostOutside[i]);
        }
    }

    // ------------------------------------------------------------------------------------------------ checks

    /// @notice X01's identity at the boundary: the system holds exactly what came in less what left
    /// (held + Σ out == Σ in, so a shortfall or a surplus is reported, never an underflow).
    function _ghostEthBalanced() internal view returns (bool ok, uint256 held, uint256 inTotal, uint256 outTotal) {
        held = _ghostSystemEth();
        (inTotal, outTotal) = (_ghostEthInTotal, _ghostEthOutTotal);
        ok = held + outTotal == inTotal;
    }

    /// @notice The outside holders hold exactly the T booked out less the T booked in (held + Σ in == Σ out).
    function _ghostTBalanced() internal view returns (bool ok, uint256 held, uint256 inTotal, uint256 outTotal) {
        held = _ghostOutsideT();
        (inTotal, outTotal) = (_ghostTInTotal, _ghostTOutTotal);
        ok = held + inTotal == outTotal;
    }

    // ------------------------------------------------------------------------------------------------ reads

    function ghostEthIn(EthIn c) public view returns (uint256) {
        return _ghostEthIn[c];
    }

    function ghostEthOut(EthOut c) public view returns (uint256) {
        return _ghostEthOut[c];
    }

    function ghostTIn(TIn c) public view returns (uint256) {
        return _ghostTIn[c];
    }

    function ghostTOut(TOut c) public view returns (uint256) {
        return _ghostTOut[c];
    }

    function ghostTotals() public view returns (uint256 ethIn, uint256 ethOut, uint256 tIn, uint256 tOut) {
        return (_ghostEthInTotal, _ghostEthOutTotal, _ghostTInTotal, _ghostTOutTotal);
    }

    function ghostSystem() public view returns (address[] memory) {
        return _ghostSystem;
    }

    function ghostOutside() public view returns (address[] memory) {
        return _ghostOutside;
    }

    function _balanceOf(address token, address who) private view returns (uint256 b) {
        if (token == address(0)) return 0;
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, who));
        if (ok && ret.length >= 32) b = abi.decode(ret, (uint256));
    }
}
