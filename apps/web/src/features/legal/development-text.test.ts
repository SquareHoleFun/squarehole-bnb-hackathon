import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRIVACY_NOTICE, STORED_ON_DEVICE } from './privacy';
import { TERMS_DATE, TERMS_DATE_TEXT, TERMS_DOCUMENT, TERMS_GATE, TERMS_VERSION } from './terms';

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * SH-V2-FE7 keeps the development build's legal texts as they are: the gate, the Terms and the privacy notice, down to
 * the last character. A change to the development text is a counsel matter with a new TERMS_VERSION; update the hash
 * with it. SH-V2-FE8 (F130, founder 2026-10-11: no Demo mention anywhere in the UI) made draft-6: draft-5 as it stood
 * at 6e1f59b5 (FE6) with the sample data named for what it is instead of "Demo" (the gate's status bullet, 3.1, 5.3
 * (c) (f) (g), Read this first) and the privacy notice's two tab-only keys renamed (sh.boxes.sample-created.v1,
 * sh.sample-tx-scenario). These hashes were taken from that change. SH-V2-FE10 (F135, the silent reconnect) adds one
 * stored item, `sh.wallet.connected.v1`, to the list both notices show; the notice's own text is unchanged. SH-V2-FE11 made
 * draft-7: 5.2(c) takes production draft-3's F135 sentence, and 5.3(f), 5.13(f), 11.2 and the gate's fee bullet describe
 * the test boxes this build shows instead of the first handoff's test pairs (off since F134 R46B). The Terms hash below
 * was taken from that change; the privacy notice is unchanged. SH-TA-22 (Create sends on a real build) adds one tab-only
 * stored item, `sh.create.send.v2`, to the list; the notice's own text is unchanged, and the privacy hash is that change's.
 * LINKS-WEB (F148, docs/design/box-links-v2.md § 5 "Privacy") changes the notice's text: the summary's "except links you
 * sign for a box you made" and the "Box links" line, the design's wording for the founder and counsel to review; the
 * privacy hash is that change's. The Terms and TERMS_VERSION are unchanged (nobody accepts the privacy notice).
 * SH-ARWEAVE-PICTURES-WEB adds one more tab-only stored item, `sh.create.v2.arweave`; the notice's own text is unchanged
 * (this build keeps no picture on Arweave unless SH_ARWEAVE_PICTURES=1), and the privacy hash is that change's.
 * SH-192 (BOXSPEC-AUTOSAVE) adds one stored item, the IndexedDB copy of each created box's reveal data
 * (`sh.reveal.keep.v1`), wording for the founder and counsel to review; the notice's own text is unchanged, and the
 * privacy hash is that change's. SH-192 af1 (c6ef497bf, "the privacy list is complete") adds one tab-only stored item,
 * `sh.create.collection-cover.v2`, names the secret salts in `sh.create.art.v2` and says when `sh.reveal.keep.v1` is
 * removed (after a confirmed unsent attempt, or once every item is revealed, checked while the app is open); the
 * notice's own text is unchanged, and the privacy hash is that change's. SH-203 adds one stored item, the IndexedDB
 * journal of the reveal run (`squarehole-reveal-run-v2`, written by SH-202's reveal-indexeddb.ts), working wording for the
 * founder and counsel to review (docs/evidence/SH-203.md); the notice's own text is unchanged. SH-203 af1 says what the
 * journal really keeps (attempts before the wallet is asked, refusals, sends with or without an id, blocks and results,
 * the release wait's times); the privacy hash is that change's. SH-241 (F201, the founder's approved wording) changes
 * the notice's text: the Sepolia providers are "PublicNode and Tenderly", since the third left the site's endpoint list
 * (SH-240); the privacy hash is that change's. The Terms and TERMS_VERSION are unchanged (nobody accepts the privacy notice).
 */
describe('the development legal texts (draft-7 since FE11)', () => {
  it('keep the gate, the Terms and their version byte for byte', () => {
    expect(sha256({ version: TERMS_VERSION, date: TERMS_DATE, dateText: TERMS_DATE_TEXT, gate: TERMS_GATE, document: TERMS_DOCUMENT })).toBe('f77887e71ba6e7a9051b7a949041e9d2ab34c9881dc91efb37d3317ede2a2333');
  });

  it('keep the privacy notice and its stored items byte for byte', () => {
    expect(sha256({ notice: PRIVACY_NOTICE, stored: STORED_ON_DEVICE })).toBe('e799d27dadaffbb353eb4072a857f84cc6d6f2121d2dfdfc708e3f0fc9a7d8bd');
  });
});
