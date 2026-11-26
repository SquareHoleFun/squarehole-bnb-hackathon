/** M2/M3 launch entry. Validation stays in the generated twin; this module owns presentation and refresh. */
import { decodeAbiParameters } from 'viem';
import { checkSpecV2 as checkCore, DRAFT_FORMAT_V2, renderTextV2, modelForV2 } from './check-spec-v2.mjs';
import { abiOf, decodeParamsV2 } from './spec-types-v2.mjs';
import { decimalText, percentText } from './spec-model.mjs';
export * from './check-spec-v2.mjs';

const boxKind = (model, wire) => model.shapes.enums.get('BoxType').members[wire.boxType]?.name;
const pileParams = (model, wire) => boxKind(model, wire) === 'PILE' ? decodeParamsV2(model.shapes, wire.contentsParams.length === 194 ? 'PileParamsV21' : 'PileParams', wire.contentsParams) : null;
const seedListing = (model, asset) => model.menu.listings.find((l) => l.address.toLowerCase() === asset.toLowerCase());
const ownerClaims = 'Payouts are claim-only: each owner claims its own funds. Owner claims have no minimum or tip. Wallets, contracts and EIP-7702 owners use the same owner claim entry. The FIT and platform Safes claim their own fee shares.';

export function checkSpecV2(model, doc) {
  const result = checkCore(model, doc);
  if (!result.ok) return result;
  const { wire, pricing } = result;
  const P = pricing.symbol;
  const T = wire.tokenSymbol;
  result.notes.push(ownerClaims);
  const member = (name, id) => model.shapes.enums.get(name).members[id]?.name;
  const holders = ['buyers', 'sellers'].some((s) => member('Dest', wire[s].a.dest) === 'Holders');
  result.overview = result.overview.map(([label, value]) => {
    const side = label === "Buyers' fees" ? 'buyers' : label === "Sellers' fees" ? 'sellers' : null;
    if (!side) return [label, value];
    const branch = wire[side].a;
    const inT = member('Leg', branch.leg) === 'BuyT';
    const payout = inT ? T : P;
    if (member('Dest', branch.dest) === 'Eat' && member('Leg', branch.leg) === 'AsPaid') {
      value = `eat ${P}: checked burn or permanent lock after graduation`;
      result.notes.push(`Read the checked listing capability before showing Burn ${P} or Lock ${P}; never infer it from the coin name. Only successful amounts add to Eaten. Pending ${P} joins the failure pot; a refused operation leaves claims for retry.`);
    }
    if (member('Dest', branch.dest) === 'Holders') value = inT ? `to holders in ${T}, bought after graduation` : `to holders in ${P}, no conversion`;
    if (member('Dest', branch.dest) === 'Items') {
      const { insidePolicy } = decodeParamsV2(model.shapes, 'ItemsDestParams', branch.destParams);
      // One explicit description per admitted policy (Keep 1, BuyBackBurn 2, Depth 3); never a fallback to burn.
      const inside = insidePolicy === 1 ? 'keep a stash with the item'
        : insidePolicy === 2 ? (inT ? `burn ${T}` : `buy back and burn ${T}`)
          : insidePolicy === 3 ? `grow this box's own pool in ${P}${inT ? `; only outside shares buy ${T}` : ''}` : null;
      if (inside === null) throw new Error(`Items inside policy ${insidePolicy} has no launch description.`);
      value = `to every item in ${payout}; inside shares ${inside}`;
    }
    return [label, value];
  });
  const rewardsT = ['buyers', 'sellers'].some(side => wire[side].a.leg === 2 && [6, 8].includes(wire[side].a.dest));
  if (rewardsT) result.notes.push(`T rewards book the chosen 10/15 as pending ${P}. Nothing is bought before graduation. Afterwards anyone can run the same capped own-pool buy step as Burn, crediting ${T} for owner claims. Pending ${P} joins the closing pot on failure. Keep retains inside-item ${T}; BuyBackBurn burns it; Depth buys no inside-item ${T}: all held ${P} goes to this box's own pool at graduation, then the inside share in ${P} of each collection, and an unspent queue once every item is back inside, so only outside ${P} buys ${T}. T residue burns, and failed payouts remain for retry. Each item purchase uses the custody journal at purchase time; holder purchases retain the original trade history.`);
  if (holders && !rewardsT) result.notes.push(`Holders earn a share of each trade batch's net ${P}, after reserves, tips and rounding. Missed notices and non-trade money do not increase another holder's credit. Earned ${P} stays claimable after failure, without expiry, separately from the closing-price claim. A paused payout waits for retry.`);
  if (!rewardsT && ['buyers', 'sellers'].some((side) => member('Dest', wire[side].a.dest) === 'Items')) {
    result.notes.push(`Items money is held until graduation; on failure before graduation it joins the closing-price pot. Each item of this box's own collection has equal weight. Keep gives each item a base stash at graduation; BuyBackBurn uses all that side's held money to buy and burn ${T}, and Depth sends all of it to this box's own pool, both with no pre-graduation item credit.`);
    result.notes.push(`After graduation, outside items and pending draws earn equal shares of each net ${P} receipt. Keep retains inside shares as stashes; BuyBackBurn uses inside shares in this box's own pool; Depth adds inside shares to this box's own pool, as Grow does. Division remainders go to pool depth. No price coin is burned. Item payouts remain in ${P}; the ledger performs no swaps or conversions.`);
    result.notes.push(`Every royalty box requires a creator payee. Royalties and gifts reach this box's inbox: the box offers coins on its creation-time sale list for ${P} on CoW in whole lots, with no price or fill promised; the payee can take a listed coin that does not sell for 30 days, and any other coin at any time, as it is. ${P} from the inbox is booked like the buyers' fees, including their Items policy; it waits until graduation, and after failure it joins the claim pot.`);
    result.notes.push(`Only the current owner claims an item's unclaimed ${P}, to a nonzero recipient other than this box's own vault; a transfer or return preserves its credit and stash. Each draw keeps its own request record. Cancelling sends outside earnings to residue and restores its retained stash. Item claims have no expiry; a refused or paused payout preserves the credit for retry.`);
    result.notes.push('The pick-before-collect timing gap remains: an item picked just before collection can share that receipt. Fees and timing affect the result; this is not a promised return.');
  }
  const pile = pileParams(model, wire);
  if (pile) {
    const listed = seedListing(model, pile.asset);
    if (!listed || listed.retired) return { ...result, ok: false, stage: 'input', problems: [{ path: 'contentsParams.asset', message: 'The pile seed coin must be listed and offered in this release.', fix: 'Choose its address from the current menu; refresh listings before creation.' }] };
    result.overview = result.overview.map(([label, value]) => [label, label === 'Contents' ? `a pile of ${listed.symbol}` : value]);
    result.overview.push(['Pile seed', `${decimalText(pile.seedAmount, listed.decimals)} ${listed.symbol} (${pile.seedAmount} raw units), from the creator after Create`]);
    result.notes.push('To the pile books pending fees in P; after graduation anyone moves them into a pile of the same P. On failure, pending fees join the closing pot separately from the seed return. Seed is separate from the creation payment and the price coin’s raise. The creator is the recorded seeder. Anyone can trigger an exact approved ERC-20 pull from that creator; native seed requires the creator and exact value.');
    result.overview.push(['Leave behind', `${pile.leaveBehindBps ?? 0} basis points; the last redeemer takes the remaining balance`]);
    result.notes.push(pile.seedAmount === 0n ? 'A zero seed needs no loader or seed completion; it still names one listed coin other than this box’s own coin.' : 'Nonzero seed and all required chunks hold the opening gate until successful seed completion. A refused pull or completion rolls back the funding; retry after fixing it.');
    result.notes.push(`Only after graduation, redeem ${T} for floor(live ${listed.symbol} balance × coins handed in / pre-burn supply). The caller supplies and burns its own coins, with a minimum output; a refused payout rolls back the burn and can be retried. ${BigInt(pile.leaveBehindBps ?? 0) === 500n ? 'The payment is 95% of that floored share; the rest stays for remaining holders. The last holder takes all.' : 'There is no leave-behind.'}`);
    result.notes.push('On failure, only the recorded seed returns to the creator in a separate retryable call; a paused seed coin cannot block holders’ closing-price claims. Fixed-asset gifts join live redemptions, but unsolicited surplus after failure and unrelated assets remain stranded: there is no rescue.');
    result.warnings.push('Offline pile acceptance checks the saved listing only. Before Create, refresh the seed listing and price listing, and check the seed asset against the predicted box coin using the newly mined salts.');
  }
  if (member('BoxType', wire.boxType) === 'SHOP') {
    // Decode only after the generated entry accepts. No parallel shop validator.
    const [shop] = decodeAbiParameters([abiOf(model.shapes, 'ShopConfigV2')], wire.contentsParams);
    result.overview = result.overview.map(([label, value]) => [label, label === 'Contents' ? `a fixed-price shop, ${shop.collections.length} initial collections` : value]);
    result.overview.push(
      ['Shop seed', `${decimalText(shop.seedT, 18)} ${T}, from the creator's approved pull after Create`],
      ['Give prices', shop.givePricesT.map((p) => `${decimalText(p, 18)} ${T}`).join(', ')],
      ['Pick price', `${decimalText(BigInt(shop.pickBps), 4)}x the give price, rounded up; the last item stays`],
      ['Give limits', `${percentText(BigInt(shop.weeklyBps))} per week, ${percentText(BigInt(shop.collectionBps))} per collection; both have a floor of one cheapest active listed give, bounded by the frozen weekly snapshot`],
      ['Collection delay', `${BigInt(shop.listDelay) / 86400n} days`],
      ['Curator', /^0x0+$/.test(shop.curator) ? 'fixed list' : shop.curator],
    );
    result.notes.push(`The shop budget uses ${T} seed and pick receipts, never trade fees. Weekly limits use a fixed budget snapshot; unused allowance does not roll over. The curator can only add collections, at most weekly; handover takes two steps and renouncing freezes additions.`);
    result.notes.push('The seed must cover two cheapest initially listed gives, even with no starter items. The allowance floor is shared spending room, not a top-up per call; pick receipts increase next week’s snapshot only.');
    result.notes.push('Creation pulls no starter NFTs. The creator approves the shop, then loads the committed set in pages of at most 32. Seed and the full set must be ready before anyone completes the opening gate; chunks must also be ready.');
    result.notes.push(`After failure, shop ${T} stays quarantined for burn retries and never returns to the creator. Starter NFTs return only to the creator in separately retryable calls. Holder earnings remain separate.`);
  }
  return result;
}

export function renderMenuV2(model) {
  const offered = model.sources.spec.contexts[0];
  const choices = model.sources.spec.menu.choices.filter((c) => offered.offeredDests.includes(c.dest));
  const rows = [`What a format 2 box can be on ${model.menu.label} (offline draft check; no live release claimed).`, '', 'Price coins:'];
  for (const l of model.menu.listings.filter((l) => !l.retired)) rows.push(`  "${l.symbol}" ${l.label}, listing ${l.id}: raise ${decimalText(l.raise, l.decimals)} ${l.symbol}. ${(l.powers ?? []).join(' ')}`);
  rows.push('', `Fees on each side: ${choices.map((c) => ['holders', 'items'].includes(c.key) ? `to ${c.key}` : c.key === 'grow' ? 'grow the pool' : c.key).join(', ')}.`, '1% of every buy and sale, in the price coin. Of each fee: 2/15 FIT, 1/15 platform, 2/15 pool, 10/15 your choice.', 'Contents: just the token, a new collection, a fixed-price shop funded by seed and pick receipts, or a coin pile. To the pile funds a pile of the price coin after graduation. Shops use seed and pick receipts.', 'Items pay every item of the own new collection equally in the chosen price coin or box token. T choices wait as pending P until capped own-pool purchases after graduation. Inside policy: Keep (explicit default), BuyBackBurn or Depth (inside P goes to this box’s own pool), independently per side. No splits, creator caps, outside conversions or plug-ins.', `Add-ons: ${offered.offeredAddOns.map((id) => model.addOnById.get(id).key).join(', ')}.`, 'Refresh the listing before creation. If its raise changed, rebuild the spec and quote, then mine both salts again. Existing boxes keep their creation raise.');
  rows.push(ownerClaims);
  return `${rows.join('\n')}\n`;
}

/**
 * Read-only integration seam for M2-52/M3-52. Both callbacks are required; there is no offline fallback.
 * readListings({network, release, listingId, token, pileAsset?}) returns squarehole.listings/1 with fresh rows for BOTH coins when a pile is requested.
 * prepareLaunch({network, release, wire, specHash}) quotes and mines BOTH salts for the refreshed wire; for piles it also returns predictedT from that exact plan.
 * Returns a new draft and preparation; never mutates the old draft or reuses its quote/salts.
 * A preparation is not permission to sign: inclusion still checks the latest listing on chain.
 */
export async function refreshLaunchV2(model, doc, { readListings, prepareLaunch }) {
  if (typeof readListings !== 'function' || typeof prepareLaunch !== 'function') throw new Error('Fresh listing reads and quote/salt preparation are required.');
  const input = structuredClone(doc);
  // Discard only supported public bytes32 preparation fingerprints before the secret scan.
  // Malformed values and every other field still pass through the unchanged authoring checks.
  if (input?.format === DRAFT_FORMAT_V2) {
    const isFingerprint = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
    if (isFingerprint(input.specHash)) delete input.specHash;
    if (isFingerprint(input.coordinatorSalt)) delete input.coordinatorSalt;
    if (isFingerprint(input.hookSalt)) delete input.hookSalt;
  }
  const before = checkCore(model, input);
  if (!before.wire || !before.pricing) throw new Error('Fix the draft before refreshing its listing.');
  const old = before.pricing;
  const pricing = before.wire.pricing;
  if (pricing.listingId !== old.id || pricing.token.toLowerCase() !== old.address.toLowerCase()) throw new Error('The draft pricing token does not match its permanent listing identity.');
  const pile = pileParams(model, before.wire);
  if (boxKind(model, before.wire) === 'PILE' && !pile) throw new Error('Fix the pile seed tuple before refreshing.');
  const oldSeed = pile ? seedListing(model, pile.asset) : null;
  const request = { network: model.network, release: model.menu.release, listingId: old.id, token: old.address, ...(pile ? { pileAsset: pile.asset } : {}) };
  const answer = await readListings(request);
  const row = answer?.listings?.find((l) => l.id === old.id);
  if (!row) throw new Error('The fresh read omitted this price coin; no quote or salts were prepared.');
  if (row.address.toLowerCase() !== old.address.toLowerCase() || ['class', 'kind', 'decimals'].some((k) => row[k] !== old[k])) throw new Error('The fresh read changed the permanent listing identity.');
  const fresh = modelForV2({ network: model.network, twin: model.twin, sources: model.sources, curve: model.curve, shapes: model.shapes, indexer: answer });
  if (pile) {
    // Never let readMenu's offline merge stand in for a live second-coin admission read.
    const seed = answer.listings.find((l) => l.address.toLowerCase() === pile.asset.toLowerCase());
    if (!seed || seed.retired) throw new Error('The fresh read must include an offered listing for the pile seed coin.');
    if (oldSeed && (seed.address.toLowerCase() !== oldSeed.address.toLowerCase() || ['id', 'decimals', 'class', 'kind'].some((k) => seed[k] !== oldSeed[k]))) throw new Error('The fresh read changed the permanent listing identity of the pile seed coin.');
  }
  // Only draft fields survive. Any prior quote, mined salts or spec hash are intentionally discarded.
  const draft = { format: input.format, network: model.network, spec: { ...input.spec, pricing: { ...pricing }, raise: row.raise } };
  for (const key of ['brief', 'site', 'preset']) if (input[key] !== undefined) draft[key] = input[key];
  const result = checkSpecV2(fresh, draft);
  if (!result.ok) return { draft, result, preparation: null };
  const made = await prepareLaunch({ network: model.network, release: fresh.menu.release, wire: result.wire, specHash: result.specHash });
  if (made?.specHash !== result.specHash || !/^0x[0-9a-fA-F]{64}$/.test(made.coordinatorSalt) || !/^0x[0-9a-fA-F]{64}$/.test(made.hookSalt) || !made.quote) throw new Error('The fresh quote and both salts must bind the refreshed spec hash.');
  if (pile && (!/^0x[0-9a-fA-F]{40}$/.test(made.predictedT) || /^0x0{40}$/i.test(made.predictedT) || made.predictedT.toLowerCase() === pile.asset.toLowerCase())) throw new Error('The pile seed must differ from the nonzero predicted own box coin.');
  return { draft, result, preparation: { specHash: made.specHash, quote: made.quote, coordinatorSalt: made.coordinatorSalt, hookSalt: made.hookSalt, ...(pile ? { predictedT: made.predictedT } : {}) } };
}

export { renderTextV2 };
