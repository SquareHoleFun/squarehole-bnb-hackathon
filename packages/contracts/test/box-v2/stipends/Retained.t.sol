// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LinkedPayoutGasTest} from "../payout-gas/Linked.t.sol";
import {LinkedItemClaimGasTest} from "../item-claim-gas/LinkedClaims.t.sol";
import {M260HoldersTest} from "../gas/m2/Holders.t.sol";
import {M260BoundariesTest} from "../gas/m2/Boundaries.t.sol";
import {M260ShopTest} from "../gas/m2/Shop.t.sol";
import {M360LifecycleTest} from "../gas/m3/Lifecycle.t.sol";
import {M360BoundariesTest} from "../gas/m3/Boundaries.t.sol";
// These fixtures deploy by artifact name; include their library links in the restricted test graph.
import {BoxFactoryV2ChecksM332Double} from "../m3-32/doubles/BoxFactoryV2ChecksM332Double.sol";
import {BoxHookV2M332Double} from "../m3-32/doubles/BoxHookV2M332Double.sol";
import {BoxHookV2ExtensionM332Double} from "../m3-32/doubles/BoxHookV2ExtensionM332Double.sol";

/// Sweep pins retain the reviewed cold, half-cap, exhaustion and exact activation assertions.
/// Their original fixture boundaries (including M360's named integration doubles) still apply.
contract SafePayoutStipendsTest is LinkedPayoutGasTest {}
contract ItemClaimStipendsTest is LinkedItemClaimGasTest {}
contract HolderNoticeStipendsTest is M260HoldersTest {}
contract HolderReserveStipendsTest is M260BoundariesTest {}
contract ShopRecoveryStipendsTest is M260ShopTest {}
contract ItemNoticeStipendsTest is M360LifecycleTest {}
contract ItemReserveStipendsTest is M360BoundariesTest {}
