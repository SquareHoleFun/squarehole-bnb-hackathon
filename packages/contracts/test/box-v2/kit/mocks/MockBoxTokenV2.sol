// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxSupplyFloor, IBoxToken} from "../../../../src/box/interfaces/IBoxToken.sol";
import {IBoxTokenV2, BoxTokenV2Args} from "../../../../src/box-v2/interfaces/IBoxTokenV2.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";

/// @title MockBoxTokenV2
/// @notice TEST ONLY (M1-03). The release's one T implementation (`IBoxTokenV2` as M1-00 froze it at `56e6e18c`), for
/// parts built before M1-30's. Every v2 box's T in the kit is a clone of it (F102): the standard 45-byte EIP-1167 proxy
/// followed by `BoxTokenV2Args` (`BoxClones.runtime`), created by the box's coordinator mock with CREATE and
/// initialised in the same call (`MockBox.createToken`). Follows:
/// - the arguments read with EXTCODECOPY from byte 45 of the clone's own code (`BoxClones.ARGS_OFFSET`) at the frozen
///   offsets: holder, vault, ledger, supply, name and its length, symbol and its length;
/// - `initialize()`: the clone's `initialHolder()` only (`NotCoordinator`), once (`AlreadyInitialised`): the one
///   issuance to it, with v1's `Transfer`. The implementation marks itself initialised in its constructor, so it is
///   inert alone. Before `initialize` every balance is 0;
/// - v1's clauses (`BoxToken.sol`, BC-055): full amounts and standard events; a send to the vault refused unless the
///   vault pulls, a send to T itself refused (`DirectSendRefused`); `burn` of the caller's own balance, refused below
///   the vault's `supplyFloor()` once the vault has code (`BurnBelowSupplyFloor`); a max allowance never decremented;
///   transfers to or from address(0) refused; no owner, pause, fee or upgrade; no DELEGATECALL, CALLCODE or
///   SELFDESTRUCT (`MockShapes` scans it).
/// Not modeled: v1's text rule on the name and symbol (`BoxTokenV2Args.encode` checks only their lengths; the spec's
/// rule is `validate()`'s), and M2's ledger variant (`ledger()` is read, never called).
contract MockBoxTokenV2 is IBoxTokenV2 {
    uint8 public constant decimals = 18;

    bool private _initialised;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor() {
        _initialised = true;
    }

    function initialize() external {
        if (_initialised) revert AlreadyInitialised();
        address holder = initialHolder();
        if (msg.sender != holder) revert NotCoordinator(msg.sender);
        _initialised = true;
        uint256 issuance = initialSupply();
        // A standard `_mint`, never a direct assignment of a balance (`IBoxTokenV2`'s initialize; the clone scanner
        // research's rule 1, `docs/research/clone-scanner-check.md` Part 2), so M1-30 copies no flagged pattern.
        totalSupply += issuance;
        balanceOf[holder] += issuance;
        emit Transfer(address(0), holder, issuance);
    }

    // ------------------------------------------------------------------ the clone's arguments

    function initialHolder() public view returns (address) {
        return address(bytes20(_arg(BoxTokenV2Args.HOLDER, 20)));
    }

    function vault() public view returns (address) {
        return address(bytes20(_arg(BoxTokenV2Args.VAULT, 20)));
    }

    function ledger() external view returns (address) {
        return address(bytes20(_arg(BoxTokenV2Args.LEDGER, 20)));
    }

    function initialSupply() public view returns (uint256) {
        return uint256(_arg(BoxTokenV2Args.SUPPLY, 32));
    }

    function ISSUANCE() external view returns (uint256) {
        return initialSupply();
    }

    function name() external view returns (string memory) {
        return _text(BoxTokenV2Args.NAME, 32, BoxTokenV2Args.NAME_LENGTH);
    }

    function symbol() external view returns (string memory) {
        return _text(BoxTokenV2Args.SYMBOL, 11, BoxTokenV2Args.SYMBOL_LENGTH);
    }

    function totalBurned() external view returns (uint256) {
        return initialSupply() - totalSupply;
    }

    // ------------------------------------------------------------------ ERC-20, v1's clauses

    function approve(address spender, uint256 amount) external returns (bool) {
        if (spender == address(0)) revert ApproveToZeroAddress();
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (amount > allowed) revert InsufficientAllowance(allowed, amount);
            allowance[from][msg.sender] = allowed - amount;
        }
        _transfer(from, to, amount);
        return true;
    }

    function burn(uint256 amount) external {
        uint256 balance = balanceOf[msg.sender];
        if (amount > balance) revert InsufficientBalance(balance, amount);
        uint256 supplyAfter = totalSupply - amount;
        address v = vault();
        if (v.code.length != 0) {
            uint256 floor = IBoxSupplyFloor(v).supplyFloor();
            if (supplyAfter < floor) revert BurnBelowSupplyFloor(supplyAfter, floor);
        }
        balanceOf[msg.sender] = balance - amount;
        totalSupply = supplyAfter;
        emit Transfer(msg.sender, address(0), amount);
    }

    // ------------------------------------------------------------------ internals

    function _transfer(address from, address to, uint256 amount) private {
        if (from == address(0)) revert TransferFromZeroAddress();
        if (to == address(0)) revert TransferToZeroAddress();
        address v = vault();
        if (to == address(this) || (to == v && msg.sender != v)) revert DirectSendRefused(to);
        uint256 fromBalance = balanceOf[from];
        if (amount > fromBalance) revert InsufficientBalance(fromBalance, amount);
        balanceOf[from] = fromBalance - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    /// `length` bytes of the arguments at `offset`, left-aligned in a word (in a clone's frame `address()` is the clone).
    function _arg(uint256 offset, uint256 length) private view returns (bytes32 w) {
        uint256 at = BoxClones.ARGS_OFFSET + offset;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 0)
            extcodecopy(address(), p, at, length)
            w := mload(p)
        }
    }

    function _text(uint256 offset, uint256 max, uint256 lengthAt) private view returns (string memory s) {
        uint256 length = uint8(bytes1(_arg(lengthAt, 1)));
        if (length > max) length = max;
        bytes32 word = _arg(offset, max);
        s = new string(length);
        assembly ("memory-safe") {
            mstore(add(s, 0x20), word)
        }
    }
}

/// @title KitSupplyFloor
/// @notice TEST ONLY (M1-03). A box vault's supply floor (`IBoxSupplyFloor`, v1's), fixed at deployment as an immutable,
/// so a test can etch its code at a kit box's vault address to make T's burns meet a floor (v1's BC-005, BC-016).
contract KitSupplyFloor is IBoxSupplyFloor {
    uint256 private immutable _floor;

    constructor(uint256 floor_) {
        _floor = floor_;
    }

    function supplyFloor() external view returns (uint256) {
        return _floor;
    }
}
