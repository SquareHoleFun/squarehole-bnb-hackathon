// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Keep the independent behavioral oracle; only isolated production code is mutated.
import {HolderReceiverTest} from "../m2-30/HolderReceiver.t.sol";

contract M262Receiver is HolderReceiverTest {}
