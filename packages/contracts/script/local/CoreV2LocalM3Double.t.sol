// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LocalOpenItemLedgerDouble} from "./LocalOpenItemLedgerDouble.sol";
import {LocalV2DeploymentHarness, CoreV2LocalTest} from "./CoreV2Local.t.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {BoxHookV2M332Double} from "../../test/box-v2/m3-32/doubles/BoxHookV2M332Double.sol";
import {BoxHookV2ExtensionM332Double} from "../../test/box-v2/m3-32/doubles/BoxHookV2ExtensionM332Double.sol";
import {BoxFactoryV2ChecksM332Double} from "../../test/box-v2/m3-32/doubles/BoxFactoryV2ChecksM332Double.sol";

/// @notice Offline integration double only. The separate CoreV2LocalTest retains the real M3 failures.
/// Never imported by a broadcast script. No mock RPC, fee receipts, custody, item ledger or pile is substituted.
contract CoreV2LocalM3DoubleTest is CoreV2LocalTest {
    function setUp() public override {
        super.setUp();
        IPoolManager pm = IPoolManager(localFactory.poolManager());
        address ext = address(new BoxHookV2ExtensionM332Double(pm));
        address hook = address(new BoxHookV2M332Double(pm, localFactory.implementation(0), ext));
        vm.etch(localFactory.implementation(2), hook.code);
        address checks = address(new BoxFactoryV2ChecksM332Double());
        vm.etch(address(localFactory.checks()), checks.code);
    }
}

/// @notice Explicit additional open-art ledger double; no broadcast entry uses this deployment recipe.
contract LocalV2OpenItemDeploymentHarness is LocalV2DeploymentHarness {
    function _localItemLedgerArtifact() internal pure override returns (string memory) {
        return "LocalOpenItemLedgerDouble.sol:LocalOpenItemLedgerDouble";
    }
}

/// @notice Money/life recipe proof against named doubles only, not evidence of a working production M3 release.
contract CoreV2LocalM3RecipeTest is CoreV2LocalM3DoubleTest {
    function _deploymentHarness() internal override returns (LocalV2DeploymentHarness) {
        return new LocalV2OpenItemDeploymentHarness();
    }
}
