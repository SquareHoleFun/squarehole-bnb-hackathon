/**
 * The words of the F74 polish on the steps (SH-F74-polish items 4, 9, 12, 14), rendered one step at a time: the fee
 * cap's (i) names every choice on screen above it and how a token payout counts, the cap amount shows once, the
 * target's (i) does not repeat "every box", and the collection cover's (i) says it is also the unrevealed items' picture
 * in open art.
 */
import { CapExcess, QStream, TStream, type Network } from '@squarehole/box-spec';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LaunchStep, RaiseStep } from './ChoiceSteps';
import { ContentsStep } from './ContentsStep';
import { DEFAULT_FORM, EMPTY_PAGE, type CreateForm } from './create-model';
import { KindStep } from './KindStep';
import { NOW, formOf } from './test-support/fixtures';

const ETH = 10n ** 18n;
const noop = () => undefined;
const props = (form: CreateForm) => ({ form, set: noop, errorFor: () => null, touch: noop });

afterEach(cleanup);

/** Opens or closes the cap's group as a browser does on its summary (jsdom does not toggle <details> itself). */
function toggleCap(open: boolean) {
  const details = screen.getByText(/^Fee cap/, { selector: 'summary' }).closest('details') as HTMLDetailsElement;
  act(() => {
    details.open = open;
    fireEvent(details, new Event('toggle'));
  });
}

function renderKind(form: CreateForm, network: Network) {
  render(<KindStep {...props(form)} network={network} />);
  toggleCap(true);
}

const capInfo = () => {
  fireEvent.click(screen.getByRole('button', { name: 'About the cap' }));
  return document.getElementById(screen.getByRole('button', { name: 'About the cap' }).getAttribute('aria-controls') ?? '')?.textContent ?? '';
};

describe('the fee cap (add-on 5) in Box kind', () => {
  it('its (i) names every excess choice on screen: holders in the Demo only', () => {
    renderKind(formOf({ qStream: QStream.TO_CREATOR, capPerEpoch: 4n * ETH, capExcess: CapExcess.BURN }), 'demo');
    expect(capInfo()).toContain('Above it, fees are burned, go into the pool or go to holders.');
    cleanup();
    renderKind(formOf({ qStream: QStream.TO_CREATOR, capPerEpoch: 4n * ETH, capExcess: CapExcess.BURN }), 'sepolia');
    expect(capInfo()).toContain('Above it, fees are burned or go into the pool.');
  });

  it('its (i) says how a token payout counts: paid in MOON at the 1-hour average, bought for you at the ETH spent', () => {
    renderKind(formOf({ qStream: QStream.TO_CREATOR, capPerEpoch: 4n * ETH }), 'demo');
    const info = capInfo();
    expect(info).toContain('MOON paid to you counts at the pool’s 1-hour average price; MOON bought for you counts the ETH spent.');
    expect(info).not.toContain('Payouts in the token');
    cleanup();
    // Sepolia builds no buy for you (the swap module): only the average.
    renderKind(formOf({ qStream: QStream.TO_CREATOR, capPerEpoch: 4n * ETH }), 'sepolia');
    expect(capInfo()).toContain('MOON paid to you counts at the pool’s 1-hour average price.');
  });

  it('with a cap on, its amount shows once: on its chip while open, in the summary while closed', () => {
    render(<KindStep {...props(formOf({ qStream: QStream.TO_CREATOR, tStream: TStream.BURN_T, capPerEpoch: 4n * ETH }))} network="demo" />);
    const summary = screen.getByText(/^Fee cap/, { selector: 'summary' });
    const group = summary.closest('details') as HTMLElement;
    expect(summary.textContent).toBe('Fee cap · 4 ETH / 30 days');
    toggleCap(true);
    expect(summary.textContent).toBe('Fee cap');
    expect(within(group).getAllByText(/4 ETH/).map((node) => node.textContent)).toEqual(['4 ETH']);
    expect(within(group).getByText('Per 30 days')).toBeTruthy();
  });
});

describe('each side’s (i) on Sepolia (SH-F74-polish item 5)', () => {
  const sideInfo = (side: 'Buyers’' | 'Sellers’', network: Network) => {
    render(<KindStep {...props(formOf({ qStream: QStream.TO_CREATOR, tStream: TStream.BURN_T }))} network={network} />);
    const button = screen.getByRole('button', { name: `About ${side.toLowerCase()} fees` });
    fireEvent.click(button);
    const text = document.getElementById(button.getAttribute('aria-controls') ?? '')?.textContent ?? '';
    cleanup();
    return text;
  };

  it('names no conversion or sell where core v1 builds none (Sepolia), and both in the Demo', () => {
    expect(sideInfo('Buyers’', 'demo')).toContain('Paid in the other token, it is converted after graduation.');
    expect(sideInfo('Sellers’', 'demo')).toContain('or sold for ETH that joins FIT’s burn');
    const buyers = sideInfo('Buyers’', 'sepolia');
    const sellers = sideInfo('Sellers’', 'sepolia');
    expect(buyers).not.toContain('converted');
    expect(sellers).not.toMatch(/converted|sold for|sells/);
    expect(sellers).toContain('Burn: the MOON is burned.');
  });
});

describe('the target and the collection cover', () => {
  it('the target’s (i) says once that every box raises the same', () => {
    render(<RaiseStep {...props(formOf())} />);
    fireEvent.click(screen.getByRole('button', { name: 'About the target' }));
    const panel = document.getElementById(screen.getByRole('button', { name: 'About the target' }).getAttribute('aria-controls') ?? '');
    expect(panel?.textContent).toBe('Every box raises this same amount, so nobody picks one.');
  });

  it('the collection cover’s (i) also names the unrevealed items’ picture in open art', () => {
    const contents = (form: CreateForm) =>
      render(
        <ContentsStep
          {...props(form)}
          art={null}
          commitment={null}
          collectionCover={null}
          page={EMPTY_PAGE}
          pictures={{ collection: { busy: false, problem: null }, banner: { busy: false, problem: null }, teaser: { busy: false, problem: null } }}
          progress={null}
          onArt={noop}
          onCollectionCover={noop}
          onBanner={noop}
          onTeasers={noop}
          onPage={noop}
        />,
      );
    const info = () => {
      const button = screen.getByRole('button', { name: 'About the collection cover' });
      fireEvent.click(button);
      return document.getElementById(button.getAttribute('aria-controls') ?? '')?.textContent ?? '';
    };
    contents(formOf({ artMode: 'open' }));
    expect(info()).toBe('The collection’s picture on marketplaces, and each item’s until it is revealed. Your logo stays the token’s picture.');
    cleanup();
    contents(formOf({ artMode: 'hidden' }));
    expect(info()).toBe('The collection’s picture on marketplaces. Your logo stays the token’s picture.');
  });
});

describe('Opening: Now first and the default (founder 2026-10-04)', () => {
  it('offers Now, 5 min, 1 h, 24 h and Pick a time; a new form starts on Now; each chip sets its preset', () => {
    const patches: Partial<CreateForm>[] = [];
    render(<LaunchStep form={formOf({ open: DEFAULT_FORM.open })} set={(patch) => patches.push(patch)} errorFor={() => null} touch={noop} nowMs={NOW} />);
    const opens = screen.getByRole('group', { name: 'Opens' });
    const radios = within(opens).getAllByRole('radio');
    expect(radios.map((radio) => [(radio as HTMLInputElement).value, radio.closest('label')?.textContent])).toEqual([
      ['now', 'Now'],
      ['5m', '5 min'],
      ['1h', '1 h'],
      ['24h', '24 h'],
      ['time', 'Pick a time'],
    ]);
    expect(within(opens).getByRole('radio', { name: 'Now' })).toHaveProperty('checked', true);
    // A preset shows no time line: only Pick a time has its field and its UTC line.
    expect(screen.queryByLabelText('Time (UTC)')).toBeNull();
    fireEvent.click(within(opens).getByRole('radio', { name: '1 h' }));
    fireEvent.click(within(opens).getByRole('radio', { name: '24 h' }));
    fireEvent.click(within(opens).getByRole('radio', { name: '5 min' }));
    expect(patches.map((patch) => patch.open)).toEqual([
      { kind: 'preset', id: '1h' },
      { kind: 'preset', id: '24h' },
      { kind: 'preset', id: '5m' },
    ]);
    cleanup();
    patches.length = 0;
    render(<LaunchStep form={formOf({ open: { kind: 'preset', id: '1h' } })} set={(patch) => patches.push(patch)} errorFor={() => null} touch={noop} nowMs={NOW} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Now' }));
    expect(patches.map((patch) => patch.open)).toEqual([{ kind: 'preset', id: 'now' }]);
  });

  it('Pick a time is an exact UTC time: the field is labelled UTC, starts an hour ahead in UTC, and its line says how far', () => {
    const patches: Partial<CreateForm>[] = [];
    render(<LaunchStep form={formOf({ open: DEFAULT_FORM.open })} set={(patch) => patches.push(patch)} errorFor={() => null} touch={noop} nowMs={NOW + 20_000} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Pick a time' }));
    // NOW is 2026-10-03 12:00:00 UTC: an hour ahead, the next whole minute, in UTC whatever this machine's zone.
    expect(patches.map((patch) => patch.open)).toEqual([{ kind: 'time', utc: '2026-10-03T13:01' }]);
    cleanup();
    render(<LaunchStep form={formOf({ open: { kind: 'time', utc: '2026-10-03T15:30' } })} set={noop} errorFor={() => null} touch={noop} nowMs={NOW} />);
    expect((screen.getByLabelText('Time (UTC)') as HTMLInputElement).value).toBe('2026-10-03T15:30');
    expect(document.getElementById('create-open-time-utc')?.textContent).toBe('in 4 h');
    cleanup();
    render(<LaunchStep form={formOf({ open: { kind: 'time', utc: '2026-10-05T09:00' } })} set={noop} errorFor={() => null} touch={noop} nowMs={NOW} />);
    expect(document.getElementById('create-open-time-utc')?.textContent).toBe('in 45 h');
  });
});
