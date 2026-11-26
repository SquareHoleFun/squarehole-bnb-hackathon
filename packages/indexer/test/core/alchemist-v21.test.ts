import { expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters, parseAbi, parseAbiItem, type Address, type Hex } from 'viem';
import { m3Fixture, H, logM3 } from '../../src/core/v2/m3-fixture.test-support';
import { routeV2, decodeV2Logs } from '../../src/core/v2/events-v2';
import { applyV2Block } from '../../src/core/v2/views-v2';
import { jsonV2 } from '../../src/core/core-row';
const abi = parseAbi(['event PileConverted(address indexed receiver,address indexed pile,address indexed asset,uint256 amountIn,uint256 amountOut)']);
const A = (n: number) => `0x${n.toString(16).padStart(40,'0')}` as Address;
const executed = parseAbiItem('event ModuleExecuted(bool indexed sellers,address indexed module,uint256 amount)');
const module = A(99), gold = A(98);
function fixture() {
  const f = m3Fixture(true,0n);
  const row = { ...f.row, feeModules: [{ module,codeHash: H(9) }], spec: { ...f.spec, contentsParams: encodeAbiParameters(parseAbiParameters('address,uint256,uint16'),[gold,0n,500]), buyers: { ...f.spec.buyers,a: { leg:1,dest:9,legParams:'0x' as const,destParams:H(7) } } } };
  const route = routeV2(f.release,f.manifest,[],[f.record],row.feeModules);
  const raw = { ...logM3(executed,f.at(5),{ sellers:false,module,amount:19n },1),
    address: module, topics: encodeEventTopics({ abi,eventName:'PileConverted',args:{ receiver:f.at(5),pile:f.at(3),asset:gold } }) as Hex[],
    data: encodeAbiParameters(parseAbiParameters('uint256,uint256'),[19n,37n]) };
  const done = logM3(executed,f.at(5),{ sellers:false,module,amount:19n },2);
  return { f,row,route,raw,done };
}
it('AL23 authenticates shared-module logs and reports conversion separately from seed and same-P fees', () => {
  const { row,route,raw,done } = fixture();
  const header = { number:raw.blockNumber,hash:raw.blockHash,parentHash:H(99),timestamp:1000n };
  const events = decodeV2Logs([raw,raw,done],route);
  const state = applyV2Block(undefined,header,events,row).state;
  expect(state.view.alchemist).toEqual({ inputP:19n,receivedAsset:37n,dustToDepthP:0n });
  expect(state.view.pileMovedP).toBe(0n);
  expect(jsonV2(state.view.alchemist)).toEqual({ inputP:'19',receivedAsset:'37',dustToDepthP:'0' });
  expect(applyV2Block(state,header,events,row).state).toBe(state);
  expect(decodeV2Logs([{ ...raw,address:A(97) }],route)).toEqual([]);
  expect(decodeV2Logs([{ ...raw,removed:true }],route)).toEqual([]);
});
it('AL24 conversion must pair once with the exact receiver execution in the same transaction', () => {
  const { row,route,raw,done } = fixture();
  const header = { number:raw.blockNumber,hash:raw.blockHash,parentHash:H(99),timestamp:1000n };
  for (const logs of [[raw],[raw,{ ...done,transactionHash:H(123) }],[raw,{ ...done,data: encodeAbiParameters(parseAbiParameters('uint256'),[18n]) }]]) {
    expect(() => applyV2Block(undefined,header,decodeV2Logs(logs,route),row)).toThrow(/conversion/);
  }
});

it('E2 decodes dust under its receiver without counting it as converted P or pile growth', () => {
  const { f, row, route, raw } = fixture();
  const dust = logM3(parseAbiItem('event DustToDepth(address indexed receiver,address indexed hook,address indexed asset,uint256 amount)'),
    module, { receiver: f.at(5), hook: f.at(2), asset: row.q, amount: 10n }, 1);
  const done = logM3(executed, f.at(5), { sellers: false, module, amount: 10n }, 2);
  const events = decodeV2Logs([dust, dust, done], route);
  expect(events.map(e => e.name)).toEqual(['DustToDepth', 'ModuleExecuted']);
  expect(events[0]).toMatchObject({ boxId: row.boxId, source: 'feeModule', args: { amount: 10n } });
  expect((events[0]?.args.hook as string).toLowerCase()).toBe(f.at(2).toLowerCase());
  const header = { number: raw.blockNumber, hash: raw.blockHash, parentHash: H(99), timestamp: 1000n };
  const state = applyV2Block(undefined, header, events, row).state;
  // G1-INT: dust is its own total (P claims sent to the box hook), never converted P and never pile coin received.
  expect(state.view.alchemist).toEqual({ inputP: 0n, receivedAsset: 0n, dustToDepthP: 10n });
  expect(jsonV2(state.view.alchemist)).toEqual({ inputP: '0', receivedAsset: '0', dustToDepthP: '10' });
  expect(state.view.pileMovedP).toBe(0n);
  expect(decodeV2Logs([{ ...dust, address: A(97) }], route)).toEqual([]);
});

it('G1-INT dust pairs once with its own receiver execution, in its own coin, beside conversions', () => {
  const { f, row, route, raw, done } = fixture();
  const dustAbi = parseAbiItem('event DustToDepth(address indexed receiver,address indexed hook,address indexed asset,uint256 amount)');
  const dust = (amount: bigint, index: number, asset: Address = row.q) => logM3(dustAbi, module, { receiver: f.at(5), hook: f.at(2), asset, amount }, index);
  const header = { number: raw.blockNumber, hash: raw.blockHash, parentHash: H(99), timestamp: 1000n };
  const apply = (logs: Parameters<typeof decodeV2Logs>[0]) => applyV2Block(undefined, header, decodeV2Logs(logs, route), row).state.view.alchemist;
  // A conversion (logs 1, 2) and a dust step (logs 3, 4) in one block: each total from its own pair.
  const dustDone = logM3(executed, f.at(5), { sellers: false, module, amount: 10n }, 4);
  expect(apply([raw, done, dust(10n, 3), dustDone])).toEqual({ inputP: 19n, receivedAsset: 37n, dustToDepthP: 10n });
  // No execution of its own (the conversion's pairing is not shared), another amount, another coin: refused.
  expect(() => apply([dust(10n, 1)])).toThrow(/dust has no matching module execution/);
  expect(() => apply([raw, dust(10n, 3), done])).toThrow(/no matching module execution/);
  expect(() => apply([dust(11n, 3), dustDone])).toThrow(/dust has no matching module execution/);
  expect(() => apply([dust(10n, 3, gold), dustDone])).toThrow(/dust identity mismatch/);
  const wrongHook = logM3(dustAbi, module, { receiver: f.at(5), hook: A(77), asset: row.q, amount: 10n }, 3);
  expect(() => apply([wrongHook, dustDone])).toThrow(/dust identity mismatch/);
});
