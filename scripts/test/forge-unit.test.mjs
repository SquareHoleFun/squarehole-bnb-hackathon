import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { foundryRemappings, importGraph, importersOf, projectSources, solidityImports } from '../gates/solidity-imports.mjs';

const root = new URL('../../packages/contracts/', import.meta.url);
const manager = 'lib/v4-core/src/PoolManager.sol';
const markers = ['test/box-v2/rc6-cow/ForkCowArtifacts.sol', 'test/utils/v4/PoolManagerBuild.sol'];

test('SH-200: only the two artifact markers reach the upstream PoolManager compiler unit', () => {
  const sources = new Map([...projectSources(fileURLToPath(root))].map(([file, source]) => [file, solidityImports(source)]));
  for (const [profile, remappings] of foundryRemappings(readFileSync(new URL('foundry.toml', root), 'utf8'))) {
    const graph = importGraph(sources, remappings);
    assert.deepEqual(importersOf(graph, manager), markers, `${profile}: use IPoolManager and deployCode, never import a marker or PoolManager`);
    for (const marker of markers) assert.deepEqual(graph.get(marker), [manager], `${marker} must remain artifact-only`);
  }
});

test('import parsing ignores comments and strings and accepts every Solidity import form', () => {
  assert.deepEqual(solidityImports(`
    // import "fake.sol";
    /* import {Fake} from "fake.sol"; */
    string constant text = "import 'fake.sol'; // not a comment";
    import "one.sol";
    import 'two.sol' as Two;
    import * as Three from "three.sol";
    import { Four as Alias, Five } /* explanation */ from
      'four.sol';
  `), ['one.sol', 'two.sol', 'three.sol', 'four.sol']);
  assert.throws(() => solidityImports('import {Broken} from "broken.sol"'), /Malformed/);
});

test('remapped, relative, transitive and cyclic imports cannot hide a new importer', () => {
  const remappings = foundryRemappings(`[profile.default]
    remappings = ["v4-core/=lib/v4-core/", "@uniswap/v4-core/=lib/v4-core/", "local/=src/"]
    [profile.alternate]
    remappings = ['local/=test/'] # independent override
  `);
  assert.equal(remappings.get('alternate')[0].target, 'test/');
  const graph = importGraph(new Map([
    ['test/Marker.sol', 'import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";'],
    ['src/Helper.sol', 'import "../test/Marker.sol"; import "./Cycle.sol";'],
    ['src/Cycle.sol', 'import "./Helper.sol";'],
    ['test/Regression.sol', 'import {Helper} from "local/Helper.sol";'],
    ['test/Safe.sol', 'import "v4-core/src/interfaces/IPoolManager.sol";'],
  ]), remappings.get('default'));
  assert.deepEqual(importersOf(graph, manager), ['src/Cycle.sol', 'src/Helper.sol', 'test/Marker.sol', 'test/Regression.sol']);
  assert.throws(() => importGraph(new Map([['test/Bad.sol', 'import "./Missing.sol";']]), []), /unresolved import/);
});
