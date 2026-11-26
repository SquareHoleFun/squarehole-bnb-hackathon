// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxCloneBase} from "./BoxCloneBase.sol";
import {RoyaltyDestination} from "./interfaces/BoxTypes.sol";
import {IBoxCoordinator} from "./interfaces/IBoxCoordinator.sol";
import {IBoxReceiver} from "./interfaces/IBoxReceiver.sol";
import {IBoxRoyaltyRouter} from "./interfaces/IBoxRoyaltyRouter.sol";
import {BoxCloneArgs as A} from "./libraries/BoxCloneArgs.sol";
import {BoxClones} from "./libraries/BoxClones.sol";

/// @notice The chain's WETH9 (the two calls the router makes).
interface IWETH9 {
    function balanceOf(address account) external view returns (uint256);
    function withdraw(uint256 amount) external;
}

/// @title BoxRoyaltyRouter (add-on 4 `royalties`, hook point `receiver.ethIntake`; slice S3; the implementation of its
/// per-box clone)
/// @notice The ERC-2981 receiver of a box with the royalties add-on, at every destination (F65, F68 (4); nft-royalties
/// § 4 "The router", new code). Marketplaces pay in the sale currency: ETH for listings, WETH for accepted offers. The
/// Creator destination goes through it too (review of sh-core-v1): royaltyInfo never names the payee itself, so a
/// payee that refuses ETH cannot make royalty-paying sales of the box's items revert.
///
/// - **Receiving** (BC-114): the clone is a receiving clone (`BoxClones.initCodeReceiving`): a call without
///   calldata stops in the clone's own code, so every ETH payment is accepted, 0 wei and the 2,300-gas stipend of
///   `transfer` included (WETH9's `withdraw` pays that way too), and nothing else happens: no storage write, no event,
///   no revert. A plain EIP-1167 clone would spend 2,600 gas (3,000 after EIP-8038) on its cold DELEGATECALL alone.
/// - **`flush()`**, anyone, once the box has graduated (`coordinator.graduated()`; core-v1-interfaces § 5 decision 8):
///   unwraps all its WETH and sends all its ETH to the box's receiver, and nowhere else: `fundFees()` for FeeHandling
///   (box 0: its capped receiver, so the platform part counts in the 32 ETH cap, BC-107), `fundDepth()` for PoolDepth,
///   `fundCreator()` for Creator (credited to the one creator payee, who pulls it, F72 (3)).
///   A reverting receiver reverts the flush (`SinkFailed`): the ETH and the WETH stay for the next one.
/// - **`sweep(token)`**: WETH as in `flush()`; any other ERC-20 stays (`TokenNotTaken`) until a version routes it (S12).
/// - No owner, admin, setter, pause, upgrade or rescue (F23 C2); no storage at all. Never pays the Safe directly.
/// @dev Invariants: ETH and WETH leave only to `receiver()`; the router holds nothing of another box. Written for
/// Square Hole (MIT, no third-party code).
/// Integration (SH-core-wave-2): S3 and S4+S5 each wrote this router with the same 61-byte argument layout and
/// interface. S3's is kept (the plan gives the router to S3, launch pipeline v1 § 4): its graduation read is gas-capped
/// and reads a failure as "not graduated", so the bare implementation refuses `flush()` with `NotGraduated`; an
/// unknown destination byte reads as FeeHandling. S4+S5's and S6's tests run against it unchanged.
contract BoxRoyaltyRouter is IBoxRoyaltyRouter, BoxCloneBase {
    /// @dev Gas for the graduation read (a failure reads as "not graduated").
    uint256 private constant _READ_GAS = 50_000;

    /// @dev Receiving clones carry their arguments from byte 51.
    function _argsBase() internal pure override returns (uint256) {
        return BoxClones.RECEIVING_ARGS_OFFSET;
    }

    /// @inheritdoc IBoxRoyaltyRouter
    /// @dev The clone answers empty calldata before delegating, so this body runs only for a direct payment to the
    /// implementation (which has no arguments and can flush nothing); it does nothing either way.
    receive() external payable {}

    /// @inheritdoc IBoxRoyaltyRouter
    function flush() public returns (uint256 ethSent) {
        if (!_graduated()) revert NotGraduated();
        uint256 unwrapped = _unwrapAll();
        ethSent = address(this).balance;
        if (ethSent == 0) revert NothingToFlush();
        address sink = receiver();
        RoyaltyDestination d = destination();
        bytes memory call = d == RoyaltyDestination.PoolDepth
            ? abi.encodeCall(IBoxReceiver.fundDepth, ())
            : d == RoyaltyDestination.Creator
                ? abi.encodeCall(IBoxReceiver.fundCreator, ())
                : abi.encodeCall(IBoxReceiver.fundFees, ());
        (bool ok,) = sink.call{value: ethSent}(call);
        if (!ok) revert SinkFailed();
        emit Flushed(sink, ethSent, unwrapped);
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function sweep(address token) external returns (uint256 amount) {
        if (token == address(0) || token != weth()) revert TokenNotTaken(token);
        return flush();
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function coordinator() public view returns (address) {
        return _argAddress(A.R_COORDINATOR);
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function receiver() public view returns (address) {
        return _argAddress(A.R_RECEIVER);
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function weth() public view returns (address) {
        return _argAddress(A.R_WETH);
    }

    /// @inheritdoc IBoxRoyaltyRouter
    function destination() public view returns (RoyaltyDestination) {
        // PoolDepth and Creator as written; any other byte reads as FeeHandling (the factory writes the byte).
        uint256 raw = _argUint(A.R_DESTINATION, 1);
        if (raw == uint8(RoyaltyDestination.PoolDepth)) return RoyaltyDestination.PoolDepth;
        if (raw == uint8(RoyaltyDestination.Creator)) return RoyaltyDestination.Creator;
        return RoyaltyDestination.FeeHandling;
    }

    /// @dev Unwraps the router's whole WETH balance (zero WETH address or no code: nothing to unwrap).
    function _unwrapAll() private returns (uint256 amount) {
        address w = weth();
        if (w.code.length == 0) return 0;
        amount = IWETH9(w).balanceOf(address(this));
        if (amount != 0) IWETH9(w).withdraw(amount);
    }

    /// @dev `coordinator.graduated()`, gas-capped; a revert or a short answer reads as false.
    function _graduated() private view returns (bool yes) {
        address c = coordinator();
        bytes4 selector = IBoxCoordinator.graduated.selector;
        assembly ("memory-safe") {
            mstore(0x00, selector)
            // The call first, then its returndatasize: Yul evaluates arguments right to left, so `and(staticcall(…),
            // gt(returndatasize(), 31))` would read the size before the call.
            let ok := staticcall(_READ_GAS, c, 0x00, 4, 0x00, 32)
            if and(ok, gt(returndatasize(), 31)) { yes := eq(mload(0x00), 1) }
        }
    }
}
