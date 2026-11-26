import { readFileSync } from 'node:fs';
import { DRAND_SOURCE, RANDOMNESS_SOURCE } from '@squarehole/box-spec';
import { drandSourceOf, rowAddresses } from '@squarehole/chain';
import { backedSourceAbi, boxTicketsAbi, drandSourceAbi } from '@squarehole/chain/abi';
import { labelAddress, labelHash } from '@squarehole/chain/core/test-support';
import { keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { CoreChainIndexer } from '../../src/core/chain-indexer';
import { decodeBoxLogs, decodeCoreLog, type BoxRoute } from '../../src/core/core-events';
import { applyCoreBlock, initialCoreState } from '../../src/core/derive-core';
import { checkBoxAtCreation } from '../../src/core/discovery';
import { rowsFromV2Logs } from '../../src/core/v2/discovery-v2';
import { decodeV2Logs, routeV2 } from '../../src/core/v2/events-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';
import { event, synthBox, synthManifest, testQList, World, type SynthBox } from './core-synth';
import { F143_DRAND, f143Box, f143Manifest, withF143 } from './f143-synth';
import { boxLogsV2, serviceBoxV2, synthManifestV2, V2 } from './scripted-core-chain';

const round = 32_654_000n;
const poster = labelAddress('f143:poster');
const bounty = 9007199254740993n;
const mix = labelHash('f143:mix');
const drandRuntime = (JSON.parse(readFileSync(new URL('../fixtures/f143-drand-runtime.json', import.meta.url), 'utf8')) as { runtime: Hex }).runtime;
const requested = (box: SynthBox, n = round) => event(boxTicketsAbi, box.row.contracts.tickets as Address, 'GraduationWordRequested', { requester: poster, round: n, bounty });
const posted = (address = DRAND_SOURCE, n = round, by = poster) => event(drandSourceAbi, address, 'RoundPosted', { round: n, randomness: mix, poster: by, bounty });
const routeOf = (box = f143Box(), manifest = f143Manifest()): BoxRoute => ({ addresses: new Map(rowAddresses(box.row)), poolManager: box.row.poolManager, poolId: box.row.poolId, randomness: box.row.randomness, drand: drandSourceOf(manifest).address, drandConsumers: new Set([(box.row.contracts.tickets as string).toLowerCase()]) });

function chainOf(w: World) {
  const chain = w.chain();
  const codes = chain.codeAnswers;
  chain.codeAnswers = (address, hash) => address.toLowerCase() === DRAND_SOURCE.toLowerCase() ? drandRuntime : codes(address, hash);
  return chain;
}

const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing F143 fixture value');
  return value;
};

function fold(w: Pick<World, 'headers' | 'logs'>, box = f143Box(), route = routeOf(box)) {
  let state = initialCoreState(box.row);
  const activity = [];
  for (const header of w.headers) {
    const result = applyCoreBlock(state, header, decodeBoxLogs(w.logs.filter(l => l.blockHash === header.hash), route), box.row);
    state = result.state;
    activity.push(...result.activity);
  }
  return { state, activity };
}

describe('F143: box 0 reads its source and the shared DrandSource', () => {
  it('a graduation round post on DrandSource keeps its fields and counts once; wrong emitters, rounds and removed logs add nothing', () => {
    const box = f143Box();
    const w = new World();
    w.block(12n, [requested(box)]);
    w.block(13n, [posted(), posted(RANDOMNESS_SOURCE), posted(DRAND_SOURCE, round + 1n), posted()]);
    w.logs[w.logs.length - 1] = { ...required(w.logs.at(-1)), removed: true };
    const result = fold(w);
    expect(result.state.draws.roundsPosted).toBe(1);
    expect(result.activity.filter(a => a.kind === 'round_posted').map(a => a.data)).toEqual([{ round: round.toString(), poster: poster.toLowerCase(), bounty: bounty.toString() }]);
    expect(decodeCoreLog(required(w.logs[2]), routeOf())).toBeNull();
    expect(decodeCoreLog(required(w.logs[4]), routeOf())).toBeNull();
    expect(decodeBoxLogs([...w.logs, ...w.logs], routeOf())).toEqual(decodeBoxLogs(w.logs, routeOf()));
  });

  it('DrandSource Requested naming the wrapper is ignored; the backed source request names tickets; BountyAdded comes only from DrandSource', () => {
    const box = f143Box();
    const args = { consumer: RANDOMNESS_SOURCE, key: 7n, round, bounty };
    const w = new World();
    w.block(12n, [event(drandSourceAbi, DRAND_SOURCE, 'Requested', args), event(drandSourceAbi, RANDOMNESS_SOURCE, 'Requested', { ...args, consumer: box.row.contracts.tickets }), event(drandSourceAbi, RANDOMNESS_SOURCE, 'Requested', args), event(drandSourceAbi, DRAND_SOURCE, 'BountyAdded', { round, from: poster, amount: bounty }), event(drandSourceAbi, RANDOMNESS_SOURCE, 'BountyAdded', { round, from: poster, amount: bounty })]);
    expect(decodeBoxLogs(w.logs, routeOf()).map(e => [e.source, e.name])).toEqual([['backedSource', 'Requested'], ['randomness', 'BountyAdded']]);
    const result = fold(w);
    expect(result.activity).toEqual([]);
    expect(result.state.draws).toEqual(initialCoreState(box.row).draws);
  });

  it('before F143 one address decodes each event exactly as before', () => {
    const box = synthBox({ boxId: 0n, creationBlock: 12n });
    const route = routeOf(box, synthManifest());
    const w = new World();
    w.block(12n, [requested(box), posted(box.row.randomness)]);
    const events = decodeBoxLogs([...w.logs, ...w.logs], route);
    expect(events.map(e => [e.source, e.name])).toEqual([['tickets', 'GraduationWordRequested'], ['randomness', 'RoundPosted']]);
    expect(fold(w, box, route).state.draws.roundsPosted).toBe(1);
  });

  it('the derived DrandSource code is pinned and read once at creation, while older manifests add no code read', async () => {
    expect(keccak256(drandRuntime)).toBe(F143_DRAND.codeHash);
    const box = f143Box();
    const w = new World();
    const header = w.block(12n, [w.created(box)]);
    const chain = chainOf(w);
    const read = vi.spyOn(chain, 'codeAt');
    expect(await checkBoxAtCreation(chain, f143Manifest(), box.row, header.hash)).toEqual({ classification: 'shown', reason: null });
    expect(read.mock.calls.filter(([a]) => a.toLowerCase() === DRAND_SOURCE.toLowerCase())).toEqual([[DRAND_SOURCE, header.hash]]);
    const old = synthBox({ boxId: 0n, creationBlock: 12n });
    read.mockClear();
    expect((await checkBoxAtCreation(chain, synthManifest(), old.row, header.hash)).classification).toBe('shown');
    expect(read.mock.calls).toHaveLength(old.codes.size);
  });

  it.each(['0x', '0x6000'] as const)('wrong DrandSource code %s refuses the box with the fixed reason', async code => {
    const box = f143Box();
    const w = new World();
    const header = w.block(12n, [w.created(box)]);
    const chain = chainOf(w);
    const codes = chain.codeAnswers;
    chain.codeAnswers = (address, hash) => address.toLowerCase() === DRAND_SOURCE.toLowerCase() ? code : codes(address, hash);
    expect(await checkBoxAtCreation(chain, f143Manifest(), box.row, header.hash)).toEqual({ classification: 'refused', reason: 'drand source code is not the pinned DrandSource' });
  });

  it.each([false, true])('the address filter reads both sources on cold start or live blocks (live=%s), and a reorg replaces the round post', async live => {
    const box = f143Box();
    const w = new World();
    w.block(10n);
    w.block(12n, [w.created(box), requested(box)]);
    w.block(13n, [posted()]);
    w.block(14n);
    const chain = chainOf(w);
    const indexer = new CoreChainIndexer({ reader: chain, manifest: f143Manifest(), qList: testQList() });
    if (live) chain.tip = 10n;
    await indexer.start();
    if (live) for (let n = 11n; n <= 14n; n += 1n) { chain.tip = n; await indexer.enqueue(chain.header(n)); }
    await indexer.idle();
    const rows = () => indexer.recent(box.row.contracts.token as string)?.activity.filter(a => a.kind === 'round_posted');
    const count = () => {
      const entry = required(indexer.boxes.get((box.row.contracts.token as string).toLowerCase()));
      return indexer.stateAt(entry, required(indexer.head() ?? undefined))?.draws.roundsPosted;
    };
    expect(rows()).toHaveLength(1);
    expect(count()).toBe(1);
    expect(rows()?.[0]?.data.poster).toBe(poster.toLowerCase());
    const replacement = labelAddress('f143:replacement');
    const branch = w.fork(12n, 'b');
    branch.block(13n, [posted(DRAND_SOURCE, round, replacement)]);
    branch.block(14n);
    chain.setBranch(branch.headers.filter(h => h.number > 12n), branch.logs.filter(l => l.blockNumber > 12n));
    await indexer.enqueue(chain.header(14n));
    await indexer.idle();
    expect(rows()).toHaveLength(1);
    expect(count()).toBe(1);
    expect(rows()?.[0]).toMatchObject({ blockHash: branch.headers.find(h => h.number === 13n)?.hash, data: { poster: replacement.toLowerCase() } });
    expect(indexer.metrics.errors).toBe(0);
  });
});


const targetBlock = 9007199254740997n;
const backup = (name: 'BackupStarted' | 'BackupFixed', n = round, by = poster, address = RANDOMNESS_SOURCE) =>
  event(backedSourceAbi, address, name, { round: n, targetBlock, mix, by });

describe('SH-RC8-INDEXER-FOLLOWUPS: a started backup owns its round', () => {
  it.each(['graduation', 'draw'] as const)('box 0 ignores a later drand post for a backed-up %s round, before and after its backup is fixed', kind => {
    const box = f143Box();
    const request = kind === 'graduation' ? requested(box) : event(boxTicketsAbi, box.row.contracts.tickets as Address, 'DrawRequested', { ticketId: 1n, drawer: poster, principal: 1n, fee: 0n, round, bounty });
    for (const fixed of [false, true]) {
      const w = new World();
      w.block(12n, [request]);
      w.block(13n, [backup('BackupStarted')]);
      w.block(14n, fixed ? [backup('BackupFixed')] : []);
      const before = fold(w);
      w.block(15n, [posted()]);
      const result = fold(w);
      expect.soft(result.activity.filter(a => a.kind === 'round_posted')).toEqual([]);
      expect.soft(result.state.draws.roundsPosted).toBe(0);
      expect(result.state.draws.backupRounds).toEqual([round]);
      expect(result.activity.filter(a => a.kind.startsWith('backup_'))).toEqual(before.activity.filter(a => a.kind.startsWith('backup_')));
      expect(result.activity.filter(a => a.kind === 'backup_started').map(a => a.data)).toEqual([
        { round: round.toString(), targetBlock: targetBlock.toString(), by: poster.toLowerCase() },
      ]);
      expect(fold(w)).toEqual(result);
    }
  });

  it('box 0 counts an own round with no backup even when another own round has started backup, and ignores an unrelated round', () => {
    const box = f143Box();
    const w = new World();
    w.block(12n, [requested(box), requested(box, round + 1n)]);
    w.block(13n, [backup('BackupStarted', round + 1n)]);
    w.block(14n, [posted(), posted(DRAND_SOURCE, round + 2n)]);
    const result = fold(w);
    expect(result.state.draws.roundsPosted).toBe(1);
    expect(result.activity.filter(a => a.kind === 'round_posted').map(a => a.data)).toEqual([
      { round: round.toString(), poster: poster.toLowerCase(), bounty: bounty.toString() },
    ]);
  });

  it('v2 still decodes the shared drand post once and keeps its own reducer result when box 0 backs up the same round', () => {
    const box = f143Box();
    const plain = serviceBoxV2();
    const v2 = { ...plain, record: { ...plain.record, randomness: DRAND_SOURCE } };
    const manifest = withF143(synthManifestV2());
    const release = required(manifest.releases[0]);
    const w = new World();
    w.block(100n, [boxLogsV2(v2), requested(box), event(drandSourceAbi, DRAND_SOURCE, 'Requested', { consumer: required(v2.record.contracts[7]), key: 1n, round, bounty })]);
    w.block(101n, [backup('BackupStarted')]);
    const header = w.block(102n, [posted()]);
    const row = required(rowsFromV2Logs(w.logs, release, V2.chainId)[0]);
    const route = routeV2(release, manifest, [], [v2.record]);
    const decoded = decodeV2Logs([...w.logs, ...w.logs], route);
    expect(decoded.filter(e => e.name === 'RoundPosted')).toMatchObject([
      { source: 'randomness', boxId: null, args: { round, bounty, poster } },
    ]);
    expect(decoded.some(e => e.name === 'BackupStarted')).toBe(false);
    expect(decoded).toEqual(decodeV2Logs(w.logs.filter(l => l.blockNumber !== 101n), route));
    const postedEvents = decoded.filter(e => e.ref.blockHash === header.hash);
    // At the base, shared drand events have no v2 box id or DrawLedger; its reducer leaves them unassigned.
    const result = applyV2Block(undefined, header, postedEvents, row);
    expect(result).toEqual(applyV2Block(undefined, header, [], row));
    expect(result.activity).toEqual([]);
    expect(result.state).not.toHaveProperty('draws');
    expect(fold(w).state.draws.roundsPosted).toBe(0);
  });

  it('a reorg that removes the backup start counts the new branch drand post and replay gives the same state and rows', async () => {
    const box = f143Box();
    const w = new World();
    w.block(10n);
    w.block(12n, [w.created(box), requested(box)]);
    w.block(13n, [backup('BackupStarted')]);
    w.block(14n, [posted()]);
    const chain = chainOf(w);
    const indexer = new CoreChainIndexer({ reader: chain, manifest: f143Manifest(), qList: testQList() });
    await indexer.start();
    const entry = required(indexer.boxes.get((box.row.contracts.token as string).toLowerCase()));
    const draws = () => required(indexer.stateAt(entry, required(indexer.head() ?? undefined)) ?? undefined).draws;
    const rows = () => indexer.recent(box.row.contracts.token as string)?.activity;
    expect(draws().backupRounds).toEqual([round]);
    expect.soft(draws().roundsPosted).toBe(0);
    expect.soft(rows()?.filter(a => a.kind === 'round_posted')).toEqual([]);
    const backedReplay = fold(w);
    expect(fold(w)).toEqual(backedReplay);

    const branch = w.fork(12n, 'without-backup');
    branch.block(13n);
    branch.block(14n, [posted()]);
    chain.setBranch(branch.headers.filter(h => h.number > 12n), branch.logs.filter(l => l.blockNumber > 12n));
    await indexer.enqueue(chain.header(14n));
    await indexer.idle();
    expect(draws().backupRounds).toEqual([]);
    expect(draws().roundsPosted).toBe(1);
    expect(rows()?.filter(a => a.kind === 'backup_started')).toEqual([]);
    expect(rows()?.filter(a => a.kind === 'round_posted')).toMatchObject([
      { block: 14n, blockHash: required(branch.headers.at(-1)).hash, data: { round: round.toString(), poster: poster.toLowerCase(), bounty: bounty.toString() } },
    ]);
    const replay = fold(branch);
    expect(fold(branch)).toEqual(replay);
    expect(draws()).toEqual(replay.state.draws);
    expect(rows()).toEqual(replay.activity);
    expect(backedReplay.state.draws.backupRounds).toEqual([round]);
    expect(indexer.metrics.reorgs).toBe(1);
    expect(indexer.metrics.errors).toBe(0);
  });
});

describe('F143: backup activity', () => {
  it('backup rounds start empty and two starts remember the round once while keeping both activity rows', () => {
    const box = f143Box();
    const initial = initialCoreState(box.row);
    expect.soft(initial.draws.backupRounds).toEqual([]);
    const w = new World();
    w.block(12n, [requested(box)]);
    const before = fold(w);
    w.block(13n, [backup('BackupStarted')]);
    w.block(14n, [backup('BackupStarted')]);
    const result = fold(w);
    expect.soft(result.state.draws.backupRounds).toEqual([round]);
    expect(result.activity.filter(a => a.kind === 'backup_started').map(a => a.data)).toEqual([
      { round: round.toString(), targetBlock: targetBlock.toString(), by: poster.toLowerCase() },
      { round: round.toString(), targetBlock: targetBlock.toString(), by: poster.toLowerCase() },
    ]);
    expect.soft(before.state.draws.backupRounds).toEqual([]);
    expect.soft(initial.draws.backupRounds).toEqual([]);
  });

  it('only the box own graduation and draw rounds add backup rows and remembered rounds, in block and log order', () => {
    const box = f143Box();
    const w = new World();
    w.block(12n, [requested(box), event(boxTicketsAbi, box.row.contracts.tickets as Address, 'DrawRequested', { ticketId: 1n, drawer: poster, principal: 1n, fee: 0n, round: round + 1n, bounty })]);
    const before = fold(w);
    w.block(13n, [backup('BackupStarted'), backup('BackupFixed'), backup('BackupStarted', round + 1n), backup('BackupStarted', round + 2n), backup('BackupFixed', round + 2n), backup('BackupStarted', round, poster, DRAND_SOURCE), backup('BackupFixed', round, poster, DRAND_SOURCE)]);
    w.block(14n, [backup('BackupFixed', round + 1n), backup('BackupStarted'), backup('BackupFixed')]);
    w.logs[w.logs.length - 1] = { ...required(w.logs.at(-1)), removed: true };
    w.logs[w.logs.length - 2] = { ...required(w.logs.at(-2)), removed: true };
    const ordered = fold(w);
    const result = fold({ ...w, logs: [...w.logs].reverse() });
    expect(result).toEqual(ordered);
    expect(result.activity.filter(a => a.kind.startsWith('backup_')).map(a => [a.kind, a.block, a.logIndex, a.data])).toEqual([
      ['backup_started', 13n, 0, { round: round.toString(), targetBlock: targetBlock.toString(), by: poster.toLowerCase() }],
      ['backup_fixed', 13n, 1, { round: round.toString(), targetBlock: targetBlock.toString(), mix: mix.toLowerCase(), by: poster.toLowerCase() }],
      ['backup_started', 13n, 2, { round: (round + 1n).toString(), targetBlock: targetBlock.toString(), by: poster.toLowerCase() }],
      ['backup_fixed', 14n, 0, { round: (round + 1n).toString(), targetBlock: targetBlock.toString(), mix: mix.toLowerCase(), by: poster.toLowerCase() }],
    ]);
    // Compare with empty blocks at the same heads: only activity and backup rounds may differ.
    const empty = new World();
    empty.headers.push(...w.headers);
    empty.logs.push(...w.logs.filter(l => l.blockNumber === 12n));
    const withoutBackup = fold(empty).state;
    expect(result.state).toEqual({ ...withoutBackup, draws: { ...withoutBackup.draws, backupRounds: [round, round + 1n] } });
    expect(result.state.draws).toEqual({ ...before.state.draws, backupRounds: [round, round + 1n] });
  });

  it('backup rows roll back and replace with their canonical block and caller', async () => {
    const box = f143Box();
    const w = new World();
    w.block(10n);
    w.block(12n, [w.created(box), requested(box)]);
    w.block(13n, [backup('BackupStarted'), backup('BackupFixed')]);
    w.block(14n);
    const chain = chainOf(w);
    const indexer = new CoreChainIndexer({ reader: chain, manifest: f143Manifest(), qList: testQList() });
    await indexer.start();
    const rows = () => indexer.recent(box.row.contracts.token as string)?.activity.filter(a => a.kind.startsWith('backup_'));
    expect(rows()?.map(a => a.kind)).toEqual(['backup_started', 'backup_fixed']);
    const replacement = labelAddress('f143:backup-replacement');
    const branch = w.fork(12n, 'backup-reorg');
    branch.block(13n, [backup('BackupStarted', round, replacement)]);
    branch.block(14n, [backup('BackupFixed', round, replacement)]);
    chain.setBranch(branch.headers.filter(h => h.number > 12n), branch.logs.filter(l => l.blockNumber > 12n));
    await indexer.enqueue(chain.header(14n));
    await indexer.idle();
    expect(rows()?.map(a => [a.kind, a.block, a.blockHash, a.data.by])).toEqual([
      ['backup_started', 13n, branch.headers.find(h => h.number === 13n)?.hash, replacement.toLowerCase()],
      ['backup_fixed', 14n, branch.headers.find(h => h.number === 14n)?.hash, replacement.toLowerCase()],
    ]);
    expect(indexer.metrics.errors).toBe(0);
  });
});
