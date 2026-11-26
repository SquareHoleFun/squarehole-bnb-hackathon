import { abiCall, BURN_SELECTOR, CLASS, encodeFunctionData, encodePacked, PROBE_AMOUNT, registryAbi, cloneCode, keccak256, toHex, need } from './common.mjs';

export function listingCalls(config, coin, raise, allowance, royaltyLot, withBurn = Boolean(coin.burnSelector)) {
  need(royaltyLot && typeof royaltyLot.lot === 'bigint' && royaltyLot.lot > 0n, 'reviewed royalty lot required');
  const approve = amount => ({ to: coin.token, value: '0', data: abiCall('function approve(address,uint256) returns (bool)', [config.registry.address, amount]).data,
    contractMethod: null, contractInputsValues: null });
  return [...(allowance > 0n ? [approve(0n)] : []), approve(PROBE_AMOUNT), {
    to: config.registry.address, value: '0', data: encodeFunctionData({ abi: registryAbi, functionName: withBurn ? 'addWithBurn' : 'add',
      args: withBurn ? [coin.token, CLASS[coin.class], raise, BURN_SELECTOR] : [coin.token, CLASS[coin.class], raise] }),
    contractMethod: null, contractInputsValues: null,
  }, {
    to: config.registry.address, value: '0',
    data: abiCall('function setRoyaltyLot(uint32,uint256)', [royaltyLot.listingId, royaltyLot.lot]).data,
    contractMethod: null, contractInputsValues: null,
  }];
}
export function multiSend(config, calls) {
  const packed = `0x${calls.map(c => encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'],
    [0, c.to, 0n, BigInt((c.data.length - 2) / 2), c.data]).slice(2)).join('')}`;
  return { to: config.multiSend.address, value: '0', operation: 1,
    data: abiCall('function multiSend(bytes transactions) payable', [packed]).data };
}
export async function simulate(reader, config, calls) {
  // Some endpoints silently discard extra eth_call parameters. Prove code replacement works before
  // accepting an empty MultiSend response, which an unchanged Safe fallback could also produce.
  if (!reader.overrideCapability) {
    const marker = keccak256(toHex('Square Hole listing kit state override capability v1'));
    reader.overrideCapability = reader.request('eth_call', [{ to: config.safe, from: config.safe, data: '0x' }, reader.tag,
      { [config.safe]: { code: `0x7f${marker.slice(2)}5f5260205ff3` } }], false)
      .then(result => { need(result === marker, 'state overrides ignored'); });
  }
  await reader.overrideCapability;
  const envelope = multiSend(config, calls);
  // Only the Safe's code is overridden. Balances, token code/storage and the registry are real.
  // Delegatecall into the pinned CALL-only MultiSend preserves the Safe as ERC-20 funder/lister.
  return reader.request('eth_call', [{ to: config.safe, from: config.safe, data: envelope.data, gas: '0x1c9c380' }, reader.tag,
    { [config.safe]: { code: cloneCode(config.multiSend.address) } }], false);
}
export function transactionBuilder(config, calls, timestamp, lots = []) {
  return { version: '1.0', chainId: config.chainId, createdAt: parseInt((timestamp * 1000n).toString(), 10),
    meta: { name: 'Square Hole price coin listings', description: 'Unsigned CALL-only batch. Select all entries in Safe Transaction Builder; execute as one MultiSend. Recheck listing IDs and fork-rehearse before signing. CW2 lots use two significant digits (whole-coin results become 1.1 coins). ' + lots.map(e => `Listing ${e.listingId}: ${e.token}, raw lot ${e.lot}; price ${e.price.tokenAmount} raw token = ${e.price.wethAmount} WETH wei; ${e.price.source}; block ${e.price.blockNumber} (${e.price.blockHash}), timestamp ${e.price.timestamp}.`).join(' '),
      txBuilderVersion: '1.18.0', createdFromSafeAddress: config.safe, createdFromOwnerAddress: '' },
    transactions: calls };
}
