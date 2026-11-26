/**
 * Mock `AccountProvider` (SH-014, SH-015) over accounts.json, which scripts/gen-claims-fixture.py generates by
 * replaying deterministic demo sequences through the handoff reference model. DEMO ONLY: synthetic personas and
 * addresses, mock/demo provenance, no chain reads, no signing.
 *
 * - `listPositions`: current economic holdings (positive balances), NFT pairs split into whole units + fraction.
 * - `listClaims`: every pair with earned, claimed or pending-harvest Q, including zero-balance past holdings (ECO-05).
 * - `readClaim`: any account on any feed pair; an account the ledger does not know gets a zero claim (never held),
 *   an unknown pair rejects with `AccountQueryError` (never a fabricated zero).
 * - Clock: `now` is injected (default: the fixture asOf); a malformed value rejects with `TimeError`, one before the
 *   fixture asOf with `RangeError`. An R=T quote expires at its deadline; after that the claim shows no estimate.
 *   Nothing reads the wall clock.
 * - Scenarios: `conversion_fails` (R=T: conversion unavailable, labelled emergency direct-Q fallback), `unavailable`
 *   (ProviderUnavailableError), `loading` (pending until aborted).
 */
import {
  AccountQueryError,
  DEMO_NOW,
  canonicalAddress,
  canonicalPairId,
  formatIsoUtc,
  ledgerFor,
  parseAccountsFixture,
  parseFeedFixture,
  parseIsoTimestamp,
  parsePairId,
  sameAddress,
  splitWholeUnits,
  validateAccountClaims,
  validateAccountPositions,
  type AccountClaims,
  type AccountPositions,
  type AccountProvider,
  type AccountsFixture,
  type AccountsLedger,
  type AccountsLedgerAccount,
  type Address,
  type ClaimView,
  type DemoPersona,
  type PairId,
  type PairRecord,
  type Position,
  type Provenance,
} from '@squarehole/domain';
import { delay, throwIfAborted, waitForAbort } from '../abort';
import { ProviderUnavailableError } from '../errors';
import accountsJson from '../fixtures/accounts.json';
import feedJson from '../fixtures/feed.json';
import { MAX_MOCK_LATENCY_MS } from './mock-feed-provider';
import { deepFreeze } from './scenarios';

export const MOCK_ACCOUNT_SCENARIOS = ['default', 'conversion_fails', 'unavailable', 'loading'] as const;
export type MockAccountScenario = (typeof MOCK_ACCOUNT_SCENARIOS)[number];

export const MOCK_ACCOUNT_SOURCE =
  'Square Hole mock account provider: demo personas replayed through the reference fee model; not chain data';

export interface MockAccountProviderOptions {
  scenario?: MockAccountScenario;
  /** Injected clock returning an ISO timestamp (default: the fixture asOf). Must not be before the fixture asOf. */
  now?: () => string;
  /** Simulated latency per call, an integer from 0 to 60000 ms. Honours AbortSignal while waiting. */
  latencyMs?: number;
}

export interface MockAccountProvider extends AccountProvider {
  readonly mode: 'demo';
  readonly scenario: MockAccountScenario;
  readonly personas: readonly DemoPersona[];
}

/** The demo personas for an account switcher: labelled demo, synthetic addresses (validated with the fixture). */
export const DEMO_PERSONAS: readonly DemoPersona[] = deepFreeze(
  accountsJson.personas.map(({ id, label, address }) => ({ id: id as DemoPersona['id'], label, address: address as Address })),
);

interface AccountsData {
  readonly fixture: AccountsFixture;
  readonly pairs: ReadonlyMap<string, PairRecord>;
  readonly provenance: Provenance;
}
let accountsData: AccountsData | null = null;

/** Parsed and validated on first use (not at import), then shared: the fixture is immutable. */
function loadAccounts(): AccountsData {
  if (accountsData === null) {
    const feed = parseFeedFixture(feedJson);
    const fixture = parseAccountsFixture(accountsJson, feed);
    accountsData = deepFreeze({
      fixture,
      pairs: new Map(feed.items.map((pair) => [canonicalPairId(pair.pairId), pair])),
      provenance: { state: 'mock', asOf: fixture.asOf, blockNumber: fixture.asOfBlock, source: MOCK_ACCOUNT_SOURCE, coverage: 'demo' },
    });
  }
  return accountsData;
}

function positionOf(pair: PairRecord, account: AccountsLedgerAccount): Position {
  if (pair.type === 'token' || pair.nftUnitRaw === undefined) {
    return { pairId: pair.pairId, balanceRaw: account.balanceRaw, wholeNftCount: null, fractionalRaw: null, nftTokenIds: [] };
  }
  const { whole, fraction } = splitWholeUnits(BigInt(account.balanceRaw), BigInt(pair.nftUnitRaw));
  return {
    pairId: pair.pairId,
    balanceRaw: account.balanceRaw,
    wholeNftCount: whole.toString(),
    fractionalRaw: fraction.toString(),
    nftTokenIds: [...account.nftTokenIds],
  };
}

interface ClaimInputs {
  data: AccountsData;
  pair: PairRecord;
  owner: Address;
  ledger: AccountsLedger | undefined;
  account: AccountsLedgerAccount | undefined;
  scenario: MockAccountScenario;
  nowMs: number;
}

function claimOf({ data, pair, owner, ledger, account, scenario, nowMs }: ClaimInputs): ClaimView {
  const claimable = account?.claimableQRaw ?? '0';
  const claimed = account?.claimedQRaw ?? '0';
  const history = (account?.history ?? []).map((entry) => ({
    at: entry.at,
    block: entry.block,
    qConsumedRaw: entry.qConsumedRaw,
    payoutRaw: entry.payoutRaw,
    payoutAsset: entry.payoutSide === 'Q' ? pair.quote : pair.token,
    outcome: entry.outcome,
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  }));
  const base = {
    owner,
    pairId: pair.pairId,
    rewardSide: pair.rewardSide,
    earnedQRaw: (BigInt(claimable) + BigInt(claimed)).toString(),
    pendingHarvestQRaw: account?.pendingHarvestQRaw ?? '0',
    provenance: data.provenance,
    claimableQRaw: claimable,
    claimedQRaw: claimed,
    asOfBlock: data.fixture.asOfBlock,
    history,
  };
  if (pair.rewardSide === 'Q') {
    return {
      ...base,
      estimatedPayoutRaw: claimable,
      payoutAsset: pair.quote,
      conversionAvailable: false,
      directSourceFallbackAvailable: false,
      convertibleEstimate: null,
      directSourceFallback: null,
    };
  }
  const payable = BigInt(claimable) > 0n;
  if (scenario === 'conversion_fails') {
    return {
      ...base,
      estimatedPayoutRaw: null,
      payoutAsset: pair.token,
      conversionAvailable: false,
      directSourceFallbackAvailable: payable,
      convertibleEstimate: null,
      directSourceFallback: payable ? { label: 'emergency_direct_source_q', payoutAsset: pair.quote, payoutRaw: claimable } : null,
    };
  }
  const quote = ledger?.quote;
  const estimate = account?.convertibleEstimate;
  const current = quote && estimate && payable && nowMs < parseIsoTimestamp(quote.deadline);
  if (!current) {
    return {
      ...base,
      estimatedPayoutRaw: null,
      payoutAsset: pair.token,
      conversionAvailable: true,
      directSourceFallbackAvailable: false,
      convertibleEstimate: null,
      directSourceFallback: null,
    };
  }
  return {
    ...base,
    estimatedPayoutRaw: estimate.payoutRaw,
    payoutAsset: pair.token,
    estimateAsOf: quote.quotedAt,
    conversionAvailable: true,
    directSourceFallbackAvailable: false,
    convertibleEstimate: {
      payoutRaw: estimate.payoutRaw,
      tPerQ: quote.tPerQ,
      source: quote.source,
      asOfBlock: quote.asOfBlock,
      deadline: quote.deadline,
      minPayoutRaw: estimate.minPayoutRaw,
      toleranceBps: quote.toleranceBps,
    },
    directSourceFallback: null,
  };
}

const hasActivity = (claim: ClaimView): boolean =>
  claim.claimableQRaw !== '0' || claim.claimedQRaw !== '0' || claim.pendingHarvestQRaw !== '0' || claim.history.length > 0;

export function createMockAccountProvider(options: MockAccountProviderOptions = {}): MockAccountProvider {
  const scenario = options.scenario ?? 'default';
  const latencyMs = options.latencyMs ?? 0;
  const now = options.now ?? (() => DEMO_NOW);
  if (!MOCK_ACCOUNT_SCENARIOS.includes(scenario)) {
    throw new RangeError(`Unknown mock account scenario; expected one of ${MOCK_ACCOUNT_SCENARIOS.join(', ')}`);
  }
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0 || latencyMs > MAX_MOCK_LATENCY_MS) {
    throw new RangeError(`latencyMs must be an integer between 0 and ${MAX_MOCK_LATENCY_MS}`);
  }
  const data = loadAccounts();
  const { fixture, pairs, provenance } = data;
  const asOfMs = parseIsoTimestamp(fixture.asOf);

  /** Cancellation first, then latency, then the scenario's failure mode, then the injected clock. */
  async function ready(signal?: AbortSignal): Promise<number> {
    throwIfAborted(signal);
    if (scenario === 'loading') await waitForAbort(signal);
    if (latencyMs > 0) await delay(latencyMs, signal);
    throwIfAborted(signal);
    if (scenario === 'unavailable') throw new ProviderUnavailableError('Mock account provider: simulated outage');
    const nowMs = parseIsoTimestamp(now());
    if (nowMs < asOfMs) throw new RangeError('The injected clock is before the demo data asOf');
    return nowMs;
  }

  return {
    mode: 'demo',
    scenario,
    personas: DEMO_PERSONAS,

    async readClaim(pairId: PairId, account: Address, signal?: AbortSignal): Promise<ClaimView> {
      const nowMs = await ready(signal);
      const wanted = parsePairId(pairId).pairId;
      const owner = canonicalAddress(account);
      const pair = pairs.get(wanted);
      if (!pair) throw new AccountQueryError('unknown_pair', 'The mock account provider does not know this pair');
      const ledger = ledgerFor(fixture, pair.pairId);
      const entry = ledger?.accounts.find((candidate) => sameAddress(candidate.address, owner));
      const claim = claimOf({ data, pair, owner, ledger, account: entry, scenario, nowMs });
      const checked = validateAccountClaims({ owner, asOfBlock: fixture.asOfBlock, claims: [claim], provenance }, pairs, { asOf: formatIsoUtc(nowMs) });
      return deepFreeze(checked.claims[0] ?? claim);
    },

    async listPositions(account: Address, signal?: AbortSignal): Promise<AccountPositions> {
      await ready(signal);
      const owner = canonicalAddress(account);
      const positions = fixture.ledgers.flatMap((ledger) => {
        const pair = pairs.get(canonicalPairId(ledger.pairId));
        const entry = ledger.accounts.find((candidate) => sameAddress(candidate.address, owner));
        return pair && entry && BigInt(entry.balanceRaw) > 0n ? [positionOf(pair, entry)] : [];
      });
      return deepFreeze(validateAccountPositions({ owner, asOfBlock: fixture.asOfBlock, positions, provenance }, pairs));
    },

    async listClaims(account: Address, signal?: AbortSignal): Promise<AccountClaims> {
      const nowMs = await ready(signal);
      const owner = canonicalAddress(account);
      const claims = fixture.ledgers.flatMap((ledger) => {
        const pair = pairs.get(canonicalPairId(ledger.pairId));
        const entry = ledger.accounts.find((candidate) => sameAddress(candidate.address, owner));
        if (!pair || !entry) return [];
        const claim = claimOf({ data, pair, owner, ledger, account: entry, scenario, nowMs });
        return hasActivity(claim) ? [claim] : [];
      });
      // Validated at the read time, so an estimate can never outlive its quote deadline (claimViewIssues).
      return deepFreeze(validateAccountClaims({ owner, asOfBlock: fixture.asOfBlock, claims, provenance }, pairs, { asOf: formatIsoUtc(nowMs) }));
    },
  };
}
