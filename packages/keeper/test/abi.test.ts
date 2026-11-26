/**
 * ABI drift guard: every function and event the keeper encodes must match the compiled frozen interface it names (M1-00's
 * files and v1's), by signature and outputs. The artifacts live in packages/contracts/out (gitignored; `forge build`);
 * without them the comparison is reported as skipped, never as passed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ABI_SOURCES, canonicalInputs, canonicalOutputs } from '../src/abi';

const OUT = new URL('../../contracts/out/', import.meta.url);
type ArtifactItem = { type: string; name?: string; inputs?: unknown[]; outputs?: unknown[]; stateMutability?: string };
/** Review round 1, L5: an event's `indexed` flags decide its topics, so they are compared too. */
const indexed = (item: { inputs?: readonly unknown[] }) => ((item.inputs ?? []) as { indexed?: boolean }[]).map((i) => Boolean(i.indexed)).join(',');
/**
 * SH-V21-RC7-INT release review RR-2: a source compiled under two profiles (foundry.toml's v4-upstream) is written as
 * `<Name>.default.json` and `<Name>.v4-upstream.json`, not `<Name>.json`, so a fresh full build has no
 * `IExtsload.sol/IExtsload.json`. Take the named file, or else its default-profile file.
 */
const resolved = (path: string): string | null => [path, path.replace(/\.json$/, '.default.json')]
  .find((p) => existsSync(new URL(p, OUT))) ?? null;
const artifact = (path: string) => JSON.parse(readFileSync(new URL(resolved(path) ?? path, OUT), 'utf8')) as { abi: ArtifactItem[] };
const contractsBuilt = existsSync(OUT);
const built = ABI_SOURCES.every((s) => s.artifact === null || resolved(s.artifact) !== null);

describe('the keeper\'s ABIs against the frozen interfaces', () => {
  // Drand coverage must not disappear just because an unrelated optional artifact is absent in a lane.
  for (const source of ABI_SOURCES.filter(s => s.name.startsWith('drand') || s.name === 'backedSource')) {
    it.skipIf(!source.artifact || resolved(source.artifact) === null)(`pins ${source.name} calls to its compiled contract`, () => {
      if (!source.artifact) throw new Error('artifact missing');
      const compiled = artifact(source.artifact).abi;
      for (const item of source.abi) {
        if (item.type !== 'function' && item.type !== 'event' && item.type !== 'error') continue;
        const match = compiled.find(c => c.type === item.type && c.name === item.name && canonicalInputs(c) === canonicalInputs(item));
        expect(match, `${source.name}.${item.name}`).toBeDefined();
        if (item.type === 'function') {
          expect(canonicalOutputs(match ?? {})).toBe(canonicalOutputs(item));
          expect(match?.stateMutability).toBe(item.stateMutability);
        } else expect(indexed(match ?? {})).toBe(indexed(item));
      }
    });
  }
  it('names an artifact for every in-repo contract it calls', () => {
    expect(ABI_SOURCES.map((s) => s.name)).toEqual(['drandSource', 'backedSource', 'drandTicketsV1', 'drandTicketsV2', 'drandVault', 'item', 'itemFunding', 'itemLifecycle', 'pile', 'pileFactory', 'holder', 'holderFunding', 'holderBatch', 'shop', 'boxRegistry', 'coordinator', 'coordinatorV1', 'hookV2', 'receiverV2', 'receiverCursors', 'receiverPileV21', 'receiverModulesV21', 'receiverEatV21', 'launchRouterV2', 'hookV1', 'receiverV1', 'fitExecutor', 'poolManager']);
    for (const s of ABI_SOURCES) expect(s.artifact === null ? s.external : s.artifact, s.name).toBeTruthy();
  });

  // RR-2: once the contracts are built, a named artifact that cannot be found is a red, not a silent skip of the guard.
  it.skipIf(!contractsBuilt)('finds every named artifact when packages/contracts/out exists', () => {
    const missing = ABI_SOURCES.filter((s) => s.artifact !== null && resolved(s.artifact) === null).map((s) => `${s.name}: ${s.artifact}`);
    expect(missing).toEqual([]);
  });

  it.skipIf(!built)('matches every compiled artifact by signature and outputs (needs forge build)', () => {
    for (const source of ABI_SOURCES) {
      if (source.artifact === null) continue;
      const compiled = artifact(source.artifact).abi;
      for (const item of source.abi) {
        if (item.type !== 'function' && item.type !== 'event' && item.type !== 'error') continue;
        const match = compiled.find((c) => c.type === item.type && c.name === item.name && canonicalInputs(c) === canonicalInputs(item));
        expect(match, `${source.name}.${item.name}(${canonicalInputs(item)})`).toBeDefined();
        if (item.type === 'function') {
          expect(canonicalOutputs(match ?? {}), `${source.name}.${item.name}`).toBe(canonicalOutputs(item));
          expect(match?.stateMutability, `${source.name}.${item.name} mutability`).toBe(item.stateMutability);
        } else {
          expect(indexed(match ?? {}), `${source.name}.${item.name} indexed`).toBe(indexed(item));
        }
      }
    }
  });
});
