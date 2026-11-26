// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BoxCoordinatorV2} from "../../../src/box-v2/BoxCoordinatorV2.sol";
import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxToken} from "../../../src/box/interfaces/IBoxToken.sol";
import {FeeBatchV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {PricingToken} from "../../../src/box-v2/libraries/PricingToken.sol";

// TEST ONLY: real coordinator code with creation state seeded, other phase-1 owners' parts scripted.
contract CoordinatorHarness is BoxCoordinatorV2 {
    constructor(IPoolManager pm) BoxCoordinatorV2(pm, msg.sender) {}

    function seed(address h, uint256 open, bool gate) external {
        _w = uint256(uint160(h)) | (1 << 208);
        _g = open | (gate ? open << 40 : 0);
    }
}

contract FailureHook {
    IPoolManager public immutable pm;
    address public immutable coordinator;
    address public immutable receiver;
    address public immutable token;
    address public immutable p;
    bool public closed;
    bool public failed;
    bool public rejectClose;
    bool public rejectMigrate;
    // This isolated fixture owns no pool inventory; all T is liquid or claim-backed.
    uint256 public closedTResidue;
    uint256 public closedAt;
    uint256 public reserveMinted;
    uint256 public finalFees;
    uint256 public finalReserve;
    uint256 public deepenTipCap;
    uint256 public migratePull;
    event Step(uint256 step);

    constructor(IPoolManager pm_, address c, address r, address t, address p_) {
        pm = pm_;
        coordinator = c;
        receiver = r;
        token = t;
        p = p_;
    }

    function fill() external {
        if (!closed) {
            closed = true;
            closedAt = block.timestamp;
        }
    }

    function configure(uint256 fees, uint256 reserve_, uint256 tip) external {
        finalFees = fees;
        finalReserve = reserve_;
        deepenTipCap = tip;
    }

    function setReject(bool close_, bool migrate_) external {
        rejectClose = close_;
        rejectMigrate = migrate_;
    }

    function setPull(uint256 amount) external {
        migratePull = amount;
    }

    function close() external returns (uint256 pot, uint256 burned) {
        require(msg.sender == coordinator && IBoxCoordinatorV2(coordinator).failed());
        uint256 id = uint256(uint160(p));
        // Fable item 8: post-failure close forwards late claims without replaying the original close.
        if (failed) {
            pot = pm.balanceOf(address(this), id);
            pm.transfer(coordinator, id, pot);
            return (pot, 0);
        }
        require(!rejectClose, "close refused");
        emit Step(2);
        failed = true;
        pm.transfer(receiver, id, finalFees);
        pm.transfer(coordinator, id, finalReserve);
        reserveMinted += finalReserve;
        pot = pm.balanceOf(address(this), id);
        pm.transfer(coordinator, id, pot);
        uint256 amount = IBoxToken(token).balanceOf(address(this));
        if (amount != 0) {
            try IBoxToken(token).burn(amount) {
                burned = amount;
            } catch {}
        }
    }

    function migrate(uint256) external returns (uint256, uint256, uint256, uint256) {
        require(msg.sender == coordinator && !failed && !rejectMigrate, "migrate refused");
        if (migratePull != 0) IBoxToken(token).transferFrom(coordinator, address(this), migratePull);
        pm.transfer(coordinator, uint256(uint160(p)), finalReserve);
        reserveMinted += finalReserve;
        return (0, 0, migratePull, 0);
    }
}

contract FailureReceiver {
    IPoolManager public immutable pm;
    address public immutable coordinator;
    address public immutable hook;
    address public immutable p;
    address public constant FIT_SAFE = address(0xF17);
    bool public reject;
    bool public entered;
    uint256 public choice = 1;
    uint256 public fitOwed;
    uint256 public platformOwed;
    uint256 public held;
    uint256 public feeInput;
    uint256 public graduationCalls;
    event Step(uint256 step);

    constructor(IPoolManager pm_, address c, address h, address p_) {
        pm = pm_;
        coordinator = c;
        hook = h;
        p = p_;
    }

    function configure(uint256 choice_, uint256 held_) external {
        choice = choice_;
        held = held_;
    }

    function setReject(bool on) external {
        reject = on;
    }

    function enterFailure() external {
        require(msg.sender == coordinator && FailureHook(hook).failed() && !entered && !reject, "receiver refused");
        emit Step(5);
        entered = true;
        feeInput = pm.balanceOf(address(this), uint256(uint160(p))) - held;
        uint256 unit = feeInput / 15;
        platformOwed = unit;
        fitOwed = 2 * unit + feeInput % 15;
        if (choice == 3) fitOwed += 10 * unit;
        // holders' credits live outside this fixture; model their claims transfer independently.
        if (choice == 4) pm.transfer(address(0xB47C), uint256(uint160(p)), 10 * unit);
        uint256 pot = held + (choice == 3 || choice == 4 ? 2 : 12) * unit;
        pm.transfer(coordinator, uint256(uint160(p)), pot);
    }

    function collect(address) external returns (FeeBatchV2 memory batch) {
        require(entered && !reject);
        fitOwed = pm.balanceOf(address(this), uint256(uint160(p))) - platformOwed;
    }

    function onGraduation() external {
        require(!reject);
        ++graduationCalls;
    }

    function payFit() external returns (uint256 amount) {
        amount = fitOwed;
        fitOwed = 0;
        pm.unlock(abi.encode(amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        uint256 amount = abi.decode(data, (uint256));
        pm.burn(address(this), uint256(uint160(p)), amount);
        pm.take(Currency.wrap(p), FIT_SAFE, amount);
        return "";
    }
}

contract FailureRouter {
    IPoolManager public immutable pm;
    address public immutable coordinator;
    address public immutable p;
    bool public reject;
    bool public exhaust;
    event Step(uint256 step);

    constructor(IPoolManager pm_, address c, address p_) {
        pm = pm_;
        coordinator = c;
        p = p_;
    }
    receive() external payable {}

    function configure(bool reject_, bool exhaust_) external {
        reject = reject_;
        exhaust = exhaust_;
    }

    function sweep() external returns (uint256 amount) {
        require(IBoxCoordinatorV2(coordinator).failed());
        require(!reject, "sweep refused");
        if (exhaust) {
            assembly { invalid() }
        }
        emit Step(3);
        amount = PricingToken.balanceOf(p, address(this));
        require(amount != 0, "empty");
        pm.unlock(abi.encode(amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        uint256 amount = abi.decode(data, (uint256));
        PricingToken.settle(pm, p, amount);
        pm.mint(coordinator, uint256(uint160(p)), amount);
        return "";
    }
}

contract FailureVault {
    uint256 public supplyFloor;
    uint256 public k;
    uint256 public windowEnds;
    bool public rejectView;
    bool public rejectEnter;
    bool public gate;
    event Step(uint256 step);

    function configure(uint256 floor_, uint256 k_, bool view_) external {
        supplyFloor = floor_;
        k = k_;
        rejectView = view_;
    }

    function setReject(bool on) external {
        rejectEnter = on;
    }

    function escrowSurplus() external view returns (uint256, uint256) {
        require(!rejectView);
        return (k, 0);
    }

    function enterFailure() external {
        require(!rejectEnter);
        emit Step(4);
        windowEnds = block.timestamp + 14 days;
    }

    function openGate() external {
        gate = true;
    }
}
