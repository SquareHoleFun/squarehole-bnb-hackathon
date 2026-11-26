// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {ReceiverFundingTest} from "../m2-30/ReceiverFunding.t.sol";

contract M262Funding is ReceiverFundingTest {}
