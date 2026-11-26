/**
 * F74 U1: holder payouts are never offered on mainnet, structurally (SH-F74-polish item 1). The generator runs
 * `holderOfferProblems` on the source files (scripts/lib/model.mjs); here each way a source could offer a holder payout
 * on mainnet is planted in a copy and must be named.
 */
import { describe, expect, it } from 'vitest';
import addOnCatalog from '../add-ons.v1.json';
import boxSpecSource from '../box-spec.v1.json';
import { holderOfferProblems, isHolderMember } from '../scripts/lib/holder-guard.mjs';

type Json = Record<string, unknown> & { enums: { name: string; members: { name: string; kind?: string; offeredOn?: string[]; pending?: string }[] }[] };
type Spec = Json & { fields: { name: string; enum?: string; check: { offered?: string[] } }[] };
type Catalog = Json & { addOns: { key: string; params: { name: string; enum?: string; offered?: string[] }[] }[] };

const fresh = (): { spec: Spec; catalog: Catalog } => ({ spec: structuredClone(boxSpecSource) as unknown as Spec, catalog: structuredClone(addOnCatalog) as unknown as Catalog });
/** The planted copy's part, or a thrown error (the source files changed shape). */
function found<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}`);
  return value;
}
const field = (spec: Spec, name: string) => found(spec.fields.find((f) => f.name === name), `field ${name}`);
const capExcess = (catalog: Catalog) => found(found(catalog.addOns.find((a) => a.key === 'creator-fee-cap'), 'add-on 5').params.find((p) => p.name === 'excess'), 'excess');
const member = (doc: Json, enumName: string, name: string) => found(found(doc.enums.find((e) => e.name === enumName), enumName).members.find((m) => m.name === name), name);
const offeredOf = (list: { offered?: string[] }) => {
  list.offered ??= [];
  return list.offered;
};

describe('holder payouts never on mainnet (F74 U1, the generator guard)', () => {
  it('passes the source files as they are', () => {
    const { spec, catalog } = fresh();
    expect(holderOfferProblems(spec, catalog)).toEqual([]);
  });

  it('knows every holder member, the cap excess included', () => {
    const { spec, catalog } = fresh();
    const holders = [...spec.enums, ...catalog.enums].flatMap((e) => e.members.filter(isHolderMember).map((m) => `${e.name}.${m.name}`));
    expect(holders).toEqual(['QStream.PAY_HOLDERS_Q', 'QStream.HOLDERS_IN_T', 'TStream.PAY_HOLDERS_T', 'TStream.HOLDERS_IN_Q', 'CapExcess.HOLDERS']);
  });

  it.each([
    ['qStream', 'QStream', 'PAY_HOLDERS_Q'],
    ['qStream', 'QStream', 'HOLDERS_IN_T'],
    ['tStream', 'TStream', 'PAY_HOLDERS_T'],
    ['tStream', 'TStream', 'HOLDERS_IN_Q'],
  ])("refuses %s's offered list with %s.%s, with or without its offeredOn", (fieldName, enumName, name) => {
    for (const keepOfferedOn of [true, false]) {
      const { spec, catalog } = fresh();
      offeredOf(field(spec, fieldName).check).push(name);
      if (!keepOfferedOn) {
        const m = member(spec, enumName, name);
        delete m.offeredOn;
        delete m.pending;
      }
      expect(holderOfferProblems(spec, catalog)).toEqual([`field ${fieldName}: offered lists the holder payout ${enumName}.${name}`]);
    }
  });

  it.each([
    ['qStream', 'QStream', 'PAY_HOLDERS_Q, HOLDERS_IN_T'],
    ['tStream', 'TStream', 'PAY_HOLDERS_T, HOLDERS_IN_Q'],
  ])('refuses %s with no offered list: a missing list offers every %s member, not none (F74 polish review)', (fieldName, enumName, holders) => {
    const { spec, catalog } = fresh();
    delete field(spec, fieldName).check.offered;
    expect(holderOfferProblems(spec, catalog)).toEqual([`field ${fieldName}: no offered list, so every ${enumName} member is offered, ${holders} included`]);
  });

  it("refuses the creator-fee cap's excess offering CapExcess.HOLDERS, or offering every member", () => {
    const listed = fresh();
    offeredOf(capExcess(listed.catalog)).push('HOLDERS');
    expect(holderOfferProblems(listed.spec, listed.catalog)).toEqual(['add-on creator-fee-cap.excess: offered lists the holder payout CapExcess.HOLDERS']);
    const unlisted = fresh();
    delete capExcess(unlisted.catalog).offered;
    expect(holderOfferProblems(unlisted.spec, unlisted.catalog)).toEqual(['add-on creator-fee-cap.excess: no offered list, so every CapExcess member is offered, HOLDERS included']);
  });

  it('refuses an offeredOn that names mainnet, and a holder named so under another fee kind', () => {
    const early = fresh();
    member(early.spec, 'TStream', 'PAY_HOLDERS_T').offeredOn = ['demo', 'mainnet'];
    member(early.catalog, 'CapExcess', 'HOLDERS').offeredOn = ['mainnet'];
    expect(holderOfferProblems(early.spec, early.catalog)).toEqual(['TStream.PAY_HOLDERS_T: offeredOn names mainnet', 'CapExcess.HOLDERS: offeredOn names mainnet']);
    const renamed = fresh();
    member(renamed.spec, 'QStream', 'HOLDERS_IN_T').kind = 'CREATOR';
    expect(holderOfferProblems(renamed.spec, renamed.catalog)).toEqual(['QStream.HOLDERS_IN_T: a holder member\'s kind is HOLDERS, not CREATOR']);
  });
});
