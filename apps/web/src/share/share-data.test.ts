// @vitest-environment node
/**
 * Which box a shared link names and what its card says, read like the site reads it: the indexer gateway's answers
 * recorded from box 0's life on a local twin (e2e/fixtures/core-local/life.json), the chain when the gateway does not
 * answer, a Sepolia manifest awaiting a broadcast (nothing shown), and the Demo boxes.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DEMO_FIT_TARGET } from '../features/fit-pair/fit-target';
import { DEMO_BOXES } from '../features/boxes/demo-boxes';
import SEPOLIA_MANIFEST from '../../../../packages/contracts/deployments/core-v1/11155111.json';
import { openingOf, parseOptionsFor, shareCoreFor, stateOfPhase, type DirectBox, type ShareConfig, type ShareCore, type ShareReaders } from '@squarehole/cards';
import { loadShareBox } from './share-data';
import { parseBoxView } from '@squarehole/indexer/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../e2e/fixtures/core-local');
interface Stage {
  readonly block: string;
  readonly box: Record<string, unknown> & { asOf: { block: string; timestamp: string }; blocks: Record<string, string | null> };
}
const LIFE = JSON.parse(readFileSync(resolve(FIXTURES, 'life.json'), 'utf8')) as { token: `0x${string}`; stages: Record<string, Stage> };
// These remain v1 sharing tests; the browser fixture now also carries a v2 release.
const { releases: _releases, ...MANIFEST } = JSON.parse(readFileSync(resolve(FIXTURES, 'manifest-11155111.json'), 'utf8')) as Record<string, unknown>;
void _releases;
const TOKEN = LIFE.token.toLowerCase() as `0x${string}`;
const ORIGIN = 'http://127.0.0.1:5399';
const stage = (name: string): Stage => {
  const s = LIFE.stages[name];
  if (!s) throw new Error(`no stage ${name}`);
  return s;
};

/** A Sepolia manifest before a broadcast (the committed file is box 0's deployed version since 2026-10-21). */
const SEPOLIA_PLACEHOLDER = { schema: 'squarehole.core-deployment/v1', status: 'awaiting-broadcast', chainId: 11_155_111, network: 'sepolia' };
const LOCAL: ShareConfig = { sepoliaManifest: SEPOLIA_MANIFEST, localManifest: MANIFEST, sepoliaRpcUrls: [], localRpcUrl: 'http://127.0.0.1:8562', indexerOrigin: ORIGIN };
const CORE = shareCoreFor(11_155_111, LOCAL) as ShareCore;

function answering(answer: (url: string) => { status: number; body?: unknown }, seen: string[] = []): ShareReaders['fetch'] {
  return async (url) => {
    seen.push(url);
    const { status, body } = answer(url);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
}
const readers = (fetch: ShareReaders['fetch'], direct: ShareReaders['direct'] = null): ShareReaders => ({ fetch, direct, indexerTimeoutMs: 1000 });
const stageReaders = (name: string, seen: string[] = []) => readers(answering((url) => (url === `${ORIGIN}/v1/boxes/11155111/${TOKEN}` ? { status: 200, body: stage(name).box } : { status: 404 }), seen));

describe('from the indexer gateway (box 0 on a local twin, recorded)', () => {
  it('upcoming: opens at the row\'s time (today the open block\'s, counted from the answer\'s block and time)', async () => {
    const s = stage('upcoming');
    const seen: string[] = [];
    const lookup = await loadShareBox('11155111', TOKEN, LOCAL, stageReaders('upcoming', seen));
    expect(seen).toEqual([`${ORIGIN}/v1/boxes/11155111/${TOKEN}`]);
    // Read through the row, so the test holds for both row shapes (openBlock today, openAt after the openAt contracts).
    const { row } = parseBoxView(s.box, parseOptionsFor(CORE));
    const opening = openingOf(row, { block: BigInt(s.box.asOf.block), timestamp: BigInt(s.box.asOf.timestamp) });
    expect(opening?.opensAt).toBeGreaterThan(Number(s.box.asOf.timestamp));
    expect(lookup).toEqual({
      status: 'box',
      via: 'indexer',
      box: {
        chainId: 11_155_111,
        token: TOKEN,
        chainLabel: 'Local chain',
        name: 'The Misfits',
        ticker: 'FIT',
        demo: false,
        state: { kind: 'upcoming', ...opening },
        logoSha256: '0x2aa8e531b2837be0a979b85b772ae4a5f286bbbd19b3d1be36804c146da69c93',
        collectionCoverSha256: row.spec.collectionCoverSha256,
      },
    });
  });

  it('the window and the curve are open; closed is graduating; migrated is graduated', async () => {
    const kinds: Record<string, string> = {};
    for (const name of ['window', 'bonding', 'closed', 'graduated', 'stream']) {
      const lookup = await loadShareBox('11155111', TOKEN, LOCAL, stageReaders(name));
      kinds[name] = lookup.status === 'box' ? lookup.box.state.kind : lookup.status;
    }
    expect(kinds).toEqual({ window: 'open', bonding: 'open', closed: 'graduating', graduated: 'graduated', stream: 'graduated' });
  });

  it('upper-case hex in the link reads the same box (the token is lowercased first)', async () => {
    const lookup = await loadShareBox('11155111', `0x${TOKEN.slice(2).toUpperCase()}`, LOCAL, stageReaders('bonding'));
    expect(lookup.status).toBe('box');
  });

  it('the gateway\'s own 404 is its answer: no box (the chain is not asked)', async () => {
    const direct = { box: vi.fn() };
    const lookup = await loadShareBox('11155111', TOKEN, LOCAL, readers(answering(() => ({ status: 404 })), direct));
    expect(lookup).toEqual({ status: 'unknown', reason: 'the indexer shows no box with that token' });
    expect(direct.box).not.toHaveBeenCalled();
  });

  it('an answer for a template the manifest does not show is no box', async () => {
    const config = { ...LOCAL, localManifest: withTemplates(MANIFEST, [`0x${'ab'.repeat(32)}`]) };
    expect(await loadShareBox('11155111', TOKEN, config, stageReaders('bonding'))).toEqual({ status: 'unknown', reason: 'the indexer shows no box with that token' });
  });
});

/** The manifest with its versions' shown templates replaced. */
function withTemplates(manifest: unknown, templates: string[]): unknown {
  const m = manifest as { versions: Record<string, unknown>[] };
  return { ...m, versions: m.versions.map((v) => ({ ...v, supportedTemplates: templates })) };
}

describe('when the gateway does not answer: the chain', () => {
  const s = stage('bonding');
  const { row } = parseBoxView(s.box, parseOptionsFor(CORE));
  const found: DirectBox = { row, phase: 'bonding', at: { block: 106n, timestamp: 1_790_679_016n } };

  for (const [what, answer] of [
    ['a 5xx', () => ({ status: 503 })],
    ['an answer that fails its checks', () => ({ status: 200, body: { schema: 'something else' } })],
    ['an answer for another token', () => ({ status: 200, body: { ...s.box, token: '0x0000000000000000000000000000000000000001' } })],
  ] as const) {
    it(`${what}: the row and phase are read from the chain`, async () => {
      const direct = { box: vi.fn(async () => found) };
      const lookup = await loadShareBox('11155111', TOKEN, LOCAL, readers(answering(answer), direct));
      expect(direct.box).toHaveBeenCalledWith(CORE, TOKEN);
      expect(lookup).toMatchObject({ status: 'box', via: 'direct', box: { name: 'The Misfits', ticker: 'FIT', state: { kind: 'open' } } });
    });
  }

  it('a gateway that does not answer at all (a network error) is the same', async () => {
    const direct = { box: vi.fn(async () => found) };
    const lookup = await loadShareBox('11155111', TOKEN, LOCAL, readers(async () => Promise.reject(new TypeError('fetch failed')), direct));
    expect(lookup).toMatchObject({ status: 'box', via: 'direct' });
  });

  it('no indexer configured: the chain only', async () => {
    const fetch = vi.fn();
    const direct = { box: vi.fn(async () => found) };
    const lookup = await loadShareBox('11155111', TOKEN, { ...LOCAL, indexerOrigin: null }, readers(fetch, direct));
    expect(fetch).not.toHaveBeenCalled();
    expect(lookup).toMatchObject({ status: 'box', via: 'direct' });
  });

  it('the chain has no such token, or its read fails: no box, and why', async () => {
    expect(await loadShareBox('11155111', TOKEN, LOCAL, readers(answering(() => ({ status: 500 })), { box: async () => null }))).toEqual({ status: 'unknown', reason: 'no shown box with that token on the chain' });
    const failed = await loadShareBox('11155111', TOKEN, LOCAL, readers(answering(() => ({ status: 500 })), { box: async () => Promise.reject(new Error('rpc down')) }));
    expect(failed).toEqual({ status: 'unknown', reason: 'the indexer answered 500; the chain read failed: rpc down', failed: true });
  });
});

describe('the build\'s manifest decides what is shown', () => {
  it('Sepolia awaiting a broadcast (a placeholder manifest): no box, and nothing is fetched', async () => {
    const fetch = vi.fn();
    const config: ShareConfig = { ...LOCAL, sepoliaManifest: SEPOLIA_PLACEHOLDER, localManifest: null };
    expect(shareCoreFor(11_155_111, config)).toEqual({ reason: 'Core v1 is not on Sepolia yet' });
    expect(await loadShareBox('11155111', TOKEN, config, readers(fetch, { box: vi.fn() }))).toEqual({ status: 'unknown', reason: 'Core v1 is not on Sepolia yet' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a local manifest is accepted only as a deployed local twin', () => {
    const sepoliaNetwork = { ...(MANIFEST as Record<string, unknown>), network: 'sepolia' };
    expect(shareCoreFor(11_155_111, { ...LOCAL, localManifest: sepoliaNetwork })).toEqual({ reason: 'the local core manifest is not a deployed local twin' });
    expect(shareCoreFor(11_155_111, { ...LOCAL, localManifest: { not: 'a manifest' } })).toEqual({ reason: 'the local core manifest is not a deployed local twin' });
    expect(shareCoreFor(11_155_111, { ...LOCAL, localRpcUrl: null })).toEqual({ reason: 'no local RPC' });
  });
});

describe('links that are not box links', () => {
  it('malformed addresses and unknown chains are invalid (nothing fetched)', async () => {
    const fetch = vi.fn();
    for (const [chain, address] of [
      ['11155111', '0x123'],
      ['11155111', 'abc'],
      ['1', TOKEN],
      ['__proto__', TOKEN],
      [undefined, TOKEN],
      ['11155111', `${TOKEN}.png`],
    ] as const) {
      expect(await loadShareBox(chain, address, LOCAL, readers(fetch)), `${chain}/${address}`).toEqual({ status: 'invalid' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('the sample boxes (chain 31337)', () => {
  it('each sample box in its sample state, on "Local chain" (no Demo label, F130); the sample Misfits on their curve', async () => {
    const seen: Record<string, string> = {};
    for (const record of [...DEMO_BOXES, { name: 'Demo Misfits', token: DEMO_FIT_TARGET.token }]) {
      const lookup = await loadShareBox('31337', record.token, LOCAL, readers(vi.fn()));
      if (lookup.status !== 'box') throw new Error(`${record.name}: ${lookup.status}`);
      expect(lookup.box).toMatchObject({ demo: true, chainLabel: 'Local chain', chainId: 31_337, logoSha256: null });
      seen[`${lookup.box.name} (${lookup.box.ticker})`] = lookup.box.state.kind;
    }
    expect(seen).toEqual({
      'Paper Kites (KITE)': 'upcoming',
      'Pocket Stamps (STMP)': 'open',
      'Toy Trains (CHOO)': 'graduated',
      'Clay Pots (POTS)': 'open',
      'Tin Cans (TINS)': 'failed',
      [`${DEMO_FIT_TARGET.names.collectionName} (${DEMO_FIT_TARGET.names.tokenSymbol})`]: 'open',
    });
  });

  it('the Demo\'s upcoming box has no fixed time (its "Opens in" counts from the visit): "Upcoming", never a countdown', async () => {
    const kites = DEMO_BOXES.find((b) => b.ticker === 'KITE');
    const lookup = await loadShareBox('31337', kites?.token, LOCAL, readers(vi.fn()));
    expect(lookup).toMatchObject({ box: { state: { kind: 'upcoming', opensAt: null } } });
  });

  it('another token on the sample chain is no box', async () => {
    expect(await loadShareBox('31337', '0x00000000000000000000000000000000000000aa', LOCAL, readers(vi.fn()))).toEqual({ status: 'unknown', reason: 'not a box on this site' });
  });

  it('the production site (`demo: false`, SH-V2-FE6) knows no Demo box', async () => {
    for (const record of DEMO_BOXES) expect(await loadShareBox('31337', record.token, LOCAL, readers(vi.fn()), { demo: false })).toEqual({ status: 'unknown', reason: 'not a box on this site' });
  });
});

describe('the opening: openAt when the row has it, else the open block', () => {
  const at = { block: 100n, timestamp: 1_000_000n };
  it('a row with openAt (the openAt contracts) names its exact time', () => {
    expect(openingOf({ openAt: 1_791_734_400n }, at)).toEqual({ opensAt: 1_791_734_400, approx: false });
    expect(openingOf({ openAt: 1_791_734_400n }, null)).toEqual({ opensAt: 1_791_734_400, approx: false });
  });

  it('a row with an open block: about its time, 12 s a block from a known block (never earlier than that block)', () => {
    expect(openingOf({ openBlock: 400n }, at)).toEqual({ opensAt: 1_000_000 + 300 * 12, approx: true });
    expect(openingOf({ openBlock: 50n }, at)).toEqual({ opensAt: 1_000_000, approx: true });
    expect(openingOf({ openBlock: 400n }, null)).toBeNull();
  });

  it('phases fold into the card\'s states', () => {
    expect(stateOfPhase('upcoming', null)).toEqual({ kind: 'upcoming', opensAt: null, approx: false });
    expect(['window', 'bonding', 'graduating', 'graduated'].map((p) => stateOfPhase(p as never, null).kind)).toEqual(['open', 'open', 'graduating', 'graduated']);
  });
});
