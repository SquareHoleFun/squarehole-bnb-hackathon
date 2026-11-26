// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Compiles the pinned Uniswap v4 PoolManager (BUSL-1.1, lib/v4-core @ 46c68346) with the upstream settings
// (foundry.toml `compilation_restrictions`: via-IR, 44,444,444 runs) so tests can deploy it from its artifact with
// `deployCode`. Test-only: nothing in src/ imports PoolManager, and it is never deployed outside local tests.
// Test files must NOT import PoolManager directly: an importer would be compiled under both compiler profiles and
// its tests would run twice and its dependency graph would enter the slow via-IR unit.
// scripts/test/forge-unit.test.mjs guards the two artifact-only markers (this file and ForkCowArtifacts.sol).
import {PoolManager} from "v4-core/src/PoolManager.sol";
