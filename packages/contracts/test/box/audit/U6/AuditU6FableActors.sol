// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxTickets} from "../../../../src/box/BoxTickets.sol";
import {ItemReveal} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxTickets} from "../../../../src/box/interfaces/IBoxTickets.sol";
import {IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";

/// @notice TEST ONLY (SH-AUDIT-B0 U6, Fable). A contract drawer without `onERC721Received`: it can call anything
/// (`exec`), accepts ETH, but refuses every ERC-721 safe transfer (no receiver hook at all). Stand-in for "a drawer
/// contract that cannot take delivery": the property under test is how BoxTickets treats such a drawer.
contract AuditU6FableNoReceiver {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory ret) {
        require(msg.sender == owner, "not owner");
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    receive() external payable {}
}

/// @notice TEST ONLY (SH-AUDIT-B0 U6, Fable). A placeholder holder and drawer whose callbacks call back into the tickets
/// add-on: `onERC721Received` (a placeholder's safe transfer, or an item's delivery) and `receive` (a draw's refund)
/// each run one scripted action and record what the add-on answered. Stand-in for a re-entering counterparty: the
/// property under test is that every re-entry either sees final state (an unguarded transfer) or is refused
/// (`Reentrancy()` under the lock), never a half-updated state.
contract AuditU6FableReenterer {
    enum Plan {
        None,
        HandBackReceived,
        TakeOne,
        OpenReceived,
        Draw,
        Settle,
        TransferBack
    }

    BoxTickets public immutable tickets;
    IBoxToken public immutable token;
    address public immutable collection;
    address public immutable owner;
    Plan public plan;
    ItemReveal internal _reveal;
    uint256 public calls;
    bool public lastOk;
    bytes4 public lastError;
    uint256 public lastValue;
    uint256 public receivedToken;
    address public receivedFrom;

    constructor(BoxTickets tickets_, IBoxToken token_, address collection_, address owner_) {
        tickets = tickets_;
        token = token_;
        collection = collection_;
        owner = owner_;
        token_.approve(address(tickets_), type(uint256).max);
    }

    function setPlan(Plan p, ItemReveal calldata r) external {
        require(msg.sender == owner, "not owner");
        plan = p;
        _reveal = r;
    }

    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory ret) {
        require(msg.sender == owner, "not owner");
        bool ok;
        (ok, ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender == address(tickets) || msg.sender == collection) {
            receivedToken = tokenId;
            receivedFrom = from;
            _act(tokenId, from);
        }
        return this.onERC721Received.selector;
    }

    receive() external payable {
        _act(0, address(0));
    }

    function _act(uint256 tokenId, address from) private {
        ++calls;
        Plan p = plan;
        plan = Plan.None; // one action per callback (no recursion)
        if (p == Plan.None) return;
        bytes memory data;
        if (p == Plan.HandBackReceived) {
            uint256[] memory ids = new uint256[](1);
            ids[0] = tokenId;
            data = abi.encodeCall(IBoxTickets.handBack, (ids, 0, block.timestamp));
        } else if (p == Plan.TakeOne) {
            data = abi.encodeCall(IBoxTickets.take, (1, type(uint256).max, block.timestamp));
        } else if (p == Plan.OpenReceived) {
            data = abi.encodeCall(IBoxTickets.open, (tokenId, _reveal));
        } else if (p == Plan.Draw) {
            data = abi.encodeCall(IBoxTickets.draw, (type(uint256).max, block.timestamp));
        } else if (p == Plan.Settle) {
            data = abi.encodeCall(IBoxTickets.settle, (1));
        } else if (p == Plan.TransferBack) {
            data = abi.encodeCall(IBoxTickets.transferFrom, (address(this), from, tokenId));
        }
        uint256 value = p == Plan.Draw ? lastValue : 0;
        (bool ok, bytes memory ret) = address(tickets).call{value: value}(data);
        lastOk = ok;
        lastError = ok ? bytes4(0) : _sel(ret);
    }

    function setDrawValue(uint256 v) external {
        lastValue = v;
    }

    function _sel(bytes memory err) private pure returns (bytes4 s) {
        if (err.length >= 4) {
            assembly ("memory-safe") {
                s := mload(add(err, 32))
            }
        }
    }
}
