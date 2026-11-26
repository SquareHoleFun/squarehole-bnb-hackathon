export const CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
export const GENESIS = 1692803367n;
export const PERIOD = 3n;
export const RELAYS = Object.freeze([
  'https://api.drand.sh', 'https://api2.drand.sh', 'https://api3.drand.sh', 'https://drand.cloudflare.com',
]);
export const SILENCE = 604800n;
export const SILENCE_UNREQUESTED = 2592000n;
export const BACKUP_AFTER = 432000n;
export const LATEST_START = 496800n;
export const RECENT_BLOCKS = 8n;
export const TARGET_BLOCKS = 256n;
export const HISTORY_WINDOW = 8191n;
export const PINS = Object.freeze({
  '1': Object.freeze({
    address: '0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6',
    codeHash: '0xb835f0713da5f533832670cd4fa7ba4cc94b93203025f9412d87c9b575a54218',
    backedAddress: '0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb',
    backedCodeHash: '0x7b3be4b9531713d98f065160d3c2dd2f517a0d5203672d8cd3df590d82f2ffa3',
  }),
  '11155111': Object.freeze({
    address: '0xbeEcE13fBdd67D0A696cB7cfD28103Ed37ba79A6',
    codeHash: '0xb835f0713da5f533832670cd4fa7ba4cc94b93203025f9412d87c9b575a54218',
    backedAddress: '0x4FE27aE2810DAdA5F2f0f425F6623FdbE6A321fb',
    backedCodeHash: '0x7b3be4b9531713d98f065160d3c2dd2f517a0d5203672d8cd3df590d82f2ffa3',
  }),
});
export const roundTime = round => GENESIS + (round - 1n) * PERIOD;
