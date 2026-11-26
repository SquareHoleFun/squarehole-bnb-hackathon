// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    SetPoolLoadGasTest,
    SetPoolOpenGasTest,
    SetPoolTradeGasTest,
    SetPoolGraduateGasTest,
    SetPoolPickGasTest,
    SetPoolReturnGasTest,
    SetPoolFailGasTest,
    SetPoolRecoveryGasTest,
    SetPoolFillGasTest,
    SetPoolERC20TradeGasTest,
    SetPoolERC20GraduateGasTest,
    SetPoolERC20FailGasTest,
    SetPoolCreateGasTest
} from "../SetPoolGas.t.sol";
import {SetPoolMaxConversionTest, SetPoolMaxFailureTest, SetPoolMaxRecoveryTest} from "../SetPoolMax.t.sol";

/// E09B report entry: inherit E07 measurements re-budgeted by E09C, including hostile floors and batch backoff.
/// All measurements run under sepolia-rehearsal, including the four N=10000 cases.
contract ReportSetPoolLoadGasTest is SetPoolLoadGasTest {}

contract ReportSetPoolOpenGasTest is SetPoolOpenGasTest {}

contract ReportSetPoolTradeGasTest is SetPoolTradeGasTest {}

contract ReportSetPoolGraduateGasTest is SetPoolGraduateGasTest {}

contract ReportSetPoolPickGasTest is SetPoolPickGasTest {}

contract ReportSetPoolReturnGasTest is SetPoolReturnGasTest {}

contract ReportSetPoolFailGasTest is SetPoolFailGasTest {}

contract ReportSetPoolRecoveryGasTest is SetPoolRecoveryGasTest {}

contract ReportSetPoolFillGasTest is SetPoolFillGasTest {}

contract ReportSetPoolERC20TradeGasTest is SetPoolERC20TradeGasTest {}

contract ReportSetPoolERC20GraduateGasTest is SetPoolERC20GraduateGasTest {}

contract ReportSetPoolERC20FailGasTest is SetPoolERC20FailGasTest {}

contract ReportSetPoolCreateGasTest is SetPoolCreateGasTest {}

contract ReportSetPoolMaxConversionTest is SetPoolMaxConversionTest {}

contract ReportSetPoolMaxFailureTest is SetPoolMaxFailureTest {}

contract ReportSetPoolMaxRecoveryTest is SetPoolMaxRecoveryTest {}
