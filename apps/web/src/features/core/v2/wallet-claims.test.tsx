/** F128 on My Box (WalletClaimsV2.tsx): which v2 boxes the wallet's Claim all covers, and what the Claims tab says. */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { AppProviders } from '../../../app-providers';
import type { BoxRecord } from '../../boxes/box-model';
import { parseSnapshotV2 } from './indexer-v2';
import { recordV2 } from './record-v2';
import { publishedM2, A } from './test-support/m2-published';
import { claimBoxOf, useWalletClaimsV2 } from './WalletClaimsV2';

// No chain in these tests: every RPC read fails at once.
beforeEach(() => { vi.stubGlobal('fetch', async () => { throw new Error('offline'); }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function failedHolderBox(): Promise<BoxRecord> {
  const { body, source } = await publishedM2(true);
  return recordV2(parseSnapshotV2(body, source), source);
}
function Show({ records, own }: { records: readonly BoxRecord[]; own: boolean }) {
  const claims = useWalletClaimsV2(records, A, own);
  return <output data-testid="claims">{claims === null ? 'none' : claims.lead}</output>;
}
const show = (records: readonly BoxRecord[], own: boolean) => render(<AppProviders><MemoryRouter><Show records={records} own={own} /></MemoryRouter></AppProviders>);

describe('F128 My Box claims', () => {
  it('a v2 box that can hold a claim joins; a stale or unverified one waits; a box without v2 data is left out', async () => {
    const record = await failedHolderBox(); const view = record.v2Chain?.snapshot;
    expect(claimBoxOf(record, 0n)).toMatchObject({ key: record.id, name: record.name, symbol: record.pairAsset, disabled: false });
    expect(claimBoxOf({ ...record, v2Chain: { source: record.v2Chain?.source ?? null, snapshot: view ? { ...view, stale: true } : null } }, 0n)?.disabled).toBe(true);
    expect(claimBoxOf({ ...record, v2Chain: { source: record.v2Chain?.source ?? null, snapshot: view ? { ...view, verified: false } : null } }, 0n)?.disabled).toBe(true);
    expect(claimBoxOf({ ...record, v2Chain: undefined }, 0n)).toBeNull();
  });

  it('no v2 box on the source: nothing to show, so the tab keeps its earlier words', () => {
    show([], true);
    expect(screen.getByTestId('claims').textContent).toBe('none');
  });

  it('another wallet’s My Box is view only; its own lists its claims', async () => {
    const record = await failedHolderBox();
    show([record], false);
    expect(screen.getByTestId('claims').textContent).toBe('View only');
    cleanup();
    show([record], true);
    // Its own: the Claims tab heads Claim all (here the reads fail offline, so it never invents a claim).
    expect(['Reading…', 'Nothing to claim']).toContain(screen.getByTestId('claims').textContent);
  });
});
