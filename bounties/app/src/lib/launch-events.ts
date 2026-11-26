/**
 * SH-303: every launch's creation event the launch pages use, in ONE scan for the tab: our Flap launcher factories'
 * sale creations (the plain pair and the rules pairs), the rules vault factories' vault creations (which sale launched
 * which token), and OpenFour Core's token creations. One eth_getLogs per window over all of them, kept and read on per
 * poll (lib/logs.ts), instead of one scan per factory, per list row and per picture.
 */
import { getAbiItem, type Abi, type AbiEvent, type Address, type PublicClient } from 'viem';
import { curveFactoryAbi, rulesVaultFactoryAbi, tokenCurveFactoryAbi } from '../abi/flap';
import { fourCoreAbi } from '../abi/openfour';
import type { Loaded } from './app-context';
import type { AppConfig, FlapConfig } from './config';
import { readEventsMany } from './logs';

const ev = (abi: Abi, name: string) => getAbiItem({ abi, name }) as AbiEvent;
const EVENTS: readonly AbiEvent[] = [
  ev(curveFactoryAbi, 'CurveLauncherCreated'),
  ev(tokenCurveFactoryAbi, 'TokenCurveLauncherCreated'),
  ev(rulesVaultFactoryAbi, 'RulesVaultCreated'),
  ev(fourCoreAbi, 'TokenCreated'),
];

export interface LaunchLog {
  address: Address;
  eventName: string;
  blockNumber: bigint;
  args: Record<string, unknown>;
}

/** The contracts whose creation events the pages read, from the deployment file. */
export function launchEventSources(config: AppConfig): { flapFactories: Address[]; rulesVaultFactories: Address[]; core?: Address } {
  const f = config.flap;
  return {
    flapFactories: f
      ? [f.curveLauncherFactory, ...(f.tokenQuote ? [f.tokenQuote.launcherFactory] : []), ...(f.rules?.native ? [f.rules.native.launcherFactory] : []), ...(f.rules?.token ? [f.rules.token.launcherFactory] : [])]
      : [],
    rulesVaultFactories: f?.rules ? [...(f.rules.native ? [f.rules.native.rulesVaultFactory] : []), ...(f.rules.token ? [f.rules.token.rulesVaultFactory] : [])] : [],
    ...(config.openfour ? { core: config.openfour.core } : {}),
  };
}

/** All of them, from the deployment's first block to the head. */
export async function readLaunchEvents(c: PublicClient, config: AppConfig): Promise<LaunchLog[]> {
  const s = launchEventSources(config);
  const address = [...s.flapFactories, ...s.rulesVaultFactories, ...(s.core ? [s.core] : [])];
  if (address.length === 0) return [];
  return readEventsMany<LaunchLog>(c, { address, events: EVENTS, fromBlock: BigInt(config.fromBlock) });
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const from = (l: LaunchLog, list: readonly Address[]) => list.some((x) => same(l.address, x));

/**
 * The sales our Flap launcher factories created (their creation events), grouped by factory in the file's order (the
 * plain native, the token quote, the rules native, the rules token), each oldest first: the list's order before SH-303.
 * Each slot takes only its own event from its factory, as the scans before SH-303 asked: an address the file names in
 * two slots does not move a launch.
 */
export function flapSalesIn(logs: readonly LaunchLog[], config: AppConfig): Address[] {
  const f = config.flap;
  if (!f) return [];
  const slots: [Address | undefined, string][] = [
    [f.curveLauncherFactory, 'CurveLauncherCreated'],
    [f.tokenQuote?.launcherFactory, 'TokenCurveLauncherCreated'],
    [f.rules?.native?.launcherFactory, 'CurveLauncherCreated'],
    [f.rules?.token?.launcherFactory, 'TokenCurveLauncherCreated'],
  ];
  return slots.flatMap(([factory, eventName]) => (factory ? logs.filter((l) => l.eventName === eventName && same(l.address, factory)).map((l) => l.args.launcher as Address) : []));
}

/** Core's token creations with one of `presetIds`, oldest first. */
export function fourTokensIn(logs: readonly LaunchLog[], config: AppConfig, presetIds: readonly bigint[]): Address[] {
  const core = config.openfour?.core;
  if (!core) return [];
  return logs.filter((l) => l.eventName === 'TokenCreated' && same(l.address, core) && presetIds.includes(l.args.presetId as bigint)).map((l) => l.args.token as Address);
}

/** A Core token's creation event, or undefined. */
export function fourCreationOf(logs: readonly LaunchLog[], config: AppConfig, token: Address): LaunchLog | undefined {
  const core = config.openfour?.core;
  return core ? logs.find((l) => l.eventName === 'TokenCreated' && same(l.address, core) && same(l.args.token, token)) : undefined;
}

/** Core's picture link takes precedence, including when a launch has an empty link. */
export function fourPictureLink(logs: readonly LaunchLog[], config: AppConfig, token: Address): string | null {
  const event = fourCreationOf(logs, config, token);
  if (event) return typeof event.args.tokenMetaUri === 'string' ? event.args.tokenMetaUri : null;
  return config.openfour?.tokens.find((t) => same(t.token, token))?.tokenUri ?? null;
}

const namedRulesSales = (rules: FlapConfig['rules']) => [...(rules?.native?.sales ?? []), ...(rules?.token?.sales ?? [])];

/** The rules sale that launched `token`, from the file or a rules vault factory's RulesVaultCreated. */
export function rulesLauncherIn(logs: readonly LaunchLog[], config: AppConfig, token: Address): Address | undefined {
  const sale = namedRulesSales(config.flap?.rules).find((s) => same(s.token, token));
  if (sale) return sale.launcher;
  const rvf = launchEventSources(config).rulesVaultFactories;
  const hit = logs.find((l) => l.eventName === 'RulesVaultCreated' && from(l, rvf) && same(l.args.token, token));
  return hit?.args.launcher as Address | undefined;
}

const okList = (value: string[]): Loaded<string[]> => ({ state: 'ok', value, at: Date.now(), stale: false });
const newestFirst = (all: readonly string[]) => [...new Set(all.map((a) => a.toLowerCase()))].reverse();

/**
 * The launch page's two lists from the one shared read: the file's entries, then what the events add, newest first.
 * A list that needs no events (no Flap entry; OpenFour without preset ids) never waits on the shared read nor fails
 * with it: a failed read fails only the lists that need it.
 */
export function launchLists(config: AppConfig, launches: Loaded<LaunchLog[]>): { sales: Loaded<string[]>; tokens: Loaded<string[]> } {
  const f = config.flap;
  const o = config.openfour;
  const ids = o ? [o.presetId, o.taxPresetId].filter((x): x is string => x !== undefined).map(BigInt) : [];
  const fileSales = f ? [...f.sales, ...(f.tokenQuote?.sales ?? []), ...namedRulesSales(f.rules)].map((s) => s.launcher) : [];
  const fileTokens = o ? o.tokens.map((t) => t.token) : [];
  const sales: Loaded<string[]> = !f
    ? okList([])
    : launches.state === 'ok'
      ? { ...launches, value: newestFirst([...fileSales, ...flapSalesIn(launches.value, config)]) }
      : launches;
  const tokens: Loaded<string[]> = !o
    ? okList([])
    : ids.length === 0
      ? okList(newestFirst(fileTokens))
      : launches.state === 'ok'
        ? { ...launches, value: newestFirst([...fileTokens, ...fourTokensIn(launches.value, config, ids)]) }
        : launches;
  return { sales, tokens };
}

