import type { Address, Hex } from 'viem';

/** Public deployment pins, changed only by code review. No runtime/config/env override. */
export interface EthParityPin {
  /** Only Sepolia (11155111) or BNB Chain testnet (97, SH-259). An entry for any other chain is refused. */
  readonly chainId: string;
  readonly token: Address;
  /** Decimal string, 6..18, checked on chain at the finalized block. */
  readonly decimals: string;
  /** Runtime keccak256, checked at finality. A null pin counts nothing. */
  readonly codeHash: Hex | null;
  /** Positive decimal-string wei (of the chain's native coin) of keeper room per whole coin, bounded by uint256. */
  readonly weiPerCoin: string;
}

/** SH-236 part A: proposed rates await the founder. Seven literals, changed together by code review. */
export const testCoinRates = Object.freeze({
  tETH: '1000000000000000000',
  tUSDC: '10000000000000000000',
  tNVDA: '10000000000000000000',
  tLINK: '10000000000000000000',
  tGOLD: '1000000000000000000000',
  tPEPE: '10000000000000000',
  tFROG: '10000000000000000',
});

/**
 * Keeper room only; no sale, pool or gas-wallet ETH. tETH retains F164 D3's 1:1 valuation.
 * tETH address/hash: packages/chain/src/trade-sepolia/coin-deployment.json (deployed, sh-177).
 * Six other addresses/decimals/hashes: docs/evidence/SH-SEPOLIA-EXAMPLES-INFRA.md, step 3a.
 * The trade record covers four pairs, not every listing. Later coins need their own reviewed pin.
 * Production never imports trade-sepolia. Receipt proofs and income/spending limits remain unchanged.
 */
export const ethParityManifest: Readonly<Record<string, EthParityPin>> = Object.freeze({
  '11155111:0x7156c3e4dd23f5776c26b3f6140bc03ffb7c4d5e': Object.freeze({
    chainId: '11155111', token: '0x7156c3e4DD23F5776c26b3F6140BC03fFb7c4D5E', decimals: '18',
    codeHash: '0xd505c35f935774b06c15d563b72fc31ddab453a4c83c3e4297e2e1ba76a3ee6c', weiPerCoin: testCoinRates.tETH,
  }),
  '11155111:0x5b397f65571def193ba5dbe8b2a353c3963c65f6': Object.freeze({
    chainId: '11155111', token: '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6', decimals: '6',
    codeHash: '0x5837487a0e4a1474c40c1e21e37f318dc24c716f1cc70fca32fb00d125ded928', weiPerCoin: testCoinRates.tUSDC,
  }),
  '11155111:0x2cbbad2607fccfee778d959d386997862099f33b': Object.freeze({
    chainId: '11155111', token: '0x2cbBAD2607fCCFEe778d959d386997862099f33B', decimals: '18',
    codeHash: '0xcd10e4a3585ed7988888c647416aa7dc2d03416bef9a4f1c1a7b775e2379d650', weiPerCoin: testCoinRates.tNVDA,
  }),
  '11155111:0xb1b5cddb6be298e9188984e53513b0db38eea6d7': Object.freeze({
    chainId: '11155111', token: '0xb1b5CDdB6Be298e9188984e53513B0db38eEa6D7', decimals: '18',
    codeHash: '0xcd10e4a3585ed7988888c647416aa7dc2d03416bef9a4f1c1a7b775e2379d650', weiPerCoin: testCoinRates.tLINK,
  }),
  '11155111:0x25f276ce776f5c9b0686250e78ea34bf7ab4c17a': Object.freeze({
    chainId: '11155111', token: '0x25f276Ce776f5C9b0686250e78EA34bF7aB4C17A', decimals: '18',
    codeHash: '0x92b27e4de58da269118de73a7445a685069b10e13eb23355cdd5639d24c5481a', weiPerCoin: testCoinRates.tGOLD,
  }),
  '11155111:0x1c5231c8bdde9ed7aa80fe13edb634db9bd3e1c7': Object.freeze({
    chainId: '11155111', token: '0x1C5231c8BDde9ED7AA80Fe13EDb634db9Bd3E1c7', decimals: '18',
    codeHash: '0xcd10e4a3585ed7988888c647416aa7dc2d03416bef9a4f1c1a7b775e2379d650', weiPerCoin: testCoinRates.tPEPE,
  }),
  '11155111:0x86d5c2533a78077c125630d4d1d1b2321a07eb35': Object.freeze({
    chainId: '11155111', token: '0x86d5c2533A78077c125630d4D1D1B2321A07Eb35', decimals: '18',
    codeHash: '0xe61b0e2559814a1a64ca184e8ed3d9fa4455e499dc64731c3a408ba371b4d37d', weiPerCoin: testCoinRates.tFROG,
  }),
  // SH-259: BNB Chain testnet (97), the release deployment's test coins (packages/contracts/deployments/bnb-testnet/
  // 97-extras.json, `coins`, written from the real network at finalized block 144758967; the same addresses and runtime
  // code hashes as SH-260's rehearsals predicted). A pin that does not match the chain counts nothing (PIN_INVALID).
  '97:0x860822580d4eb2529de0c74c3e2b1d6d7c183302': Object.freeze({
    chainId: '97', token: '0x860822580d4EB2529DE0C74c3E2B1D6D7C183302', decimals: '18',
    codeHash: '0xd505c35f935774b06c15d563b72fc31ddab453a4c83c3e4297e2e1ba76a3ee6c', weiPerCoin: testCoinRates.tETH,
  }),
  '97:0x25c5789b269d8f76309ce961759d643dce291347': Object.freeze({
    chainId: '97', token: '0x25C5789b269D8f76309CE961759d643dce291347', decimals: '6',
    codeHash: '0x5837487a0e4a1474c40c1e21e37f318dc24c716f1cc70fca32fb00d125ded928', weiPerCoin: testCoinRates.tUSDC,
  }),
  '97:0x2f8029a6447663e0881b0e21f5e4ad0f1717627e': Object.freeze({
    chainId: '97', token: '0x2F8029A6447663e0881b0E21F5E4aD0f1717627e', decimals: '18',
    codeHash: '0xcd10e4a3585ed7988888c647416aa7dc2d03416bef9a4f1c1a7b775e2379d650', weiPerCoin: testCoinRates.tNVDA,
  }),
  '97:0x4ba04db6044a6f442bdb29b032cb019f663ab164': Object.freeze({
    chainId: '97', token: '0x4bA04db6044A6F442BDB29B032CB019F663Ab164', decimals: '18',
    codeHash: '0x9a27ae2b73983ba987c573588e58db35225f8e0ca8894f454c5c48d71ef43501', weiPerCoin: testCoinRates.tGOLD,
  }),
  '97:0xf4f59ecf2221c9c07ca8fcf47a2652008fea2ed8': Object.freeze({
    chainId: '97', token: '0xF4F59ECf2221c9c07cA8fCF47A2652008FeA2Ed8', decimals: '18',
    codeHash: '0xcd10e4a3585ed7988888c647416aa7dc2d03416bef9a4f1c1a7b775e2379d650', weiPerCoin: testCoinRates.tPEPE,
  }),
});
