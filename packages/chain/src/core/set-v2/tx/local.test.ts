import { spawnSync } from 'node:child_process';
import { expect,it } from 'vitest';
import { sparseSetIds, setManifestFromReads } from '../../../../scripts/lib/set-v2-local.mjs';
import { core, setManifestInput } from '../test-support';
it('E08B-LOCAL creates sparse uint256 ids and a separate manifest from one pinned block',async()=>{
  const ids=sparseSetIds();expect(ids).toHaveLength(40);expect(ids[0]).toBe(0n);expect(ids[1]).toBe((1n<<256n)-1n);expect(new Set(ids).size).toBe(40);
  const m=setManifestInput();const at:bigint[]=[];
  const result=await setManifestFromReads({chainId:core.chainId,factory:m.factory.address,startBlock:'51',block:55n,core,
    pin:async(address:string,block:bigint)=>{at.push(block);return [m.factory,m.registry,m.listingRegistry,m.poolManager,m.platformSafe,...Object.values(m.implementations)].find(p=>p.address===address);},
    read:async(fn:string,args:unknown[],block:bigint)=>{at.push(block);if(fn==='registry')return m.registry.address;if(fn==='listingRegistry')return m.listingRegistry.address;if(fn==='versionCodeHash')return m.versionCodeHash;
      return Object.values(m.implementations)[[0,1,2,3,5,6,19].indexOf(Number(args[0]))]?.address;}});
  expect(result.schema).toBe('squarehole.set-release/v1');expect(new Set(at)).toEqual(new Set([55n]));expect(core.releases).toHaveLength(1);
});

it('E08B-LOCAL loads the dev-chain entry with Node type stripping and no listener or network',()=>{
  const entry=new URL('../../../../scripts/local-core-v2-chain.mjs',import.meta.url).href;
  const child=spawnSync(process.execPath,['--experimental-transform-types','--no-warnings=ExperimentalWarning','--input-type=module','--eval',`await import(${JSON.stringify(entry)})`],{encoding:'utf8'});
  expect(child.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT/);
  expect(child.status,child.stderr).toBe(0);
});
