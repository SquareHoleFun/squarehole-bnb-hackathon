import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LaunchOn } from './LaunchOn';

describe('LaunchOn (SH-265): where a launch happens, in the BNB Chain testnet build only', () => {
  it('on BNB Chain testnet: "Launch on" Flap, Four.meme, Own pool in that order; Own pool is this page', () => {
    render(<LaunchOn network="bnb" />);
    const group = screen.getByRole('group', { name: 'Launch on' });
    const options = Array.from(group.querySelectorAll('.sh-pic-ways__option')).map((o) => o.textContent);
    expect(options).toEqual(['Flap', 'Four.meme', 'Own pool']);
    expect(within(group).getByText('Own pool').getAttribute('aria-current')).toBe('true');
    expect(within(group).getByRole('link', { name: 'Flap' }).getAttribute('href')).toBe('/launches/#/flap/create');
    expect(within(group).getByRole('link', { name: 'Four.meme' }).getAttribute('href')).toBe('/launches/#/four/create');
    expect(group.textContent).not.toContain('Square Hole');
  });

  it('on Sepolia (and in this suite, whose build names no test network): nothing at all', () => {
    const { container } = render(<LaunchOn network="sepolia" />);
    expect(container.innerHTML).toBe('');
    const plain = render(<LaunchOn />);
    expect(plain.container.innerHTML).toBe('');
  });

  it('says no internal working name', () => {
    render(<LaunchOn network="bnb" />);
    expect(document.body.textContent ?? '').not.toMatch(/Starts/i);
  });
});
