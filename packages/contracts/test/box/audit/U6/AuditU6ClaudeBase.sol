// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {DrawStatus, ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {BoxShuffle} from "../../../../src/box/libraries/BoxShuffle.sol";
import {AuditPhases} from "../common/AuditPhases.sol";

/// @notice TEST ONLY (SH-AUDIT-B0 U6, Claude). An account with code for the U6 properties that need a contract to act:
/// an ERC-721 receiver or an ETH receiver that calls back into any contract while it is being paid or handed a token,
/// and records what each call answered. Owner-only `exec`; the hooks run whatever list the owner set.
contract AuditU6ClaudeAgent {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    address public immutable owner;
    bool public refuseEth;
    bool public refuseNft;
    uint256 public ethReceived;
    uint256 public nftCalls;
    Call[] internal _onEth;
    Call[] internal _onNft;
    /// @dev abi.encode(ok, returndata) of every hook call, in order.
    bytes[] internal _ethResults;
    bytes[] internal _nftResults;

    error NotOwner(address caller);

    constructor(address owner_) {
        owner = owner_;
    }

    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory ret) {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function setRefuse(bool eth, bool nft) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        (refuseEth, refuseNft) = (eth, nft);
    }

    function addOnEth(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _onEth.push(Call(target, value, data));
    }

    function addOnNft(address target, uint256 value, bytes calldata data) external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        _onNft.push(Call(target, value, data));
    }

    function clearHooks() external {
        if (msg.sender != owner) revert NotOwner(msg.sender);
        delete _onEth;
        delete _onNft;
        delete _ethResults;
        delete _nftResults;
    }

    function ethResults() external view returns (bytes[] memory) {
        return _ethResults;
    }

    function nftResults() external view returns (bytes[] memory) {
        return _nftResults;
    }

    /// @dev The hooks run at the outermost receipt only (a token handed over inside a hook's own call is just taken).
    bool private _inHook;

    receive() external payable {
        ethReceived += msg.value;
        if (!_inHook) {
            _inHook = true;
            for (uint256 i; i < _onEth.length; ++i) {
                Call memory c = _onEth[i];
                (bool ok, bytes memory ret) = c.target.call{value: c.value}(c.data);
                _ethResults.push(abi.encode(ok, ret));
            }
            _inHook = false;
        }
        if (refuseEth) revert("agent refuses ETH");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        ++nftCalls;
        if (!_inHook) {
            _inHook = true;
            for (uint256 i; i < _onNft.length; ++i) {
                Call memory c = _onNft[i];
                (bool ok, bytes memory ret) = c.target.call{value: c.value}(c.data);
                _nftResults.push(abi.encode(ok, ret));
            }
            _inHook = false;
        }
        if (refuseNft) revert("agent refuses NFTs");
        return this.onERC721Received.selector;
    }
}

/// @notice TEST ONLY. A randomness source that misbehaves in `wordOf` (its code is etched over box 0's source address
/// for the duration of one test; slot 0 holds the mode): 1 reverts, 2 answers 32 bytes, 3 uses all its gas, 4 names a
/// time above 2^64, 5 a word ready before its request (time 1), 6 a word ready in the future, 7 a zero word ready now,
/// 8 answers 200 bytes (a valid word and time first). Any other selector reverts.
contract AuditU6ClaudeHostileSource {
    fallback() external payable {
        assembly ("memory-safe") {
            let mode := sload(0)
            // wordOf(address,uint256)
            if iszero(eq(shr(224, calldataload(0)), 0x2b3fb3a9)) { revert(0, 0) }
            switch mode
            case 1 { revert(0, 0) }
            case 2 {
                mstore(0, 0x1234)
                return(0, 32)
            }
            case 3 { for {} 1 {} {} }
            case 4 {
                mstore(0, 0x1234)
                mstore(32, shl(64, 1))
                return(0, 64)
            }
            case 5 {
                mstore(0, 0x1234)
                mstore(32, 1)
                return(0, 64)
            }
            case 6 {
                mstore(0, 0x1234)
                mstore(32, add(timestamp(), 1000))
                return(0, 64)
            }
            case 7 {
                mstore(0, 0)
                mstore(32, timestamp())
                return(0, 64)
            }
            default {
                mstore(0, 0x1234)
                mstore(32, timestamp())
                return(0, 200)
            }
        }
    }
}

/// @notice TEST ONLY. Etched over box 0's per-item stream for one test (a stand-in by necessity: the property is the
/// transient value the tickets expose to their observer): every observer call (`onVaultAction`, `onItemTransfer`)
/// records the tickets' `ticketInFlight()` at that moment. Slot 0 holds the tickets' address and slot 1 the record's
/// length (both set with vm.store after the etch, over the stream's own storage).
contract AuditU6ClaudeInFlightRecorder {
    address internal ticketsAddress;
    uint256[] internal seen;

    fallback() external payable {
        (bool ok, bytes memory ret) = ticketsAddress.staticcall(abi.encodeWithSignature("ticketInFlight()"));
        seen.push(ok && ret.length == 32 ? abi.decode(ret, (uint256)) : type(uint256).max);
    }

    function recorded() external view returns (uint256[] memory) {
        return seen;
    }
}

/// @title AuditU6ClaudeBase
/// @notice TEST ONLY (SH-AUDIT-B0 U6, Claude audit of box 0's tickets, placeholders and draws). Drivers and oracles on
/// top of the shared world (`AuditPhases`: the factory's box 0 on the mainnet build, the pinned BoxBackedSource and
/// DrandSource, committed quicknet rounds). The oracle `_replayItems` recomputes every settled draw's item from the
/// words the source answers, with an array-based lazy Fisher-Yates and `BoxShuffle.permute`, independently of
/// BoxTickets' mapping-based one.
abstract contract AuditU6ClaudeBase is AuditPhases {
    uint256 internal constant BOUNTY_GAS = BoxSpecV1.DRAND_BOUNTY_GAS;
    bytes32 internal constant MIX = keccak256("audit.u6.claude mix");

    /// @notice Graduated (the word requested on r0 by graduation's poke), then one block later r0 posted and the word
    /// accepted; a request in this block fixes r0 + 4 (committed), in the next r0 + 8, then r0 + 12.
    function _toWordAccepted() internal {
        _toGraduated();
        _advance(1);
        _post(r0);
        vm.prank(keeper);
        tickets.acceptGraduationWord();
    }

    /// @notice The round a request in this block fixes (the first round at least MARGIN ahead).
    function _roundNow() internal view returns (uint256) {
        return drand.roundAt(vm.getBlockTimestamp() + drand.MARGIN());
    }

    /// @notice The pot a draw in this block must leave in its round (DRAND_BOUNTY_GAS × base fee).
    function _target() internal view returns (uint256) {
        return BOUNTY_GAS * block.basefee;
    }

    /// @notice A new outside account with code (registered with the ghost ledger) that holds `t` T from `from`.
    function _agent(address from, uint256 t) internal returns (AuditU6ClaudeAgent ag) {
        ag = new AuditU6ClaudeAgent(address(this));
        _ghostAddOutside(address(ag));
        if (t != 0) _transferT(from, address(ag), t);
    }

    /// @notice `who` (any outside holder) gets `t` T from `from` (between outside holders: nothing crosses the boundary).
    function _giveT(address from, address who, uint256 t) internal {
        _ghostAddOutside(who);
        _transferT(from, who, t);
    }

    function _assertTicketsHoldNothing() internal view {
        assertEq(token.balanceOf(a.tickets), 0, "no T stays in the tickets contract");
        assertEq(a.tickets.balance, 0, "no ETH stays in the tickets contract");
    }

    /// @notice The live placeholders (ids and slots), scanning every id ever minted.
    function _livePlaceholders() internal view returns (uint256[] memory ids, uint256[] memory slots) {
        uint256 minted = tickets.status().minted;
        uint256[] memory idsAll = new uint256[](minted);
        uint256[] memory slotsAll = new uint256[](minted);
        uint256 live;
        for (uint256 id = 1; id <= minted; ++id) {
            try tickets.ownerOf(id) returns (address) {
                idsAll[live] = id;
                slotsAll[live] = tickets.slotOf(id);
                ++live;
            } catch {}
        }
        ids = new uint256[](live);
        slots = new uint256[](live);
        for (uint256 i; i < live; ++i) {
            (ids[i], slots[i]) = (idsAll[i], slotsAll[i]);
        }
    }

    /// @notice Draws not yet opened or cancelled (Requested or Settled).
    function _openDraws() internal view returns (uint256 count) {
        uint256 requested = tickets.status().drawsRequested;
        for (uint256 k = 1; k <= requested; ++k) {
            DrawStatus st = tickets.drawTicket(k).status;
            if (st == DrawStatus.Requested || st == DrawStatus.Settled) ++count;
        }
    }

    /// @notice IBoxTickets' slot and ticket invariants (`IBoxTickets.sol:27-29`) on the live state.
    function _assertSlotsAndTickets() internal view {
        (uint256[] memory ids, uint256[] memory slots) = _livePlaceholders();
        IBoxTickets.TicketState memory s = tickets.status();
        for (uint256 i; i < ids.length; ++i) {
            // q is fixed at graduation and slots never move after it, so this holds in every phase.
            assertLt(slots[i], s.slots, "every live placeholder holds a slot below q");
            for (uint256 j; j < i; ++j) {
                assertTrue(slots[i] != slots[j], "distinct slots");
            }
        }
        if (vault.gateOpenedAt() == 0) assertEq(ids.length, s.slots, "on the curve q == live placeholders");
        assertEq(vault.pendingTickets(), ids.length + _openDraws(), "pending tickets == live placeholders + open draws");
    }

    /// @notice Every settled draw's item, recomputed from the source's words (index 0 unused).
    function _replayItems(uint256 upTo) internal view returns (uint256[] memory items) {
        IBoxTickets.TicketState memory s = tickets.status();
        uint256 n = editionSize;
        uint256 q = s.slots;
        uint256 left = n - q;
        uint256[] memory arr = new uint256[](left);
        for (uint256 i; i < left; ++i) {
            arr[i] = q + i;
        }
        (uint256 u, uint256 v) = BoxShuffle.halves(n);
        bytes32 w = tickets.graduationWord();
        items = new uint256[](upTo + 1);
        for (uint256 k = 1; k <= upTo; ++k) {
            (bytes32 word,) = src.wordOf(a.tickets, k);
            uint256 idx = BoxShuffle.pickIndex(word, k, left);
            uint256 position = arr[idx];
            arr[idx] = arr[left - 1];
            --left;
            items[k] = tickets.firstId() + (q == 0 ? position : BoxShuffle.permute(w, position, n, u, v));
        }
    }

    /// @notice The settled draws' items equal the oracle's.
    function _assertItemsMatchOracle() internal view {
        uint256 settled = tickets.status().drawsSettled;
        uint256[] memory want = _replayItems(settled);
        for (uint256 k = 1; k <= settled; ++k) {
            assertEq(tickets.drawTicket(k).itemId, want[k], "a draw's item is the oracle's (word, position, pi_w)");
        }
    }

    /// @notice An empty reveal (no proof).
    function _noReveal() internal pure returns (ItemReveal memory r) {}

    /// @notice The revert data of `IBoxTickets.Reentrancy()` (TransientReentrancyGuard's selector).
    function _reentrancy() internal pure returns (bytes memory) {
        return abi.encodeWithSignature("Reentrancy()");
    }
}
