import { viem } from './deps.mjs';

// Deliberately owned here; text-only drift tests compare selectors and outputs with the generated ABIs.
export const ABIS = {
  boxTickets: viem.parseAbi([
    'function status() view returns ((uint40 minted, uint32 slots, uint40 wordRequestedAt, uint40 wordAcceptedAt, uint40 terminalAt, uint32 drawsRequested, uint32 drawsSettled))',
    'function phase() view returns (uint8)',
    'function source() view returns (address)',
    'function vault() view returns (address)',
    'function requestGraduationWord() payable',
    'function acceptGraduationWord()',
    'error WordAlreadyRequested()',
    'error WordAlreadyAccepted()',
    'error WordNotReady()',
    'error HeadNotDead(uint256 key, uint256 deadline)',
    'error NothingPending()',
  ]),
  drandSource: viem.parseAbi([
    'function requestOf(address consumer, uint256 key) view returns (uint64 requestedAt, uint64 round)',
    'function wordOf(address consumer, uint256 key) view returns (bytes32 word, uint64 readyAt)',
    'function postRound(uint256 round, bytes signature) returns (bytes32 randomness)',
    'event RoundPosted(uint256 indexed round, bytes32 randomness, address indexed poster, uint256 bounty)',
    'error RoundKnown(uint256 round)',
    'error RoundNotYet(uint256 round, uint256 at)',
    'error InvalidSignature(uint256 round)',
  ]),
  backedSource: viem.parseAbi([
    'function DRAND() view returns (address)',
    'function requestOf(address consumer, uint256 key) view returns (uint64 requestedAt, uint64 round)',
    'function wordOf(address consumer, uint256 key) view returns (bytes32 word, uint64 readyAt)',
    'function backupOf(uint256 round) view returns (uint64 startedAt, uint64 targetBlock, uint64 fixedAt, bytes32 mix)',
    'function startBackup(uint256 round, uint256 headerBlock, bytes header) returns (uint256 target)',
    'function fixBackup(uint256 round, bytes header) returns (bytes32 mix)',
    'event BackupStarted(uint256 indexed round, uint256 targetBlock, address indexed by)',
    'event BackupFixed(uint256 indexed round, uint256 targetBlock, bytes32 mix, address indexed by)',
    'error RoundAlreadyPosted(uint256 round)',
    'error BackupTooEarly(uint256 round, uint256 at)',
    'error BackupTooLate(uint256 round, uint256 until)',
    'error BackupAlreadyStarted(uint256 round)',
    'error BackupAlreadyFixed(uint256 round)',
    'error NoBackup(uint256 round)',
    'error HeaderUnavailable(uint256 blockNumber)',
    'error WrongHeader(uint256 blockNumber)',
    'error BadHeader()',
  ]),
  boxRegistry: viem.parseAbi(['function coordinatorOf(uint256 boxId) view returns (address)']),
  boxCoordinator: viem.parseAbi(['function tickets() view returns (address)']),
  boxVault: viem.parseAbi(['function gateOpenedAt() view returns (uint256)']),
};
export const ABI = Object.values(ABIS).flat();
export const SIGNATURES = Object.freeze({
  start: 'startBackup(uint256,uint256,bytes)', fix: 'fixBackup(uint256,bytes)',
  request: 'requestGraduationWord()', post: 'postRound(uint256,bytes)', accept: 'acceptGraduationWord()',
});
