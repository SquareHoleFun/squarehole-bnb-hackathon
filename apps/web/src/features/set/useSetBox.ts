/**
 * SH-EXISTING-NFTS-E08C: a set box's page data. The indexer's row and members (E-08B's routes, by the box's token;
 * set-indexer.ts), refreshed every few seconds; the coordinator's close and claim state and the price coin, read over
 * the source's RPC; and, once graduated, what one pick costs and one return pays at one pinned block. View calls only:
 * nothing here touches a wallet.
 */
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { erc20Abi, type Address } from 'viem';
import type { BoxRecord } from '../boxes/box-model';
import { setSubmit, type SetSubmit } from './set-calls';
import { readCoordinatorFacts } from './set-actions';
import { readSetIdentity } from './set-identity';
import { allMembers, httpSetIndexer, type SetFetcher, type SetIndexer } from './set-indexer';
import { phaseOf, tradingOf } from './set-model';
import { ONE_ITEM, prepareConversion } from './set-conversion';
import { rpcSetReads, type SetReads } from './set-reads';

export interface SetBoxSeams {
  readonly reads?: SetReads;
  readonly indexer?: SetIndexer | null;
  readonly submit?: SetSubmit | null;
  readonly fetcher?: SetFetcher;
}

export type SetRecordData = NonNullable<BoxRecord['set']>;

export interface SetCoin {
  readonly symbol: string;
  readonly decimals: number;
}

/** The price coin's symbol and decimals: ETH for the native coin, else its own contract's (a failed read: none). */
export async function coinOf(reads: SetReads, token: Address): Promise<SetCoin | null> {
  if (/^0x0{40}$/i.test(token)) return { symbol: 'ETH', decimals: 18 };
  const [symbol, decimals] = await Promise.all([reads.read(token, erc20Abi, 'symbol').catch(() => null), reads.read(token, erc20Abi, 'decimals').catch(() => null)]);
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return { symbol: typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 16 ? symbol : 'P', decimals };
}

export function useSetBox(set: SetRecordData, seams: SetBoxSeams = {}) {
  const { source } = set;
  const queries = useQueryClient();
  const reads = useMemo(() => seams.reads ?? rpcSetReads(source.rpc), [seams.reads, source.rpc]);
  const indexer = useMemo(() => (seams.indexer !== undefined ? seams.indexer : httpSetIndexer(source, seams.fetcher)), [seams.indexer, seams.fetcher, source]);
  const boxId = set.box.boxId;
  const token = set.box.token;
  const key = useMemo(() => ({ token, boxId }), [token, boxId]);
  const base = useMemo(() => ['set-box', source.chainId, source.release.registry.address, boxId] as const, [source, boxId]);
  const live = useQuery({ queryKey: base, queryFn: () => (indexer as SetIndexer).box(key), enabled: indexer !== null, refetchInterval: 4_000, retry: false, placeholderData: (previous) => previous });
  const box = live.data?.box ?? set.box;
  const asOf = live.data?.asOf ?? set.asOf;
  const members = useQuery({
    queryKey: [...base, 'members', box.state.loaded, box.state.inside, box.state.failed, asOf.block],
    queryFn: () => allMembers(indexer as SetIndexer, key), enabled: indexer !== null && box.state.loaded !== '0', retry: false, placeholderData: (previous) => previous,
  });
  const coordinator = box.coordinator as Address;
  const facts = useQuery({ queryKey: [...base, 'coordinator'], queryFn: () => readCoordinatorFacts(reads, coordinator), refetchInterval: 8_000, retry: false, placeholderData: (previous) => previous });
  // Open is the coordinator's trading gate, read on chain (the wire's seedReady is only "every item loaded").
  const trading = facts.data ? tradingOf(facts.data) : null;
  const phase = phaseOf(box, trading);
  const coin = useQuery({ queryKey: [...base, 'coin', box.spec.pricing.token], queryFn: () => coinOf(reads, box.spec.pricing.token as Address), staleTime: Infinity, retry: false });
  // Once graduated: one item's pick and return at one pinned block (the page's figures; each action requotes).
  const ones = useQuery({
    queryKey: [...base, 'ones', asOf.block, box.state.inside, box.state.totalSupply, box.state.escrowPrincipal],
    queryFn: async () => {
      const identity = await readSetIdentity(reads, source, coordinator, box.encodedSpec as `0x${string}`);
      // E-08B's preparation of one item each way (the figures only: nothing prepared here is sent).
      const one = (kind: 'pick' | 'return') => prepareConversion(reads, identity, identity.creator, kind, ONE_ITEM).catch(() => null);
      const [pick, back] = await Promise.all([one('pick'), one('return')]);
      return { pick, back };
    },
    enabled: phase === 'graduated', retry: false, placeholderData: (previous) => previous,
  });
  const refresh = () => queries.invalidateQueries({ queryKey: base });
  return {
    source, reads, indexer, submit: seams.submit !== undefined ? seams.submit : setSubmit(), base,
    box, asOf, phase, trading, stale: live.isError,
    members: members.data?.members ?? null, membersFailed: members.isError,
    facts: facts.data ?? null, factsFailed: facts.isError, coin: coin.data ?? null, ones: ones.data ?? null, refresh,
  };
}
