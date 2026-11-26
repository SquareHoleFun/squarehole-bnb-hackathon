/**
 * Core v2's roles (ADR-0017 § 12; core-v2-m1-tickets.md § 2, M1-00: "`packages/chain/src/core/roles.ts` (v2 roles
 * beside v1's)"): `ROLE_V2` beside v1's `ROLE`, v1's 0-12 unchanged, 13 sampler, 14-15 LEG clones, 16 the M3 item
 * ledger, 17 the M2 holder ledger, 18 an add-on 9 part, 19 the M2 starter-set loader, 20-23 reserved, count 24; the
 * same numbers as `BoxRolesV2` in packages/contracts/src/box-v2/interfaces/IBoxRegistryV2.sol, which
 * packages/contracts/test/box-v2/shape/RegistryShape.t.sol also pins. [P] the export names `ROLE_V2`,
 * `ROLE_V2_COUNT` and `ROLE_V2_NAMES`, the new role keys (camelCase, as v1's) and one key per reserved index.
 * Integrated at M1-00 from the owner's test (sh-v2-m1-00c) and the shape-test writer's (sh-v2-m1-00t).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as abis from '../abi/index';
import { CORE_EVENTS, ROLE, ROLE_COUNT, ROLE_V2, ROLE_V2_COUNT, ROLE_V2_NAMES } from './roles';

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '../../../contracts/src');

/** `NAME = n;` constants of one Solidity library or contract body, in source order. */
function solidityConstants(path: string, container: string): Map<string, number> {
  const source = readFileSync(join(CONTRACTS, path), 'utf8');
  const start = source.search(new RegExp(`\\b(library|contract) ${container}\\b`));
  expect(start, `${container} in ${path}`).toBeGreaterThanOrEqual(0);
  const body = source.slice(start, source.indexOf('\n}', start));
  const found = new Map<string, number>();
  for (const [, name, value] of body.matchAll(/uint256 (?:public|internal) constant (ROLE_[A-Z0-9_]+) = (\d+);/g)) {
    if (name !== undefined && value !== undefined) found.set(name, Number(value));
  }
  return found;
}

/** `itemLedger` → `ROLE_ITEM_LEDGER`, `leg0` → `ROLE_LEG_0`. */
const solidityName = (name: string): string =>
  `ROLE_${name.replace(/([a-z])([A-Z0-9])/g, '$1_$2').toUpperCase()}`;

describe('core v2 roles beside v1 (M1-00)', () => {
  it('leaves v1 roles as they are', () => {
    expect(ROLE_COUNT).toBe(13);
    expect(Object.keys(ROLE)).toHaveLength(13);
  });

  it("keeps v1's 0-12 in v2 under the same names", () => {
    for (const [name, index] of Object.entries(ROLE)) {
      expect((ROLE_V2 as Record<string, number>)[name], name).toBe(index);
    }
  });

  it('adds 13 sampler, 14-15 LEG clones, 16 item ledger, 17 holder ledger, 18 add-on 9, 19 starter-set loader, 20-23 reserved', () => {
    expect(ROLE_V2.sampler).toBe(13);
    expect(ROLE_V2.leg0).toBe(14);
    expect(ROLE_V2.leg1).toBe(15);
    expect(ROLE_V2.itemLedger).toBe(16);
    expect(ROLE_V2.holderLedger).toBe(17);
    expect(ROLE_V2.heldItemEarnings).toBe(18);
    expect(ROLE_V2.starterSetLoader).toBe(19);
    expect([ROLE_V2.reserved20, ROLE_V2.reserved21, ROLE_V2.reserved22, ROLE_V2.reserved23]).toEqual([20, 21, 22, 23]);
    expect(ROLE_V2_COUNT).toBe(24);
    // Every index 0-23 has exactly one key (the reserved four included), so a record's 24 entries all decode.
    const indexes = Object.values(ROLE_V2).sort((a, b) => a - b);
    expect(indexes).toEqual([...Array(ROLE_V2_COUNT).keys()]);
    expect(ROLE_V2_NAMES.map((name) => ROLE_V2[name])).toEqual([...Array(ROLE_V2_COUNT).keys()]);
  });

  it('matches BoxRolesV2 in IBoxRegistryV2.sol and v1 BoxRegistry.sol', () => {
    const v2 = solidityConstants('box-v2/interfaces/IBoxRegistryV2.sol', 'BoxRolesV2');
    const v1 = solidityConstants('box/BoxRegistry.sol', 'BoxRegistry');
    expect(v2.get('ROLE_COUNT')).toBe(ROLE_V2_COUNT);
    expect(v1.get('ROLE_COUNT')).toBe(ROLE_COUNT);
    for (const name of ROLE_V2_NAMES) expect(v2.get(solidityName(name)), name).toBe(ROLE_V2[name]);
    for (const [name, index] of Object.entries(ROLE)) expect(v1.get(solidityName(name)), name).toBe(index);
    expect(v2.size).toBe(ROLE_V2_COUNT + 1);
  });
});


describe('F143 event sources', () => {
  it('the backed source owns request and backup events, and DrandSource owns round posts and bounties', () => {
    expect(CORE_EVENTS.backedSource).toEqual(['Requested', 'BackupStarted', 'BackupFixed']);
    expect(CORE_EVENTS.randomness).toEqual(['Requested', 'RoundPosted', 'BountyAdded']);
  });

  it('exports the backed source ABI and its artifact digest', () => {
    expect(abis.backedSourceAbi).toBeDefined();
    expect(abis.ABI_SOURCES.find(s => s.name === 'backedSourceAbi')).toMatchObject({ artifact: 'BoxBackedSource.sol/BoxBackedSource.json' });
    expect(abis.backedSourceAbi.filter(e => e.type === 'event').map(e => e.name).sort()).toEqual(['BackupFixed', 'BackupStarted', 'Requested']);
  });
});
