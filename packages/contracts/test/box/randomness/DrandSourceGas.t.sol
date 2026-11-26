// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {IDrandSource} from "../../../src/box/interfaces/IDrandSource.sol";
import {DrandSource} from "../../../src/box/randomness/DrandSource.sol";
import {DrandWords} from "../../../src/box/randomness/DrandWords.sol";
import {BoxDrandVectors} from "./utils/BoxDrandVectors.sol";
import {DrawQueueConsumer} from "./utils/DrawQueueConsumer.sol";

/// @notice A consumer that measures its own calls into the source (execution gas inside its frame, the source's cold
/// account included).
contract MeteredBox {
    IDrandSource internal immutable src;
    uint256 public last;

    constructor(IDrandSource src_) {
        src = src_;
    }

    function request(uint256 key) external payable {
        uint256 g = gasleft();
        DrandWords.request(src, key, msg.value);
        last = g - gasleft();
    }

    function read(uint256 key) external {
        uint256 g = gasleft();
        DrandWords.wordOf(src, key);
        last = g - gasleft();
    }
}

/// @notice Gas of `DrandSource` (slice S9) today (Osaka) and under Glamsterdam (`vm.setEvmVersion("amsterdam")`:
/// EIP-8037 state gas, EIP-8038 access costs; docs/evidence/SH-S0-spikes.md § 2.4). Every figure is a `gasleft` delta
/// around one call with the source's account and storage cooled first (`vm.cool`), which counts state gas under
/// Glamsterdam (S0 caveat 1) and includes the cold call to the source (2,600 today, 3,000 after) that a direct
/// transaction does not pay (its target is warm). A whole transaction ≈ 21,000 + calldata + the call's gas − the cold
/// call. The EVM's precompile set stays Osaka's in both runs (the inline config), so the BLS check runs under both
/// schedules. Lines start `S9GAS|`.
/// forge-config: default.evm_version = "osaka"
contract DrandSourceGasTest is BoxDrandVectors {
    DrandSource internal src;
    MeteredBox internal box;
    uint256 internal first;
    uint256 internal t0;

    function setUp() public {
        _loadBoxDrand();
        src = new DrandSource();
        box = new MeteredBox(IDrandSource(address(src)));
        first = _localFirst();
        t0 = src.roundTime(first);
        vm.deal(address(this), 10 ether);
    }

    function test_gas_today_osaka() public {
        _measure("osaka");
    }

    function test_gas_glamsterdam_amsterdam() public {
        _measure("amsterdam");
    }

    function _measure(string memory evm) internal {
        vm.setEvmVersion(evm);
        _requests(evm);
        uint256 postTx = _posts(evm);
        _reads(evm);
        // The bounty must cover a post of a bountied round by a new poster: today twice over, after Glamsterdam 1.3
        // times (DrandWords.BOUNTY_GAS).
        if (keccak256(bytes(evm)) == keccak256("osaka")) {
            assertGe(DrandWords.BOUNTY_GAS, 2 * postTx, "BOUNTY_GAS: twice a post today");
        } else {
            assertGe(DrandWords.BOUNTY_GAS * 10, 13 * postTx, "BOUNTY_GAS: 1.3 times a post after Glamsterdam");
        }
    }

    function _requests(string memory evm) internal {
        vm.warp(t0 - 12);
        vm.cool(address(src));
        box.request(1);
        _log(evm, "request, no bounty (consumer frame)", box.last());
        vm.cool(address(src));
        box.request{value: 0.001 ether}(2);
        _log(evm, "request with a bounty, the round's first (consumer frame)", box.last());
        vm.cool(address(src));
        box.request{value: 0.001 ether}(3);
        _log(evm, "request with a bounty, the round's pot exists (consumer frame)", box.last());
        // The graduation word: what the coordinator's poke must give `requestGraduationWord` (S6's POKE_GAS). The
        // consumer graduates with a poke that fails for lack of gas, then the request is measured on its own, cold.
        DrawQueueConsumer tickets = new DrawQueueConsumer(IDrandSource(address(src)), true, 1_000);
        tickets.graduate();
        assertEq(tickets.wordRequestedAt(), 0);
        vm.cool(address(src));
        vm.cool(address(tickets));
        uint256 g = gasleft();
        tickets.requestGraduationWord();
        _log(evm, "requestGraduationWord, the tickets' state and the source's request (call)", g - gasleft());
        // A draw's randomness part: its request with the round's bounty, and the funded check.
        vm.fee(1 gwei);
        DrawQueueConsumer drawn = new DrawQueueConsumer(IDrandSource(address(src)), false, 1_000);
        drawn.graduate();
        vm.deal(address(this), 10 ether);
        uint256 target = DrandWords.roundTarget();
        vm.warp(t0 - 9);
        vm.cool(address(src));
        vm.cool(address(drawn));
        g = gasleft();
        drawn.draw{value: target}();
        _log(
            evm,
            "draw (the reference consumer): ticket, request with the round's bounty, funded check (call)",
            g - gasleft()
        );
        vm.fee(0);
    }

    /// @return postTx The whole transaction of the dearest post: a bountied round, the poster's first credit.
    function _posts(string memory evm) internal returns (uint256 postTx) {
        address keeper = makeAddr("gas.keeper");
        bytes memory sig0 = _localSig(0);
        bytes memory sig1 = _localSig(1);
        bytes memory sig2 = _localSig(2);
        vm.warp(t0);
        vm.cool(address(src));
        vm.prank(keeper);
        uint256 g = gasleft();
        src.postRound(first, sig0);
        uint256 used = g - gasleft();
        postTx = _tx(used, evm);
        _log(evm, "postRound, round with a pot, poster's first credit (call)", used);
        _log(evm, "  = whole transaction (21,000 + calldata + call - cold call)", postTx);

        vm.warp(t0 + 3);
        vm.cool(address(src));
        g = gasleft();
        src.postRound(first + 1, sig1);
        used = g - gasleft();
        _log(evm, "postRound, round without a pot (call)", used);
        _log(evm, "  = whole transaction", _tx(used, evm));

        vm.warp(t0 + 6);
        src.addBounty{value: 0.001 ether}(first + 2);
        vm.cool(address(src));
        vm.prank(keeper);
        g = gasleft();
        src.postRound(first + 2, sig2);
        used = g - gasleft();
        _log(evm, "postRound, round with a pot, poster holds a credit (call)", used);
        _log(evm, "  = whole transaction", _tx(used, evm));

        address hunter = makeAddr("gas.hunter");
        vm.deal(hunter, 1 ether);
        vm.cool(address(src));
        vm.prank(hunter);
        g = gasleft();
        src.addBounty{value: 0.001 ether}(first + 9);
        _log(evm, "addBounty, a fresh pot (call)", g - gasleft());
        vm.cool(address(src));
        vm.prank(keeper);
        g = gasleft();
        src.withdrawBounty(payable(keeper));
        _log(evm, "withdrawBounty to an EOA (call)", g - gasleft());
    }

    function _reads(string memory evm) internal {
        vm.cool(address(src));
        box.read(1);
        uint256 read = box.last();
        _log(evm, "DrandWords.wordOf, posted word, cold (consumer frame)", read);
        assertLt(read, DrandWords.WORD_GAS, "inside the consumers' 50,000");
        vm.cool(address(src));
        uint256 g = gasleft();
        src.wordOf(address(box), 1);
        _log(evm, "wordOf, posted word, cold (call)", g - gasleft());
        vm.cool(address(src));
        g = gasleft();
        src.isSilent(address(box), 1);
        _log(evm, "isSilent, cold (call)", g - gasleft());
    }

    /// @dev A whole transaction for a call measured from this frame: 21,000 + postRound's calldata (4 + 3 words + 96
    /// bytes; zero bytes 4, others 16) + the call − the cold call to the source.
    function _tx(uint256 callGas, string memory evm) internal pure returns (uint256) {
        uint256 cold = keccak256(bytes(evm)) == keccak256("osaka") ? 2_600 : 3_000;
        // selector (4 non-zero), round (29 zero, 3 non-zero), offset (31 zero, 1), length (31 zero, 1), 96 bytes ≈ all
        // non-zero.
        uint256 calldataGas = (4 + 3 + 1 + 1 + 96) * 16 + (29 + 31 + 31) * 4;
        return 21_000 + calldataGas + callGas - cold;
    }

    function _log(string memory evm, string memory what, uint256 gas) internal pure {
        console.log(string.concat("S9GAS|", evm, "|", what, "|", vm.toString(gas)));
    }
}
