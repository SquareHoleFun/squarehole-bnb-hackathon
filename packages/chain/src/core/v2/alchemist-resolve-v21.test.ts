/**
 * SH-V21-FE14: The Alchemist is offered for a new box only where the release's own directory resolves a mature, active
 * row whose module answers as this release's version-1 Alchemist for exactly the box's coins, with its pinned route
 * helper and the route that helper holds. A read double plays the directory, the modules and their helpers; every
 * refusal names the first part that does not agree, and the route comes from the helper, never from the caller.
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, getAddress, keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { receiverModulesV21Abi } from './abi-v2';
import {
  AlchemistRefusalV21, alchemistDirectoryV21Abi, alchemistModuleV21, alchemistRouteV21Abi, alchemistRowV21, alchemistRowsV21, alchemistSideV21, alchemistV21Abi,
  releaseDirectoryV21, type AlchemistHopV21, type AlchemistReadsV21, type AlchemistReleaseV21,
} from './alchemist-v21';

const a = (n: number) => getAddress(toHex(n, { size: 20 })) as Address;
const RELEASE: AlchemistReleaseV21 = { directory: a(0xd1), poolManager: a(0x9f), receiverImplementation: a(0x71), coordinatorImplementation: a(0x72) };
const PEPE = a(0xe1); const WETH = a(0xe2); const PAXG = a(0xe3);
/** The module's G1 getters: a creation-fixed per-call cap and dust size in raw price coin, and the platform keeper's trigger. */
const CAP = 10n ** 15n; const DUST = 10n ** 9n; const TRIGGER = a(0x44);
const code = (n: number): Hex => `0x6080${n.toString(16).padStart(8, '0')}00`;

/** `cap`, `dust` and `trigger`: the G1 getters' answers; null plays a module without that getter (its call reverts). */
interface Module { address: Address; code: Hex; version?: bigint; manager?: Address; receiver?: Address; coordinator?: Address; price: Address; pile: Address; executor: Address; executorHash?: Hex; cap?: bigint | null; dust?: bigint | null; trigger?: Address | null }
interface Helper { address: Address; code: Hex; module: Address; manager?: Address; route: readonly AlchemistHopV21[] }
interface Row { module: Address; codeHash: Hex; readyAt: bigint; withdrawn?: boolean; mature?: boolean }

function world(rows: Row[], modules: Module[], helpers: Helper[]) {
  const calls: string[] = [];
  const reads: AlchemistReadsV21 = {
    code: async (address) => [...modules, ...helpers].find((x) => x.address.toLowerCase() === address.toLowerCase())?.code ?? '0x',
    call: async (to, data) => {
      const at = to.toLowerCase();
      if (at === RELEASE.receiverImplementation.toLowerCase()) {
        decodeFunctionData({ abi: receiverModulesV21Abi, data });
        return encodeFunctionResult({ abi: receiverModulesV21Abi, functionName: 'receiverCode', result: [a(0x73), a(0x74), RELEASE.directory] });
      }
      if (at === RELEASE.directory.toLowerCase()) {
        const { functionName, args } = decodeFunctionData({ abi: alchemistDirectoryV21Abi, data });
        calls.push(`${functionName}(${args?.join(',') ?? ''})`);
        if (functionName === 'count') return encodeFunctionResult({ abi: alchemistDirectoryV21Abi, functionName, result: BigInt(rows.length) });
        const row = rows[Number(args?.[0])];
        if (!row) return null;
        if (functionName === 'record') return encodeFunctionResult({ abi: alchemistDirectoryV21Abi, functionName, result: [row.module, row.codeHash, row.readyAt, row.withdrawn ?? false] });
        // resolve refuses an immature, withdrawn or code-changed row.
        const live = modules.find((m) => m.address === row.module);
        if (functionName === 'resolve') return row.withdrawn || row.mature === false || !live || keccak256(live.code) !== row.codeHash ? null : encodeFunctionResult({ abi: alchemistDirectoryV21Abi, functionName, result: [row.module, row.codeHash] });
        throw new Error(functionName);
      }
      const module = modules.find((m) => m.address.toLowerCase() === at);
      if (module) {
        const { functionName } = decodeFunctionData({ abi: alchemistV21Abi, data });
        const answers: Record<string, unknown> = { feeActionVersion: module.version ?? 1n, poolManager: module.manager ?? RELEASE.poolManager, receiverImplementation: module.receiver ?? RELEASE.receiverImplementation,
          coordinatorImplementation: module.coordinator ?? RELEASE.coordinatorImplementation, priceCoin: module.price, pileCoin: module.pile, executor: module.executor,
          executorCodeHash: module.executorHash ?? keccak256(helpers.find((h) => h.address === module.executor)?.code ?? '0x00'),
          inputCap: module.cap === undefined ? CAP : module.cap, dustMax: module.dust === undefined ? DUST : module.dust,
          conversionTrigger: module.trigger === undefined ? TRIGGER : module.trigger };
        if (answers[functionName] === null) return null;
        return encodeFunctionResult({ abi: alchemistV21Abi, functionName, result: answers[functionName] } as never);
      }
      const helper = helpers.find((h) => h.address.toLowerCase() === at);
      if (helper) {
        const { functionName, args } = decodeFunctionData({ abi: alchemistRouteV21Abi, data });
        if (functionName === 'module') return encodeFunctionResult({ abi: alchemistRouteV21Abi, functionName, result: helper.module });
        if (functionName === 'manager') return encodeFunctionResult({ abi: alchemistRouteV21Abi, functionName, result: helper.manager ?? RELEASE.poolManager });
        if (functionName === 'length') return encodeFunctionResult({ abi: alchemistRouteV21Abi, functionName, result: BigInt(helper.route.length) });
        const hop = helper.route[Number(args?.[0])];
        return hop ? encodeFunctionResult({ abi: alchemistRouteV21Abi, functionName: 'hop', result: hop }) : null;
      }
      // A built-in action has no Alchemist getters: its calls revert.
      return null;
    },
  };
  return { reads, calls };
}
const V3 = (tokenIn: Address, tokenOut: Address, pool: number, fee = 3000): AlchemistHopV21 => ({ kind: 3, tokenIn, tokenOut, pool: a(pool), fee, tickSpacing: 60 });
const V2 = (tokenIn: Address, tokenOut: Address, pool: number): AlchemistHopV21 => ({ kind: 2, tokenIn, tokenOut, pool: a(pool), fee: 3000, tickSpacing: 0 });
const ROUTE = [V3(PEPE, WETH, 0xa1), V2(WETH, PAXG, 0xa2)];
const lead = (overrides: Partial<Module> = {}, route: readonly AlchemistHopV21[] = ROUTE, helper: Partial<Helper> = {}) => {
  const module: Module = { address: a(0x51), code: code(1), price: PEPE, pile: PAXG, executor: a(0x52), ...overrides };
  const help: Helper = { address: module.executor, code: code(2), module: module.address, route, ...helper };
  return { module, help, row: { module: module.address, codeHash: keccak256(module.code), readyAt: 86_400n } as Row };
};
const COINS = { priceCoin: PEPE, pileCoin: PAXG };
const refused = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { return error instanceof AlchemistRefusalV21 ? error.reason : `threw ${String(error)}`; } return 'resolved'; };

describe('SH-V21-FE14 resolving The Alchemist through the release’s directory', () => {
  it('finds the directory through the release receiver, and resolves a mature active row with its module, helper and route', async () => {
    const { module, help, row } = lead();
    const builtIn: Row = { module: a(0x41), codeHash: keccak256(code(9)), readyAt: 86_400n };
    const { reads } = world([builtIn, builtIn, builtIn, builtIn, row], [module, { address: a(0x41), code: code(9), price: zeroAddress, pile: zeroAddress, executor: zeroAddress }], [help]);
    expect(await releaseDirectoryV21(reads, RELEASE.receiverImplementation)).toBe(RELEASE.directory);
    const resolved = await alchemistRowV21(reads, RELEASE, 4, COINS);
    expect(resolved).toEqual({ id: 4, readyAt: 86_400n, module: module.address, codeHash: row.codeHash, priceCoin: PEPE, pileCoin: PAXG, executor: help.address, executorCodeHash: keccak256(help.code), route: ROUTE,
      inputCap: CAP, dustMax: DUST, conversionTrigger: TRIGGER });
    // The side is the chain package's canonical AsPaid / Module with that id.
    expect(alchemistSideV21(resolved.id).a.destParams).toBe(toHex(4n, { size: 32 }));
    expect(await alchemistRowsV21(reads, RELEASE, COINS)).toEqual([resolved]);
  });

  it('refuses rows that are not active and mature, and modules of another release or other coins', async () => {
    const cases: [string, ReturnType<typeof lead>, Partial<Row>, typeof COINS][] = [
      ['not-selectable', lead(), { mature: false }, COINS],
      ['not-selectable', lead(), { withdrawn: true }, COINS],
      ['not-an-alchemist', lead({ version: 2n }), {}, COINS],
      // G1: an Alchemist must answer its fixed cap and trigger, the figures the site states before selection.
      ['not-an-alchemist', lead({ cap: null }), {}, COINS],
      ['not-an-alchemist', lead({ cap: 0n }), {}, COINS],
      ['not-an-alchemist', lead({ cap: 1n << 127n }), {}, COINS],
      ['not-an-alchemist', lead({ trigger: null }), {}, COINS],
      ['not-an-alchemist', lead({ trigger: zeroAddress }), {}, COINS],
      // G1-INT: and its fixed dust size, positive and at most the cap, the largest step it may send as claims to box depth.
      ['not-an-alchemist', lead({ dust: null }), {}, COINS],
      ['not-an-alchemist', lead({ dust: 0n }), {}, COINS],
      ['not-an-alchemist', lead({ dust: CAP + 1n }), {}, COINS],
      ['other-release', lead({ manager: a(0x9e) }), {}, COINS],
      ['other-release', lead({ receiver: a(0x70) }), {}, COINS],
      ['other-release', lead({ coordinator: a(0x70) }), {}, COINS],
      ['other-coins', lead(), {}, { priceCoin: WETH, pileCoin: PAXG }],
      ['other-coins', lead(), {}, { priceCoin: PEPE, pileCoin: WETH }],
    ];
    for (const [reason, { module, help, row }, changed, coins] of cases) {
      const { reads } = world([{ ...row, ...changed }], [module], [help]);
      expect(await refused(alchemistRowV21(reads, RELEASE, 0, coins)), `${reason} ${JSON.stringify(changed)}`).toBe(reason);
      expect(await alchemistRowsV21(reads, RELEASE, coins), reason).toEqual([]);
    }
    // A module whose live code is not the recorded code does not resolve.
    const { module, help, row } = lead();
    const { reads } = world([row], [{ ...module, code: code(3) }], [help]);
    expect(await refused(alchemistRowV21(reads, RELEASE, 0, COINS))).toBe('not-selectable');
    // The constructor's own bounds, int128's maximum for the cap and the cap itself for the dust size, still resolve;
    // the trigger is read as the module answers it.
    const max = lead({ cap: (1n << 127n) - 1n, dust: (1n << 127n) - 1n, trigger: a(0x45) });
    const resolved = await alchemistRowV21(world([max.row], [max.module], [max.help]).reads, RELEASE, 0, COINS);
    expect([resolved.inputCap, resolved.dustMax, resolved.conversionTrigger]).toEqual([(1n << 127n) - 1n, (1n << 127n) - 1n, a(0x45)]);
    const one = lead({ dust: 1n });
    expect((await alchemistRowV21(world([one.row], [one.module], [one.help]).reads, RELEASE, 0, COINS)).dustMax).toBe(1n);
  });

  it('refuses a helper that is not the pinned code, serves another module, or holds a route that does not connect the coins', async () => {
    const routes: [string, readonly AlchemistHopV21[]][] = [
      ['bad-route', []],
      ['bad-route', [V3(PEPE, PAXG, 0xa1, 2999)]],
      ['bad-route', [{ kind: 4, tokenIn: PEPE, tokenOut: PAXG, pool: RELEASE.poolManager, fee: 500, tickSpacing: 10 }]],
      ['bad-route', [V3(PEPE, WETH, 0xa1), V2(WETH, a(0xe4), 0xa2), V2(a(0xe4), a(0xe5), 0xa3), V2(a(0xe5), PAXG, 0xa4)]],
      ['bad-route', [V3(WETH, PEPE, 0xa1), V2(PEPE, PAXG, 0xa2)]],
      ['bad-route', [V3(PEPE, WETH, 0xa1), V2(PEPE, PAXG, 0xa2)]],
      ['bad-route', [V3(PEPE, WETH, 0xa1)]],
      ['bad-route', [{ ...V3(PEPE, PAXG, 0xa1), kind: 5 as never }]],
      ['bad-route', [{ kind: 4, tokenIn: PEPE, tokenOut: PAXG, pool: a(0xa1), fee: 3000, tickSpacing: 60 }]],
    ];
    for (const [reason, route] of routes) {
      const { module, help, row } = lead({}, route);
      const { reads } = world([row], [module], [help]);
      expect(await refused(alchemistRowV21(reads, RELEASE, 0, COINS)), JSON.stringify(route.map((h) => h.kind))).toBe(reason);
    }
    // A v4 hop in the release's own PoolManager is admitted (static fee, hookless).
    const v4: AlchemistHopV21 = { kind: 4, tokenIn: PEPE, tokenOut: PAXG, pool: RELEASE.poolManager, fee: 3000, tickSpacing: 60 };
    const ok = lead({}, [v4]);
    expect((await alchemistRowV21(world([ok.row], [ok.module], [ok.help]).reads, RELEASE, 0, COINS)).route).toEqual([v4]);
    for (const [label, change, helper] of [['executor hash', { executorHash: keccak256(code(7)) }, {}], ['no code at the executor', { executor: a(0x53) }, { address: a(0x52) }]] as const) {
      const { module, help, row } = lead(change, ROUTE, helper);
      expect(await refused(alchemistRowV21(world([row], [module], [help]).reads, RELEASE, 0, COINS)), label).toBe('helper-changed');
    }
    for (const helper of [{ module: a(0x50) }, { manager: a(0x9e) }]) {
      const { module, help, row } = lead({}, ROUTE, helper);
      expect(await refused(alchemistRowV21(world([row], [module], [help]).reads, RELEASE, 0, COINS))).toBe('helper-changed');
    }
  });

  it('an existing box’s module is checked without a directory row, and the search reads at most the newest rows', async () => {
    const { module, help, row } = lead();
    const { reads, calls } = world(Array.from({ length: 70 }, () => row), [module], [help]);
    expect((await alchemistModuleV21(reads, RELEASE, module.address, row.codeHash, COINS)).route).toEqual(ROUTE);
    const rows = await alchemistRowsV21(reads, RELEASE, COINS, 64);
    expect(rows.map((r) => r.id)).toEqual(Array.from({ length: 64 }, (_, i) => 69 - i));
    expect(calls.filter((c) => c.startsWith('resolve')).length).toBe(64);
    // The same coin on both sides is the built-in To the pile, never The Alchemist.
    expect(await alchemistRowsV21(reads, RELEASE, { priceCoin: PAXG, pileCoin: PAXG })).toEqual([]);
  });
});
