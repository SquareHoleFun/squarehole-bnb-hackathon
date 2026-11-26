import { readFileSync } from 'node:fs';
import { loadExamples } from '../../../packages/box-spec/examples/v2/registry.mjs';

// Only public recipe and kit documentation is read. Never read hidden assignments or reveal files here.
const repo = new URL('../../../', import.meta.url);
const guides = {
  'gpu-poor': {
    coin: 'tNVDA',
    brief: 'Too poor for a GPU, so it burns VRAM to stay warm. Token only; both fee sides buy and burn VRAM after graduation.',
    needs: 'The unbound settings use ETH listing 0. Supply a verified tNVDA priceListing when building, or select the verified tNVDA listing after Load settings. The locked description is coin-neutral; no rewrite is needed when changing the price coin. tNVDA is an unbacked test coin, not Nvidia stock or an Ondo claim.',
  },
  'one-dollar': {
    coin: 'tUSDC',
    brief: 'The token is 1. The dollar is in the box. Seed exactly one tUSDC (1000000 raw units); both fee sides burn the box token. Fees never feed this pile. After graduation, burn tokens for a share with zero leave-behind.',
    needs: [
      'The unbound settings use ETH listing 0 and seed one ETH (1000000000000000000 raw units). For this Sepolia example, use the verified tUSDC listing: a bound file seeds one tUSDC (1000000 raw units at 6 decimals). To build it, supply priceListing with its verified id, token and raise. If supplied, assets.TEST_USDC must match the listing token; an address alone does not select a listing.',
      'Load settings accepts this same-price-coin pile when its coin is listed. Before Create, the pile coin follows the selected price coin: changing price keeps the typed seed `1` and rebuilds the raw amount using the new listing\'s decimals. This is one whole unit of the selected coin, not a value conversion. Create refuses a seed that needs more decimals than the new coin supports.',
      'Never reinterpret a raw seed in another coin\'s decimals. Load settings first decodes it in the original coin\'s own listing decimals; only then can the typed amount follow a new price selection. Recheck the final coin, seed and raise. The founder separately approves and loads the seed after Create.',
      'The locked description is coin-neutral; no rewrite is needed when changing the price coin. tUSDC is an unbacked Sepolia test coin; this setup makes no promise of value.',
    ].join('\n\n'),
  },
  'rent-free': {
    coin: 'tUSDC',
    brief: '500 open houses, RENT. Buyers pay every house in the price coin: outside shares are claimable and inside shares buy RENT and burn it. Sellers burn RENT. Rent and property tax are jokes, not real property income.',
    needs: 'Each of the 500 houses has its own picture and its own 3D model (a GLB). The settings file carries every picture, every model and the public reveal list. After **Load settings**, add the bundle\'s `items/` files together: `1.png` … `500.png`, `1.glb` … `500.glb` and `traits.csv` (**Images + models + traits**, or the folder). Create checks every model and refuses the pictures without their models. The unbound settings use ETH listing 0. Supply a verified tUSDC priceListing when building, or select the verified tUSDC listing after Load settings. The locked description is coin-neutral; no rewrite is needed when changing the price coin. tUSDC is an unbacked Sepolia test coin; this setup makes no promise of value.',
  },
  'bag-holders': {
    coin: 'tLINK',
    brief: '420 open bags, TOTE. Both fee sides pay every bag in the price coin with Keep inside: an inside bag retains its stash for whoever takes it out. Picking before collection has a timing gap.',
    needs: 'Each of the 420 bags has its own picture and its own 3D model (a GLB). After **Load settings**, add the bundle\'s `items/` files together: `1.png` … `420.png`, `1.glb` … `420.glb` and `traits.csv` (**Images + models + traits**, or the folder). Create checks every model. Select tLINK after loading; the old 100-hidden-bag ETH recipe is obsolete.',
  },
  'exit-liquidity': {
    coin: 'tUSDC',
    brief: '404 open exit signs, EXIT. Buyers deepen the pool. Sellers pay every sign in the price coin, with inside shares buying and burning EXIT. This is a collection, with no new preset.',
    needs: 'Each of the 404 signs has its own picture and no 3D model (2D). After **Load settings**, add `1.png` … `404.png` and `traits.csv` from the bundle\'s `items/` folder. Verify the full-size settings file in the browser before signing; successful Node loading alone is insufficient.',
  },
  'link-marines': {
    coin: 'tLINK',
    label: 'Link Marines version 1 (archival)',
    brief: 'Archival version 1: 420 open marines, MARINE. Both fee sides Eat the price coin after graduation; the marines receive no item fees. The Sepolia example uses link-marines-v2, while this Eat kit remains buildable.',
    needs: 'The v1 assignment has 12 roles and 35 squads. Use that full set only when deliberately building the archival Eat recipe. Show Lock tLINK unless its verified listing records a checked burn; do not infer burnability from its name.',
  },
  'link-marines-v2': {
    label: 'Link Marines version 2', coin: 'tLINK',
    brief: 'The Sepolia Link Marines example is version 2: 420 open marines, MARINE. Both fee sides pay the box share (10 of 15 parts) as equal rations in the price coin. Outside owners claim tLINK; inside shares deepen the box’s own pool (Items/Depth). Royalties of 2.5% feed the same fee handling.',
    needs: 'Each of the 420 marines has its own portrait and no 3D model (2D), with nine traits: Rank, Squad, Face, Eyes, Grooming, Collar, Mouth, Prop and Wall. The twelve ranks and 35 squads follow the original rule. Build all 420 numbered pictures and the public reveal list. Rank changes no ration. The unbound settings use ETH listing 0; supply a verified tLINK priceListing or choose that listing after Load settings. The locked description is coin-neutral. tLINK is an unbacked Sepolia test coin; there is no promise of value. Its local contract and browser lives cover both sides’ rations, an owner’s claim in the price coin, the inside shares going to the box’s own pool and the royalty; that is not a Sepolia deployment. After creation, prepare open reveals from the created box’s own download.',
  },
  'frog-kiln': {
    coin: 'tFROG', hidden: true,
    brief: '420 hidden clay toads, KILN. Buyers burn the price coin after graduation; sellers buy KILN for every toad, with inside shares burned. Outside owners claim KILN, not tFROG.',
    needs: 'Use the public settings template and its plan manifest below, then the kit plan.csv with the 12 PNGs in art/items/. Require a tFROG listing admitted with addWithBurn and checked burn(uint256), selector 0x42966c68. A lock-only listing does not meet this example.',
  },
  'paper-certificates': {
    coin: 'tGOLD', hidden: true,
    brief: 'Gold Certificates, SCRIP: 1,929 hidden certificates. Buyers burn SCRIP; sellers buy SCRIP for every certificate, with inside shares burned. This launch uses the gold edition; tGOLD has no real-gold backing.',
    needs: 'Use the public settings template and its plan manifest below, then the specimen-0 plan route: plan.csv plus the 12 PNGs in art/items/. Every picture retains specimen number 0; the page randomly assigns ids 1–1929. Do not load the 776 MB numbered rendition (above the 256 MiB limit). The founder distributes tGOLD directly.',
  },
  'dragons-hoard': {
    coin: 'SepETH',
    brief: "Dragon's Hoard, HOARD: seed 1 ETH separately after Create. Buyers feed the ETH pile after graduation; sellers buy and burn HOARD. Redemptions leave 5% for remaining holders; the last redeemer takes the balance.",
    needs: 'Use native Sepolia ETH, listing 0. The base settings and registry still carry the earlier raise. The founder must execute updateRaise(0, 0.1 ETH) before creating these examples, then refresh the listing, quote and salts. Do not rewrite a saved hash or silently treat the old raise as current.',
  },
  junkyard: {
    coin: 'tGOLD',
    brief: 'The Junkyard, TRASH: a creator Safe seeds 180 million TRASH and ten outside NFTs. Buyers pay holders in the price coin. Sellers fill the shop up to 2x its seed, then pay holders. Picks cost twice the give price; 10% weekly and 2.5% per collection, with a seven-day delay.',
    needs: 'The base registry below uses four local-life scrap collections (4+2+2+2 starters). The Sepolia kit explicitly substitutes five Test Junk collections: bent-cans, lost-cogs, split-boots, cracked-mugs and tangled-wires, ids 1–2 each, tier 0. Keep that distinction visible. Bind all five deployed addresses and the creator Safe. Type those starter ids in Load settings. Re-quote the 0.3 ETH-equivalent creator buy in tGOLD using the current raises; it is not 0.3 tGOLD. The founder signs offline Safe batches for creation, exact starter approvals and loading. See docs/runbooks/junkyard-launch.md.',
  },
  'one-collection-shop': {
    coin: 'SepETH',
    brief: 'SHOP accepts only Test Junk Bent Cans. The creator Safe supplies ids 3–12 and 2 million SHOP, enough for two gives at 1 million each. Picks cost 2 million. No curator: nobody can add collections. Buyers pay holders; sellers fill the shop to 2x seed, then pay holders.',
    needs: 'Bind the deployed bent-cans collection and creator Safe. Mint ids 3–12 to that Safe, separately from Junkyard ids 1–2, and type 3–12 in Load settings. Preserve No curator. Use native listing 0, a freshly quoted 0.01 ETH creator buy, and offline Safe batches. The collection limit is 2.5% of the weekly starting budget with the cheapest-give floor; the global weekly limit is 10%. The last NFT stays.',
  },
  'lake-house': {
    coin: 'tUSDC',
    brief: 'Lake House, HOUSE: a mock house in a box. Its tUSDC pile starts empty. After graduation both fee sides go to the pile, and payments sent to the box\'s inbox add 10 of every 15 parts. Anyone hands in HOUSE for its share of the pile, with nothing left behind. Test coins; a mock house, not legal title.',
    needs: [
      'Use the verified tUSDC listing. The unbound settings use ETH listing 0 with an empty ETH pile; binding tUSDC moves the empty pile to tUSDC, because the pile follows the price coin (both fee sides need the pile in the price coin). Its seed stays 0; there is nothing to approve or load after Create.',
      'The Sepolia creator is the company Safe "Lake House Co. (mock company)" (a Safe app label; no company exists). Its create batch comes from the launch pack: zero the tUSDC allowance, approve exactly the bootstrap, createBox, zero it again. The launch window opens with createBox itself.',
      'The locked description is the About line and stays public for good. Never describe this box with earn, yield, APY, rent income or returns. The house, the guests and the title are made up; one wallet funds the simulation.',
    ].join('\n\n'),
  },
  'the-alchemist': {
    coin: 'tPEPE', pending: true,
    brief: 'LEAD is priced in tPEPE; its pile holds tGOLD with zero seed and 5% leave-behind. Buyers use Alchemist conversion; sellers buy and burn LEAD. Conversion waits for graduation, may fail, and is not a promise of gold or income.',
    needs: 'Refuse to offer or create this pending ALCHEMIST-REGISTRATION recipe. The settings file is a review artifact only: its row slot 0 is unset, not a registered module. Both coins need verified listings and route pools, a compatible module and active directory registration, its full one-day readyAt delay, and the required example lives. The registry raise remains null, never zero. Never replace Alchemist with another fee action to make the file load.',
  },
};

const feeWords = {
  burn: 'Buy and burn the box token', eat: 'Eat the price coin', grow: 'Deepen the pool',
  items: 'Pay every item in the price coin', 'items-t': 'Buy box tokens for every item',
  holders: 'Pay holders in the price coin', pile: 'To the pile', shop: 'Into the shop',
  alchemist: 'Alchemist conversion (pending)',
};
const fee = side => `${feeWords[side.choice]}${side.inside ? `; inside ${{ keep: 'Keep', burn: 'BuyBackBurn', depth: 'Depth' }[side.inside]}` : ''}${side.ceilingPreset ? `; ${side.ceilingPreset}x ceiling` : ''}`;

const settingsPath = (id, row) => `examples/boxes/${id}/${row.contents.kind === 'collection' && row.contents.art.mode === 'open' ? 'build' : 'settings'}/${id}-boxspec-v2.json`;
const planPath = id => `examples/boxes/${id}/settings/${id}-plan.json`;

// Both reference indexes describe the same public-template import and private edition boundary.
export const hiddenKitRoute = [
  'For Frog Kiln and Paper Certificates, in **Load settings** pick the public settings file and its `-plan.json` together. Then select the plan\'s 12 variant PNG pictures from `art/items/` and `plan.csv` together in **Images + traits**, or a folder containing just those files. Create checks the settings/plan binding, plan count and sorted trait table, deals fresh numbers and salts, and replaces the template marker with a new private root. Save the reveal file privately before Create. The public template is not create calldata.',
  'The creator adds the art without an AI browser agent. Keep the reveal file outside any folder an AI can read; never paste it into chat. Keep item pictures, assignments, salts and reveal data out of this skill and every public bundle until reveal. Load settings keeps the file\'s own hidden picture; `art/hidden.svg` is a public placeholder by design. The launch flow still takes no SVG upload. Paper Certificates uses Gold Certificates and specimen number 0; the page deals its 1,929 item numbers privately.',
].join('\n\n');

export function kitReferences() {
  const rows = new Map(loadExamples().map(row => [row.id, row]));
  const outputs = [];
  for (const [id, guide] of Object.entries(guides)) {
    const row = rows.get(id);
    if (!row) throw new Error(`Missing kit registry row: ${id}`);
    const kit = `examples/boxes/${id}`;
    // The kit itself must exist; a misspelled or removed kit must fail the generation check.
    readFileSync(new URL(`${kit}/README.md`, repo), 'utf8');
    const settings = settingsPath(id, row);
    const steps = guide.pending ? [
      `1. Review \`${settings}\` as a proposed recipe. Do not use Load settings to create this box while registration is pending.`,
      '2. Ask the integrator for verified tPEPE and tGOLD listings, the compatible module row and its on-chain readyAt. Keep the zero seed, conversion buyers, Burn sellers and 5% leave-behind unchanged.',
      '3. Resume the normal kit path only after the registry readiness and all listed dependencies are satisfied. Rebuild with reviewed public bindings and choose the verified tPEPE listing then; never reuse the ETH quote or unset directory slot.',
    ] : guide.hidden ? [
      `1. The creator, without an AI browser agent, opens Create on Sepolia. In **Load settings**, pick \`${settings}\` and \`${planPath(id)}\` together. These are a public settings template and its plan manifest, not a private edition or an assistant draft.`,
      `2. Then select the plan's 12 variant PNG pictures from \`${kit}/art/items/\` and \`${kit}/plan.csv\` together in **Images + traits**, or a folder containing just those files. Create checks the settings/plan binding, plan count and sorted trait table, deals fresh numbers and salts, and replaces the template marker with a new private root. Never submit the public template directly as create calldata or substitute public assignments or deterministic salts.`,
      '3. Save the reveal file privately before Create, outside any folder an AI can read; never paste it into chat. Keep item pictures, assignments, salts and reveal data out of this skill and every public bundle until reveal. Load settings keeps the file\'s own hidden picture; `art/hidden.svg` is a public placeholder by design. The launch flow still takes no SVG upload. Prepare drand and the reveal worker before opening.',
      `4. Choose the listing for **${guide.coin}** by verified chain and full token address; the template's ETH listing 0 is not that binding. Refresh the listing raise and quotes, compare the overview with this recipe, and confirm opening time and art rights. Only the founder signs; this worked example is not evidence of a live deployment.`,
    ] : [
      `1. Review public bindings with the integrator, then rebuild from the repository root: \`node scripts/kits/bundle.mjs ${id}\` (add \`--bindings PUBLIC_JSON\` when needed). A build alone does not prove any address is deployed.`,
      `2. Use the settings file \`${settings}\`. In Create on Sepolia, choose **Load settings** and select that file. This is the app download, not a skill draft or the registry JSON below.`,
      `3. Choose the listing for **${guide.coin}** by verified chain and token address. Loading ETH listing 0 does not select a test token. Resolve every slot in build/inventory.json, refresh the listing raise, and recheck the seed and creator buy in their own units.`,
      '4. Compare name, ticker, contents, art mode, fees, deadline and pick fee with the recipe. Confirm the opening time (zero means next block), art rights and final overview. The founder signs; prepare offline Safe batches for a shop.',
    ];
    if (row.pendingStep === 'EXAMPLE-LIFE') steps.unshift('0. Preparation and review only while EXAMPLE-LIFE is pending. The integrator must verify the contract and browser lives before launch.');
    const text = [
      `# ${row.name} (${row.ticker})`, '',
      '> Generated by `scripts/kit-references.mjs`; edit the guide there, then run `pnpm launch-skill:write`.', '',
      guide.brief, '',
      `Source kit: [${kit}/README.md](../../../../../${kit}/README.md).`,
      `Source row: [packages/box-spec/examples/v2/${id}.json](../../../../../packages/box-spec/examples/v2/${id}.json).`, '',
      '## Worked choices', '',
      '| Choice | Value |', '|---|---|',
      `| Sepolia listing | ${guide.coin} (registry binding: ${row.priceCoin.symbol}) |`,
      `| Contents | ${row.contents.kind}; ${row.contents.size} new items; ${row.contents.art.mode} art |`,
      `| Buyers | ${fee(row.fees.buyers)} |`, `| Sellers | ${fee(row.fees.sellers)} |`,
      `| Deadline | ${row.deadline.days} days |`,
      `| Named pick / royalties | ${row.contents.pickFeeBps} / ${row.royalties.bps} basis points |`, '',
      '## Start from this kit', '', guide.needs, '', ...steps, '',
      'Payouts are claim-only. Registry ready means the recipe has a test life; it is not evidence of Sepolia deployment. Refresh mutable listings before Create. Keep monetary values as raw decimal strings.', '',
      'Public example art can be served by the project node. New box collections become listable only after graduation and take-out; Test Junk and Bent Cans are the outside full sets for these shops. Videos use captions only.', '',
      '## Exact base registry row', '',
      'This is recipe data for comparison, not a Load settings file or an executable BoxSpec draft. Its raise and local art paths describe the base registry; use the kit art and verified Sepolia bindings above.', '',
      '```json', JSON.stringify(row, null, 2), '```', '',
    ].join('\n');
    outputs.push([`kits/${id}.md`, text]);
  }
  const index = [
    '# Start from a kit', '',
    '> Generated by `scripts/kit-references.mjs`. Commands run from the repository root.', '',
    'Pick the worked example, prepare its app settings file, open Create → Load settings, then choose the listing by verified Sepolia address. These are templates, not deployment attestations. The exact base registry row is included in each example and checked for equality by `pnpm check:launch-skill`.', '',
    '| Kit | Sepolia price coin | Settings in this base |', '|---|---|---|',
    ...Object.entries(guides).map(([id, g]) => `| [${g.label ?? rows.get(id).name}](${id}.md) | ${g.coin} | \`${settingsPath(id, rows.get(id))}\`${g.hidden ? ` + \`${planPath(id)}\`` : g.pending ? ' — Review file only; creation refused' : ''} |`), '',
    'Use the [kit settings instructions](../../../../../scripts/kits/README.md) for bindings and builds. Existing kit filenames are unchanged. Open collections use build/; six token/pile/shop files and the two public hidden-plan templates use settings/. The hidden-template loading route below supersedes older README claims that these files cannot load.', '',
    hiddenKitRoute, '',
    'Use the [hidden collection plan](../../../../../docs/guides/hidden-collection-plan.md) for the CSV format and private handling. Link Marines version 2 is the Sepolia example: Items/Depth rations on both sides. Version 1 remains the archival Eat kit.', '',
    'Shop creators are Safes; the founder signs offline batches. Resolve exact starter ownership and addresses before approval. A Load settings success is not a Safe execution plan. No assistant sends transactions or handles keys.', '',
    'Alchemist remains refused while ALCHEMIST-REGISTRATION is pending. A saved file with directory slot 0 does not satisfy registration or its one-day delay.', '',
    'The draft JSON files elsewhere in this reference use the offline demo menu to exercise encoding. They are not app downloads: their addresses, raises and art placeholders are not Sepolia bindings. Use the worked kit path for actual settings.', '',
  ].join('\n');
  outputs.push(['kits/README.md', index]);
  return outputs;
}
