import { encodeAbiParameters, keccak256, parseAbiParameters, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { checkBoxV2 } from '../../../src/core/v2/discovery-v2';
import { applyV2Block } from '../../../src/core/v2/views-v2';
import { decodeV2Logs, routeV2 } from '../../../src/core/v2/events-v2';
import { rowsFromV2Logs } from '../../../src/core/v2/discovery-v2';
import { candlesFromTrades } from '../../../src/core/candles';
import { synthBoxV2, synthManifestV2, SynthReaderV2, V2, ZERO } from '../../../../chain/src/core/v2/test-support/synth-v2';
import { boxLogsV2, eventV2, requiredV2 } from '../scripted-core-chain';
import { World } from '../core-synth';

const manifest = synthManifestV2(); const release = requiredV2(manifest.releases[0]);
const keyHash = (p: Address, t: Address, hook: Address, fee: number) => keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'), [p, t, fee, 60, hook]));
const hash = keccak256('0x01');

describe('F137 plain pool identity and legacy trade money', () => {
  it('refuses the old dynamic pool id and removed sampler/module roles', async () => {
    const box = synthBoxV2({ boxId: 4n });
    const check = (record = box.record) => checkBoxV2(new SynthReaderV2().addBox(box), manifest, { registry: V2.registry, record, encodedSpec: box.encodedSpec }, { creationHash: hash, headHash: hash, reviewed: [] });
    const t = requiredV2(box.record.contracts[1]); const h = requiredV2(box.record.contracts[2]);
    const valid = { ...box.record, poolId: keyHash(box.record.q, t, h, 10000), contracts: box.record.contracts.map((a, i) => i === 11 || i === 13 ? ZERO : a) };
    expect((await check(valid)).classification).toBe('shown');
    expect((await check({ ...valid, poolId: keyHash(box.record.q, t, h, 0x800000) })).classification).toBe('refused');
    expect((await check({ ...valid, contracts: valid.contracts.map((a, i) => i === 13 ? V2.weth : a) })).reason).toMatch(/sampler/);
  });
  it('charges sales in P, pairs each SaleFee with its preceding swap, and excludes buy-back volume', () => {
    const box = synthBoxV2({ boxId: 4n }); const h = requiredV2(box.record.contracts[2]); const receiver = requiredV2(box.record.contracts[5]);
    const world = new World('cq11-trades'); world.block(100n, [boxLogsV2(box)]);
    const swap = (sender: Address, amount0: bigint, amount1: bigint, fee = 0) => eventV2('poolManager', 'Swap', V2.poolManager, { id: box.record.poolId, sender, amount0, amount1, sqrtPriceX96: 2n ** 96n, liquidity: 1_000n, tick: 0, fee });
    world.block(101n, [[
      swap(box.record.creator, 101n, -300n), eventV2('hook', 'SaleFee', h, { poolId: box.record.poolId, payer: box.record.creator, fee: 2n }),
      swap(box.record.creator, -101n, 200n, 10000),
      swap(box.record.creator, 500n, -900n), eventV2('hook', 'SaleFee', h, { poolId: box.record.poolId, payer: box.record.creator, fee: 5n }),
      swap(receiver, -1000n, 2000n, 10000),
    ]]);
    const row = requiredV2(rowsFromV2Logs(world.logs, release, V2.chainId)[0]);
    const logs = decodeV2Logs(world.logs.filter((l) => l.blockNumber === 101n), routeV2(release, manifest, [], [box.record]));
    const result = applyV2Block(undefined, requiredV2(world.headers.at(-1)), logs, row);
    expect(result.trades.map((t) => [t.side, t.qRaw, t.feeQ, t.feeT, t.route])).toEqual([
      ['sell', 99n, 2n, 0n, 'other'], ['buy', 101n, 2n, 0n, 'other'], ['sell', 495n, 5n, 0n, 'other'], ['buy', 1000n, 10n, 0n, 'buy_back'],
    ]);
    expect(result.state.volumeQ).toBe(695n);
    expect(candlesFromTrades(result.trades, '1h')[0]).toMatchObject({ volumeQ: '695', trades: 3 });
  });
  it('RC6: a plain-hook sale pays 1% of the T put in, with no P surcharge; the box’s own sale step is not volume', () => {
    const box = synthBoxV2({ boxId: 4n }); const h = requiredV2(box.record.contracts[2]);
    const world = new World('rc6-plain-sales'); world.block(100n, [boxLogsV2(box)]);
    const swap = (sender: Address, amount0: bigint, amount1: bigint) => eventV2('poolManager', 'Swap', V2.poolManager, { id: box.record.poolId, sender, amount0, amount1, sqrtPriceX96: 2n ** 96n, liquidity: 1_000n, tick: 0, fee: 10000 });
    world.block(101n, [[swap(box.record.creator, 990n, -1001n), swap(h, 40n, -400n), swap(box.record.creator, -101n, 200n)]]);
    const row = requiredV2(rowsFromV2Logs(world.logs, release, V2.chainId)[0]);
    const logs = decodeV2Logs(world.logs.filter((l) => l.blockNumber === 101n), routeV2(release, manifest, [], [box.record]));
    const result = applyV2Block(undefined, requiredV2(world.headers.at(-1)), logs, row);
    expect(result.trades.map((t) => [t.side, t.qRaw, t.tRaw, t.feeQ, t.feeT, t.route])).toEqual([
      ['sell', 990n, 1001n, 0n, 11n, 'other'], ['sell', 40n, 400n, 0n, 4n, 'hook'], ['buy', 101n, 200n, 2n, 0n, 'other'],
    ]);
    expect(result.state.volumeQ).toBe(1091n);
  });
});
