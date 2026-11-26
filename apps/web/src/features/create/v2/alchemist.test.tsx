/**
 * SH-V21-FE14 (step 8 request 2): The Alchemist in the creation flow. It is offered only for a coin pile whose coin is
 * not the price coin, and only once the page resolved a row for exactly that pair (the chain package's
 * `alchemistRowsV21`, over the source's RPC: view calls, no wallet); the side is the chain package's
 * `alchemistSideV21(id)`; the route shown is the one the row's helper holds; any other pick is named at Fees. The Demo
 * has no directory and offers none: no route is invented.
 */
import { cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { encodeFunctionResult, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateBoxSpecV2 } from '../../../../../../packages/box-spec/src/generated/box-spec.v2';
import { alchemistSideV21, receiverModulesV21Abi, type AlchemistRowV21 } from '../../../../../../packages/chain/src/core/v2';
import { feeChoiceV2 } from '../../../../../../packages/indexer/src/core/v2/views-v2';
import { AppProviders } from '../../../app-providers';
import { required } from '../../core/v2/test-support/required';
import { appCopyFraming, renderedCopy } from '../../legal/wording';
import { ALCHEMIST_OFF, alchemistReleaseV21, rpcAlchemistReads, useAlchemistRows, type AlchemistAnswer } from './alchemist';
import { creationPlan, demoCreateGas } from './creation-plan';
import { FeesStep } from './FeesStep';
import { ALCHEMIST_ROUTE_FIXED, ALCHEMIST_WARNING, alchemistLine, hopText, triggerText } from './fee-words';
import { DEMO_LISTINGS, FREEZE_LINE, NATIVE_TOKEN } from './listings';
import { ALCHEMIST_CHECKING, ALCHEMIST_NEEDS_PILE, ALCHEMIST_UNCHECKED, alchemistNoRoute, buildSpecV2, newPile, pileInOther, recipeCtx, v2Issues, type BuildV2Input, type V2Choices } from './model';
import { OverviewV2, sideText } from './OverviewV2';
import { alchemistPick, choiceOf, moduleIdOf, pickFor, sideOf, type SidePick } from './recipes';
import { newShop } from './shop';
import { specHashV2 } from './spec-types';
import { CONFIGURATIONS } from './test-support/example-configurations';
import { inputV2Of } from './test-support/v2-fixtures';
import { shownText, tucked } from '../../../test-support/shown-text';
import { INBOX_SIDE_LINE } from './FeesStep';

afterEach(cleanup);
const config = (id: string) => required(CONFIGURATIONS.find((entry) => entry.id === id));
const coin = (symbol: string) => required(DEMO_LISTINGS.find((l) => l.symbol === symbol));
const PAXG = coin('PAXG'); const USDC = coin('USDC');
const WETH = '0x00000000000000000000000000000000000000e2' as Address;
/**
 * G1: the module's fixed trigger (`conversionTrigger()`; anvil's account 4, the local chain's keeper account, letters in
 * both spellings), a 0.001 ETH cap and a 1 gwei dust size (`dustMax()`). F153: any address can be a row's trigger and the
 * site names it by its address alone; Sepolia's row 4 has the founder's deployer (`DEPLOYER`), not the platform keeper.
 */
const TRIGGER = getAddress('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65') as Address;
const DEPLOYER = getAddress('0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE') as Address;
/** No word may call a row's trigger a keeper or say how it sends (SH-APP8-TRIGGER-WORDS). */
const KEEPER_WORDS = /keeper|private/i;
const ROW: AlchemistRowV21 = {
  id: 4, readyAt: 86_400n, module: '0x0000000000000000000000000000000000000051', codeHash: keccak256('0x01'), priceCoin: NATIVE_TOKEN, pileCoin: PAXG.token,
  executor: '0x0000000000000000000000000000000000000052', executorCodeHash: keccak256('0x02'),
  route: [{ kind: 3, tokenIn: NATIVE_TOKEN, tokenOut: WETH, pool: '0x00000000000000000000000000000000000000a1', fee: 3000, tickSpacing: 60 }, { kind: 2, tokenIn: WETH, tokenOut: PAXG.token, pool: '0x00000000000000000000000000000000000000a2', fee: 3000, tickSpacing: 0 }],
  inputCap: 10n ** 15n, dustMax: 10n ** 9n, conversionTrigger: TRIGGER,
};
const READY: AlchemistAnswer = { state: 'ready', rows: [ROW] };
/** An ETH-priced token with a PAXG coin pile (seed 0, 5% leave-behind: the launch defaults' shape), buyers The Alchemist. */
const pileInput = (v2: Partial<V2Choices> = {}, alchemist: AlchemistAnswer = READY): BuildV2Input & { alchemist: AlchemistAnswer } => ({
  ...inputV2Of(config('dragons-hoard'), { pricing: NATIVE_TOKEN, buyers: alchemistPick(4), sellers: pickFor('burn'), pile: { ...newPile(PAXG.token), seed: '0', leaveBehindBps: 500 }, ...v2 }, { contents: 'token', ticker: 'LEAD' }),
  alchemist,
});

describe('SH-V21-FE14 The Alchemist: the chain package’s wire', () => {
  it('is AsPaid / Module with the row’s canonical uint32 id, read back as a module side; the validator accepts it', () => {
    const pick = alchemistPick(4);
    expect(choiceOf(pick)).toBe('alchemist');
    expect(moduleIdOf(pick)).toBe(4);
    expect(sideOf(pick)).toEqual(alchemistSideV21(4));
    expect(sideOf(pick).a.destParams).toBe(toHex(4n, { size: 32 }));
    expect(feeChoiceV2(sideOf(pick))).toBe('module');
    const input = pileInput();
    expect(v2Issues(input)).toEqual([]);
    expect(validateBoxSpecV2(buildSpecV2(input), { listing: recipeCtx(input).pricing })).toEqual({ reason: 0, field: 0 });
    // The id is part of the spec: another row is another spec hash (a stale quote or salt).
    expect(specHashV2(buildSpecV2(pileInput({ buyers: alchemistPick(5) }, { state: 'ready', rows: [{ ...ROW, id: 5 }] })))).not.toBe(specHashV2(buildSpecV2(input)));
    // A module pick without a row id, or with an id outside uint32, is no choice.
    for (const module of [undefined, -1, 2 ** 32, 1.5]) expect(choiceOf({ ...pick, a: { ...pick.a, module } }), String(module)).toBeNull();
  });

  it('the plan is the pile’s: no seed step for a zero seed, nothing else to send', () => {
    const input = pileInput();
    const plan = creationPlan(buildSpecV2(input), recipeCtx(input).pricing, { estimate: demoCreateGas });
    expect(plan.steps.map((step) => step.call)).toEqual(['createBox']);
  });
});

describe('SH-V21-FE14 The Alchemist: only a resolved row for exactly this pair', () => {
  it('names at Fees why a pick cannot be created: checking, unreadable, no row for this pair, no pile in another coin', () => {
    const issue = (input: Parameters<typeof v2Issues>[0]) => v2Issues(input).filter((i) => i.step === 'v2-fees').map((i) => i.message);
    expect(issue(pileInput({}, { state: 'checking' }))).toEqual([ALCHEMIST_CHECKING]);
    expect(issue(pileInput({}, { state: 'failed' }))).toEqual([ALCHEMIST_UNCHECKED]);
    expect(issue(pileInput({}, ALCHEMIST_OFF))).toEqual([alchemistNoRoute('ETH', 'PAXG')]);
    expect(issue(pileInput({}, { state: 'ready', rows: [{ ...ROW, id: 5 }] }))).toEqual([alchemistNoRoute('ETH', 'PAXG')]);
    // A pile in the price coin is To the pile's; a pile-less token, a shop and a collection have no pile at all.
    expect(issue(pileInput({ pile: { ...newPile(NATIVE_TOKEN), seed: '1' } }))).toEqual([ALCHEMIST_NEEDS_PILE]);
    expect(issue(pileInput({ pile: null }))).toEqual([ALCHEMIST_NEEDS_PILE]);
    expect(issue(pileInput({ shop: newShop() }))).toContain(ALCHEMIST_NEEDS_PILE);
    expect(pileInOther(pileInput())?.symbol).toBe('PAXG');
    expect(pileInOther(pileInput({ pile: { ...newPile(NATIVE_TOKEN), seed: '1' } }))).toBeNull();
  });
});

describe('SH-V21-FE14 The Alchemist on the page', () => {
  const step = (buyers: SidePick, answer: AlchemistAnswer = READY, pile = PAXG) => {
    const set = vi.fn();
    const input = pileInput({ buyers });
    render(<MemoryRouter><FeesStep buyers={buyers} sellers={pickFor('burn')} ctx={{ ...recipeCtx(input), listings: [...DEMO_LISTINGS, { ...PAXG, id: 99, token: WETH, symbol: 'WETH', name: 'Wrapped Ether', powers: [] }] }} collection={false} alchemist={{ pile, answer }} errorFor={() => null} set={set} /></MemoryRouter>);
    const group = (side: 'Buyers’' | 'Sellers’') => screen.getByRole('group', { name: side === 'Buyers’' ? 'Buyers’ fees · in ETH' : 'Sellers’ fees · paid in LEAD, used as ETH' });
    return { set, buyers: group('Buyers’'), sellers: group('Sellers’') };
  };
  const names = (group: HTMLElement) => within(group).getAllByRole('button').map((b) => b.textContent);
  /** SH-ALCHEMIST-LESS-TEXT: the route block is a Details button, closed until pressed; pressed, its rows show. */
  const open = (route: HTMLElement, side: 'buyers’' | 'sellers’' = 'buyers’') => {
    const toggle = within(route).getByRole('button', { name: `Details: Alchemist, ${side} fees` });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(route).queryAllByRole('listitem')).toEqual([]);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  };

  it('is offered on either side once a row resolved, and picks the newest row', () => {
    const page = step(pickFor('burn'), { state: 'ready', rows: [{ ...ROW, id: 6 }, ROW] });
    for (const side of [page.buyers, page.sellers]) expect(names(side)).toContain('The Alchemist');
    fireEvent.click(within(page.buyers).getByRole('button', { name: 'The Alchemist' }));
    expect(page.set).toHaveBeenLastCalledWith({ buyers: alchemistPick(6) });
    cleanup();
    for (const answer of [ALCHEMIST_OFF, { state: 'checking' } as const, { state: 'failed' } as const, { state: 'ready', rows: [] } as const]) {
      const none = step(pickFor('burn'), answer);
      expect(names(none.buyers), answer.state).not.toContain('The Alchemist');
      cleanup();
    }
  });

  it('shows the route its helper holds, the one line and the pile coin’s issuer powers; Fee details say the limits', () => {
    const page = step(alchemistPick(4));
    const route = required(page.buyers.querySelector<HTMLElement>('[data-alchemist="4"]'));
    open(route);
    expect(within(route).getByText('Route · row 4')).toBeTruthy();
    expect(within(route).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['ETH → WETH · Uniswap v3 · 0.3%', 'WETH → PAXG · Uniswap v2 · 0.3%', FREEZE_LINE]);
    expect(within(route).getByText(alchemistLine('PAXG'))).toBeTruthy();
    // G1: before the side is chosen, the row's admitted cap and its fixed trigger, as the module answers them.
    const term = (name: string) => Array.from(route.querySelectorAll('.sh-newbox-row')).find((r) => r.querySelector('dt')?.textContent === name)?.querySelector('dd')?.textContent;
    expect(term('Each step')).toBe('Up to 0.001 ETH');
    // RC5-B: the dust size is the largest step that stays in the box's own pool depth, never the FIT Safe.
    expect(term('Too small')).toBe('0.000000001 ETH or less stays in the box’s pool depth');
    expect(term('Started by')).toBe('0x15d3…6A65 · anyone after 7 days without a step');
    expect(triggerText(TRIGGER)).toBe('0x15d3…6A65 · anyone after 7 days without a step');
    const details = required(document.querySelector('details')).textContent ?? '';
    for (const words of ['within 49 ticks of its price at the start', 'keeps it waiting for a later try, with no tip', 'does not know a fair price', 'promise that a conversion happens', 'if the box fails first, it joins the closing claim', 'with the pile’s leave-behind',
      'after graduation one fixed address starts each step; if a side waits 7 days without one, anyone may start the next', 'Each step converts at most its row’s amount, and the rest waits for the next one.', 'A step goes along the fixed route',
      'When more than one but less than two full steps are left, two steps split the rest.',
      'A step a pool would pay nothing for stays in the box’s pool depth instead, not in the pile, up to its row’s limit; a larger one refuses and waits.',
      'Once anyone may start a step, a trader can move a pool’s price just before it', 'within the 49 ticks; a step seen early can be traded around the same way.']) expect(details, words).toContain(words);
    // F153: the trigger is any address; nothing calls it a keeper or says it sends privately.
    expect(document.body.textContent).not.toMatch(KEEPER_WORDS);
    // No promise of unrestricted or whole-queue conversion; the general paragraph names no row's figure (G1-INT: a side
    // may keep an older row with another cap, so the figures stay in each row's box).
    expect(details).not.toMatch(/whole waiting|in one try|anyone may run the conversion|0\.001 ETH|0\.000000001 ETH|FIT Safe instead/);
    expect(appCopyFraming(renderedCopy(document.body).map((text) => text.replace(/\bGrow the pool\b/g, 'Add to the pool')))).toEqual([]);
    expect(document.body.textContent).not.toMatch(/profit|earn|yield|returns?\b/i);
    cleanup();
    // A coin without issuer powers shows none; a pick whose row did not resolve shows no route (v2Issues names it).
    expect(step(alchemistPick(4), READY, { ...PAXG, powers: [] }).buyers.querySelector('.sh-newbox-warnings')).toBeNull();
    cleanup();
    expect(step(alchemistPick(9)).buyers.querySelector('[data-alchemist]')).toBeNull();
  });

  it('the overview names the row and its fixed route into the pile', () => {
    const input = pileInput();
    const ctx = { ...recipeCtx(input), listings: [...recipeCtx(input).listings, { ...USDC, id: 99, token: WETH, symbol: 'WETH' }] };
    expect(sideText('buyers', alchemistPick(4), ctx)).toBe('The Alchemist · row 4 · in ETH');
    expect(hopText(required(ROW.route[0]), ctx.listings)).toBe('ETH → WETH · Uniswap v3 · 0.3%');
    const spec = buildSpecV2(input);
    const plan = creationPlan(spec, ctx.pricing, { estimate: demoCreateGas });
    render(<MemoryRouter><OverviewV2 spec={spec} hash={specHashV2(spec)} form={input.form} v2={input.v2} ctx={ctx} plan={plan} nowMs={0} fix={new Set()} run={null} alchemist={[ROW]} /></MemoryRouter>);
    const fees = required(screen.getByRole('heading', { name: 'Fees' }).closest('section'));
    const row = (name: string) => required(Array.from(fees.querySelectorAll('.sh-newbox-row')).find((r) => r.querySelector('dt')?.textContent === name)).querySelector('dd')?.textContent;
    // SH-ALCHEMIST-LESS-TEXT: the route, the limits, the trigger and the warning wait behind the group's closed Details.
    const toggle = within(fees).getByRole('button', { name: 'Details: Alchemist' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(fees).queryByRole('list')).toBeNull();
    fireEvent.click(toggle);
    expect(within(fees).getByRole('listitem').textContent).toBe(ALCHEMIST_WARNING);
    expect(row('Route')).toBe('ETH → WETH · Uniswap v3 · 0.3% · then WETH → PAXG · Uniswap v2 · 0.3%');
    // G1: the cap and the trigger beside the route, and the fallback's limits with the fee rows the creator confirms.
    expect(row('Each step')).toBe('Up to 0.001 ETH');
    expect(row('Too small')).toBe('0.000000001 ETH or less stays in the box’s pool depth');
    expect(row('Started by')).toBe('0x15d3…6A65 · anyone after 7 days without a step');
    expect(fees.textContent).not.toMatch(KEEPER_WORDS);
    expect(within(fees).getByText(ALCHEMIST_WARNING)).toBeTruthy();
    // SH-APP8: true for any trigger, not only after the fallback: a step sent in public can be seen and traded around
    // too (F153: Sepolia's row 4), so the warning names any step and no condition.
    expect(ALCHEMIST_WARNING).toBe('A trader can move a pool’s price just before any step.');
    expect(ALCHEMIST_WARNING).not.toMatch(/7 days|after|once|anyone may/i);
    expect(appCopyFraming(renderedCopy(fees))).toEqual([]);
    cleanup();
    // Without an Alchemist side the Overview names no cap, trigger or fallback.
    const plain = { ...input, v2: { ...input.v2, buyers: pickFor('burn') } };
    const plainSpec = buildSpecV2(plain);
    render(<MemoryRouter><OverviewV2 spec={plainSpec} hash={specHashV2(plainSpec)} form={plain.form} v2={plain.v2} ctx={ctx} plan={creationPlan(plainSpec, ctx.pricing, { estimate: demoCreateGas })} nowMs={0} fix={new Set()} run={null} alchemist={[ROW]} /></MemoryRouter>);
    expect(screen.queryByText(ALCHEMIST_WARNING)).toBeNull();
    expect(screen.queryByText('Each step')).toBeNull();
    expect(screen.queryByText('Too small')).toBeNull();
    expect(screen.queryByText('Started by')).toBeNull();
  });

  it('F153: a trigger that is not the platform keeper (Sepolia’s row 4: the founder’s deployer) is named by its own address, nothing else changes', () => {
    const row4: AlchemistRowV21 = { ...ROW, conversionTrigger: DEPLOYER };
    expect(triggerText(DEPLOYER)).toBe('0x1F14…4eeE · anyone after 7 days without a step');
    const page = step(alchemistPick(4), { state: 'ready', rows: [row4] });
    const route = required(page.buyers.querySelector<HTMLElement>('[data-alchemist="4"]'));
    open(route);
    const term = (name: string) => Array.from(route.querySelectorAll('.sh-newbox-row')).find((r) => r.querySelector('dt')?.textContent === name)?.querySelector('dd')?.textContent;
    expect(Array.from(route.querySelectorAll('.sh-newbox-row dt')).map((dt) => dt.textContent)).toEqual(['Each step', 'Too small', 'Started by']);
    expect(term('Started by')).toBe('0x1F14…4eeE · anyone after 7 days without a step');
    // The row's cap, dust size, route and line are as for any trigger.
    expect(term('Each step')).toBe('Up to 0.001 ETH');
    expect(term('Too small')).toBe('0.000000001 ETH or less stays in the box’s pool depth');
    expect(within(route).getAllByRole('listitem').map((li) => li.textContent).slice(0, 2)).toEqual(['ETH → WETH · Uniswap v3 · 0.3%', 'WETH → PAXG · Uniswap v2 · 0.3%']);
    expect(within(route).getByText(alchemistLine('PAXG'))).toBeTruthy();
    const details = required(document.querySelector('details')).textContent ?? '';
    expect(details).toContain('The Alchemist: after graduation one fixed address starts each step; if a side waits 7 days without one, anyone may start the next.');
    expect(details).toContain('Once anyone may start a step, a trader can move a pool’s price just before it, within the 49 ticks; a step seen early can be traded around the same way.');
    expect(document.body.textContent).not.toMatch(KEEPER_WORDS);
    expect(document.body.textContent).not.toContain('0x15d3');
    cleanup();
    // The Overview: the deployer's row 4 on the buyers' side and row 5 (anvil's account 4) on the sellers', each by its own trigger.
    const input = pileInput({ sellers: alchemistPick(5) }, { state: 'ready', rows: [{ ...ROW, id: 5 }, row4] });
    const ctx = { ...recipeCtx(input), listings: [...recipeCtx(input).listings, { ...USDC, id: 99, token: WETH, symbol: 'WETH' }] };
    const spec = buildSpecV2(input);
    render(<MemoryRouter><OverviewV2 spec={spec} hash={specHashV2(spec)} form={input.form} v2={input.v2} ctx={ctx} plan={creationPlan(spec, ctx.pricing, { estimate: demoCreateGas })} nowMs={0} fix={new Set()} run={null} alchemist={[{ ...ROW, id: 5 }, row4]} /></MemoryRouter>);
    const fees = required(screen.getByRole('heading', { name: 'Fees' }).closest('section'));
    const row = (name: string) => required(Array.from(fees.querySelectorAll('.sh-newbox-row')).find((r) => r.querySelector('dt')?.textContent === name)).querySelector('dd')?.textContent;
    expect(row('Started by · row 4')).toBe('0x1F14…4eeE · anyone after 7 days without a step');
    expect(row('Started by · row 5')).toBe('0x15d3…6A65 · anyone after 7 days without a step');
    expect(row('Each step · row 4')).toBe('Up to 0.001 ETH');
    // One warning for both rows, the deployer's public steps included (SH-APP8).
    expect(within(fees).getAllByText('A trader can move a pool’s price just before any step.')).toHaveLength(1);
    expect(fees.textContent).not.toMatch(KEEPER_WORDS);
    expect(appCopyFraming(renderedCopy(fees))).toEqual([]);
  });
});

describe('SH-ALCHEMIST-LESS-TEXT the Fees step and the Overview: the choice in view, the rules behind a closed Details', () => {
  const ctxOf = (input: ReturnType<typeof pileInput>) => ({ ...recipeCtx(input), listings: [...DEMO_LISTINGS, { ...PAXG, id: 99, token: WETH, symbol: 'WETH', name: 'Wrapped Ether', powers: [] }] });
  const fees = (buyers: SidePick, sellers: SidePick = pickFor('burn')) => {
    const input = pileInput({ buyers, sellers });
    render(<MemoryRouter><FeesStep buyers={buyers} sellers={sellers} ctx={ctxOf(input)} collection={false} alchemist={{ pile: PAXG, answer: READY }} errorFor={() => null} set={() => undefined} /></MemoryRouter>);
    const group = (side: 'Buyers’' | 'Sellers’') => screen.getByRole('group', { name: side === 'Buyers’' ? 'Buyers’ fees · in ETH' : 'Sellers’ fees · paid in LEAD, used as ETH' });
    return { buyers: group('Buyers’'), sellers: group('Sellers’') };
  };
  const chips = (group: HTMLElement) => within(group).getAllByRole('button').filter((b) => b.hasAttribute('aria-pressed')).map((b) => b.textContent ?? '');
  const panelOf = (button: HTMLElement) => required(document.getElementById(required(button.getAttribute('aria-controls'))));

  it('Fees: the default view is the step’s two lines and each side’s chips; The Alchemist’s side adds one closed Details and no sentence', () => {
    const page = fees(alchemistPick(4));
    const toggle = within(page.buyers).getByRole('button', { name: 'Details: Alchemist, buyers’ fees' });
    expect(toggle.textContent).toBe('Details');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panelOf(toggle).hidden).toBe(true);
    expect(shownText(page.buyers)).toEqual(['Buyers’ fees · in ETH', ...chips(page.buyers), 'Details']);
    expect(shownText(page.sellers)).toEqual(['Sellers’ fees · paid in LEAD, used as ETH', ...chips(page.sellers)]);
    expect(chips(page.buyers)).toContain('The Alchemist');
    // The only sentences in view are the step's own two lines; Fee details stays closed.
    const lines = Array.from(document.querySelectorAll('p')).filter((p) => !tucked(p)).map((p) => p.textContent);
    // SH-SITE-FIXES-10: the price coin by its own name, no "P =" key.
    expect(lines).toEqual(['1% of every trade: in ETH on buys, in LEAD on sales', 'You choose where 10/15 goes']);
    expect(required(document.querySelector('details')).open).toBe(false);
    for (const words of ['Route · row 4', 'Each step', 'Too small', 'Started by', alchemistLine('PAXG'), ALCHEMIST_ROUTE_FIXED, FREEZE_LINE, INBOX_SIDE_LINE]) {
      expect(tucked(screen.getByText(words)), words).toBe(true);
    }
  });

  it('SH-251: the approved line on the fixed route follows the one line, inside the closed Details, word for word', () => {
    expect(ALCHEMIST_ROUTE_FIXED).toBe('This route never changes: if one of its pools stops working after graduation, these fees wait in the box until it works again, or for good if it never does.');
    const page = fees(alchemistPick(4));
    const toggle = within(page.buyers).getByRole('button', { name: 'Details: Alchemist, buyers’ fees' });
    const line = within(page.buyers).getByText(ALCHEMIST_ROUTE_FIXED);
    expect(tucked(line)).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const shown = shownText(panelOf(toggle));
    expect(shown.indexOf(ALCHEMIST_ROUTE_FIXED)).toBe(shown.indexOf(alchemistLine('PAXG')) + 1);
    expect(appCopyFraming([ALCHEMIST_ROUTE_FIXED])).toEqual([]);
  });

  it('Fees: pressed, its Details shows every moved line in its old order, the powers in their warning style, then the Terms link', () => {
    const page = fees(alchemistPick(4));
    const toggle = within(page.buyers).getByRole('button', { name: 'Details: Alchemist, buyers’ fees' });
    fireEvent.click(toggle);
    const panel = panelOf(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    expect(shownText(panel)).toEqual(['Route · row 4', 'ETH → WETH · Uniswap v3 · 0.3%', 'WETH → PAXG · Uniswap v2 · 0.3%', 'Each step', 'Up to 0.001 ETH',
      'Too small', '0.000000001 ETH or less stays in the box’s pool depth', 'Started by', '0x15d3…6A65 · anyone after 7 days without a step', alchemistLine('PAXG'), ALCHEMIST_ROUTE_FIXED, FREEZE_LINE, 'Terms, Section 6']);
    expect(within(panel).getByText(FREEZE_LINE).closest('ul')?.className).toBe('sh-newbox-warnings');
    expect(within(panel).getByRole('link', { name: 'Terms, Section 6' }).getAttribute('href')).toBe('/about/terms#terms-6');
    // The sellers' side has no Details while it keeps Burn.
    expect(within(page.sellers).queryByRole('button', { name: /^Details/ })).toBeNull();
  });

  it('Fees: The Alchemist on the sellers’ side alone keeps its inbox note in its own Details', () => {
    const page = fees(pickFor('burn'), alchemistPick(4));
    const toggle = within(page.sellers).getByRole('button', { name: 'Details: Alchemist, sellers’ fees' });
    const note = screen.getByText('The inbox will not feed the sellers’ Alchemist.');
    expect(panelOf(toggle).contains(note)).toBe(true);
    expect(tucked(note)).toBe(true);
    fireEvent.click(toggle);
    expect(tucked(note)).toBe(false);
    expect(shownText(panelOf(toggle)).slice(-2)).toEqual(['The inbox will not feed the sellers’ Alchemist.', 'Terms, Section 6']);
  });

  it('Overview: the Fees section shows its two side rows and one closed Details; pressed, the route, limits, trigger and warning', () => {
    const input = pileInput();
    const ctx = ctxOf(input);
    const spec = buildSpecV2(input);
    render(<MemoryRouter><OverviewV2 spec={spec} hash={specHashV2(spec)} form={input.form} v2={input.v2} ctx={ctx} plan={creationPlan(spec, ctx.pricing, { estimate: demoCreateGas })} nowMs={0} fix={new Set()} run={null} alchemist={[ROW]} /></MemoryRouter>);
    const section = required(screen.getByRole('heading', { name: 'Fees' }).closest('section'));
    expect(shownText(section)).toEqual(['Fees', 'Edit', 'Buyers’ fees', 'The Alchemist · row 4 · in ETH', 'Sellers’ fees', 'Buy back and burn LEAD · paid in LEAD, used as ETH', 'Details']);
    const toggle = within(section).getByRole('button', { name: 'Details: Alchemist' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(section).queryByText(ALCHEMIST_WARNING)?.closest('[hidden]')).not.toBeNull();
    fireEvent.click(toggle);
    expect(shownText(panelOf(toggle))).toEqual(['Route', 'ETH → WETH · Uniswap v3 · 0.3% · then WETH → PAXG · Uniswap v2 · 0.3%', 'Each step', 'Up to 0.001 ETH',
      'Too small', '0.000000001 ETH or less stays in the box’s pool depth', 'Started by', '0x15d3…6A65 · anyone after 7 days without a step', ALCHEMIST_WARNING, 'Terms, Section 6']);
    expect(within(panelOf(toggle)).getByText(ALCHEMIST_WARNING).closest('ul')?.className).toBe('sh-newbox-warnings');
    // The Edit link and the side rows stay outside the panel.
    expect(panelOf(toggle).contains(within(section).getByRole('link', { name: 'Edit Fees' }))).toBe(false);
    cleanup();
    // Without an Alchemist side there is nothing to hide: no Details in the Fees section.
    const plain = { ...input, v2: { ...input.v2, buyers: pickFor('burn') } };
    const plainSpec = buildSpecV2(plain);
    render(<MemoryRouter><OverviewV2 spec={plainSpec} hash={specHashV2(plainSpec)} form={plain.form} v2={plain.v2} ctx={ctx} plan={creationPlan(plainSpec, ctx.pricing, { estimate: demoCreateGas })} nowMs={0} fix={new Set()} run={null} alchemist={[ROW]} /></MemoryRouter>);
    const plainFees = required(screen.getByRole('heading', { name: 'Fees' }).closest('section'));
    expect(shownText(plainFees)).toEqual(['Fees', 'Edit', 'Buyers’ fees', 'Buy back and burn LEAD · in ETH', 'Sellers’ fees', 'Buy back and burn LEAD · paid in LEAD, used as ETH']);
  });
});

describe('SH-V21-FE14 The Alchemist’s reads', () => {
  it('the Demo offers none and asks nothing', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useAlchemistRows(NATIVE_TOKEN, PAXG.token), { wrapper: ({ children }) => <AppProviders>{children}</AppProviders> });
    expect(result.current).toEqual(ALCHEMIST_OFF);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it('reads over the source’s RPC, only after it says it serves the chain; a revert is an absent answer', async () => {
    const answers: string[] = [];
    const directory = '0x00000000000000000000000000000000000000d1';
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: readonly { to?: string }[] };
      answers.push(body.method);
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      if (body.method === 'eth_chainId') return reply('0x7a69');
      if (body.method === 'eth_getCode') return reply('0x6080');
      if (body.method === 'eth_call' && body.params[0]?.to?.toLowerCase() === '0x0000000000000000000000000000000000000071') {
        return reply(encodeFunctionResult({ abi: receiverModulesV21Abi, functionName: 'receiverCode', result: ['0x0000000000000000000000000000000000000073', '0x0000000000000000000000000000000000000074', directory] }));
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: 3, message: 'execution reverted', data: '0x' } }));
    }) as unknown as typeof fetch;
    const reads = rpcAlchemistReads('http://127.0.0.1:8599', 31337, fetchFn);
    expect(await reads.code('0x0000000000000000000000000000000000000051')).toBe('0x6080' as Hex);
    expect(answers[0]).toBe('eth_chainId');
    expect(await reads.call('0x0000000000000000000000000000000000000099', '0x12345678')).toBeNull();
    const source = { network: 'local', origin: 'https://indexer.invalid', rpc: 'http://127.0.0.1:8599', manifest: { chainId: 31337, chain: { poolManager: { address: '0x000000000000000000000000000000000000009f' } },
      releases: [{ implementations: { receiver: { address: '0x0000000000000000000000000000000000000071' }, coordinator: { address: '0x0000000000000000000000000000000000000072' } } }] } } as never;
    expect(await alchemistReleaseV21(reads, source)).toEqual({ poolManager: '0x000000000000000000000000000000000000009f', receiverImplementation: '0x0000000000000000000000000000000000000071', coordinatorImplementation: '0x0000000000000000000000000000000000000072', directory: '0x00000000000000000000000000000000000000D1' });
    // Another chain's RPC is never read.
    const wrong = rpcAlchemistReads('http://127.0.0.1:8599', 1, fetchFn);
    await expect(wrong.call(directory, '0x12345678')).rejects.toThrow(/serves chain 31337, not 1/);
  });
});
