import { V2_GAS_FLOORS } from '../src/gas';

/** Test-only bridge: Solidity release-envelope assertions consume the keeper's published floor. */
export function renderReleaseGas(): string {
  return `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Generated from src/gas.ts by pnpm --filter @squarehole/keeper ours:write. Do not edit.
library KeeperReleaseGas {
    uint256 internal constant GRADUATE = ${V2_GAS_FLOORS.graduate};
}
`;
}
