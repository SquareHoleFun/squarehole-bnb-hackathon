// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {HostileToken} from "../HostileToken.sol";
import {IBoxHookV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxCoordinatorV2} from "../../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";

/// @notice TEST ONLY CQ11 shape model. Real-token balances stand in for P claims; no curve or reserve splitting.
contract MockBoxHookV2 {
    HostileToken public immutable p;
    address public coordinator;
    address public receiver;
    bool public failed;
    bool public closed;
    uint256 public closedAt;
    uint256 public lastProtocolBlock;
    uint256 public saleFeesPending;
    constructor(HostileToken p_) { p = p_; }
    function wire(address c, address r) external { require(coordinator == address(0)); coordinator = c; receiver = r; }
    function scriptFill() external { require(!closed); closed = true; closedAt = block.timestamp; }
    function scriptSaleFee(uint256 amount) external { p.mint(receiver, amount); saleFeesPending += amount; }
    function scriptProtocolStep() external {
        if (lastProtocolBlock == block.number) revert IBoxHookV2.ProtocolStepTaken();
        lastProtocolBlock = block.number;
    }
    function harvest() external returns (uint256 buyersP, uint256 sellersP, uint256 qToReserve) {
        if (msg.sender != receiver) revert IBoxHookV2.NotReceiver(msg.sender);
        sellersP = saleFeesPending; saleFeesPending = 0;
        emit IBoxHookV2.HarvestedV2(PoolId.wrap(0), 0, sellersP, 0);
        return (0, sellersP, 0);
    }
    function close() external returns (uint256 qToPot, uint256 tBurned) {
        if (msg.sender != coordinator) revert IBoxHookV2.NotCoordinator(msg.sender);
        if (failed) revert IBoxHookV2.BoxFailed();
        failed = true;
        qToPot = p.balanceOf(address(this));
        require(p.transfer(coordinator, qToPot));
        emit IBoxHookV2.Closed(PoolId.wrap(0), qToPot, 0);
        return (qToPot, 0);
    }
}

/// @notice TEST ONLY minimal close/claim model for CQ11 jobs. No vault, tips or reserve model; lane 2 adds M1-03.
contract MockBox {
    HostileToken public immutable p;
    HostileToken public immutable t;
    MockBoxHookV2 public immutable hook;
    address public immutable fitSafe;
    bool public failed;
    bool public graduated;
    uint256 public tLeft;
    constructor(HostileToken p_, HostileToken t_, MockBoxHookV2 h, address fit) { p=p_; t=t_; hook=h; fitSafe=fit; }
    function graduate() external {
        if (failed) revert IBoxCoordinatorV2.AlreadyFailed();
        require(hook.closed()); graduated=true;
    }
    function fail() external {
        if (failed) revert IBoxCoordinatorV2.AlreadyFailed();
        require(!graduated);
        if (hook.closed() && block.timestamp < hook.closedAt() + 7 days)
            revert IBoxCoordinatorV2.GraduationEscapeNotReached(hook.closedAt() + 7 days);
        failed=true;
        hook.close();
        tLeft=t.totalSupply()-t.balanceOf(address(this))-t.balanceOf(address(hook));
        emit IBoxCoordinatorV2.PotFixed(p.balanceOf(address(this)),tLeft,0,msg.sender);
    }
    function quoteClaim(uint256 amount) public view returns (uint256) {
        require(failed && amount > 0 && amount <= tLeft);
        uint256 pot=p.balanceOf(address(this));
        return amount == tLeft ? pot : FullMath.mulDiv(pot,amount,tLeft);
    }
    function claimState() external view returns (uint256 pot,uint256 left) { return (p.balanceOf(address(this)),tLeft); }
    function claim(uint256 amount,address to) external returns (uint256 value) {
        require(to != address(0)); value=quoteClaim(amount); tLeft-=amount;
        require(t.transferFrom(msg.sender,address(this),amount));
        t.burn(amount); require(p.transfer(to,value));
        emit IBoxCoordinatorV2.Claimed(msg.sender,to,amount,value);
    }
}
