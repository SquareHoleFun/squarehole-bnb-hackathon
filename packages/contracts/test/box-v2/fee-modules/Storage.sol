// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {ReceiverBooksV21} from "../../../src/box-v2/libraries/ReceiverBooksV21.sol";
/// Compiler layout witness: the linked core overlay must match every receiver slot and nested type.
contract FeeCoreStorageWitness { ReceiverBooksV21.State internal state; }
