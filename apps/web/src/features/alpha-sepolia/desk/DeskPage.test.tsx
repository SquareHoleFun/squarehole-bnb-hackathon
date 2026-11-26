import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlphaApi, AlphaResult, AlphaStatus, Decision, Desk, Signup } from '../alpha-api';
import { DESK_WORDS } from '../alpha-words';
import { DeskPage, decisionsFor, profileOf, utcTime } from './DeskPage';

afterEach(cleanup);

/**
 * F161 (4), SH-ALPHA-SITE, work package D: the founder's desk over a double of our server's desk API. Profile text is
 * hostile input: it is shown as text, with control and direction characters taken out.
 */
const signup = (xId: string, handle: string, status: AlphaStatus, over: Partial<Signup> = {}): Signup => ({
  xId, privyDid: `did:privy:${xId}`, handle, name: `Name ${handle}`, status, signedUpAt: '2026-10-29T10:00:00.000Z', lastSignIn: '2026-10-29T11:00:00.000Z', ...over,
});

function deskApi(start: Desk, over: Partial<AlphaApi> = {}) {
  let desk = start;
  const decided: [string, Decision][] = [];
  const api: AlphaApi = {
    intake: vi.fn(async () => ({ ok: true as const, value: { open: true, returning: false } })), me: vi.fn(), session: vi.fn(), signOut: vi.fn(), claimMessage: vi.fn(), claim: vi.fn(), claimState: vi.fn(),
    signups: vi.fn(async (): Promise<AlphaResult<Desk>> => ({ ok: true, value: desk })),
    decide: vi.fn(async (xId: string, decision: Decision): Promise<AlphaResult<AlphaStatus>> => {
      decided.push([xId, decision]);
      const status: AlphaStatus = decision === 'approve' ? 'approved' : decision === 'remove' ? 'removed' : 'pending';
      desk = { signups: desk.signups.map((row) => (row.xId === xId ? { ...row, status } : row)), decisions: [...desk.decisions, { seq: desk.decisions.length + 1, xId, decision, actor: 'founder', at: '2026-10-29T12:00:00.000Z' }] };
      return { ok: true, value: status };
    }),
    ...over,
  };
  return { api, decided };
}

const rows = () => within(screen.getByRole('list', { name: 'Sign-ups' })).getAllByRole('listitem');
const rowOf = (xId: string) => rows().find((row) => row.dataset.xId === xId) as HTMLElement;

describe('the founder’s desk (F161 (4), SH-ALPHA-SITE)', () => {
  it('shows each sign-up’s handle as a link to its X profile, its name and its sign-up time, pending first, and the counts', async () => {
    const { api } = deskApi({ signups: [signup('3', 'carol', 'removed'), signup('1', 'alice', 'approved'), signup('2', 'bob', 'pending', { signedUpAt: '2026-10-28T09:05:00.000Z' })], decisions: [] });
    render(<DeskPage api={api} />);
    await screen.findByRole('list', { name: 'Sign-ups' });
    expect(rows().map((row) => row.dataset.xId)).toEqual(['2', '1', '3']);
    const bob = rowOf('2');
    const link = within(bob).getByRole('link');
    // By X number (XR-ALPHA-SITE af2): a handle can be released and taken by someone else; the number stays this account's.
    expect(link.getAttribute('href')).toBe('https://x.com/i/user/2');
    expect(link.textContent).toContain('@bob');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(bob.textContent).toContain('Name bob');
    expect(bob.textContent).toContain('Signed up 28 Oct 2026, 09:05 UTC · X 2');
    // No age, followers or anything else Privy does not give.
    expect(document.body.textContent ?? '').not.toMatch(/follower|account age|joined x|verified/i);
    const counts = screen.getByRole('main').querySelector('.sh-desk__counts')?.textContent;
    expect(counts).toBe('Pending1Approved1Removed1');
  });

  it('approve, remove and reset each ask once more; Cancel sends nothing, Confirm sends the decision by X number and reloads', async () => {
    const { api, decided } = deskApi({ signups: [signup('2', 'bob', 'pending')], decisions: [] });
    render(<DeskPage api={api} />);
    await screen.findByRole('list', { name: 'Sign-ups' });
    expect(within(rowOf('2')).getAllByRole('button').map((button) => button.textContent)).toEqual(['Approve @bob', 'Remove @bob']);
    fireEvent.click(within(rowOf('2')).getByRole('button', { name: 'Approve @bob' }));
    expect(within(rowOf('2')).getByRole('status').textContent).toBe('Let @bob in?');
    fireEvent.click(within(rowOf('2')).getByRole('button', { name: DESK_WORDS.cancel }));
    expect(decided).toEqual([]);
    fireEvent.click(within(rowOf('2')).getByRole('button', { name: 'Approve @bob' }));
    await act(async () => { fireEvent.click(within(rowOf('2')).getByRole('button', { name: DESK_WORDS.confirm })); });
    expect(decided).toEqual([['2', 'approve']]);
    await waitFor(() => expect(rowOf('2').dataset.status).toBe('approved'));
    expect(rowOf('2').textContent).toContain('approved 29 Oct 2026, 12:00 UTC');
    expect(within(rowOf('2')).getAllByRole('button').map((button) => button.textContent)).toEqual(['Remove @bob', 'Reset @bob']);
    fireEvent.click(within(rowOf('2')).getByRole('button', { name: 'Remove @bob' }));
    expect(within(rowOf('2')).getByRole('status').textContent).toBe('End @bob’s access?');
    await act(async () => { fireEvent.click(within(rowOf('2')).getByRole('button', { name: DESK_WORDS.confirm })); });
    fireEvent.click(await within(rowOf('2')).findByRole('button', { name: 'Reset @bob' }));
    expect(within(rowOf('2')).getByRole('status').textContent).toBe('Put @bob back on the list?');
    await act(async () => { fireEvent.click(within(rowOf('2')).getByRole('button', { name: DESK_WORDS.confirm })); });
    expect(decided).toEqual([['2', 'approve'], ['2', 'remove'], ['2', 'reset']]);
    await waitFor(() => expect(rowOf('2').dataset.status).toBe('pending'));
  });

  it('shows profile text as text only, with control and direction characters taken out; the link goes by X number, whatever the handle', async () => {
    const hostile = signup('9', 'mallory', 'pending', { name: '<img src=x onerror=alert(1)>\u202Eevil\u0007 name' });
    const odd = signup('8', 'not ok!', 'pending');
    const { api } = deskApi({ signups: [hostile, odd], decisions: [] });
    const { container } = render(<DeskPage api={api} />);
    await screen.findByRole('list', { name: 'Sign-ups' });
    expect(container.querySelector('img')).toBeNull();
    expect(rowOf('9').querySelector('.sh-desk__name')?.textContent).toBe('<img src=x onerror=alert(1)> evil name');
    expect([...(rowOf('9').textContent ?? '')].filter((char) => { const code = char.codePointAt(0) ?? 0; return code < 0x20 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069); })).toEqual([]);
    expect(within(rowOf('8')).getByRole('link').getAttribute('href')).toBe('https://x.com/i/user/8');
    expect(profileOf('1849302217654321001')).toBe('https://x.com/i/user/1849302217654321001');
    for (const bad of ['not ok!', 'bob', '0123', '', '12345678901234567890123', '1/../2']) expect(profileOf(bad), bad).toBeNull();
  });

  it('says when the desk cannot be read: no answer (an expired Access sign-in), or a refusal', async () => {
    render(<DeskPage api={deskApi({ signups: [], decisions: [] }, { signups: vi.fn(async (): Promise<AlphaResult<Desk>> => ({ ok: false, status: 0, error: 'no answer' })) }).api} />);
    expect((await screen.findByRole('alert')).textContent).toBe(DESK_WORDS.accessExpired);
    cleanup();
    render(<DeskPage api={deskApi({ signups: [], decisions: [] }, { signups: vi.fn(async (): Promise<AlphaResult<Desk>> => ({ ok: false, status: 503, error: 'service unavailable' })) }).api} />);
    expect((await screen.findByRole('alert')).textContent).toBe('The alpha service is not available. Try again later.');
    cleanup();
    render(<DeskPage api={deskApi({ signups: [], decisions: [] }).api} />);
    expect(await screen.findByText(DESK_WORDS.empty)).toBeTruthy();
  });

  it('a decision our server refuses is one line, and the list stays as it was', async () => {
    const { api } = deskApi({ signups: [signup('2', 'bob', 'pending')], decisions: [] }, { decide: vi.fn(async (): Promise<AlphaResult<AlphaStatus>> => ({ ok: false, status: 404, error: 'signup not found' })) });
    render(<DeskPage api={api} />);
    await screen.findByRole('list', { name: 'Sign-ups' });
    fireEvent.click(within(rowOf('2')).getByRole('button', { name: 'Approve @bob' }));
    await act(async () => { fireEvent.click(within(rowOf('2')).getByRole('button', { name: DESK_WORDS.confirm })); });
    expect(screen.getByRole('alert').textContent).toBe('Not found.');
    expect(rowOf('2').dataset.status).toBe('pending');
  });

  it('formats times in UTC on any machine, and offers each status its own decisions', () => {
    expect(utcTime('2026-01-02T03:04:05.000Z')).toBe('2 Jan 2026, 03:04 UTC');
    expect(utcTime('not a time')).toBe('not a time');
    expect(decisionsFor('pending')).toEqual(['approve', 'remove']);
    expect(decisionsFor('approved')).toEqual(['remove', 'reset']);
    expect(decisionsFor('removed')).toEqual(['approve', 'reset']);
  });
});


it('SH-198 shows the cap, waiting claims and sender float beside account counts', async () => {
  render(<DeskPage api={deskApi({ signups: [], decisions: [], load: { pending: 0, approved: 0, cap: 100, claimsWaiting: 7, senderFloat: 'low' } }).api} />);
  expect(await screen.findByText('Cap 100 · Claims waiting 7 · Sender float needs refill')).toBeTruthy();
});
