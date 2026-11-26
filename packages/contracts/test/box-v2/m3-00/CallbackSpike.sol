// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Layout-cost spike only: three fresh item slots plus an exact ticket-index slot per entry.
/// No claim that this is the final ledger callback's worst case.
contract CallbackSpike {
    uint256 public constant CANDIDATE_BATCH = 1;
    struct Record { uint256 index; uint256 credit; uint256 stash; }
    mapping(uint256 => Record) public records;
    mapping(uint256 => uint256) public ticketStart;
    function record(uint256 count) external {
        for (uint256 i = 1; i <= count; ++i) {
            records[i] = Record(1, 2, 3); ticketStart[i] = 4;
        }
    }
}

contract CappedNotice {
    uint256 public calls;
    function notice(address ledger, uint256 count, uint256 cap) external returns (bool ok) {
        if (ledger == address(0)) return true;
        require(gasleft() >= cap + cap / 63 + 10_000, "gas floor");
        bytes memory data = abi.encodeCall(CallbackSpike.record, (count));
        assembly ("memory-safe") { ok := call(cap, ledger, 0, add(data, 32), mload(data), 0, 0) }
        ++calls;
    }
}

contract BurningNotice {
    fallback() external { assembly ("memory-safe") { for {} 1 {} {} } }
}
