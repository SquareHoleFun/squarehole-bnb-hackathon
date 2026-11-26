// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRailStakeFactory} from "./IRailStake.sol";
import {RailStake} from "./RailStake.sol";

/// @title RailStakeFactory
/// @notice Creates one RailStake per (creator, token), by that creator, with CREATE2 at an address that commits to
/// every setting: the salt is the hash of (creator, token, asset, period), so an address a launch names as a payee
/// can only ever hold a stake with those settings, and the creator cannot give it another asset or period later.
/// The new contract reads its settings from here while it is created (one init code for all). Income paid to the
/// address before `create` is counted by the first sync. No owner, no fee.
///
/// Stated limit: the creator may never create the stake a launch names, or create one with other settings first
/// (one per creator and token), and then the named address never holds code and what is paid there stays there. A
/// page therefore shows a holders' rule as a stake only when its payee is `stakeOf(creator, token)` already when it
/// is read; creating the stake before the sale is the order that lets buyers see it before the first buy.
contract RailStakeFactory is IRailStakeFactory {
    uint256 public constant MIN_PERIOD = 1 hours;
    uint256 public constant MAX_PERIOD = 365 days;

    /// keccak256 of RailStake's creation code
    bytes32 public immutable STAKE_CODE_HASH;

    mapping(address => mapping(address => address)) public stakeOf;
    mapping(address => bool) public isStake;

    struct Params {
        address creator;
        address token;
        address asset;
        uint256 period;
    }

    Params private _params;

    constructor() {
        STAKE_CODE_HASH = keccak256(type(RailStake).creationCode);
    }

    function create(address token, address asset, uint256 period) external returns (address stake) {
        if (token == address(0) || token == asset) revert InvalidSettings("token");
        if (asset != address(0) && asset.code.length == 0) revert InvalidSettings("asset has no code");
        if (period < MIN_PERIOD || period > MAX_PERIOD) revert InvalidSettings("period");
        address existing = stakeOf[msg.sender][token];
        if (existing != address(0)) revert AlreadyCreated(existing);
        _params = Params(msg.sender, token, asset, period);
        stake = address(new RailStake{salt: _salt(msg.sender, token, asset, period)}());
        delete _params;
        stakeOf[msg.sender][token] = stake;
        isStake[stake] = true;
        emit StakeCreated(stake, msg.sender, token, asset, period);
    }

    /// Read by RailStake's constructor during `create`.
    function parameters() external view returns (address, address, address, uint256) {
        Params memory p = _params;
        return (p.creator, p.token, p.asset, p.period);
    }

    function stakeAddress(address creator, address token, address asset, uint256 period) public view returns (address) {
        bytes32 salt = _salt(creator, token, asset, period);
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, STAKE_CODE_HASH)))));
    }

    function _salt(address creator, address token, address asset, uint256 period) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, token, asset, period));
    }
}
