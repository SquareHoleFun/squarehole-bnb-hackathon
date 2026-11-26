import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, type Address, type PublicClient } from 'viem';
import { railStakeAbi, railStakeFactoryAbi } from '../src/abi/railStake';
import { HOLDERS_WORDS, HoldersPanel, launcherCreatorAbi } from '../src/components/HoldersPanel';
import { AppProvider } from '../src/lib/app-context';
import { checkConfig, type AppConfig } from '../src/lib/config';
import { REFUSALS } from '../src/lib/forms';
import { decodeError, ERROR_SENTENCES, STAKE_ERRORS } from '../src/lib/errors';
import { checkStake, checkUnstake, findStake, holderRate, RATE_SCALE, stakeShareText, streamState, timeLeft, ZERO } from '../src/lib/stake';

/** SH-290: the holders panel's model. */
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const FACTORY = A(0xf0), CREATOR = A(0xc0), TOKEN = A(0x70), STAKE = A(0x5a);

describe('the stake the panel shows: the creator’s own, made by our factory', () => {
  const client = (answers: Record<string, unknown>) => ({
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      const key = `${address.toLowerCase()}.${functionName}`;
      if (!(key in answers)) throw new Error(`not asked for: ${key}`);
      return answers[key];
    },
  }) as unknown as PublicClient;
  const good = {
    [`${FACTORY}.stakeOf`]: STAKE, [`${FACTORY}.isStake`]: true, [`${STAKE}.token`]: TOKEN, [`${STAKE}.factory`]: FACTORY,
    [`${STAKE}.asset`]: ZERO, [`${STAKE}.period`]: 604_800n,
  };
  const paid = async () => [A(0x01), STAKE, A(0x02)];
  it('found: ours, the token’s, and one of the targets the launch’s rules pay', async () => {
    expect(await findStake(client(good), FACTORY, CREATOR, TOKEN, paid)).toEqual({ stake: STAKE, token: TOKEN, asset: ZERO, period: 604_800n });
  });
  it('none: not created, not our factory’s, for another token, from another factory, or paid by no rule', async () => {
    expect(await findStake(client({ ...good, [`${FACTORY}.stakeOf`]: ZERO }), FACTORY, CREATOR, TOKEN, paid)).toBeNull();
    expect(await findStake(client({ ...good, [`${FACTORY}.isStake`]: false }), FACTORY, CREATOR, TOKEN, paid)).toBeNull();
    expect(await findStake(client({ ...good, [`${STAKE}.token`]: A(0x71) }), FACTORY, CREATOR, TOKEN, paid)).toBeNull();
    expect(await findStake(client({ ...good, [`${STAKE}.factory`]: A(0xf1) }), FACTORY, CREATOR, TOKEN, paid)).toBeNull();
    expect(await findStake(client(good), FACTORY, CREATOR, TOKEN, async () => [A(0x01)])).toBeNull();
    expect(await findStake(client(good), FACTORY, CREATOR, TOKEN, async () => [])).toBeNull();
  });
});

describe('the numbers', () => {
  it('one holder’s share of the stream, from the scaled rate (never 0 while a small stream pays)', () => {
    expect(holderRate(1_000n * RATE_SCALE, 25n, 100n)).toBe(250n);
    expect(holderRate(1_000n * RATE_SCALE, 0n, 100n)).toBe(0n);
    expect(holderRate(1_000n * RATE_SCALE, 5n, 0n)).toBe(0n);
    // A stream of 0.4 last units a second (the whole-unit rate reads 0): 34,560 a day for the only staker.
    expect(holderRate(4n * RATE_SCALE / 10n, 7n, 7n, 86_400n)).toBe(34_560n);
    expect(holderRate(10n ** 30n, 10n ** 27n, 3n * 10n ** 27n)).toBe(333n);
  });
  it('the stream: none, streaming, paused while nobody is staked, a leftover after the end', () => {
    expect(streamState({ undistributed: 0n, streamEnd: 100n, totalStaked: 5n, now: 50n })).toBe('none');
    expect(streamState({ undistributed: 0n, streamEnd: 40n, totalStaked: 5n, now: 50n })).toBe('none');
    expect(streamState({ undistributed: 9n, streamEnd: 100n, totalStaked: 5n, now: 50n })).toBe('streaming');
    expect(streamState({ undistributed: 9n, streamEnd: 100n, totalStaked: 0n, now: 50n })).toBe('paused');
    expect(streamState({ undistributed: 9n, streamEnd: 40n, totalStaked: 0n, now: 50n })).toBe('paused');
    // Stakers, the end passed, a remainder waiting: nothing pays, so never "Paying out".
    expect(streamState({ undistributed: 9n, streamEnd: 40n, totalStaked: 5n, now: 50n })).toBe('leftover');
    expect(streamState({ undistributed: 9n, streamEnd: 50n, totalStaked: 5n, now: 50n })).toBe('leftover');
    expect([HOLDERS_WORDS.leftover, HOLDERS_WORDS.leftoverNote]).toEqual(['Left over', 'paid with the next income.']);
  });
  it('the share: a stake that earns never reads 0%', () => {
    expect(stakeShareText(400n * 10n ** 18n, 300_000_400n * 10n ** 18n)).toBe('<0.01%');
    expect(stakeShareText(1n, 10n ** 30n)).toBe('<0.01%');
    expect(stakeShareText(0n, 100n)).toBe('0%');
    expect(stakeShareText(1n, 10_000n)).toBe('0.01%');
    expect(stakeShareText(1n, 8n)).toBe('12.5%');
    expect(stakeShareText(5n, 5n)).toBe('100%');
  });
  it('time left', () => {
    expect([timeLeft(0n), timeLeft(40n), timeLeft(360n), timeLeft(3_600n * 4n + 300n), timeLeft(86_400n * 2n + 3_600n * 3n)]).toEqual(['0 s', '40 s', '6 min', '4 h 5 min', '2 d 3 h']);
  });
  it('stake and unstake amounts, to the last unit', () => {
    expect(checkStake('1.5', 18, 2n * 10n ** 18n)).toEqual({ ok: true, value: 15n * 10n ** 17n });
    expect(checkStake('0.000000000000000001', 18, 1n)).toEqual({ ok: true, value: 1n });
    expect(checkStake('3', 18, 2n * 10n ** 18n)).toEqual({ ok: false, refusal: 'over-balance' });
    expect(checkStake('0', 18, 2n)).toEqual({ ok: false, refusal: 'zero' });
    expect(checkUnstake('2', 18, 10n ** 18n)).toEqual({ ok: false, refusal: 'over-staked' });
    expect(checkUnstake('1', 18, 10n ** 18n)).toEqual({ ok: true, value: 10n ** 18n });
    expect(REFUSALS['over-staked']).toBe('More than you have staked.');
  });
});

describe('the stake’s refusals read as the stake’s sentences, keyed by contract', () => {
  const reverted = (errorName: string) =>
    new BaseError('call failed', {
      cause: new ContractFunctionRevertedError({ abi: railStakeAbi, data: encodeErrorResult({ abi: railStakeAbi, errorName } as never), functionName: 'stake' }),
    });
  it('each of the stake’s errors has its sentence with the stake’s kind', () => {
    expect(STAKE_ERRORS).toEqual({
      NotStaked: 'More than you have staked.',
      TransferFailed: 'A transfer did not go through.',
      WrongAsset: 'This stake is paid in a token, not in the native coin.',
      BalanceUnreadable: 'The token’s balance could not be read, so nothing was staked.',
      BadReceiver: 'That address cannot receive the payout.',
    });
    for (const name of ['TransferFailed', 'WrongAsset', 'BalanceUnreadable', 'BadReceiver']) {
      expect(decodeError(reverted(name), 18, 'stake')).toEqual({ name, sentence: STAKE_ERRORS[name] });
    }
    // Shared names still read their shared sentence with the stake's kind.
    expect(decodeError(reverted('ZeroAmount'), 18, 'stake').sentence).toBe(ERROR_SENTENCES.ZeroAmount);
    expect(decodeError(reverted('Reentrancy'), 18, 'stake').sentence).toBe(ERROR_SENTENCES.Reentrancy);
  });
  it('without the kind, no stake sentence answers for another contract’s error of the same name', () => {
    for (const name of ['TransferFailed', 'BadReceiver', 'BalanceUnreadable', 'WrongAsset', 'NotStaked']) expect(ERROR_SENTENCES[name]).toBeUndefined();
    for (const name of ['TransferFailed', 'BadReceiver', 'BalanceUnreadable', 'WrongAsset']) {
      expect(decodeError(reverted(name)).sentence).toBe('The contract refused this call.');
    }
  });
});

describe('the deployment file and the interfaces', () => {
  it('the factory is optional; given, it must be an address', () => {
    const base = { chainId: 97, rpcUrls: ['https://bsc-testnet-rpc.publicnode.com'], explorer: 'https://testnet.bscscan.com', fromBlock: '1' };
    const without = checkConfig(base);
    expect(without.ok && without.value.railStake).toBeUndefined();
    const withIt = checkConfig({ ...base, railStake: { factory: FACTORY } });
    expect(withIt.ok && withIt.value.railStake).toEqual({ factory: FACTORY });
    expect(checkConfig({ ...base, railStake: { factory: 'nope' } }).ok).toBe(false);
    expect(checkConfig({ ...base, railStake: { factory: FACTORY, more: 1 } }).ok).toBe(false);
  });
  it('the stake’s and the factory’s calls, events and errors are the fixed interface’s', () => {
    const names = (abi: readonly { type: string; name?: string }[], type: string) => abi.filter((e) => e.type === type).map((e) => e.name).sort();
    for (const call of ['arrived', 'asset', 'claim', 'claimTo', 'claimable', 'claimed', 'creator', 'factory', 'period', 'ratePerSecondScaled', 'stake', 'stakedOf', 'streamEnd', 'sync', 'token', 'totalStaked', 'undistributed', 'unstake', 'unsynced']) {
      expect(names(railStakeAbi, 'function')).toContain(call);
    }
    expect(names(railStakeAbi, 'event')).toEqual(['Claimed', 'Staked', 'Synced', 'Unstaked']);
    expect(names(railStakeAbi, 'error')).toEqual(['BadReceiver', 'BalanceUnreadable', 'NotStaked', 'Reentrancy', 'TransferFailed', 'WrongAsset', 'ZeroAmount']);
    for (const call of ['MAX_PERIOD', 'MIN_PERIOD', 'create', 'isStake', 'stakeAddress', 'stakeOf']) expect(names(railStakeFactoryAbi, 'function')).toContain(call);
    expect(names(railStakeFactoryAbi, 'event')).toEqual(['StakeCreated']);
  });
  it('every entry is lane f’s, by its exported ABI files', () => {
    type Entry = { readonly type: string; readonly name?: string; readonly inputs?: readonly { readonly type: string }[]; readonly outputs?: readonly { readonly type: string }[]; readonly stateMutability?: string };
    const sig = (e: Entry) => `${e.type} ${e.name}(${(e.inputs ?? []).map((i) => i.type).join(',')})${e.type === 'function' ? `${e.stateMutability} ${(e.outputs ?? []).map((o) => o.type).join(',')}` : ''}`;
    let compared = 0;
    for (const [mine, file] of [[railStakeAbi, 'RailStake.json'], [railStakeFactoryAbi, 'RailStakeFactory.json']] as const) {
      const url = new URL(`../../core/abi/${file}`, import.meta.url);
      if (!existsSync(url)) continue;
      const theirs = new Set((JSON.parse(readFileSync(url, 'utf8')) as Entry[]).map(sig));
      for (const e of mine as readonly Entry[]) expect(theirs.has(sig(e)), sig(e)).toBe(true);
      compared += 1;
    }
    expect(compared).toBe(2);
  });
  it('the sale’s creator() is the Flap entry’s own', () => {
    const launcher = JSON.parse(readFileSync(new URL('../../flap/abi/CurveLauncher.json', import.meta.url), 'utf8')) as { type: string; name?: string; outputs?: { type: string }[]; inputs?: unknown[] }[];
    const creator = launcher.find((e) => e.type === 'function' && e.name === 'creator');
    expect(creator?.inputs).toEqual([]);
    expect(creator?.outputs?.map((o) => o.type)).toEqual(['address']);
    expect(launcherCreatorAbi[0].name).toBe('creator');
  });
});

describe('the panel without our factory', () => {
  it('draws nothing (the page is exactly as before)', () => {
    const config = { chainId: 97, rpcUrl: 'http://127.0.0.1:1', rpcUrls: ['http://127.0.0.1:1'], explorer: 'https://testnet.bscscan.com', fromBlock: '0' } as AppConfig;
    const html = renderToStaticMarkup(createElement(AppProvider, { config, children: createElement(HoldersPanel, { token: TOKEN, creator: CREATOR, payees: async () => [STAKE], payeesKey: 'x' }) }));
    expect(html).toBe('');
    expect(HOLDERS_WORDS.helpLines).toHaveLength(3);
  });
});
