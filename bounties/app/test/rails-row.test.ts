/**
 * SH-282: the row at the top of one rail's list: Boxes back to the platform, On Flap and On Four.meme, the list's own
 * entry current (no link), the other one a link to its list.
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RailsRow } from '../src/screens/Home';

const html = (current: 'flap' | 'four') => renderToStaticMarkup(createElement(RailsRow, { current }));

describe('the rails row of the launch lists', () => {
  it('on the Flap list: On Flap current, Boxes to /, On Four.meme to #/four', () => {
    const out = html('flap');
    expect(out).toContain('aria-label="Launch on"');
    expect(out).toContain('<a class="rails-row__option" href="/">Boxes</a>');
    expect(out).toContain('<span class="rails-row__option" aria-current="page">On Flap</span>');
    expect(out).toContain('<a class="rails-row__option" href="#/four">On Four.meme</a>');
  });
  it('on the Four.meme list: On Four.meme current, On Flap to #/flap', () => {
    const out = html('four');
    expect(out).toContain('<a class="rails-row__option" href="#/flap">On Flap</a>');
    expect(out).toContain('<span class="rails-row__option" aria-current="page">On Four.meme</span>');
    expect(out).not.toContain('href="#/four"');
  });
});
