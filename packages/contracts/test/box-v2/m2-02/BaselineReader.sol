// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IBoxCoordinatorV2} from "../../../src/box-v2/interfaces/IBoxCoordinatorV2.sol";
import {IBoxHookV2} from "../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {IBoxReceiverV2} from "../../../src/box-v2/interfaces/IBoxReceiverV2.sol";
import {IBoxTokenV2} from "../../../src/box-v2/interfaces/IBoxTokenV2.sol";

/// Test-only external M2 consumer. Uses only the supplied interfaces, not a substitute M2 ABI.
contract BaselineReader {
    struct Snapshot {
        address holder;
        address tokenLedger;
        address receiverLedger;
        address loader;
        bool pending;
        uint256 batchPaid;
        uint256 pot;
        uint256 outstanding;
        uint256 closedAt;
    }

    function read(IBoxCoordinatorV2 box, uint256 batch) external view returns (Snapshot memory s) {
        s.holder = box.roleAddress(17);
        s.tokenLedger = IBoxTokenV2(box.token()).ledger();
        IBoxReceiverV2 receiver = IBoxReceiverV2(box.receiver());
        s.receiverLedger = receiver.holderLedger();
        s.loader = box.starterSetLoader();
        s.pending = box.starterSetPending();
        s.batchPaid = receiver.holderBatchPaid(batch);
        (s.pot, s.outstanding) = box.claimState();
        s.closedAt = IBoxHookV2(box.hook()).closedAt();
    }
}
