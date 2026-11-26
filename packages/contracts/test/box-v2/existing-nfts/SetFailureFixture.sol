// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetConversionFixture, ConversionVault} from "./SetConversionFixture.sol";
import {PricingToken} from "../../../src/box-v2/libraries/PricingToken.sol";

// Independent ABI so the first red run compiles against the E-04 production vault.
interface RecoveryVault {
    event ReleaseSucceeded(address indexed collection, uint256 indexed id, address indexed creator);
    event ReleaseDeferred(address indexed collection, uint256 indexed id);
    function releaseToCreator(uint256[] calldata ids) external returns (uint256 released);
    function releaseOne(uint256 id) external;
}

/// A real contract creator without an ERC-721 receiver hook.
contract NonreceiverCreator {
    function execute(address target, bytes calldata data) external {
        (bool ok,) = target.call(data);
        require(ok, "creator call");
    }
}

abstract contract SetFailureFixture is SetConversionFixture {
    function recovery() internal view returns (RecoveryVault) {
        return RecoveryVault(address(vault));
    }

    function _start(uint256 count, uint256 loaded, bool hostile) internal {
        if (hostile) _hostile(count);
        else _standard(count);
        _deploy(true);
        conversion = ConversionVault(address(vault));
        for (uint256 i; i < loaded; i += 32) {
            _page(i, loaded - i > 32 ? 32 : loaded - i);
        }
    }

    function _failClosed() internal {
        vm.warp(box.openAt() + box.GATE_CAP());
        box.failClosed();
        assertTrue(box.failed());
        assertTrue(vault.failed());
    }

    function _fundPot(uint256 amount) internal {
        vm.deal(address(this), amount);
        pm.unlock(abi.encode(amount));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm));
        uint256 amount = abi.decode(data, (uint256));
        PricingToken.settle(pm, address(0), amount);
        pm.mint(address(hook), 0, amount);
        return "";
    }

    function _give(address to, uint256 amount) internal {
        vm.prank(address(box));
        token.transfer(to, amount);
    }
}
