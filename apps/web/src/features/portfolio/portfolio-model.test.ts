import { DEMO_PERSONAS, createMockAccountProvider } from '@squarehole/providers';
import { canonicalPairId } from '@squarehole/domain';
import { describe, expect, it } from 'vitest';
import { fixturePair } from '../../test-support/fixture';
import { toPositionView } from './portfolio-model';

const CURRENT = DEMO_PERSONAS.find((persona) => persona.id === 'current_holder')?.address ?? '0x00000000000000000000000000000000de000001';

async function positionOf(name: string) {
  const pair = fixturePair(name);
  const { positions } = await createMockAccountProvider().listPositions(CURRENT);
  const position = positions.find((candidate) => canonicalPairId(candidate.pairId) === canonicalPairId(pair.pairId));
  if (!position) throw new Error(`no ${name} position`);
  return { pair, position };
}

describe('toPositionView (economic units once, whole NFTs + fraction beneath)', () => {
  it('ORCHARD: 3.25 ORCH = 3 whole NFTs (#7, #12, #31) + 0.25 ORCH fraction', async () => {
    const { pair, position } = await positionOf('ORCHARD');
    expect(toPositionView(position, pair)).toEqual({
      nft: { wholeText: '3 whole NFTs', fractionText: '0.25 ORCH', unitText: '1 NFT = 1 ORCH', ids: ['#7', '#12', '#31'], unlistedWhole: 0n },
      demoValue: { value: '$7.8', price: '$2.4' },
    });
  });

  it('TINY FRAMES: 0.5 FRAME is a fraction only (0 whole NFTs, no ids)', async () => {
    const { pair, position } = await positionOf('TINY FRAMES');
    const view = toPositionView(position, pair);
    expect(view.nft).toEqual({ wholeText: '0 whole NFTs', fractionText: '0.5 FRAME', unitText: '1 NFT = 1 FRAME', ids: [], unlistedWhole: 0n });
  });

  it('ROUND TRIP: a token has no NFT representation', async () => {
    const { pair, position } = await positionOf('ROUND TRIP');
    const view = toPositionView(position, pair);
    expect(view.nft).toBeNull();
  });

  it('counts whole units without a listed id (e.g. NFTs from a demo claim) and has no value without a price', async () => {
    const { pair, position } = await positionOf('ORCHARD');
    const view = toPositionView({ ...position, balanceRaw: '5250000000000000000', wholeNftCount: '5', fractionalRaw: '250000000000000000' }, { ...pair, priceUsd: null });
    expect(view.nft?.wholeText).toBe('5 whole NFTs');
    expect(view.nft?.unlistedWhole).toBe(2n);
    expect(view.demoValue).toBeNull();
    expect(toPositionView({ ...position, balanceRaw: '1000000000000000000', wholeNftCount: '1', fractionalRaw: '0', nftTokenIds: ['7'] }, pair).nft).toMatchObject({
      wholeText: '1 whole NFT',
      fractionText: null,
    });
  });
});
