import type { Address, Hex, PublicClient } from 'viem';

/** Standard immutable clone layout only. An absent contract or unrecognized runtime is never a cache entry. */
export class HookCodeCache {
  private readonly entries = new Map<string, { code: Hex; minimum: bigint | undefined }>();
  private anchor: { number: bigint; hash: Hex } | undefined;

  /** One shared canonicality check for the fleet; a reorg, rewind or unreadable anchor forces fresh code. */
  async begin(pub: PublicClient, number: bigint, hash: Hex | null | undefined): Promise<void> {
    const previous = this.anchor;
    let canonical = false;
    if (previous && hash && number >= previous.number) {
      if (number === previous.number) canonical = hash === previous.hash;
      else if (this.entries.size) {
        try {
          const block = await pub.getBlock({ blockNumber: previous.number });
          canonical = block.number === previous.number && block.hash === previous.hash;
        } catch { /* Unproven code must be reread at this round's explicit block. */ }
      }
    }
    if (!canonical) this.entries.clear();
    this.anchor = hash && /^0x[0-9a-f]{64}$/i.test(hash) ? { number, hash } : undefined;
  }

  async minimum(pub: PublicClient, hook: Address, blockNumber: bigint): Promise<bigint | undefined> {
    const key = hook.toLowerCase();
    const known = this.entries.get(key);
    if (known) return known.minimum;
    const code = (await pub.getBytecode({ address: hook, blockNumber }))?.toLowerCase() as Hex | undefined;
    if (!code || code.length > 2 + 24_576 * 2 || !/^0x(?:[0-9a-f]{2})+$/.test(code)
      || !code.startsWith('0x363d3d373d3d3d363d73') || code.slice(62, 92) !== '5af43d82803e903d91602b57fd5bf3') return undefined;
    // BoxClones.ARGS_OFFSET 45; BoxHookV2Args.STEP_MIN_Q: offset 195, sixteen bytes.
    const minimum = code.length < 2 + (45 + 211) * 2 ? undefined
      : BigInt(`0x${code.slice(2 + (45 + 195) * 2, 2 + (45 + 211) * 2)}`);
    if (this.anchor?.number === blockNumber) {
      this.entries.set(key, { code, minimum });
      if (this.entries.size > 1024) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    return minimum;
  }
}
