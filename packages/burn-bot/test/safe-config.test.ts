import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { validateManifest, validateSnapshot, buildAction } from '../src/builders';
import type { Manifest, Snapshot } from '../src/types';
import { addr, hash, manifest, snapshot, lot, quote } from './fixtures';

// The FIT Safe's pins are reviewed per deployment: 1.4.1 with no guard or handler, or 1.5.0 with its own.
const guarded = { version: '1.5.0' as const, codeHash: hash(102n), singleton: addr(21n), singletonCodeHash: hash(21n),
  guard: addr(31n), guardCodeHash: hash(31n), handler: addr(32n), handlerCodeHash: hash(32n) };
const guardedManifest: Manifest = { ...manifest, safeConfigs: { fit: guarded } };
const guardedSnapshot = (): Snapshot => ({ ...snapshot(), version: guarded.version, singleton: guarded.singleton,
  guard: guarded.guard, fallbackHandler: guarded.handler, codeHashes: { ...snapshot().codeHashes, [manifest.safes.fit]: guarded.codeHash,
    [guarded.singleton]: guarded.singletonCodeHash, [guarded.guard]: guarded.guardCodeHash, [guarded.handler]: guarded.handlerCodeHash } });

describe('M1/M2 independently reviewed Safe configuration', () => {
  it('accepts the FIT Safe on 1.4.1, or on 1.5.0 with its own reviewed guard/handler', () => {
    expect(validateSnapshot(validateManifest(manifest), snapshot(), 'fit').version).toBe('1.4.1');
    const m = validateManifest(guardedManifest);
    expect(validateSnapshot(m, guardedSnapshot(), 'fit').version).toBe('1.5.0');
    expect(buildAction(m, guardedSnapshot(), lot(),
      { kind: 'sale', lotId: 'lot-1', amount: 100n, routeId: 'coin-eth', quote: quote() }).role).toBe('fit');
  });

  it.each([
    ['1.4.1', manifest, snapshot], ['1.5.0 guarded', guardedManifest, guardedSnapshot],
  ] as const)('refuses changed runtime, singleton and unreviewed state for the %s FIT Safe', (_pin, m, make) => {
    const s = make();
    const config = m.safeConfigs.fit;
    for (const patch of [
      { version: '1.3.0' }, { singleton: addr(99n) }, { modules: [addr(99n)] },
      { guard: addr(99n) }, { fallbackHandler: addr(99n) },
      ...[s.safe, config.singleton, config.guard, config.handler].filter(a => a !== zeroAddress)
        .map(a => ({ codeHashes: { ...s.codeHashes, [a]: hash(999n) } })),
    ]) expect(() => validateSnapshot(m, { ...s, ...patch }, 'fit')).toThrow(/Safe configuration/);
  });

  it('does not widen a FIT Safe pinned at 1.4.1 to 1.5.0', () => {
    expect(() => validateSnapshot(manifest, { ...snapshot(), version: '1.5.0' }, 'fit')).toThrow();
  });

  it('refuses missing identity pins and unsupported versions', () => {
    for (const patch of [{ version: '9.9.9' }, { codeHash: hash(0n) }, { singleton: zeroAddress },
      { singletonCodeHash: hash(0n) }, { guardCodeHash: hash(0n) }, { handlerCodeHash: hash(0n) }]) {
      expect(() => validateManifest({ ...manifest, safeConfigs: { fit: { ...guarded, ...patch } } })).toThrow();
    }
  });
});
