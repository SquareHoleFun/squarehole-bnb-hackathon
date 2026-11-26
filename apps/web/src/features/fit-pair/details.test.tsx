/**
 * SH-ALCHEMIST-LESS-TEXT: the shared Details disclosure (InfoTip.tsx). Founder, 2026-10-27: "We can make buttons for
 * people that want to see the details, but that should never be the default." A real button with `aria-expanded` and
 * `aria-controls`, its panel hidden until pressed, Escape closes it and puts focus back, and nothing remembers it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { required } from '../core/v2/test-support/required';
import { Details } from './InfoTip';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const panelOf = (button: HTMLElement): HTMLElement => required(document.getElementById(required(button.getAttribute('aria-controls'))));

describe('SH-ALCHEMIST-LESS-TEXT Details', () => {
  it('starts closed: a native button that controls a hidden panel right after it, with its words still in the page', () => {
    render(<Details><p>A rule line.</p><a href="#rules">Rules</a></Details>);
    const button = screen.getByRole('button', { name: 'Details' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe('Details');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panel = panelOf(button);
    expect(panel.hidden).toBe(true);
    expect(button.nextElementSibling).toBe(panel);
    expect(panel.textContent).toBe('A rule line.Rules');
    // Hidden from the accessibility tree while closed: no link to tab to, no line to read.
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a press opens it in place and a second closes it; Escape on the button or inside the panel closes it and puts focus back on the button', () => {
    render(<Details><a href="#rules">Rules</a></Details>);
    const button = screen.getByRole('button', { name: 'Details' });
    const panel = panelOf(button);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(screen.getByRole('link', { name: 'Rules' })).toBeTruthy();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
    // Escape on the button.
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    // Escape inside the panel.
    fireEvent.click(button);
    const link = screen.getByRole('link', { name: 'Rules' });
    link.focus();
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    // Escape while closed does nothing (and lets the key through to the page).
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    button.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
  });

  it('names what it opens for screen readers, starting with its visible label', () => {
    render(<><Details name="Alchemist, buyers’ fees"><p>Route</p></Details><Details label="Pile details"><p>Seed</p></Details></>);
    const named = screen.getByRole('button', { name: 'Details: Alchemist, buyers’ fees' });
    expect(named.textContent).toBe('Details');
    const own = screen.getByRole('button', { name: 'Pile details' });
    expect(own.hasAttribute('aria-label')).toBe(false);
    // Each has its own panel.
    expect(panelOf(named)).not.toBe(panelOf(own));
  });

  it('remembers nothing: no storage is written, and a new mount starts closed', () => {
    const stored = vi.spyOn(Storage.prototype, 'setItem');
    const first = render(<Details><p>Rule</p></Details>);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe('true');
    first.unmount();
    render(<Details><p>Rule</p></Details>);
    expect(screen.getByRole('button', { name: 'Details' }).getAttribute('aria-expanded')).toBe('false');
    expect(stored).not.toHaveBeenCalled();
  });
});
