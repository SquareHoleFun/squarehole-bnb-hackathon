import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AlphaApi, AlphaMe, AlphaResult, ClaimState } from '../alpha-sepolia/alpha-api';
import { CLAIM_WORDS } from '../alpha-sepolia/alpha-words';
import { ClaimCard } from './ClaimCard';

vi.mock('../wallet', () => ({
  useWallet: () => ({ status: 'disconnected', kind: 'injected', account: null, signer: null }),
  shortAddress: (address: string) => address,
  BrowserWalletDialog: () => null,
}));
afterEach(cleanup);
const waiting: ClaimState = { id: '00000000-0000-4000-8000-000000000001', status: 'waiting',
  admitTx: null, sendTx: null, reason: 'insufficient float for starter and gas', at: '2026-11-11T12:00:00Z' };

it.each(['waiting', 'queued'] as const)('the actual Claim card shows a refill wait from %s without offering another claim', async status => {
  const api: AlphaApi = {
    intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(async (): Promise<AlphaResult<AlphaMe>> => ({ ok: true, value: { status: 'approved', handle: 'tester', claim: { ...waiting, status } } })),
    claimState: vi.fn(async (): Promise<AlphaResult<ClaimState>> => ({ ok: true, value: waiting })),
    session: vi.fn(), signOut: vi.fn(), claimMessage: vi.fn(), claim: vi.fn(), signups: vi.fn(), decide: vi.fn(),
  };
  render(<ClaimCard api={api} pollMs={1} />);
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Waiting: the faucet is being refilled.'));
  expect(screen.queryByText('Refused. Nothing was sent.')).toBeNull();
  expect(screen.queryByRole('button', { name: CLAIM_WORDS.sign })).toBeNull();
  expect(api.claim).not.toHaveBeenCalled(); expect(api.claimMessage).not.toHaveBeenCalled();
});
