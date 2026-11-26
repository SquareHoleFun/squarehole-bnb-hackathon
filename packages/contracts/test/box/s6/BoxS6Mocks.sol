// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxPhase} from "../../../src/box/interfaces/BoxTypes.sol";

interface IS6Coordinator {
    function graduate() external returns (uint256);
    function claimReward(address to) external returns (uint256);
    function launch() external payable;
}

interface IS6Token {
    function balanceOf(address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function burn(uint256) external;
}

/// @notice TEST ONLY: S3's collection as the coordinator sees it: `initialize()`, once, by the coordinator.
contract MockBoxCollection {
    address public immutable coordinator;
    uint256 public initializedAt;

    constructor(address coordinator_) {
        coordinator = coordinator_;
    }

    function initialize() external {
        require(msg.sender == coordinator, "collection: not coordinator");
        require(initializedAt == 0, "collection: initialised");
        initializedAt = block.number;
    }
}

/// @notice TEST ONLY: S3's vault as the coordinator and T see it (BoxVault.sol on sh-core-s3: `initialize` once by the
/// coordinator after the collection's, `openGate` once by the coordinator, `supplyFloor` = E + n with E = 0).
contract MockBoxVault {
    address public immutable coordinator;
    address public immutable collection;
    uint256 public immutable n;
    bool public initialized;
    uint256 public gateOpenedAt;
    uint256 public openGateCalls;

    constructor(address coordinator_, address collection_, uint256 n_) {
        (coordinator, collection, n) = (coordinator_, collection_, n_);
    }

    function initialize() external {
        require(msg.sender == coordinator, "vault: not coordinator");
        require(!initialized, "vault: initialised");
        require(MockBoxCollection(collection).initializedAt() != 0, "vault: collection first");
        initialized = true;
    }

    function openGate() external {
        require(msg.sender == coordinator, "vault: not coordinator");
        require(initialized, "vault: not initialised");
        require(gateOpenedAt == 0, "vault: gate open");
        gateOpenedAt = block.timestamp;
        ++openGateCalls;
    }

    function gateOpen() external view returns (bool) {
        return gateOpenedAt != 0;
    }

    function supplyFloor() external view returns (uint256) {
        return initialized ? n : 0;
    }
}

/// @notice TEST ONLY: the tickets add-on as the coordinator sees it (BoxTickets.sol on sh-core-s3:
/// `requestGraduationWord` refuses before the vault's gate opened, and a second time).
contract MockBoxTickets {
    address public immutable coordinator;
    MockBoxVault public immutable vault;
    bool public initialized;
    uint256 public requestedAt;
    address public requester;

    constructor(address coordinator_, MockBoxVault vault_) {
        (coordinator, vault) = (coordinator_, vault_);
    }

    function initialize() external {
        require(msg.sender == coordinator, "tickets: not coordinator");
        require(!initialized, "tickets: initialised");
        initialized = true;
    }

    function requestGraduationWord() external payable {
        require(vault.gateOpenedAt() != 0, "tickets: not graduated");
        require(requestedAt == 0, "tickets: requested");
        requestedAt = block.number;
        requester = msg.sender;
    }
}

/// @notice TEST ONLY: a module that misbehaves when poked (BC-098): it stands in for the receiver, the tickets add-on
/// or the executor. `initialize()` passes (so `launch` can wire it); every poke runs the chosen mode.
contract HostileModule {
    enum Mode {
        Ok,
        Revert,
        BurnGas,
        Reenter,
        ReturnBomb,
        RevertBomb
    }

    Mode public mode;
    address public coordinator;
    uint256 public pokes;
    /// @dev What the re-entry attempts returned (0 when they reverted as they must).
    bool public reentryGraduateSucceeded;
    bool public reentryClaimSucceeded;
    bytes4 public reentryGraduateError;
    uint256 public fundedBudget;

    function setMode(Mode m, address coordinator_) external {
        (mode, coordinator) = (m, coordinator_);
    }

    function initialize() external {}

    function onGraduation() external {
        _act();
    }

    function requestGraduationWord() external payable {
        _act();
    }

    function poke() external returns (int24) {
        _act();
        return 0;
    }

    function fundBudget() external payable {
        fundedBudget += msg.value;
    }

    function fitGraduated() external pure returns (bool) {
        return true;
    }

    receive() external payable {}

    function _act() internal {
        Mode m = mode;
        if (m == Mode.Revert) revert("hostile: no");
        if (m == Mode.BurnGas) {
            uint256 i;
            while (true) {
                ++i;
            }
        }
        if (m == Mode.Reenter) {
            try IS6Coordinator(coordinator).graduate() {
                reentryGraduateSucceeded = true;
            } catch (bytes memory err) {
                reentryGraduateError = bytes4(err);
            }
            try IS6Coordinator(coordinator).claimReward(address(this)) {
                reentryClaimSucceeded = true;
            } catch {}
            ++pokes;
            // Returns normally, so the test can read what the re-entry attempts got.
            return;
        }
        if (m == Mode.ReturnBomb) {
            ++pokes;
            assembly {
                return(0, 200000)
            }
        }
        if (m == Mode.RevertBomb) {
            assembly {
                revert(0, 200000)
            }
        }
        ++pokes;
    }
}

/// @notice TEST ONLY: the receiver as the coordinator sees it in unit tests (`initialize`, `onGraduation`).
contract MockBoxReceiverS6 {
    address public immutable coordinator;
    bool public initialized;
    uint256 public graduations;

    constructor(address coordinator_) {
        coordinator = coordinator_;
    }

    function initialize() external {
        require(msg.sender == coordinator, "receiver: not coordinator");
        initialized = true;
    }

    function onGraduation() external {
        ++graduations;
    }
}

/// @notice TEST ONLY: the launch router in unit tests: `initialize`, `bootstrap` (sends the coordinator nothing) and
/// `creatorBuy` (returns 0).
contract MockBoxRouterS6 {
    address public immutable coordinator;
    bool public initialized;
    uint256 public bootstrapValue;
    uint256 public creatorBuyValue;
    address public creatorSeen;

    constructor(address coordinator_) {
        coordinator = coordinator_;
    }

    function initialize() external {
        require(msg.sender == coordinator, "router: not coordinator");
        initialized = true;
    }

    function bootstrap() external payable returns (uint256) {
        bootstrapValue = msg.value;
        return 0;
    }

    function creatorBuy(address creator, uint256 qIn) external payable returns (uint256) {
        require(msg.value == qIn, "router: value");
        (creatorBuyValue, creatorSeen) = (msg.value, creator);
        return 0;
    }
}

/// @notice TEST ONLY: a hook whose reserve the test sets (D6 unit cases: zero, below and above the cap, gifts). The
/// coordinator's `migrate` call pulls `pull` T from it (the ask) and may top the reserve up by `topUp`, minting real
/// ERC-6909 Q claims to the coordinator through the PoolManager as the real hook does.
contract MockGradHook is IUnlockCallback {
    IPoolManager public immutable pm;
    address public immutable coordinatorAddr;
    address public immutable tokenAddr;
    bool public closed;
    uint256 public reserveMinted;
    uint256 public migratedAtBlock;
    uint256 public openAt;
    uint256 public migrateBudget;
    /// @dev T the ask takes from the coordinator's budget (default: all of it, as the real ask nearly does).
    uint256 public pull = type(uint256).max;
    uint256 public topUp;
    bool public initialized;
    bool public launched;

    constructor(IPoolManager pm_, address coordinator_, address token_) {
        (pm, coordinatorAddr, tokenAddr) = (pm_, coordinator_, token_);
    }

    receive() external payable {}

    function initialize() external {
        require(msg.sender == coordinatorAddr, "hook: not coordinator");
        initialized = true;
        openAt = block.timestamp + 1;
    }

    function launch() external {
        require(msg.sender == coordinatorAddr, "hook: not coordinator");
        launched = true;
    }

    function setClosed(bool c) external {
        closed = c;
    }

    function setMigrate(uint256 pull_, uint256 topUp_) external {
        (pull, topUp) = (pull_, topUp_);
    }

    /// @dev Mints `amount` Q claims (native ETH, from this contract's balance) to the coordinator as the reserve.
    function mintReserve(uint256 amount) public {
        if (amount == 0) return;
        reserveMinted += amount;
        pm.unlock(abi.encode(amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        uint256 amount = abi.decode(data, (uint256));
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.mint(coordinatorAddr, 0, amount);
        return "";
    }

    function migrate(uint256 tokenBudget) external returns (uint256, uint256, uint256, uint256) {
        require(msg.sender == coordinatorAddr, "hook: not coordinator");
        require(closed, "hook: not closed");
        require(migratedAtBlock == 0, "hook: migrated");
        migratedAtBlock = block.number;
        migrateBudget = tokenBudget;
        uint256 p = pull < tokenBudget ? pull : tokenBudget;
        if (p != 0) require(IS6Token(tokenAddr).transferFrom(coordinatorAddr, address(this), p), "hook: pull");
        mintReserve(topUp);
        return (0, 0, p, 0);
    }

    function phase() external view returns (BoxPhase) {
        if (migratedAtBlock != 0) return BoxPhase.Graduated;
        if (closed) return BoxPhase.Closed;
        return BoxPhase.Bonding;
    }
}

/// @notice TEST ONLY: settles native ETH into the PoolManager and mints the claims to `to` (a stranger's gift of claims).
contract S6ClaimsMinter is IUnlockCallback {
    IPoolManager public immutable pm;

    constructor(IPoolManager pm_) {
        pm = pm_;
    }

    function mintTo(address to) external payable {
        pm.unlock(abi.encode(to, msg.value));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm");
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        pm.sync(Currency.wrap(address(0)));
        pm.settle{value: amount}();
        pm.mint(to, 0, amount);
        return "";
    }
}

/// @notice TEST ONLY: a recipient that refuses Q (reverts) or burns all gas sent with it.
contract RefusingRecipientS6 {
    bool public burn;

    function setBurn(bool b) external {
        burn = b;
    }

    receive() external payable {
        if (burn) {
            uint256 i;
            while (true) {
                ++i;
            }
        }
        revert("no Q");
    }

    function graduate(IS6Coordinator c) external returns (uint256) {
        return c.graduate();
    }

    function claim(IS6Coordinator c, address to) external returns (uint256) {
        return c.claimReward(to);
    }
}
