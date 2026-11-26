import { required as present } from '../../../../chain/src/core/set-v2/test-support';
import { expect,it } from 'vitest';
import { keccak256, zeroAddress, type Hex } from 'viem';
import { checkSetBoxV2 } from '../../../src/core/set-v2/discovery';
import { fixture,core,hash,address,creationTime } from './fixture';
it('E08B-DISCOVERY admits the separate graph and refuses wrong routes, roles, pins, clones and every vault/loader argument',async()=>{
  const {row,codes,reader}=fixture();
  const check=(r=row)=>checkSetBoxV2(reader,core,row.release,r,hash('block'));
  expect((await check()).classification).toBe('shown');
  for(const bad of [{record:{...row.record,poolId:hash('wrong pool')}},{registry:address('other')},{record:{...row.record,templateId:hash('other')}},{record:{...row.record,contracts:row.record.contracts.map((a,i)=>i===4?row.spec.collection:a)}},{record:{...row.record,randomness:address('drand')}}]) {
    expect((await check({...row,...bad})).classification).toBe('refused');
  }
  for(const role of [3,19]) {
    const a=present(row.record.contracts[role]);const original=present(codes.get(a.toLowerCase()));
    const variants:Hex[]=[`${original}00`,original.slice(0,-2) as Hex];
    for(const byte of role===3?[10,45,65,85,105,125,145,149,181]:[10,45,65,85,117]) {
      const at=2+byte*2;variants.push(`${original.slice(0,at)}${original.slice(at,at+2)==='ff'?'00':'ff'}${original.slice(at+2)}` as Hex);
    }
    for(const code of variants) {
      codes.set(a.toLowerCase(),code);
      const r={...row,record:{...row.record,codeHashes:row.record.codeHashes.map((h,i)=>i===role?keccak256(code):h)}};
      expect((await check(r)).classification).toBe('refused');
    }
    codes.set(a.toLowerCase(),original);
  }
  codes.set(row.release.implementations.vault.address,'0x6000');
  expect((await check()).classification).toBe('refused');
  expect(zeroAddress).not.toBe(row.registry);
});

it.each([0, Number(creationTime - 60n), Number(creationTime), Number(creationTime + 3600n)])(
  'af1 F1 resolves requested openAt=%s at creation while retaining the raw immutable argument', async openAt => {
    const {row,reader,codes}=fixture(openAt);
    const check=(r=row)=>checkSetBoxV2(reader,core,row.release,r,hash('block'));
    expect(await check()).toEqual({classification:'shown',reason:null});
    for(const resolved of new Set([0n, BigInt(openAt), row.record.openAt-1n, row.record.openAt+1n])) {
      if(resolved===row.record.openAt)continue;
      expect(await check({...row,openAt:resolved,record:{...row.record,openAt:resolved}})).toMatchObject({classification:'refused'});
    }
    const coordinator=present(row.record.contracts[0]), original=present(codes.get(coordinator.toLowerCase()));
    const wrong=(BigInt(openAt)+2n).toString(16).padStart(8,'0');
    const at=2+(45+204)*2;
    const runtime=`${original.slice(0,at)}${wrong}${original.slice(at+8)}` as Hex;
    codes.set(coordinator.toLowerCase(),runtime);
    expect(await check({...row,record:{...row.record,codeHashes:row.record.codeHashes.map((h,i)=>i===0?keccak256(runtime):h)}}))
      .toMatchObject({classification:'refused',reason:'set coordinator arguments'});
  });

it('af1 F1 pins the creation header and retries unavailable reads instead of persisting a refusal',async()=>{
  const {row,reader}=fixture(); const at=hash('creation'); const seen:Hex[]=[];
  const pinned={...reader,headerByHash:async(h:Hex)=>{seen.push(h);return reader.headerByHash(h);}};
  expect((await checkSetBoxV2(pinned,core,row.release,row,at)).classification).toBe('shown');
  expect(seen).toEqual([at]);
  const unavailable={...reader,headerByHash:async()=>null};
  await expect(checkSetBoxV2(unavailable,core,row.release,row,at)).rejects.toThrow('creation block unavailable');
  const wrong={...reader,headerByHash:async(h:Hex)=>({...await reader.headerByHash(h),number:52n})};
  expect(await checkSetBoxV2(wrong,core,row.release,row,at)).toMatchObject({classification:'refused',reason:'set creation block mismatch'});
});
