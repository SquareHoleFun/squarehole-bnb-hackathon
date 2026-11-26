/**
 * SH-282: the Boxes page's row to the launches on the other rails: BNB Chain testnet only, three entries (Boxes
 * current, On Flap, On Four.meme) with their addresses; any other network shows nothing.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchRails } from './LaunchRails';

afterEach(cleanup);

describe('the launch rails row', () => {
  it('BNB Chain testnet: Boxes (current, no link), On Flap and On Four.meme on the Boxes page', () => {
    render(<MemoryRouter><LaunchRails params={new URLSearchParams()} network="bnb" /></MemoryRouter>);
    const row = screen.getByRole('group', { name: 'Launch on' });
    expect(within(row).getByText('Boxes').getAttribute('aria-current')).toBe('page');
    expect(within(row).queryByRole('link', { name: 'Boxes' })).toBeNull();
    expect(within(row).getByRole('link', { name: 'On Flap' }).getAttribute('href')).toBe('/?on=flap');
    expect(within(row).getByRole('link', { name: 'On Four.meme' }).getAttribute('href')).toBe('/?on=four');
  });

  it('the other network: nothing', () => {
    const { container } = render(<LaunchRails params={new URLSearchParams()} network="sepolia" />);
    expect(container.innerHTML).toBe('');
  });
});
