import { DRAFT_FEE_TERMS } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import {
  GATE_FREE_PATHS,
  PRIVACY_PATH,
  RESTRICTED_COUNTRIES,
  TERMS_DOCUMENT,
  TERMS_GATE,
  TERMS_PATH,
  TERMS_SECTIONS,
  TERMS_VERSION,
  allTermsText,
  eligibilityBullet,
  joinOr,
  restrictedCountryClause,
} from './terms';
import { isGateFree } from './TermsGate';
import { appCopyFraming, unnegatedReturnFraming } from './wording';

const section = (n: string) => TERMS_SECTIONS.find((candidate) => candidate.n === n);
const clause = (n: string) => section(n.split('.')[0] ?? '')?.clauses.find((candidate) => candidate.n === n);
const item = (n: string, letter: string) => clause(n)?.items?.find((candidate) => candidate.text.startsWith(`(${letter})`))?.text ?? '';
const allText = () => allTermsText().join(' ');

describe('Terms of Use content (F19, v2 rewrite F23–F30)', () => {
  it('has a dated draft version and the gate-free routes', () => {
    // draft-7 (SH-V2-FE11): F135's silent reconnect in 5.2(c); the test boxes, not the old test pairs; everyone accepts again.
    expect(TERMS_VERSION).toBe('2026-10-11-draft-7');
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-draft-\d+$/);
    expect(TERMS_DOCUMENT.versionLine).toBe(`Version ${TERMS_VERSION} · Draft of 11 October 2026`);
    expect(TERMS_DOCUMENT.status).toBe('DRAFT pending legal review. It may change, and you will be asked to accept the final version.');
    expect(TERMS_GATE.status).toBe('Draft Terms, not yet reviewed by a lawyer.');
    // Users are asked to accept this text, so it never calls itself "not in force"; "not legal advice" is an internal note.
    expect(allText()).not.toMatch(/not in force|not legal advice/i);
    expect(GATE_FREE_PATHS).toEqual([TERMS_PATH, '/about/risks', PRIVACY_PATH]);
    expect(PRIVACY_PATH).toBe('/about/privacy');
    expect(isGateFree('/about/terms')).toBe(true);
    expect(isGateFree('/about/terms/')).toBe(true);
    expect(isGateFree('/about/risks')).toBe(true);
    expect(isGateFree('/about/privacy')).toBe(true);
    expect(isGateFree('/')).toBe(false);
    expect(isGateFree('/about/termsx')).toBe(false);
    expect(isGateFree('/about/privacyx')).toBe(false);
    expect(isGateFree('/settings')).toBe(false);
  });

  it('numbers sections 1 to 18 in order, with unique anchors and clause numbers under their section', () => {
    expect(TERMS_SECTIONS.map((section) => section.n)).toEqual(Array.from({ length: 18 }, (_, index) => String(index + 1)));
    expect(new Set(TERMS_SECTIONS.map((section) => section.id)).size).toBe(18);
    for (const section of TERMS_SECTIONS) {
      expect(section.id).toBe(`terms-${section.n}`);
      const numbers = section.clauses.flatMap((clause) => (clause.n ? [clause.n] : []));
      expect(new Set(numbers).size, section.n).toBe(numbers.length);
      for (const n of numbers) expect(n.startsWith(`${section.n}.`), n).toBe(true);
    }
    expect(section('5')?.clauses.flatMap((clause) => (clause.n ? [clause.n] : []))).toEqual(
      Array.from({ length: 16 }, (_, index) => `5.${index + 1}`),
    );
  });

  it('points every internal cross-reference at a clause (and item) that exists', () => {
    const references = new Set<string>();
    for (const text of allTermsText()) {
      // "5.8", "5.13(b)", "(5.4(e))", "Section 5.3", "Sections 5.1 to 5.3": a section number followed by a clause number.
      for (const match of text.matchAll(/(?<![\d.])(\d{1,2})\.(\d{1,2})(?:\(([a-z])\))?(?![\d.]\d)/g)) references.add(match[0]);
    }
    const missing = [...references].filter((reference) => {
      const [, n, letter] = /^(\d{1,2}\.\d{1,2})(?:\(([a-z])\))?$/.exec(reference) ?? [];
      if (!n || !clause(n)) return true;
      return letter !== undefined && item(n, letter) === '';
    });
    // 4,206,980,085 wei, 0.0015 ETH, 0.168 ETH, 0.1% and 0.07% are amounts, not references (no section is numbered 0).
    expect(missing.filter((reference) => !/^(0\.|4\.20)/.test(reference))).toEqual([]);
    expect(references.has('5.13(b)')).toBe(true);
    expect(references.has('5.4(e)')).toBe(true);
  });

  it('builds the restricted-country text of the gate and of §4.2(a) from one list', () => {
    expect(RESTRICTED_COUNTRIES.map((country) => country.short)).toEqual(['the US', 'Canada', 'the UK']);
    expect(TERMS_GATE.bullets[2]).toBe('Not for anyone under 18, anyone in or from the US, Canada or the UK, or anyone sanctioned or in a sanctioned place.');
    expect(clause('4.2')?.items?.[0]?.text).toBe(restrictedCountryClause());
    expect(restrictedCountryClause()).toContain('uses the Services from the United States, Canada or the United Kingdom, or is organised or based there');
    expect(restrictedCountryClause()).toContain('[COUNSEL: confirm this list]');
  });

  it('follows a changed list in both texts (the founder decision is one edit)', () => {
    const eu = [...RESTRICTED_COUNTRIES, { name: 'the European Union', short: 'the EU' }];
    expect(eligibilityBullet(eu)).toContain('anyone in or from the US, Canada, the UK or the EU,');
    expect(restrictedCountryClause(eu)).toContain('the United States, Canada, the United Kingdom or the European Union');
    expect(eligibilityBullet([])).toBe('Not for anyone under 18, or anyone sanctioned or in a sanctioned place.');
    expect(restrictedCountryClause([])).toContain('No country is listed at present');
    expect(joinOr(['a'])).toBe('a');
    expect(joinOr(['a', 'b'])).toBe('a or b');
    expect(joinOr([])).toBe('');
  });

  it('asks visitors to declare eligibility themselves and blocks no IP or location (F30 Q8)', () => {
    expect(TERMS_GATE.checkbox).toBe('I have read and agree to the Square Hole Terms of Use, and I confirm that I am at least 18 and not a Restricted User.');
    expect(clause('4.4')?.text).toContain('We do not block access by IP address or location.');
    expect(clause('4.4')?.text).toContain('you confirm that you are at least 18 and not a Restricted User');
    expect(allText()).not.toMatch(/decide whether to add location-based blocking|including a location block/i);
  });

  it('never presents burns, buybacks, the stream or fee shares as yield, return, profit, value or growth (SEC staff FAQ Q2.5)', () => {
    const text = allText();
    expect(text).not.toMatch(/\bAPY\b|\bAPR\b|passive income|number go up|to the moon|deflationary/i);
    expect(text).not.toMatch(/all fees are burned/i);
    // Every clause that names a return-like outcome (wording.ts: yield, return, profit, value, gain, increase, earn,
    // rewards, growth, a flywheel, backed…) negates it before that word.
    expect(unnegatedReturnFraming(allTermsText())).toEqual([]);
    // The app-wide rule too: earn, rewards and accrual are never used, not even negated.
    expect(appCopyFraming(allTermsText())).toEqual([]);
  });

  it('carries no V7 vocabulary: no swap-back, no tiers, and minting only where it is denied (Fable review R-22)', () => {
    const text = allText();
    expect(text).not.toMatch(/swap[- ]?backs?/i);
    expect(text).not.toMatch(/\btiers?\b/i);
    expect(text).not.toMatch(/shelf/i);
    expect(unnegatedReturnFraming(allTermsText(), /\bmint\w*/i)).toEqual([]);
    // The vault action is "give back" here: the Terms check flags the word "return" everywhere.
    expect(item('5.8', 'd')).toMatch(/^\(d\) \*\*Give back\.\*\*/);
  });

  it('says what nobody promises about the mechanisms (5.13(e)) and that the gate promises nothing', () => {
    const promises = item('5.13', 'e');
    expect(promises).toContain('A burn only lowers the number of tokens that exist. It pays nobody and gives nobody a right to anything.');
    expect(promises).toContain('Nobody promises that burns will happen, how large or how frequent they will be, or that they will bring profit, yield, return, income, a price rise or price support.');
    expect(promises).toContain('Market prices can fall to zero however many tokens are burned.');
    expect(TERMS_GATE.bullets.join(' ')).toContain('Burns are not a promise, and no one owes you anything because of them.');
    expect(TERMS_GATE.bullets.join(' ')).toContain('Holding FIT pays you nothing.');
    expect(TERMS_GATE.bullets[0]).toBe('Nothing here is an offer, a recommendation or advice.');
    // The app takes wallet transactions (5.1), so nothing calls the Services "information only".
    expect(allText()).not.toMatch(/information only/i);
  });

  it('separates the build of today (5.1 to 5.3) from the planned design (5.4 to 5.16) and matches the build’s fee split', () => {
    const today = item('5.3', 'f');
    // draft-7: the build shows core v2 test boxes (1% of every buy and every sale, V2BoxPage.tsx), not the first
    // handoff's 3% test pairs (DRAFT_FEE_TERMS), which no page shows since F134 R46B.
    expect(DRAFT_FEE_TERMS.headlineFeeTargetBps).toBe(300);
    expect(allText()).not.toMatch(/test pairs?\b|draft fee of 3%|draft 3%/);
    expect(today).toContain('The boxes this build shows on a local chain or on Sepolia are test deployments of the current box contracts');
    expect(today).toContain('to the box’s creator, to the addresses that hold its token or to the owners of its items');
    expect(today).toContain('not the planned design in 5.4 to 5.16');
    const services = section('5')?.clauses ?? [];
    const planned = services.findIndex((candidate) => candidate.text.startsWith('**Planned design (not deployed).**'));
    expect(services[planned - 1]?.n).toBe('5.3');
    expect(services[planned + 1]?.n).toBe('5.4');
    expect(item('5.13', 'f')).toContain('On the test boxes of 5.3(f), a contract credits part of each fee as the box’s fee choices say.');
    expect(clause('11.2')?.text).toContain('Today’s test boxes charge 1% of every buy and every sale, split as each box’s page shows (5.3(f)).');
    expect(TERMS_GATE.bullets[4]).toContain('on today’s test boxes, part can be credited to holders');
    expect(TERMS_GATE.bullets[5]).toBe('Right now this is a test build: sample data or test chains only, nothing on mainnet. Test tokens have no value and give no right to any future token.');
  });

  it('5.2(c) says what F135 does: a remembered browser wallet is asked, without opening it, on the next visit (draft-7)', () => {
    const accounts = item('5.2', 'c');
    expect(accounts).toContain('Browsing never opens your wallet or asks you to approve anything.');
    expect(accounts).toContain('asks that wallet, without opening it, whether it still shares your address; Disconnect makes it forget.');
    expect(allText()).not.toContain('Browsing never asks your wallet for anything');
  });

  it('says the test build gives no right to any future token or allocation (Fable review S1)', () => {
    expect(item('5.3', 'g')).toBe(
      '(g) Using the Services, the sample data, a test network or a test token gives you no right to any future token, NFT, allocation or airdrop. Nothing you do on a test network carries over to a production network.',
    );
    // F130: the sample data is described, never labelled "Demo".
    expect(item('5.3', 'c')).toBe('(c) The sample data (a data source in Settings) is invented data at a fixed time. It shows no real launches, prices or balances.');
    expect(allText()).not.toMatch(/\bdemo\b/i);
    expect(TERMS_DOCUMENT.readFirst.bullets.join(' ')).toContain('using them gives no right to any future token or allocation');
  });

  it('describes FIT as issued once, with public burns and no payouts to holders (F24 a, F26 1–2)', () => {
    expect(item('5.4', 'b')).toContain('FIT is created once, at launch: 1,000,000,000 FIT. The FIT contract has no function to create more');
    expect(item('5.4', 'c')).toContain('Anyone may burn their own FIT.');
    expect(item('5.4', 'c')).toContain('FIT sent to a "dead" address such as 0x…dEaD is not burned: it still counts in the supply.');
    expect(item('5.4', 'e')).toBe('(e) **FIT holders receive no payouts.** No fee, burn or other mechanism pays or credits anything to anyone because they hold FIT.');
    expect(item('5.10', 'e')).toBe('(e) FIT holders receive nothing from the stream (5.4(e)).');
  });

  it('states the completion rule, graduation, outside liquidity and the reduced fee share plainly (F40 L3; security review 2026-09-30)', () => {
    const text = allText();
    // The contracts have no buy gate: nothing may promise a buying pause.
    expect(text).not.toMatch(/buying pauses/i);
    const completion = item('5.6', 'f');
    expect(completion).toContain('The curve counts as complete when a block ends with the price at, or past, the target');
    expect(completion).toContain('the curve reopens');
    expect(completion).toContain('A completed curve is not sold out for good.');
    expect(completion).toContain('(currently proposed: 600 ticks, about 0.168 ETH)');
    const graduation = item('5.7', 'a');
    expect(graduation).toContain('32 blocks (about 6.4 minutes)');
    expect(graduation).toContain('within about 0.1% of the target');
    expect(item('5.7', 'b')).toContain('99% of the ETH the curve holds');
    const outside = item('5.7', 'e');
    expect(outside).toMatch(/^\(e\) \*\*Outside liquidity\.\*\*/);
    expect(outside).toContain('From 32 blocks after graduation, anyone can add their own liquidity');
    expect(outside).toContain('cannot be changed, withdrawn or collected from for 32 blocks after it was last added to');
    expect(outside).toContain('People who add liquidity keep the fees their liquidity collects.');
    expect(outside).toContain('only the part collected by Square Hole’s own positions, and it is smaller when others add liquidity');
    expect(outside).toContain('starts its 32 blocks again whenever anyone adds to it');
    expect(item('5.10', 'a')).toContain('collected by Square Hole’s own positions');
    expect(item('5.13', 'a')).toContain('collected by Square Hole’s own positions');
    expect(clause('11.2')?.text).toContain('keep the part of the fee their liquidity collects (5.7(e))');
    expect(item('6.1', 't')).toContain('falls when others add liquidity');
  });

  it('places the collection in the vault before launch and opens withdrawals only at graduation (F30 Q3)', () => {
    expect(item('5.5', 'a')).toContain('is created before the pre-market opens, and every Misfit is placed in the vault at once');
    expect(item('5.5', 'a')).toContain('no Misfit can leave the vault before graduation (5.7)');
    expect(item('5.5', 'a')).toContain('(currently planned: 4,200 NFTs, each called a "Misfit")'); // F35
    expect(item('5.6', 'a')).toContain('(currently proposed: 798,137,969.32 FIT, just under 80%)'); // F40 (L6)
    expect(item('5.6', 'a')).toContain('(currently proposed: exactly 4.206980085 ETH)');
    // The pool share is the rest of the issuance: 1,000,000,000 − 798,137,969.32 = 201,862,030.68 FIT (FitLaunchShape).
    expect(item('5.7', 'b')).toContain('The rest of the FIT supply (currently proposed: 201,862,030.68 FIT, just over 20%)');
    expect(allText()).not.toMatch(/currently proposed: 20%/);
    expect(allText()).not.toMatch(/10,000 NFTs/);
    expect(item('5.5', 'b')).toContain('committed on chain by its hash, so it cannot be changed afterwards');
    expect(item('5.7', 'c')).toBe('(c) From graduation on, Misfits can be taken out of the vault (5.8).');
    expect(item('5.6', 'd')).toContain('the Misfits stay in the vault and can never be taken out');
    expect(clause('5.8')?.text).toBe('**The vault after graduation.**');
  });

  it('describes the lock/release vault: one quote, equal weight, flat burned fees 1% / 25% / 5%, the last Misfit stays (F23 A1, C3)', () => {
    expect(item('5.8', 'a')).toContain('the FIT that exists and is not locked in the escrow, divided by the number of Misfits in the vault');
    expect(item('5.8', 'a')).toContain('Every Misfit counts the same, whatever its art, rarity or number.');
    expect(item('5.8', 'b')).toContain('You lock FIT equal to the quote in the escrow and pay a draw fee (currently 1% of the quote), which is burned.');
    expect(item('5.8', 'c')).toContain('pay a premium (currently 25% of the quote), which is burned');
    expect(item('5.8', 'c')).toContain('A Misfit that has not been revealed can never be picked by name.');
    expect(item('5.8', 'd')).toContain('releases FIT equal to the quote from the escrow to you, less a give-back fee (currently 5% of the quote), which is burned');
    expect(item('5.8', 'e')).toContain('It stays in the escrow and is released only when someone gives a Misfit back, to that person.');
    expect(item('5.8', 'f')).toContain('They do not change with rarity, with a Misfit’s number, or with how many Misfits have been given back.');
    expect(item('5.8', 'g')).toBe('(g) **The last Misfit** can never leave the vault.');
    expect(item('5.8', 'h')).toContain('Every burn of FIT, by anyone, lowers the quote.');
    expect(clause('11.3')?.text).toBe(
      '**Vault fees.** The draw fee (currently 1% of the quote), the named-pick premium (currently 25% of the quote) and the give-back fee (currently 5% of the quote) are paid in FIT and burned. They are flat: they do not change with rarity, with a Misfit’s number, or with how many Misfits have been given back.',
    );
  });

  it('describes placeholders revealed later in batches by a random number, with the mechanism still open (F30 Q4)', () => {
    expect(item('5.9', 'a')).toContain('the same placeholder as every other unrevealed Misfit');
    expect(item('5.9', 'a')).toContain('Everyone who draws one receives one alike.');
    expect(item('5.9', 'b')).toContain('Reveals happen later, in batches. For each batch, a random number decides');
    expect(item('5.9', 'b')).toContain('[FOUNDER + ENGINEERING: the final reveal mechanism');
    expect(item('6.1', 'f')).toContain('Until its reveal, a Misfit is a placeholder');
  });

  it('describes the per-Misfit stream as mechanics only (F23 A3, F30 Q5)', () => {
    expect(item('5.10', 'b')).toContain('The share of each Misfit inside the vault is burned. The share of each Misfit outside the vault is credited to the address that owns that Misfit');
    expect(item('5.10', 'd')).toContain('It is not income, interest, a dividend or a return on anything');
    expect(item('5.10', 'd')).toContain('Square Hole pays nothing: only the contract does, and it can fail.');
    expect(item('6.1', 's')).toContain('usually very small');
  });

  it('states the pool fee split and the sniper fee to the treasury (F23 C3, C5; F30 Q6)', () => {
    expect(item('5.13', 'a')).toContain('2/15 (about 13%) goes to the Square Hole treasury, and 13/15 funds the buy-and-burn of FIT');
    expect(clause('11.2')?.text).toContain('the Square Hole pool charges a fee on every trade (currently 1%), in the coin paid in');
    expect(clause('11.2')?.text).toContain('Of the ETH part, 2/15 (about 13%) goes to the Square Hole treasury, and 13/15 buys FIT in the pool and burns it (5.13).');
    expect(item('5.13', 'b')).toContain('start higher and fall block by block to the normal pool fee. The extra part goes to the Square Hole treasury, not to the burn.');
    expect(item('5.13', 'b')).toContain('(F30 Q6, design pending)');
    // The caller payment is not built (Fable review R-03, R-19): no promise, an open item instead.
    expect(allText()).not.toMatch(/pays its caller/i);
    expect(item('5.13', 'c')).toContain('[FOUNDER + ENGINEERING: whether callers receive anything towards gas.]');
  });

  it('refuses direct sends and discloses what cannot be refused (F24 d, F25 3)', () => {
    expect(item('5.11', 'a')).toContain('The Misfits contract refuses a Misfit sent to the vault other than by the give-back action');
    expect(item('5.11', 'a')).toContain('The FIT contract is designed to refuse FIT sent to the vault or to the FIT contract itself.');
    expect(item('5.11', 'a')).toContain('[ENGINEERING: the FIT refusal is not built yet');
    expect(item('5.11', 'b')).toContain('can be lost for good. Nobody, including Square Hole, can recover it.');
  });

  it('keeps entity, address, governing law and arbitration as placeholders, and names the bought domains (F30)', () => {
    expect(clause('1.1')?.text).toContain('[COUNSEL: legal entity name, legal form, registered address and company number; no entity is formed yet]');
    expect(clause('18.2')?.text).toContain('StonkFun gives its legal name only on request');
    expect(section('16')?.clauses[0]?.text).toContain('[COUNSEL: governing law');
    expect(clause('15.2')?.text).toContain('[COUNSEL: whether disputes go to binding arbitration');
    expect(clause('1.2')?.text).toContain('squarehole.xyz, squarehole.fit and squarehole.fun');
    expect(clause('1.2')?.text).toContain('[FOUNDER: confirm the official addresses once they serve the site]');
    expect(clause('1.3')?.text).toContain('You accept these Terms when you tick the box and select Accept. If you do not accept them');
    expect(clause('1.3')?.text).toContain('[COUNSEL: whether using the Services without that step should also count as acceptance.]');
    expect(clause('17.6')?.text).toContain('(/about/privacy)');
  });

  it('is frozen all the way down', () => {
    expect(Object.isFrozen(TERMS_GATE)).toBe(true);
    expect(Object.isFrozen(TERMS_GATE.bullets)).toBe(true);
    expect(Object.isFrozen(TERMS_SECTIONS)).toBe(true);
    expect(Object.isFrozen(section('5')?.clauses)).toBe(true);
    expect(Object.isFrozen(section('6')?.clauses[0]?.items)).toBe(true);
    expect(Object.isFrozen(TERMS_DOCUMENT.readFirst.bullets)).toBe(true);
    expect(Object.isFrozen(RESTRICTED_COUNTRIES[0])).toBe(true);
  });

  it('uses only balanced **bold** marks and closed placeholders', () => {
    for (const text of allTermsText()) {
      expect(text.split('**').length % 2, text).toBe(1);
      expect((text.match(/\[/g) ?? []).length, text).toBe((text.match(/\]/g) ?? []).length);
    }
  });

  it('keeps words the browser audits forbid in controls out of the gate controls', () => {
    const controls = [TERMS_GATE.checkbox, TERMS_GATE.accept, TERMS_GATE.decline, TERMS_GATE.reviewAgain, TERMS_GATE.fullTermsLink];
    for (const label of controls) expect(label, label).not.toMatch(/\b(buy|sell|swap)\b|amount/i);
    for (const section of TERMS_SECTIONS) expect(section.title, section.title).not.toMatch(/\b(buy|sell|swap)\b/i);
  });
});
