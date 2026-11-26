// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandSourcePins} from "../../../src/box/randomness/DrandSourcePins.sol";
import {DrandWords} from "../../../src/box/randomness/DrandWords.sol";
import {DrandSourceConformance} from "./DrandSourceConformance.sol";
import {PinnedDrandSource} from "./utils/PinnedDrandSource.sol";

/// @notice A consumer on the fork: requests through the library, reads through the bounded read.
contract ForkBox {
    IDrandSource internal immutable src;

    constructor(IDrandSource src_) {
        src = src_;
    }

    function request(uint256 key) external payable returns (uint256) {
        return DrandWords.request(src, key, msg.value);
    }

    function wordOf(uint256 key) external view returns (bytes32, uint256) {
        return DrandWords.wordOf(src, key);
    }
}

/// @notice `DrandSource` on a read-only fork of mainnet or Sepolia at the pinned block the v2 fork suites use
/// (nothing is broadcast, no key is used): the real canonical deployer puts the source at the pinned address with the
/// pinned code hash (nothing is there at the fork block); a request in the fork block fixes the round 12 s later (13 s
/// on mainnet, whose block times are 2 mod 3 s against the rounds, 12 s on Sepolia), and that **real quicknet round**
/// (api.drand.sh, `test/vectors/drand-quicknet-box.json`) verifies on chain from its time on, giving the word and the
/// bounty; `wordOf` stays under 50,000 gas cold; then BC-053's instance checks run on the pinned deployment
/// (`DrandSourceConformance`). EVM Osaka (EIP-2537), as both chains run.
abstract contract DrandSourceForkBase is DrandSourceConformance {
    IDrandSource internal src;
    bool internal forkEnabled;
    uint256 internal forkTime;

    function _chainId() internal pure virtual returns (uint256);
    function _forkBlock() internal pure virtual returns (uint256);
    function _forkTimestamp() internal pure virtual returns (uint256);
    function _forkRound() internal pure virtual returns (uint256);
    function _enabledVar() internal pure virtual returns (string memory);
    function _rpcVar() internal pure virtual returns (string memory);
    function _defaultRpc() internal pure virtual returns (string memory);

    function setUp() public {
        forkEnabled = vm.envOr(_enabledVar(), false);
        if (!forkEnabled) return;
        vm.createSelectFork(vm.envOr(_rpcVar(), _defaultRpc()), _forkBlock());
        assertEq(block.chainid, _chainId());
        assertEq(block.timestamp, _forkTimestamp(), "the pinned block's time (the round depends on it)");
        forkTime = block.timestamp;
        _loadBoxDrand();
        assertGt(DrandSourcePins.DEPLOYER.code.length, 0, "the canonical deployer is on this chain");
        address pin = PinnedDrandSource.predict();
        assertEq(pin.code.length, 0, "nothing at the pinned address at the fork block");
        src = IDrandSource(address(PinnedDrandSource.deploy(vm)));
    }

    modifier forkOnly() {
        if (!forkEnabled) vm.skip(true);
        _;
    }

    function _source() internal view override returns (IDrandSource) {
        return src;
    }

    function test_fork_theRealDeployerPutsTheSourceAtThePin() public forkOnly {
        (address pin, bytes32 codeHash) = DrandSourcePins.pinned(block.chainid);
        assertEq(address(src), pin, "the pinned address");
        assertEq(address(src).codehash, codeHash, "the pinned code hash");
        assertEq(address(src).balance, 0);
    }

    /// The request lands in the fork block; its round is a real quicknet round, posted from its time on by anyone and
    /// verified on chain, with the bounty paid to the poster.
    function test_fork_aRequestAtTheForkBlockGetsARealRound() public forkOnly {
        ForkBox box = new ForkBox{salt: keccak256("squarehole.fork.box")}(src);
        vm.deal(address(this), 1 ether);
        uint256 round = box.request{value: 0.001 ether}(1);
        assertEq(round, _forkRound(), "the committed round for this fork block");
        Round memory v = _boxDrand(round);
        assertEq(v.time - forkTime, block.chainid == 1 ? 13 : 12, "the margin as the chain's clock gives it");
        vm.warp(v.time - 1);
        vm.expectRevert(abi.encodeWithSelector(IDrandSource.RoundNotYet.selector, round, v.time));
        src.postRound(round, v.xy);
        vm.warp(v.time + 11);
        address poster = makeAddr("fork.poster");
        uint256 g = gasleft();
        vm.prank(poster);
        bytes32 randomness = src.postRound(round, v.xy);
        emit log_named_uint("postRound, real round, on the fork (call)", g - gasleft());
        assertEq(randomness, v.randomness, "the League's randomness");
        (bytes32 word, uint256 readyAt) = box.wordOf(1);
        assertEq(word, keccak256(abi.encode(_tag(), v.randomness, keccak256(abi.encode(address(box), uint256(1))))));
        assertEq(readyAt, v.time + 11);
        assertEq(src.owedTo(poster), 0.001 ether);
        vm.prank(poster);
        src.withdrawBounty(payable(poster));
        assertEq(poster.balance, 0.001 ether);
        vm.cool(address(src));
        g = gasleft();
        (bool ok,) = address(src).staticcall{gas: 50_000}(abi.encodeCall(src.wordOf, (address(box), 1)));
        uint256 used = g - gasleft();
        assertTrue(ok);
        assertLt(used, 50_000);
        emit log_named_uint("wordOf gas (cold, fork)", used);
    }

    function test_BC053_drandOnly_noBackupSource() public override forkOnly {
        super.test_BC053_drandOnly_noBackupSource();
    }

    function test_BC053_wordPerConsumerAndKey_fromTheFixedRoundOnly() public override forkOnly {
        super.test_BC053_wordPerConsumerAndKey_fromTheFixedRoundOnly();
    }

    function test_BC053_waitsThenSilentAfterSevenDays() public override forkOnly {
        super.test_BC053_waitsThenSilentAfterSevenDays();
    }
}

/// Opt-in: `SH_FORK_MAINNET=true`; RPC `MAINNET_FORK_RPC_URL` (default: the Tenderly gateway, keyless).
/// forge-config: default.evm_version = "osaka"
contract DrandSourceMainnetForkTest is DrandSourceForkBase {
    function _chainId() internal pure override returns (uint256) {
        return 1;
    }

    /// @dev The genesis and randomness suites' pinned block (shared RPC cache).
    function _forkBlock() internal pure override returns (uint256) {
        return 26_055_260;
    }

    function _forkTimestamp() internal pure override returns (uint256) {
        return 1_790_348_891;
    }

    function _forkRound() internal pure override returns (uint256) {
        return 32_515_180;
    }

    function _enabledVar() internal pure override returns (string memory) {
        return "SH_FORK_MAINNET";
    }

    function _rpcVar() internal pure override returns (string memory) {
        return "MAINNET_FORK_RPC_URL";
    }

    function _defaultRpc() internal pure override returns (string memory) {
        return "https://mainnet.gateway.tenderly.co";
    }
}

/// Opt-in: `SH_FORK_SEPOLIA=true`; RPC `SEPOLIA_FORK_RPC_URL` (default: the Tenderly gateway, keyless).
/// forge-config: default.evm_version = "osaka"
contract DrandSourceSepoliaForkTest is DrandSourceForkBase {
    function _chainId() internal pure override returns (uint256) {
        return 11_155_111;
    }

    /// @dev The Sepolia suites' pinned block (SH-018 re-run).
    function _forkBlock() internal pure override returns (uint256) {
        return 11_780_483;
    }

    function _forkTimestamp() internal pure override returns (uint256) {
        return 1_790_354_496;
    }

    function _forkRound() internal pure override returns (uint256) {
        return 32_517_048;
    }

    function _enabledVar() internal pure override returns (string memory) {
        return "SH_FORK_SEPOLIA";
    }

    function _rpcVar() internal pure override returns (string memory) {
        return "SEPOLIA_FORK_RPC_URL";
    }

    function _defaultRpc() internal pure override returns (string memory) {
        return "https://sepolia.gateway.tenderly.co";
    }
}
