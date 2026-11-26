import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, encodeErrorResult, erc20Abi, erc721Abi, getAddress, zeroHash } from 'viem';
import { buildSetCommitment, createSetListFile } from '@squarehole/box-spec';
import { core, identityInput, setManifestInput, required, address } from '../test-support';
import { parseSetManifest, setVaultV2Abi } from '../index';
import { starterSetLoaderV2Abi, coordinatorV2Abi } from '../../v2/abi-v2';
import { assertSendableSetCallV2, creatorApproval, setClaimCalls, estimateWithBackoff, setLoadPlan, setCall, type SetTargetV2 } from './index';
import { submitWrite } from '../../../write/executor';
import { TEST_FEE_READER, TEST_SEND_FEE_FIELDS } from '../../../write/test-support/index';

const target = (): SetTargetV2 => ({ chainId: core.chainId, core, release: parseSetManifest(setManifestInput(), core), identity: identityInput() });
const ids = [0n, (1n << 256n) - 1n, ...Array.from({length: 38}, (_, i) => BigInt(i * 29 + 101))];
describe('E08B-TX', () => {
  it('rebuilds 16-entry pages and resumes at a non-page boundary with the correct suffix', async () => {
    const t = target(); const collection = t.identity.roles[4] === '0x0000000000000000000000000000000000000000' ? address('nft') : address('bad');
    const file = createSetListFile(collection, ids); const commitment = buildSetCommitment(collection, ids).commitment;
    const plan = await setLoadPlan({ loader: address('loader'), commitment, list: file, progress: async () => [0, commitment.setHash, false] });
    expect(plan.pages.map(p => p.page.ids.length)).toEqual([16, 16, 8]);
    const suffix = buildSetCommitment(collection, ids, 1).pages[6]?.nextHash;
    const resumed = await setLoadPlan({loader: address('loader'), commitment, list: file, progress: async () => [7, required(suffix), false]});
    expect(resumed.pages[0]?.page.ids).toEqual(ids.slice(7, 23));
    expect(decodeFunctionData({abi: starterSetLoaderV2Abi, data: required(resumed.complete ?? undefined).data}).functionName).toBe('complete');
    await expect(setLoadPlan({loader: address('loader'), commitment, list: file, progress: async () => [7, zeroHash, false]})).rejects.toThrow(/suffix/);
    const done=await setLoadPlan({loader:address('loader'),commitment,list:file,progress:async()=>[40,zeroHash,true]});
    expect(done.pages).toEqual([]);expect(done.complete).toBeNull();
  });
  it('halves Amsterdam near-cap loads, TransferGas, and stops at one; never clamps away margin', async () => {
    const make = (size: number) => ({size});
    const a = await estimateWithBackoff(16, make, async c => c.size === 16 ? 20_000_000n : 12_997_712n);
    expect(a.size).toBe(8); expect(a.gasLimit).toBe(15_597_255n);
    const transfer = {data: encodeErrorResult({abi: setVaultV2Abi, errorName: 'TransferGas'})};
    const estimate = vi.fn(async (c: {size: number}) => { if(c.size > 4) throw transfer; return 1_000_000n; });
    expect((await estimateWithBackoff(16, make, estimate)).size).toBe(4);
    await expect(estimateWithBackoff(1, make, async () => {throw transfer;})).rejects.toEqual(transfer);
    await expect(estimateWithBackoff(1, make, async () => 16_777_216n)).rejects.toThrow(/cap/);
    await expect(estimateWithBackoff(16, make, async () => {throw new Error('unrelated');})).rejects.toThrow('unrelated');
  });
  it('E09C backs off a sparse ERC721A load without changing the commitment order or suffix', async () => {
    const collection = address('nft');
    const reserve = [102n, 33n, 71n, 19n, 88n, 6n, 50n, 40n, 3n, 99n,
      101n, 82n, 63n, 44n, 25n, 16n];
    const list = createSetListFile(collection, reserve);
    const commitment = buildSetCommitment(collection, reserve).commitment;
    const transfer = {data: encodeErrorResult({abi: setVaultV2Abi, errorName: 'TransferGas'})};
    const prepared = await estimateWithBackoff(16, async size => {
      const plan = await setLoadPlan({loader: address('loader'), commitment, list,
        batchSize: size, progress: async () => [0, commitment.setHash, false]});
      return required(plan.pages[0]);
    }, async ({page}) => {
      if (page.ids.length > 8) throw transfer;
      return 12_997_712n; // E09C Amsterdam eight-item stress cost; RPC estimate is supplied at runtime.
    });
    expect(prepared.size).toBe(8);
    expect(prepared.call.page.ids).toEqual(reserve.slice(0, 8));
    expect(prepared.call.page.nextHash).toBe(buildSetCommitment(collection, reserve, 8).pages[0]?.nextHash);
    expect(prepared.gasLimit).toBe(15_597_255n);
    // A single untransferable item remains a real refusal, never a reorder/self-transfer workaround.
    const refused = {data: encodeErrorResult({abi: setVaultV2Abi, errorName: 'TransferRefused'})};
    const estimate = vi.fn(async () => {throw refused;});
    await expect(estimateWithBackoff(16, size => ({size}), estimate)).rejects.toEqual(refused);
    expect(estimate).toHaveBeenCalledTimes(1);
  });
  it('admits only canonical scoped writes and creator-only own-vault operator approvals', async () => {
    const t = target(), from = t.identity.creator, vault = required(t.identity.roles[3]), token = required(t.identity.roles[1]);
    for (const approved of [true, false]) {
      const call = creatorApproval(t, from, approved); expect(() => assertSendableSetCallV2(call, t, from)).not.toThrow();
      expect(() => assertSendableSetCallV2(call, t, address('holder'))).toThrow();
      const bad = {...t, identity: {...t.identity, roles: t.identity.roles.map((a,i) => i === 4 ? address('nft') : a)}};
      expect(() => creatorApproval(bad, from, approved)).toThrow();
    }
    const calls = [
      setCall(vault, setVaultV2Abi, 'withdrawBatch', [[0n, 3n], 100n, 500n]),
      setCall(vault, setVaultV2Abi, 'returnItems', [[0n], 0n, 500n]),
      setCall(vault, setVaultV2Abi, 'releaseToCreator', [[0n]]),
      setCall(t.identity.creator, erc721Abi, 'approve', [vault, 0n]),
      ...['fail', 'failClosed'].map(fn => setCall(required(t.identity.roles[0]), coordinatorV2Abi, fn)),
      setCall(required(t.identity.roles[0]), coordinatorV2Abi, 'claim', [1n, from]),
      setCall(required(t.identity.roles[19]), starterSetLoaderV2Abi, 'complete'),
      setCall(required(t.identity.roles[19]),starterSetLoaderV2Abi,'load',[[creatorApproval(t,from,true).to],[0n],[0],zeroHash]),
    ];
    calls.splice(3, 1, setCall(creatorApproval(t, from, true).to, erc721Abi, 'approve', [vault, 0n]));
    for (const call of calls) {
      expect(() => assertSendableSetCallV2(call, t, from)).not.toThrow();
      expect(() => assertSendableSetCallV2({...call, value: 1n}, t, from)).toThrow();
      expect(() => assertSendableSetCallV2({...call, data: `${call.data}00`}, t, from)).toThrow();
      expect(() => assertSendableSetCallV2({...call, to: address('foreign')}, t, from)).toThrow();
    }
    for(const call of [
      setCall(token,erc20Abi,'transfer',[from,1n]),
      setCall(token,erc20Abi,'approve',[address('foreign'),10n]),
      setCall(token,erc20Abi,'approve',[required(t.identity.roles[0]),10n]),
      setCall(token,erc20Abi,'approve',[vault,11n]),
      setCall(creatorApproval(t,from,true).to,erc721Abi,'transferFrom',[from,vault,0n]),
      setCall(creatorApproval(t,from,true).to,erc721Abi,'setApprovalForAll',[address('foreign'),true]),
      setCall(required(t.identity.roles[0]),coordinatorV2Abi,'graduate'),
      setCall(required(t.identity.roles[19]),starterSetLoaderV2Abi,'progress'),
      setCall(required(t.identity.roles[19]),starterSetLoaderV2Abi,'load',[[address('foreign')],[0n],[0],zeroHash]),
      setCall(required(t.identity.roles[19]),starterSetLoaderV2Abi,'load',[[creatorApproval(t,from,true).to],[0n],[1],zeroHash]),
    ]) expect(()=>assertSendableSetCallV2(call,{...t,tokenApproval:10n},from)).toThrow();
    const approve = setCall(token, erc20Abi, 'approve', [vault, 10n]);
    const submissions=[...calls,approve,creatorApproval(t,from,true),creatorApproval(t,from,false)];
    let sends=0;
    for(const call of submissions) await submitWrite({ feeReader: TEST_FEE_READER,protocol:'set-v2',target:{...t,tokenApproval:10n},call,from,gasLimit:1_000_000n,
      wallet:async({method,params})=>{if(method==='eth_chainId')return '0x7a69';if(method==='eth_accounts')return [from];
        expect(params).toEqual([{from,to:call.to,data:call.data,value:'0x0',gas:'0xf4240',...TEST_SEND_FEE_FIELDS,chainId:'0x7a69'}]);sends++;return `0x${'12'.repeat(32)}`;}});
    expect(sends).toBe(submissions.length);
    expect(() => assertSendableSetCallV2(approve, {...t, tokenApproval: 10n}, from)).not.toThrow();
    expect(() => assertSendableSetCallV2(approve, t, from)).toThrow();
    for(const badIds of [[], [0n,0n], Array.from({length:33},(_,i)=>BigInt(i))]) expect(() => assertSendableSetCallV2(setCall(vault,setVaultV2Abi,'withdrawBatch',[badIds,1n,1n]),t,from)).toThrow();
    expect(() => assertSendableSetCallV2(setCall(vault,setVaultV2Abi,'releaseOne',[0n]),t,from)).toThrow();
    expect(() => assertSendableSetCallV2(setCall(required(t.identity.roles[0]),coordinatorV2Abi,'claim',[1n,address('other')]),t,from)).toThrow();
  });
  it('executor sends set-v2 once, enforces its cap and refuses before wallet access', async () => {
    const t = target(); const sent: unknown[] = [];
    const wallet = vi.fn(async ({method,params}: {method:string;params?: unknown}) => { if(method==='eth_chainId') return '0x7a69'; if(method==='eth_accounts') return [t.identity.creator]; sent.push(params); return `0x${'12'.repeat(32)}`; });
    const call = creatorApproval(t,t.identity.creator,true);
    await submitWrite({ feeReader: TEST_FEE_READER,protocol:'set-v2',target:t,call,from:t.identity.creator,gasLimit:100_000n,wallet});
    expect(sent).toHaveLength(1);
    await expect(submitWrite({ feeReader: TEST_FEE_READER,protocol:'set-v2',target:t,call,from:t.identity.creator,gasLimit:16_777_217n,wallet})).rejects.toThrow();
    expect(sent).toHaveLength(1);
    expect(encodeFunctionData({abi:erc721Abi,functionName:'setApprovalForAll',args:[required(t.identity.roles[3]),true]})).toBe(call.data);
  });
});

it('af1 claim approvals bind an exact positive amount to the own coordinator and claiming holder', async()=>{
  const t=target(),from=address('holder'),coordinator=required(t.identity.roles[0]),token=required(t.identity.roles[1]);
  const claimScope={...t,claimApproval:{from,amount:19n}};
  expect(()=>assertSendableSetCallV2(setCall(token,erc20Abi,'approve',[coordinator,19n]),claimScope,from)).not.toThrow();
  const prepared=setClaimCalls(t,from,19n);
  expect(decodeFunctionData({abi:erc20Abi,data:prepared.approval.data}).args).toEqual([getAddress(coordinator),19n]);
  for(const call of [prepared.approval,prepared.call]) {
    expect(()=>assertSendableSetCallV2(call,prepared.target,from)).not.toThrow();
    await submitWrite({ feeReader: TEST_FEE_READER,protocol:'set-v2',target:prepared.target,call,from,gasLimit:100000n,
      wallet:async({method})=>method==='eth_chainId'?'0x7a69':method==='eth_accounts'?[from]:hashResult});
  }
  for(const [spender,amount] of [[address('another coordinator'),19n],[coordinator,0n],[coordinator,20n],[coordinator,(1n<<256n)-1n]] as const) {
    expect(()=>assertSendableSetCallV2(setCall(token,erc20Abi,'approve',[spender,amount]),prepared.target,from)).toThrow();
  }
  expect(()=>assertSendableSetCallV2(prepared.approval,prepared.target,address('other holder'))).toThrow();
  expect(()=>assertSendableSetCallV2(prepared.approval,{...t,tokenApproval:19n},from)).toThrow();
  expect(()=>assertSendableSetCallV2(setCall(coordinator,coordinatorV2Abi,'claim',[20n,from]),prepared.target,from)).toThrow();
  expect(()=>assertSendableSetCallV2(setCall(coordinator,coordinatorV2Abi,'claim',[19n,address('other holder')]),prepared.target,from)).toThrow();
  for(const amount of [0n,(1n<<256n)-1n])expect(()=>setClaimCalls(t,from,amount)).toThrow();
  const forged={...t,identity:{...t.identity,roles:t.identity.roles.map((a,i)=>i===0?address('another coordinator'):a)}};
  expect(()=>setClaimCalls(forged,from,19n)).toThrow();
});
const hashResult=`0x${'12'.repeat(32)}`;
