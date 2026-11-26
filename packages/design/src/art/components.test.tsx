// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetMonogram, monogramFor } from './AssetMonogram';
import { CastCharacter } from './CastCharacter';
import { PairAvatar } from './PairAvatar';

afterEach(cleanup);

const ORCHARD = '31337:0x0000000000000000000000000000000000000066';
const NO_PRICE_YET = '31337:0x0000000000000000000000000000000000000070';
const SHAPE = '31337:0x0000000000000000000000000000000000000067'; // shape-sphere, 55×55 native

describe('<PairAvatar>', () => {
  it('renders mapped demo art with descriptive alt text at the requested size', () => {
    render(<PairAvatar pairId={ORCHARD} size={40} />);
    const img = screen.getByRole('img', { name: 'Cartoon apple tree' });
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('width')).toBe('40');
    expect(img.getAttribute('height')).toBe('40');
    expect(img.getAttribute('src')).toMatch(/orchard-tree\.webp/);
  });

  it('never displays art above its native pixel size', () => {
    const { container } = render(<PairAvatar pairId={SHAPE} size={96} />);
    const frame = container.querySelector('[data-art-state="available"]') as HTMLElement;
    expect(frame.style.getPropertyValue('--sh-avatar-size')).toBe('55px');
    expect(screen.getByRole('img').getAttribute('width')).toBe('55');
  });

  it('can be decorative when the name is already next to it', () => {
    const { container } = render(<PairAvatar pairId={ORCHARD} decorative />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows the unavailable-artwork state with a neutral glyph and accessible text', () => {
    const { container } = render(<PairAvatar pairId={NO_PRICE_YET} size={40} />);
    const fallback = screen.getByRole('img', { name: 'Artwork unavailable' });
    expect(fallback.getAttribute('data-art-state')).toBe('unavailable');
    expect(fallback.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('img')).toBeNull();
  });

  it('treats unknown or malformed pair ids as unavailable, never as another pair', () => {
    render(<PairAvatar pairId="not-a-pair" />);
    expect(screen.getByRole('img', { name: 'Artwork unavailable' })).toBeTruthy();
  });
});

describe('<CastCharacter>', () => {
  it('renders The Sorter from extracted art with its name', () => {
    render(<CastCharacter id="sorter" />);
    expect(screen.getByRole('img', { name: 'The Sorter, a smiling lavender cube' })).toBeTruthy();
    expect(screen.getByText('The Sorter')).toBeTruthy();
  });

  it('renders a labelled placeholder for cast members pending original art', () => {
    render(<CastCharacter id="stonk" />);
    const placeholder = screen.getByRole('img', { name: 'The Stonk: original art pending' });
    expect(placeholder.getAttribute('data-art-state')).toBe('pending');
    expect(screen.getByText('The Stonk')).toBeTruthy();
  });

  it('can hide the caption', () => {
    render(<CastCharacter id="collector" caption={false} />);
    expect(screen.queryByText('The Collector')).toBeNull();
    expect(screen.getByRole('img', { name: /The Collector/ })).toBeTruthy();
  });
});

describe('<AssetMonogram>', () => {
  it('uses a neutral text chip, never an issuer logo', () => {
    const { container } = render(<AssetMonogram symbol="AAPLx-DEMO" />);
    const chip = screen.getByRole('img', { name: 'AAPLx-DEMO' });
    expect(chip.textContent).toBe('AA');
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('is hidden from assistive tech when decorative', () => {
    render(<AssetMonogram symbol="USDC-DEMO" decorative />);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('derives monograms from untrusted symbols safely', () => {
    expect(monogramFor('USDC-DEMO')).toBe('US');
    expect(monogramFor('weth')).toBe('WE');
    expect(monogramFor('x')).toBe('X');
    expect(monogramFor('')).toBe('?');
    expect(monogramFor('   ')).toBe('?');
    expect(monogramFor('-DEMO')).toBe('?');
    expect(monogramFor('👩‍🚀Z')).toBe('Z');
    expect(monogramFor('<script>')).toBe('SC');
    expect(monogramFor('مرحبا')).toBe('مر');
  });
});
