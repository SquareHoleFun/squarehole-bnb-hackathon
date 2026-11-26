/**
 * SH-255 second review (job288 R-18): in a sheet with its (?) open, the first Escape shuts the (?) wherever focus is in
 * the sheet (its Close button too) and puts focus back on the (?) button; the next Escape shuts the sheet.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PartSheet } from './PartSheet';

afterEach(() => cleanup());

describe('R-18: the first Escape shuts an open (?)', () => {
  it('from the sheet’s Close button: the (?) shuts, the sheet stays; the second Escape shuts the sheet', async () => {
    const onClose = vi.fn();
    render(
      <PartSheet title="Pool" icon={null} why={['Pool. Opens at graduation with tokens and price coins.']} whyLabel="About the pool" anchor={() => null} stage={() => null} onClose={onClose}>
        <p>0.1197</p>
      </PartSheet>,
    );
    const about = screen.getByRole('button', { name: 'About the pool' });
    await act(async () => { fireEvent.click(about); });
    expect(about.getAttribute('aria-expanded')).toBe('true');
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    await act(async () => { fireEvent.keyDown(close, { key: 'Escape' }); });
    expect(onClose).not.toHaveBeenCalled();
    expect(about.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(about);
    await act(async () => { fireEvent.keyDown(about, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalledExactlyOnceWith('escape');
  });
});
