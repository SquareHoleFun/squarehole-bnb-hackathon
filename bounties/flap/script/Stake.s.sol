// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RailStake} from "fee-rules/RailStake.sol";

interface IERC20St {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
}

/// @notice A holder's side of a RailStake, chosen by ACTION, on the stake in SALE_FILE's `stake` field (default
/// `deployments/<chainId>-rules-usdt-sale.json`; STAKE overrides the address).
///   ACTION=status                     the settings, the sender's stake and claimable, the stream (no transaction)
///   ACTION=stake    TOKENS_WEI=...    approve and stake (asserts the credit; default: all the sender holds)
///   ACTION=unstake  TOKENS_WEI=...    take tokens back (default: all of the sender's stake)
///   ACTION=sync                       count what arrived and stream it over the period
///   ACTION=claim                      pay the sender what it earned
contract Stake is Script {
    function _stake() internal view returns (RailStake) {
        address a = vm.envOr("STAKE", address(0));
        if (a == address(0)) {
            string memory file = vm.envOr(
                "SALE_FILE", string.concat("deployments/", vm.toString(block.chainid), "-rules-usdt-sale.json")
            );
            a = vm.parseJsonAddress(vm.readFile(string.concat(vm.projectRoot(), "/", file)), ".stake");
        }
        require(a.code.length > 0, "no stake contract at that address");
        return RailStake(payable(a));
    }

    function run() external {
        RailStake s = _stake();
        bytes32 a = keccak256(bytes(vm.envOr("ACTION", string("status"))));
        address me = msg.sender;
        if (a == keccak256("status")) return _status(s, me);
        vm.startBroadcast();
        if (a == keccak256("stake")) {
            uint256 amount = vm.envOr("TOKENS_WEI", IERC20St(s.token()).balanceOf(me)); // default: all the sender holds
            IERC20St(s.token()).approve(address(s), amount);
            uint256 credited = s.stake(amount);
            require(credited > 0, "nothing credited");
            console.log(string.concat("staked, credited ", vm.toString(credited)));
        } else if (a == keccak256("unstake")) {
            uint256 amount = vm.envOr("TOKENS_WEI", s.stakedOf(me));
            uint256 t0 = IERC20St(s.token()).balanceOf(me);
            s.unstake(amount);
            console.log(string.concat("unstaked ", vm.toString(IERC20St(s.token()).balanceOf(me) - t0)));
        } else if (a == keccak256("sync")) {
            console.log(string.concat("counted ", vm.toString(s.sync())));
        } else if (a == keccak256("claim")) {
            console.log(string.concat("claimed ", vm.toString(s.claim())));
        } else {
            revert("ACTION must be status, stake, unstake, sync or claim");
        }
        vm.stopBroadcast();
    }

    function _status(RailStake s, address me) internal view {
        console.log(string.concat("stake ", vm.toString(address(s)), ", token ", vm.toString(s.token())));
        console.log(string.concat("asset ", vm.toString(s.asset()), ", period ", vm.toString(s.period()), " s"));
        console.log(string.concat("total staked ", vm.toString(s.totalStaked()), ", yours ", vm.toString(s.stakedOf(me))));
        console.log(string.concat("claimable (yours) ", vm.toString(s.claimable(me))));
        console.log(string.concat("arrived ", vm.toString(s.arrived()), ", claimed ", vm.toString(s.claimed())));
        console.log(string.concat("undistributed ", vm.toString(s.undistributed()), ", unsynced ", vm.toString(s.unsynced())));
        console.log(string.concat("rate per second ", vm.toString(s.ratePerSecond()), ", stream ends ", vm.toString(s.streamEnd())));
    }
}
