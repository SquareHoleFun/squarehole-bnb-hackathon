import { describe, expect, it } from 'vitest';
import { APP_COPY_FRAMING, APP_COPY_NEVER, RETURN_FRAMING, appCopyFraming, framingPattern, renderedCopy, unnegatedReturnFraming } from './wording';

describe('wording rule check (SEC staff FAQ Q2.5)', () => {
  it('flags return-like framing, including the benefit words earn, rewards, value, increase and gain', () => {
    for (const text of [
      'Burns increase the value of FIT.',
      'Holders of T earn rewards in T or Q.',
      'Holders gain from every trade.',
      'FIT appreciates as supply falls.',
      'Fees accrue to holders.',
      'Each token is backed by the vault.',
      'Prices rise as tokens burn.',
      'The flywheel grows your balance.',
      'Upside for every holder.',
    ]) {
      expect(unnegatedReturnFraming([text]), text).toEqual([text]);
    }
  });

  it('needs the negation before the word, in the same clause', () => {
    expect(unnegatedReturnFraming(['No fees: burns grow your yield.'])).toEqual(['burns grow your yield.']);
    expect(unnegatedReturnFraming(['Nothing is promised, but holders gain value.'])).toEqual(['holders gain value.']);
    expect(unnegatedReturnFraming(['Burns grow nothing and pay no yield.'])).toEqual(['Burns grow nothing and pay no yield.']);
    expect(unnegatedReturnFraming(['They are not interest, a dividend or a return on anything.'])).toEqual([]);
    expect(unnegatedReturnFraming(['Nothing grows because someone calls these mechanisms a "flywheel": the word only names how fees move.'])).toEqual([]);
    expect(unnegatedReturnFraming(['It doesn’t mean anything will grow.'])).toEqual([]);
  });

  it('allows plain loss statements', () => {
    expect(unnegatedReturnFraming(['Any token can lose all of its value.', 'Test tokens have no value.'])).toEqual([]);
  });

  it('app copy (F23): bans earning, reward, yield, return-on, APY, growth and gain framing everywhere', () => {
    for (const text of [
      'T holders earn USDC-DEMO.',
      'Holders earn FRAME, settled from their earned WETH-DEMO.',
      'Choose what holders earn.',
      'Rewards',
      'Claim ORCHARD rewards',
      'Accrued, unclaimed',
      'T holders earn a 12% yield.',
      'A return on every trade.',
      'Holder returns this week.',
      'An APY of 12%.',
      'ROI in 30 days.',
      'Passive income for FIT holders.',
      'FIT to the moon.',
      'Burns grow the vault.',
      'Gains for Misfit owners outside the vault.',
    ]) {
      expect(unnegatedReturnFraming([text], APP_COPY_FRAMING), text).toEqual([text]);
    }
  });

  it('app copy (F23): allows the neutral mechanics wording, valuations and the verb "return"', () => {
    expect(
      unnegatedReturnFraming(
        [
          'Holder fee share paid in USDC-DEMO.',
          'Fee share credited to holders; claimable now.',
          'FIT holders. Misfit owners outside the vault.',
          'Credited in total',
          'Demo value',
          'No USD value: no USD source is adopted for test chains.',
          'What the mock account provider returns.',
          'Current return quote',
          'Last update: 12 Apr 2026, 09:30 UTC',
          'No yield, price floor or growth is predicted or promised.',
        ],
        APP_COPY_FRAMING,
      ),
    ).toEqual([]);
    expect(APP_COPY_FRAMING.flags).toBe('');
    expect(RETURN_FRAMING.flags).not.toContain('g');
  });

  it('app copy (F23): earning, reward, accrual and rate words are never excused by an earlier negation', () => {
    for (const text of [
      'No lock-up, holders earn 12% APY.',
      'It is not a loan and you earn rewards every block.',
      'Nothing to do, fees accrue daily.',
      'Never miss your rewards.',
      'No fees and a 5% APR.',
    ]) {
      expect(unnegatedReturnFraming([text], APP_COPY_FRAMING), `the negation rule alone lets "${text}" through`).toEqual([]);
      expect(appCopyFraming([text]), text).toEqual([text]);
    }
    expect(appCopyFraming(['Holders earn USDC-DEMO. No yield is predicted.', 'Fee share in USDC-DEMO'])).toEqual(['Holders earn USDC-DEMO.']);
    expect(
      appCopyFraming([
        'No yield, price floor or growth is predicted or promised.',
        'They are not interest, a dividend or a return, and they depend on trading that may not happen.',
        'Holding a pair never gives stock ownership, dividends or voting rights.',
        'Credited, unclaimed',
        'Current return quote',
        'Last update: 12 Apr 2026, 09:30 UTC',
      ]),
    ).toEqual([]);
    expect(APP_COPY_NEVER.flags).toBe('');
  });

  it('builds one pattern with any-case words and capital-only acronyms', () => {
    const pattern = framingPattern(['earn\\w*', 'price (?:rise|floor)'], ['APR']);
    expect(pattern.test('EARNINGS')).toBe(true);
    expect(pattern.test('Price Floor')).toBe(true);
    expect(pattern.test('An APR')).toBe(true);
    expect(pattern.test('12 Apr 2026')).toBe(false);
    expect(pattern.test('learn')).toBe(false);
    expect(pattern.test('earnW')).toBe(true); // `\w*` kept its meaning: only letters outside escapes change
  });

  it('reads rendered copy block by block, so one item’s negation never covers the next', () => {
    const root = document.createElement('div');
    root.innerHTML = '<ul><li>No yield is promised.</li><li>Holders earn rewards.</li></ul><p>  Plain   text </p>';
    expect(renderedCopy(root)).toEqual(['No yield is promised.', 'Holders earn rewards.', 'Plain text']);
    expect(unnegatedReturnFraming(renderedCopy(root))).toEqual(['Holders earn rewards.']);
  });

  it('also reads controls, links, options, summaries and the copy held in attributes', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<nav aria-label="Primary"><a href="/rewards">Claims</a></nav>',
      '<button type="button" title="Claim now">Claim</button>',
      '<details><summary>How claims work</summary></details>',
      '<select><option value="">Any asset</option></select>',
      '<input placeholder="Name, ticker, address" />',
      '<img alt="The Sorter" src="x.webp" />',
      '<span class="sh-reward" data-reward-side="Q">not read</span>',
    ].join('');
    expect(renderedCopy(root)).toEqual(['Claims', 'Claim', 'How claims work', 'Any asset', 'Primary', 'Claim now', 'Name, ticker, address', 'The Sorter']);
  });
});
