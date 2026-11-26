// SH-290: holder payouts on a Flap or Four.meme token: the stake contract and its factory (bounties/core/src/
// IRailStake.sol, lane f), as typed constants: the entries of bounties/core/abi/RailStake.json and RailStakeFactory.json
// (lane f's 7bbbdfd6), without their internal types. test/stake.test.ts checks every entry against those files.
// Also the two reads that tell which payees a launch's tax pays: Flap's rules factory (rulesOf) and a rules splitter.

export const railStakeAbi = [
  {
    "type": "function",
    "name": "MAX_OUTSTANDING",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "PRECISION",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "arrived",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "asset",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ]
  },
  {
    "type": "function",
    "name": "claim",
    "stateMutability": "nonpayable",
    "inputs": [],
    "outputs": [
      {
        "name": "paid",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "claimTo",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "to",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "paid",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "claimable",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "claimed",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "creator",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ]
  },
  {
    "type": "function",
    "name": "earnedScaled",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "account",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "factory",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ]
  },
  {
    "type": "function",
    "name": "period",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "ratePerSecond",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "ratePerSecondScaled",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "stake",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "credited",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "stakedOf",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "streamEnd",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "end",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "sync",
    "stateMutability": "nonpayable",
    "inputs": [],
    "outputs": [
      {
        "name": "income",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "token",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ]
  },
  {
    "type": "function",
    "name": "totalStaked",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "undistributed",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "undistributedScaled",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "unstake",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "amount",
        "type": "uint256"
      }
    ],
    "outputs": []
  },
  {
    "type": "function",
    "name": "unsynced",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "event",
    "name": "Claimed",
    "anonymous": false,
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ]
  },
  {
    "type": "event",
    "name": "Staked",
    "anonymous": false,
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ]
  },
  {
    "type": "event",
    "name": "Synced",
    "anonymous": false,
    "inputs": [
      {
        "name": "income",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "undistributed",
        "type": "uint256",
        "indexed": false
      },
      {
        "name": "streamEnd",
        "type": "uint256",
        "indexed": false
      }
    ]
  },
  {
    "type": "event",
    "name": "Unstaked",
    "anonymous": false,
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "indexed": true
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false
      }
    ]
  },
  {
    "type": "error",
    "name": "BadReceiver",
    "inputs": []
  },
  {
    "type": "error",
    "name": "BalanceUnreadable",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotStaked",
    "inputs": [
      {
        "name": "staked",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "Reentrancy",
    "inputs": []
  },
  {
    "type": "error",
    "name": "TransferFailed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WrongAsset",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;

export const railStakeFactoryAbi = [
  {
    "type": "function",
    "name": "MAX_PERIOD",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "MIN_PERIOD",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "STAKE_CODE_HASH",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32"
      }
    ]
  },
  {
    "type": "function",
    "name": "create",
    "stateMutability": "nonpayable",
    "inputs": [
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "asset",
        "type": "address"
      },
      {
        "name": "period",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "stake",
        "type": "address"
      }
    ]
  },
  {
    "type": "function",
    "name": "isStake",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool"
      }
    ]
  },
  {
    "type": "function",
    "name": "parameters",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address"
      },
      {
        "name": "",
        "type": "address"
      },
      {
        "name": "",
        "type": "address"
      },
      {
        "name": "",
        "type": "uint256"
      }
    ]
  },
  {
    "type": "function",
    "name": "stakeAddress",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "creator",
        "type": "address"
      },
      {
        "name": "token",
        "type": "address"
      },
      {
        "name": "asset",
        "type": "address"
      },
      {
        "name": "period",
        "type": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ]
  },
  {
    "type": "function",
    "name": "stakeOf",
    "stateMutability": "view",
    "inputs": [
      {
        "name": "",
        "type": "address"
      },
      {
        "name": "",
        "type": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address"
      }
    ]
  },
  {
    "type": "event",
    "name": "StakeCreated",
    "anonymous": false,
    "inputs": [
      {
        "name": "stake",
        "type": "address",
        "indexed": true
      },
      {
        "name": "creator",
        "type": "address",
        "indexed": true
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true
      },
      {
        "name": "asset",
        "type": "address",
        "indexed": false
      },
      {
        "name": "period",
        "type": "uint256",
        "indexed": false
      }
    ]
  },
  {
    "type": "error",
    "name": "AlreadyCreated",
    "inputs": [
      {
        "name": "stake",
        "type": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidSettings",
    "inputs": [
      {
        "name": "reason",
        "type": "string"
      }
    ]
  }
] as const;

/** A Flap rules launch: the factory that holds its rules (`pileVaultFactory()`), and `rulesOf(launcher)` there. */
export const rulesLaunchAbi = [
  { type: 'function', name: 'pileVaultFactory', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;
export const rulesFactoryAbi = [
  {
    type: 'function',
    name: 'rulesOf',
    stateMutability: 'view',
    inputs: [{ name: 'launcher', type: 'address' }],
    outputs: [{ name: 'r', type: 'tuple[]', components: [{ name: 'kind', type: 'uint8' }, { name: 'bps', type: 'uint16' }, { name: 'target', type: 'address' }] }],
  },
] as const;
/** A Four.meme rules tax vault (`splitter()`) and its splitter (bounties/core/src/IRuleSplitter.sol). */
export const rulesVaultAbi = [
  { type: 'function', name: 'splitter', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;
export const ruleSplitterAbi = [
  { type: 'function', name: 'ruleCount', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  {
    type: 'function',
    name: 'rule',
    stateMutability: 'view',
    inputs: [{ name: 'i', type: 'uint256' }],
    outputs: [{ name: 'kind', type: 'uint8' }, { name: 'bps', type: 'uint16' }, { name: 'target', type: 'address' }],
  },
] as const;
