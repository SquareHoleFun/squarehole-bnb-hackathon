import { expect, it } from 'vitest';
import { decodeFunctionData, encodeAbiParameters, parseAbiParameters, type Address } from 'viem';
import { executeModuleCallV21, alchemistSideV21, registerAlchemistV21, alchemistRouteV21Abi, alchemistV21Abi } from './alchemist-v21';
import { receiverModulesV21Abi } from './abi-v2';
import { assertSendableCallV2 } from './write-calls-v2';
const a = (s: string) => `0x${s.padStart(40,'0')}` as Address;
const target = { chainId: 1, token: a('1'), coordinator: a('2'), receiver: a('3'), p: a('4') };
it('AL20 encodes a canonical directory selection without changing old recipe ids', () => {
  expect(alchemistSideV21(7)).toEqual({ split: 1, splitParams: '0x', a: { leg: 1, dest: 9, legParams: '0x', destParams: encodeAbiParameters(parseAbiParameters('uint32'),[7]) }, b: { leg: 0, dest: 0, legParams: '0x', destParams: '0x' } });
  for (const id of [-1, 2 ** 32, 1.5]) expect(() => alchemistSideV21(id)).toThrow();
  expect(registerAlchemistV21(a('8'),a('9'))).toMatchObject({ to: a('8'), value: 0n });
});
it('AL21 execution writes name only the prepared receiver and one canonical side', () => {
  for (const side of [false,true]) {
    const call = executeModuleCallV21(target,side);
    expect(decodeFunctionData({ abi: receiverModulesV21Abi, data: call.data })).toEqual({ functionName: 'executeModule', args: [side] });
    expect(() => assertSendableCallV2(call,target,a('5'))).not.toThrow();
    for (const bad of [{ ...call,to: target.p },{ ...call,value: 1n },{ ...call,data: `${call.data}00` as const }]) expect(() => assertSendableCallV2(bad,target,a('5'))).toThrow();
  }
});

it('G1-A1 exports the creation-fixed raw input cap for release tooling', () => {
  expect(alchemistV21Abi.find(i => i.type === 'function' && (i.name as string) === 'inputCap')).toMatchObject({
    type: 'function', name: 'inputCap', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }],
  });
});

it('E2 exports dust payments as P claims sent to depth, distinct from pile conversion', () => {
  expect(alchemistV21Abi.find(i => i.type === 'event' && (i.name as string) === 'DustToDepth')).toMatchObject({
    type: 'event', name: 'DustToDepth', inputs: [
      { name: 'receiver', type: 'address', indexed: true }, { name: 'hook', type: 'address', indexed: true },
      { name: 'asset', type: 'address', indexed: true }, { name: 'amount', type: 'uint256' },
    ],
  });
});

it('G1-INT exports the creation-fixed dust size that bounds a step sent to the box hook, on the module and its helper', () => {
  for (const abi of [alchemistV21Abi, alchemistRouteV21Abi]) {
    expect(abi.find(i => i.type === 'function' && (i.name as string) === 'dustMax')).toMatchObject({
      type: 'function', name: 'dustMax', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }],
    });
  }
});

it('D1 exports the immutable conversion trigger for callers and release admission', () => {
  expect(alchemistV21Abi.find(i => i.type === 'function' && (i.name as string) === 'conversionTrigger')).toMatchObject({
    type: 'function', name: 'conversionTrigger', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }],
  });
});
