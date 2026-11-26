// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModuleProceedsTo} from "../../../../src/box/interfaces/BoxTypes.sol";
import {IBoxReceiver} from "../../../../src/box/interfaces/IBoxReceiver.sol";

/// @title AuditU4ClaudeClaimGifter
/// @notice TEST ONLY (SH-AUDIT-B0 U4, Claude). Mints PoolManager ERC-6909 claims to any address, paying the asset in
/// one unlock: what any account can do to box 0's receiver or coordinator (a gift of claims). The receiver counts claims
/// that are in no ledger as the next batch (BoxReceiver.sol:28-30), the coordinator forwards claims beyond its reserve
/// at graduation (BoxCoordinator.sol:276-283).
contract AuditU4ClaudeClaimGifter is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    /// @notice `msg.value` of ETH claims (id 0) to `to`.
    function giftEth(address to) external payable {
        pm.unlock(abi.encode(address(0), to, msg.value));
    }

    /// @notice `amount` of `token` claims to `to`, the token taken from this contract's balance.
    function giftToken(address token, address to, uint256 amount) external {
        pm.unlock(abi.encode(token, to, amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "gifter: only the PoolManager");
        (address asset, address to, uint256 amount) = abi.decode(data, (address, address, uint256));
        pm.sync(Currency.wrap(asset));
        uint256 paid;
        if (asset == address(0)) {
            paid = pm.settle{value: amount}();
        } else {
            (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(0xa9059cbb, address(pm), amount));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "gifter: token transfer");
            paid = pm.settle();
        }
        require(paid == amount, "gifter: settled amount");
        pm.mint(to, uint256(uint160(asset)), amount);
        return "";
    }
}

/// @title AuditU4ClaudeUnlocker
/// @notice TEST ONLY. Calls any target from inside its own PoolManager unlock (a router batching calls in one
/// unlock would do this) and bubbles the target's revert.
contract AuditU4ClaudeUnlocker is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function run(address target, bytes calldata data) external {
        pm.unlock(abi.encode(target, data));
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        require(msg.sender == address(pm), "unlocker: only the PoolManager");
        (address target, bytes memory data) = abi.decode(raw, (address, bytes));
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return "";
    }
}

/// @title AuditU4ClaudeProbe
/// @notice TEST ONLY. An account whose code, whenever it is called (ETH with or without calldata, any selector),
/// tries every entry point of box 0's receiver, both halves, and logs what each call answered: success, or the first
/// four bytes of its revert data. It never reverts and writes no storage (events only), so it can stand at a tip
/// address, or be etched at the Safe's, the stream's or FIT's executor's address for one call without touching that
/// contract's storage. Used for P4.10 (one transient lock across the receiver's two halves).
contract AuditU4ClaudeProbe {
    /// @notice One attempt: `target` called with `selector`; `ok` and the revert's first four bytes.
    event Attempt(bytes4 indexed selector, bool ok, bytes4 reason);

    address payable public immutable receiver;
    /// @notice Gas kept back for the frame's own return (the stream gives 200,000 gas in all).
    uint256 private constant _RESERVE = 6_000;

    constructor(address payable receiver_) {
        receiver = receiver_;
    }

    receive() external payable {
        _probe();
    }

    fallback() external payable {
        _probe();
    }

    function _probe() private {
        address r = receiver;
        _try(r, 0, abi.encodeCall(IBoxReceiver.collect, (address(this))));
        _try(r, 0, abi.encodeCall(IBoxReceiver.onGraduation, ()));
        _try(r, 0, abi.encodeCall(IBoxReceiver.fundFees, ()));
        _try(r, 0, abi.encodeCall(IBoxReceiver.fundDepth, ()));
        _try(r, 0, abi.encodeCall(IBoxReceiver.fundCreator, ()));
        _try(r, 0, abi.encodeCall(IBoxReceiver.payFit, ()));
        _try(r, 0, abi.encodeCall(IBoxReceiver.payPlatform, ()));
        _try(r, 0, abi.encodeCall(IBoxReceiver.claimCreator, (address(this))));
        _try(r, 0, abi.encodeCall(IBoxReceiver.pullForModule, ()));
        _try(r, 0, abi.encodeCall(IBoxReceiver.moduleProceeds, (ModuleProceedsTo.FitQ, 1)));
        // The cold half (BoxReceiverExtension, by DELEGATECALL in the clone's context).
        _try(r, 0, abi.encodeCall(IBoxReceiver.noteModuleFees, (1, 1)));
        _try(r, 0, abi.encodeCall(IBoxReceiver.proposeCreatorPayee, (address(this))));
        _try(r, 0, abi.encodeCall(IBoxReceiver.acceptCreatorPayee, ()));
        _try(r, 0, abi.encodeCall(IBoxReceiver.initialize, ()));
        _try(r, 0, abi.encodeCall(IUnlockCallback.unlockCallback, (abi.encode(uint8(2), abi.encode(uint256(1), r)))));
    }

    function _try(address target, uint256 value, bytes memory data) private {
        if (gasleft() < _RESERVE) return;
        (bool ok, bytes memory ret) = target.call{value: value, gas: gasleft() - _RESERVE}(data);
        bytes4 reason;
        if (!ok && ret.length >= 4) {
            assembly ("memory-safe") {
                reason := mload(add(ret, 0x20))
            }
        }
        emit Attempt(bytes4(data), ok, reason);
    }
}

/// @title AuditU4ClaudeEthPusher
/// @notice TEST ONLY. A tip recipient that, when the PoolManager pays it (inside the receiver's own unlock, while the
/// receiver holds its lock), settles `amount` of its own ETH and takes it to `target`: the PoolManager then pays the
/// receiver plain ETH from inside the receiver's guarded call, which `receive()` accepts (BoxReceiver.sol:405-408).
contract AuditU4ClaudeEthPusher {
    IPoolManager public immutable pm;
    address public immutable target;
    uint256 public immutable amount;
    bool public pushed;

    constructor(IPoolManager pm_, address target_, uint256 amount_) {
        pm = pm_;
        target = target_;
        amount = amount_;
    }

    receive() external payable {
        if (msg.sender != address(pm) || pushed) return;
        pushed = true;
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.take(Currency.wrap(address(0)), target, amount);
    }
}

/// @title AuditU4ClaudeStipendPayer
/// @notice TEST ONLY. A payer as marketplaces pay a royalty receiver: Solidity's `transfer` and `send` (2,300-gas
/// stipend), or a call with a chosen gas limit and calldata.
contract AuditU4ClaudeStipendPayer {
    function payTransfer(address payable to) external payable {
        to.transfer(msg.value);
    }

    function paySend(address payable to) external payable returns (bool) {
        return to.send(msg.value);
    }

    function payCall(address to, uint256 gasLimit, bytes calldata data) external payable returns (bool ok) {
        (ok,) = to.call{value: msg.value, gas: gasLimit}(data);
    }

    receive() external payable {}
}

/// @title AuditU4ClaudeWeth9
/// @notice TEST ONLY. WETH9's behaviour that matters to the royalty router (mainnet 0xC02a…6Cc2, solc 0.4.18):
/// `withdraw` pays with `msg.sender.transfer(wad)`, a 2,300-gas stipend, then logs. The world's MockWETH pays with all
/// gas, so it cannot show the stipend; this code is etched over it (same storage slot 0 for `balanceOf`).
contract AuditU4ClaudeWeth9 {
    event Withdrawal(address indexed src, uint256 wad);

    mapping(address => uint256) public balanceOf;

    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function transfer(address to, uint256 wad) external returns (bool) {
        require(balanceOf[msg.sender] >= wad, "weth9: balance");
        balanceOf[msg.sender] -= wad;
        balanceOf[to] += wad;
        return true;
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "weth9: balance");
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }
}

/// @title AuditU4ClaudeSafeSingleton
/// @notice TEST ONLY. The part of a Safe singleton that receives ETH (it logs `SafeReceived`).
contract AuditU4ClaudeSafeSingleton {
    event SafeReceived(address indexed sender, uint256 value);

    receive() external payable {
        emit SafeReceived(msg.sender, msg.value);
    }
}

/// @title AuditU4ClaudeSafeProxy
/// @notice TEST ONLY. A Safe proxy's shape: every call DELEGATEs to the singleton (a cold DELEGATECALL, more than a
/// 2,300-gas stipend allows, as the real Safe). Etched at the platform Safe's address for L6 (the world's Safe has no
/// code). Immutables live in the code, so the etched copy needs no storage.
contract AuditU4ClaudeSafeProxy {
    address public immutable singleton;

    constructor(address singleton_) {
        singleton = singleton_;
    }

    fallback() external payable {
        address s = singleton;
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), s, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(ok) { revert(0, returndatasize()) }
            return(0, returndatasize())
        }
    }
}

/// @title AuditU4ClaudeStreamStandIn
/// @notice TEST ONLY. Etched at the per-item stream's address for one call (P4.11): logs the gas it was given and the
/// amount, then answers as its mode says (accept, revert, or use all its gas). Events only: the stream's storage is
/// never touched, so its own code is restored afterwards unchanged.
contract AuditU4ClaudeStreamStandIn {
    enum Mode {
        Accept,
        Revert,
        BurnAll
    }

    event Notified(uint256 gasAtEntry, bytes data);

    Mode public immutable mode;

    constructor(Mode mode_) {
        mode = mode_;
    }

    fallback() external payable {
        uint256 g = gasleft();
        Mode m = mode;
        if (m == Mode.Revert) revert("stream stand-in says no");
        if (m == Mode.BurnAll) {
            assembly ("memory-safe") {
                for {} 1 {} {}
            }
        }
        emit Notified(g, msg.data);
    }
}
