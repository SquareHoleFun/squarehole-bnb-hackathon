import { expect } from '@playwright/test';
import { delay, rpc } from '../../../../../packages/chain/scripts/lib/core-v2-local-runtime.mjs';

// The real indexer's v2 feed; nothing is synthesized or cached here.
const feedOf = async chain => (await fetch(`http://127.0.0.1:${chain.ports.gatewayPort}/v2/feed?chain=${chain.chainId}`,
  { signal: AbortSignal.timeout(5000) })).json();
const cardOf = (feed, token) => feed.cards.find(card => card.token.toLowerCase() === token.toLowerCase());

/**
 * The indexer lists a new box once its code checks pass (its pictures play no part, SH-NO-PICTURE-GATE). Its money
 * audit runs every 32 heads, and this chain mines only on sends, so right after creation `verified` is still null:
 * wait for the listing alone.
 */
export async function listedCard(chain, token, { timeout } = {}) {
  let card; let hidden = [];
  try {
    await expect.poll(async () => {
      const feed = await feedOf(chain);
      card = cardOf(feed, token); hidden = feed.hidden ?? [];
      return card !== undefined;
    }, timeout === undefined ? {} : { timeout }).toBe(true);
  } catch (error) {
    throw new Error(`the indexer does not list box ${token}; not shown: ${JSON.stringify(hidden)}`, { cause: error });
  }
  return card;
}

/**
 * The box's card at the current head, audited (BC-080). The indexer audits every 32 heads and this chain mines only
 * on sends, so a box with few sends since its creation (Rug Rugs reaches its failure in about ten) may not be audited
 * yet. Empty blocks stand in for the heads a public network keeps producing: they change no box state and advance
 * chain time by one second each. A card the audit refutes fails at once with its mismatches. Catching up after a
 * burst of sends (an item ledger sync can be a hundred) takes the indexer a while: the wait lasts while its head
 * advances and fails after `stallMs` without progress.
 */
export async function currentCard(chain, token, evidence, { maxBlocks = 64, stallMs = 30_000 } = {}) {
  let head = BigInt(await rpc(chain.rpcUrl, 'eth_blockNumber'));
  for (let mined = 0; ; mined += 1) {
    let card;
    for (let seen = -1n, progress = Date.now(); ;) {
      card = cardOf(await feedOf(chain), token);
      // A repair (stale) re-audits on its own; only a settled refutation is a disagreement with the chain.
      if (card && !card.stale && card.verified === false) throw new Error(`the indexer's audit refutes box ${token}: ${JSON.stringify(card.audit)}`);
      const at = card ? BigInt(card.asOf.block) : -1n;
      if (card && !card.stale && at >= head) break;
      if (at > seen) { seen = at; progress = Date.now(); }
      else if (Date.now() - progress > stallMs) {
        throw new Error(`the indexer stalled at block ${seen} (head ${head}) for box ${token}: ${JSON.stringify({ stale: card?.stale, asOf: card?.asOf })}`);
      }
      await delay(100);
    }
    if (card.verified === true) {
      if (mined > 0 && evidence) (evidence.emptyBlocks ??= []).push({ token, mined, block: card.asOf.block });
      return card;
    }
    if (mined === maxBlocks) throw new Error(`box ${token} was not audited within ${maxBlocks} empty blocks`);
    await rpc(chain.rpcUrl, 'evm_mine');
    head = BigInt(await rpc(chain.rpcUrl, 'eth_blockNumber'));
  }
}
