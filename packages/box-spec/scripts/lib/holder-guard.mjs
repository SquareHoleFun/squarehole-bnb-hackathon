/**
 * F74 U1's structural guard: holder payouts are never offered on mainnet. Mainnet offers exactly what validate() offers:
 * a core enum field's `offered` list and an add-on enum parameter's `offered` list (read strictly: a missing list offers
 * every member). So a holder member may never sit in such a list, a field or parameter whose enum has a holder member
 * must list what it offers, and no holder member's `offeredOn` may name mainnet. Pure (no file access): the generator runs it on the
 * source files (model.mjs) and the tests on planted copies (holder-guard.test.ts).
 */

/** A holder payout: fee kind HOLDERS, or HOLDERS in its name (the creator-fee cap's CapExcess.HOLDERS has no fee kind). */
export const isHolderMember = (member) => member.kind === 'HOLDERS' || /(^|_)HOLDERS(_|$)/.test(member.name);

/** Every way the source would offer a holder payout on `strictest` (mainnet): one line each, none when it never does. */
export function holderOfferProblems(spec, catalog, strictest = 'mainnet') {
  const problems = [];
  const enums = new Map([...spec.enums, ...(catalog.enums ?? [])].map((e) => [e.name, e]));
  const holdersOf = (enumName) => new Set((enums.get(enumName)?.members ?? []).filter(isHolderMember).map((m) => m.name));
  for (const e of enums.values()) {
    for (const m of e.members) {
      if (!isHolderMember(m)) continue;
      if (m.kind !== undefined && m.kind !== 'HOLDERS') problems.push(`${e.name}.${m.name}: a holder member's kind is HOLDERS, not ${m.kind}`);
      if ((m.offeredOn ?? []).includes(strictest)) problems.push(`${e.name}.${m.name}: offeredOn names ${strictest}`);
    }
  }
  // A core field and an add-on parameter alike: a missing `offered` list is read as offering every member (strict), never
  // as offering none, so a holder enum must always say what it offers (F74 polish review).
  const offeredProblems = (where, enumName, offered) => {
    const holders = holdersOf(enumName);
    if (holders.size === 0) return;
    if (offered === undefined) {
      problems.push(`${where}: no offered list, so every ${enumName} member is offered, ${[...holders].join(', ')} included`);
      return;
    }
    for (const name of offered) {
      if (holders.has(name)) problems.push(`${where}: offered lists the holder payout ${enumName}.${name}`);
    }
  };
  for (const f of spec.fields) {
    if (f.enum) offeredProblems(`field ${f.name}`, f.enum, f.check?.offered);
  }
  for (const a of catalog.addOns) {
    for (const p of a.params) {
      if (p.enum) offeredProblems(`add-on ${a.key}.${p.name}`, p.enum, p.offered);
    }
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------ format 2 (M1-11)

/**
 * Format 2 (box-spec-v2-draft.md § 9 item 7): no network gate any more (F86 E); a release refuses what it has not
 * built, and holder payouts are built in M2 (F95 R19I). So an M1 release (its name ends in "-m1") must not offer the
 * `Holders` destination, and the note says "with M2", never "pending legal review".
 */
export function holderOfferProblemsV2(release) {
  const early = /-m1$/.test(release.name) && (release.offered?.dests ?? []).includes('Holders');
  return early ? [`release ${release.name} offers Holders before M2 builds it`] : [];
}

/** What the skill and the menu say about holder payouts while the release does not offer them, else null. */
export const holderNoteV2 = (release) => ((release.offered?.dests ?? []).includes('Holders') ? null : 'Holder payouts come with M2.');
