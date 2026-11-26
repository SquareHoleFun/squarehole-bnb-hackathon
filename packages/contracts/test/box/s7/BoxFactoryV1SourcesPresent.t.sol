// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {BoxFactoryV1} from "../../../src/box/BoxFactoryV1.sol";
import {BoxTickets} from "../../../src/box/BoxTickets.sol";
import {IBoxFactoryV1} from "../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BoxBackedSource} from "../../../src/box/randomness/BoxBackedSource.sol";
import {PinnedBackedSource} from "../randomness/utils/PinnedBackedSource.sol";
import {PinnedDrandSource} from "../randomness/utils/PinnedDrandSource.sol";
import {BoxS7Base} from "./BoxS7Base.sol";

/// @notice Both random sources are deterministic deployments anyone may send (no constructor input, one CREATE2
/// address on chains 1 and 11155111), so after Sepolia someone may put either or both on mainnet before our deploy.
/// The deployment (`CoreV1Deployment`, the steps `DeployCoreV1.s.sol` sends) then sends no call for a present source,
/// and the factory takes the CREATE address of the deployer's nonce at deploy time: one nonce earlier per present
/// source, and box 0's addresses (fixed by the factory's) move with it. So the mainnet deploy derives them from the
/// chain, never from a table made for a chain without the sources (SH-V21-RC8-INT part 2a; the mainnet launch
/// runbook, step 7). The case with both absent is the S7 base's own deployment and `DeployCoreV1Identities.t.sol`.
/// forge-config: default.evm_version = "osaka"
contract BoxFactoryV1SourcesPresentTest is BoxS7Base {
    function setUp() public override {
        _fixtureEncoded = vm.parseJsonBytes(vm.readFile(BOX_SPEC_VECTORS), ".columns.encoded[0]");
        _world();
    }

    function test_bothSourcesAlreadyDeployed() public {
        _deployAfter(true, true);
    }

    function test_onlyTheDrandSourceAlreadyDeployed() public {
        _deployAfter(true, false);
    }

    function test_onlyTheBackedSourceAlreadyDeployed() public {
        _deployAfter(false, true);
    }

    /// @dev Someone else sends the present sources' deterministic deployments, then our deployment runs and box 0 is
    /// created from its fixture.
    function _deployAfter(bool drandThere, bool backedThere) internal {
        vm.startPrank(makeAddr("anyone, before our deploy"));
        if (drandThere) PinnedDrandSource.deploy(vm);
        if (backedThere) PinnedBackedSource.deploy(vm);
        vm.stopPrank();
        uint256 nonce = vm.getNonce(address(this));
        version = _deployCoreV1(_config());
        uint256 missing = (drandThere ? 0 : 1) + (backedThere ? 0 : 1);
        assertEq(
            version.factory,
            vm.computeCreateAddress(address(this), nonce + CORE_V1_CREATES_BEFORE_FACTORY + missing),
            "the factory: twelve CREATEs, then one call per missing source"
        );
        assertTrue(
            version.factory != vm.computeCreateAddress(address(this), nonce + CORE_V1_CREATES_BEFORE_FACTORY + 2),
            "not where a table for a chain without the sources would put it"
        );
        assertEq(version.drandDeployed, !drandThere, "the DrandSource is sent only when absent");
        assertEq(version.randomnessDeployed, !backedThere, "the BoxBackedSource is sent only when absent");
        assertEq(_coreV1Steps.length, CORE_V1_CREATES_BEFORE_FACTORY + missing + 1, "no step for a present source");
        assertEq(version.drand, address(PinnedDrandSource.predict()), "the pinned DrandSource");
        assertEq(version.randomness, address(PinnedBackedSource.predict()), "box 0's pinned BoxBackedSource");
        // Box 0 follows the factory and reads the pinned backed source, which names the pinned DrandSource.
        factory = BoxFactoryV1(version.factory);
        IBoxFactoryV1.Box0Addresses memory a = factory.box0Addresses();
        assertEq(a.coordinator, vm.computeCreateAddress(address(factory), 2), "box 0's coordinator: the factory's");
        (uint256 boxId, address coordinator,,) = _createBox0(factory, _box0Spec());
        assertEq(boxId, 0);
        assertEq(coordinator, a.coordinator);
        assertEq(BoxTickets(a.tickets).source(), version.randomness, "box 0 reads its backed source");
        assertEq(address(BoxBackedSource(version.randomness).DRAND()), version.drand, "which posts on the DrandSource");
    }
}
