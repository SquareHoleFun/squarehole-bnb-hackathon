import { parseAbi } from 'viem';
// Safe interfaces are absent from packages/chain; no project contract ABI is duplicated here.
export const safeReadAbi = parseAbi([
  'function nonce() view returns (uint256)', 'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)', 'function VERSION() view returns (string)',
  'function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)',
  'event SafeReceived(address indexed sender,uint256 value)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)',
]);
