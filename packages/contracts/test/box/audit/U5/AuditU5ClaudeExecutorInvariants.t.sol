// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {FitBuybackExecutor} from "../../../../src/box/FitBuybackExecutor.sol";
import {AuditU5ClaudeBase} from "./AuditU5ClaudeBase.sol";

interface IAuditU5ClaudeExecutorWorld {
    function hFund(uint256 who, uint256 amount) external;
    function hForce(uint256 amount) external;
    function hPayFit() external;
    function hPoke(uint256 who) external;
    function hExecute(uint256 who, uint256 maxChunks) external;
    function hBuy(uint256 who, uint256 amount) external;
    function hSell(uint256 fraction) external;
    function hCollect() external;
    function hAdvance(uint256 blocks, bool sampled) external;
    function hWarp(uint256 secondsAhead) external;
    function hGiftFit(uint256 amount) external;
    function hProtocolFee(uint256 pips) external;
    function hNoteFailure(bytes4 action, bytes calldata reason) external;
}

interface IAuditU5ClaudeOwned {
    function owner() external view returns (address);
}

interface IAuditU5ClaudeProtocolFees {
    function setProtocolFeeController(address controller) external;
    function setProtocolFee(PoolKey memory key, uint24 newProtocolFee) external;
}

/// @notice TEST ONLY. The executor campaign's handler: every action is one call into the world (which books it and
/// checks its own bounds), fail-safe here, so `fail_on_revert` never stops a run; an action that must not fail is
/// reported to the world, whose ghosts the invariants read.
contract AuditU5ClaudeExecutorHandler {
    IAuditU5ClaudeExecutorWorld internal immutable w;

    constructor(IAuditU5ClaudeExecutorWorld w_) {
        w = w_;
    }

    function fund(uint256 who, uint256 amount) external {
        try w.hFund(who, amount) {}
        catch (bytes memory e) {
            w.hNoteFailure(this.fund.selector, e);
        }
    }

    function force(uint256 amount) external {
        try w.hForce(amount) {} catch {}
    }

    function payFit() external {
        try w.hPayFit() {} catch {}
    }

    function poke(uint256 who) external {
        try w.hPoke(who) {}
        catch (bytes memory e) {
            w.hNoteFailure(this.poke.selector, e);
        }
    }

    function execute(uint256 who, uint256 maxChunks) external {
        try w.hExecute(who, maxChunks) {}
        catch (bytes memory e) {
            w.hNoteFailure(this.execute.selector, e);
        }
    }

    function buy(uint256 who, uint256 amount) external {
        try w.hBuy(who, amount) {} catch {}
    }

    function sell(uint256 fraction) external {
        try w.hSell(fraction) {} catch {}
    }

    function collect() external {
        try w.hCollect() {} catch {}
    }

    function advance(uint256 blocks, bool sampled) external {
        try w.hAdvance(blocks, sampled) {} catch {}
    }

    function warp(uint256 secondsAhead) external {
        try w.hWarp(secondsAhead) {} catch {}
    }

    function giftFit(uint256 amount) external {
        try w.hGiftFit(amount) {} catch {}
    }

    function protocolFee(uint256 pips) external {
        try w.hProtocolFee(pips) {} catch {}
    }
}

/// @title AuditU5ClaudeExecutorInvariants
/// @notice SH-AUDIT-B0 U5 (Claude): the invariant campaign the map's gap list asks for (map § 6 item 3; U5 brief
/// P5.1, P5.2, P5.9, P5.11): FIT's executor on the factory's box 0 from graduation, under random `fundBudget`, forced
/// (unrequested) ETH, `payFit`, pokes, `execute(maxChunks)` from any caller, buys and sells moving the price either
/// way, fee batches, time (sampled blocks, unsampled gaps up to 10 days), FIT sent to it unasked and Uniswap protocol
/// fees on the buy direction. What must never happen, as ghosts: an `execute` or a `poke` that reverts; more than one chunk
/// in a block; a chunk below its band (max(sample, average) − 99 ticks) or beyond 49 ticks; T's supply rising; FIT
/// left in the executor after an `execute`; a REV-16 note above what the positions got. And the books: budget ==
/// balance == credited + forced − spent; `totalToBudget` == credited; `totalEthSpent` == Σ spent; `totalBurned` ==
/// Σ burned; the shared ghost ledger (system ETH and T identities).
/// forge-config: default.evm_version = "osaka"
contract AuditU5ClaudeExecutorInvariants is StdInvariant, AuditU5ClaudeBase, IAuditU5ClaudeExecutorWorld {
    AuditU5ClaudeExecutorHandler internal handler;

    // ghosts: books
    uint256 public credited;
    uint256 public forced;
    uint256 public spent;
    uint256 public burnedSum;
    uint256 public giftsPending;
    uint256 public lastSupply;
    // ghosts: what must never happen
    uint256 public executeFailures;
    uint256 public pokeFailures;
    uint256 public fundFailures;
    uint256 public chunkBlockViolations;
    uint256 public bandViolations;
    uint256 public impactViolations;
    uint256 public supplyRose;
    uint256 public heldAfterExecute;
    uint256 public noteAboveFee;
    bytes public lastFailure;
    // coverage
    uint256 public executes;
    uint256 public chunksBought;
    uint256 public pokes;
    uint256 public stops;
    uint256[9] public stopReasons;
    mapping(uint256 => uint256) internal _chunksAt;

    modifier onlyHandler() {
        require(msg.sender == address(handler), "handler only");
        _;
    }

    function setUp() public override {
        super.setUp();
        _toGraduated();
        uint256 owed = receiver.fitOwed();
        _payFit(keeper);
        credited = owed;
        lastSupply = token.totalSupply();
        handler = new AuditU5ClaudeExecutorHandler(this);
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](13);
        sel[0] = AuditU5ClaudeExecutorHandler.fund.selector;
        sel[1] = AuditU5ClaudeExecutorHandler.force.selector;
        sel[2] = AuditU5ClaudeExecutorHandler.payFit.selector;
        sel[3] = AuditU5ClaudeExecutorHandler.poke.selector;
        sel[4] = AuditU5ClaudeExecutorHandler.execute.selector;
        sel[5] = AuditU5ClaudeExecutorHandler.execute.selector; // twice the weight
        sel[6] = AuditU5ClaudeExecutorHandler.buy.selector;
        sel[7] = AuditU5ClaudeExecutorHandler.sell.selector;
        sel[8] = AuditU5ClaudeExecutorHandler.collect.selector;
        sel[9] = AuditU5ClaudeExecutorHandler.advance.selector;
        sel[10] = AuditU5ClaudeExecutorHandler.warp.selector;
        sel[11] = AuditU5ClaudeExecutorHandler.giftFit.selector;
        sel[12] = AuditU5ClaudeExecutorHandler.protocolFee.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    // ================================================================================================ actions

    function _actor(uint256 who) internal view returns (address) {
        uint256 i = who % 10;
        if (i < 8) return eoa[i];
        return i == 8 ? address(contractDrawer) : eoa7702;
    }

    function hFund(uint256 who, uint256 amount) external onlyHandler {
        amount = bound(amount, 1, 5 ether);
        address from = eoa[who % 8];
        _fundBudget(from, amount);
        credited += amount;
    }

    function hForce(uint256 amount) external onlyHandler {
        amount = bound(amount, 1, 2 ether);
        _forceEth(a.executor, amount);
        forced += amount;
    }

    function hPayFit() external onlyHandler {
        uint256 owed = receiver.fitOwed();
        _payFit(keeper);
        credited += owed;
    }

    function hPoke(uint256 who) external onlyHandler {
        vm.prank(_actor(who));
        executor.poke();
        ++pokes;
    }

    function hExecute(uint256 who, uint256 maxChunks) external onlyHandler {
        maxChunks = bound(maxChunks, 0, 4);
        // The band and the impact limit `execute` will use: its own sample is this timestamp's (poked first).
        executor.poke();
        (uint160 floorSqrt,) = _execFloor();
        uint160 p0 = _sqrtPrice();
        int24 t0 = _tick();
        uint256 held = token.balanceOf(a.executor);
        (uint256 q0,) = _uncollected();
        (uint256 n0,) = receiver.moduleFeesPending();
        vm.recordLogs();
        vm.prank(_actor(who));
        (uint256 c, uint256 s, uint256 b) = executor.execute(maxChunks);
        ++executes;
        _countStop();
        spent += s;
        burnedSum += b;
        if (b < held) ++heldAfterExecute; // every unsolicited FIT held is burned with the bought
        giftsPending = 0;
        if (token.balanceOf(a.executor) != 0) ++heldAfterExecute;
        if (c != 0) {
            chunksBought += c;
            _chunksAt[vm.getBlockNumber()] += c;
            if (_chunksAt[vm.getBlockNumber()] > 1) ++chunkBlockViolations;
            if (_sqrtPrice() < floorSqrt) ++bandViolations;
            if (t0 - _tick() > 50) ++impactViolations;
            (uint256 q1,) = _uncollected();
            (uint256 n1,) = receiver.moduleFeesPending();
            if (n1 - n0 > q1 - q0) ++noteAboveFee;
        } else {
            ++stops;
            if (s != 0 || _sqrtPrice() != p0) ++bandViolations;
        }
        _supplyCheck();
    }

    function _countStop() internal {
        VmSafe.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == a.executor && logs[i].topics[0] == FitBuybackExecutor.Executed.selector) {
                (,,,,,, FitBuybackExecutor.Stop r) = abi.decode(
                    logs[i].data, (uint256, uint256, uint256, uint256, int24, uint160, FitBuybackExecutor.Stop)
                );
                ++stopReasons[uint8(r)];
            }
        }
    }

    function hBuy(uint256 who, uint256 amount) external onlyHandler {
        // Mostly small buys (tens to hundreds of ticks in box 0's young pool), one in eight up to 1 ETH (thousands).
        amount = amount % 8 == 0 ? bound(amount, 0.001 ether, 1 ether) : bound(amount, 0.0001 ether, 0.05 ether);
        _buy(eoa[who % 6], amount);
        _supplyCheck();
    }

    function hSell(uint256 fraction) external onlyHandler {
        uint256 held = token.balanceOf(eoa[2]);
        // 0.01% to 1% of eoa[2]'s T (one in eight: up to 10%).
        uint256 amount =
            fraction % 8 == 0 ? held * bound(fraction, 1, 100) / 1_000 : held * bound(fraction, 1, 100) / 10_000;
        if (amount == 0) return;
        _sell(eoa[2], amount);
        _supplyCheck();
    }

    function hCollect() external onlyHandler {
        _buy(eoa[4], 0.6 ether);
        _collect(keeper, keeper);
        _supplyCheck();
    }

    function hAdvance(uint256 blocks, bool sampled) external onlyHandler {
        // Three in four advances are sampled every block (the average follows the price only through samples).
        bool unsampled = !sampled && blocks % 2 == 0;
        blocks = bound(blocks, 1, 300);
        if (unsampled) _advance(blocks);
        else _sampledBlocks(blocks);
    }

    function hWarp(uint256 secondsAhead) external onlyHandler {
        secondsAhead = bound(secondsAhead, 1 hours, 10 days);
        _warpTo(vm.getBlockTimestamp() + secondsAhead);
    }

    function hGiftFit(uint256 amount) external onlyHandler {
        amount = bound(amount, 1, 1_000_000 ether);
        if (token.balanceOf(eoa[2]) < amount) return;
        _transferT(eoa[2], a.executor, amount);
        giftsPending += amount;
        _supplyCheck();
    }

    function hProtocolFee(uint256 pips) external onlyHandler {
        pips = bound(pips, 0, 1_000);
        address owner_ = IAuditU5ClaudeOwned(address(pm)).owner();
        vm.prank(owner_);
        IAuditU5ClaudeProtocolFees(address(pm)).setProtocolFeeController(address(this));
        // casting to 'uint24' is safe because pips ≤ 1,000
        // forge-lint: disable-next-line(unsafe-typecast)
        IAuditU5ClaudeProtocolFees(address(pm)).setProtocolFee(poolKey, uint24(pips));
    }

    function hNoteFailure(bytes4 action, bytes calldata reason) external onlyHandler {
        lastFailure = reason;
        if (action == AuditU5ClaudeExecutorHandler.execute.selector) ++executeFailures;
        else if (action == AuditU5ClaudeExecutorHandler.poke.selector) ++pokeFailures;
        else ++fundFailures;
    }

    function _supplyCheck() internal {
        uint256 s = token.totalSupply();
        if (s > lastSupply) ++supplyRose;
        lastSupply = s;
    }

    // ================================================================================================ invariants

    /// P5.1: the budget is the balance, and the balance is exactly what came in (credited by `fundBudget`, `receive`
    /// and `payFit`, plus forced ETH) less what the chunks spent.
    function invariant_AUDIT_U5_budgetIsTheBalanceAndTheBooks() public view {
        assertEq(executor.budget(), a.executor.balance, "budget == balance");
        assertEq(a.executor.balance, credited + forced - spent, "balance == credited + forced - spent");
        assertEq(executor.totalToBudget(), credited, "totalToBudget == credited (forced ETH not counted)");
        assertEq(executor.totalEthSpent(), spent, "totalEthSpent == sum spent");
        assertEq(executor.totalBurned(), burnedSum, "totalBurned == sum burned");
    }

    /// P5.11: `execute` and `poke` never revert, whoever calls, in any state the campaign reaches.
    function invariant_AUDIT_U5_executeAndPokeNeverRevert() public view {
        assertEq(executeFailures, 0, string(lastFailure));
        assertEq(pokeFailures, 0, string(lastFailure));
        assertEq(fundFailures, 0, string(lastFailure));
    }

    /// P5.9: at most one chunk per block; every chunk within its band and its 49 ticks.
    function invariant_AUDIT_U5_chunksWithinTheirBounds() public view {
        assertEq(chunkBlockViolations, 0, "one chunk per block");
        assertEq(bandViolations, 0, "never below max(sample, average) - 99 ticks; a stop moves nothing");
        assertEq(impactViolations, 0, "at most 49 ticks a chunk");
    }

    /// P5.1: FIT leaves only by burning: T's supply never rises, the executor holds no FIT after an `execute` (only
    /// unsolicited FIT between a gift and the next `execute`), and its REV-16 note never exceeds its chunk's fee.
    function invariant_AUDIT_U5_fitOnlyBurnedAndNoteALowerBound() public view {
        assertEq(supplyRose, 0, "T's supply never rises");
        assertEq(heldAfterExecute, 0, "no FIT held after an execute");
        assertEq(token.balanceOf(a.executor), giftsPending, "between calls only unsolicited FIT");
        assertEq(noteAboveFee, 0, "the note is a lower bound");
    }

    /// The shared ghost ledger: system ETH == Σ in − Σ out; outside T == Σ out − Σ in; supply + burned == issuance.
    function invariant_AUDIT_U5_ghostLedger() public view {
        _assertGhostLedger();
    }

    /// The handler does what it says (its actions are fail-safe, so a silently failing action would look like a
    /// passing campaign): a seeded replay of 400 handler calls in the campaign's own mix buys chunks, stops, pokes,
    /// funds, moves the price and the clock, and every invariant above holds after it.
    function testProperty_AUDIT_U5_executorCampaignReachesItsStates() public {
        for (uint256 i; i < 400; ++i) {
            uint256 r = uint256(keccak256(abi.encode("u5.exec.replay", i)));
            uint256 op = r % 13;
            uint256 x = r >> 8;
            uint256 y = r >> 128;
            if (op == 0) handler.fund(x, y);
            else if (op == 1) handler.force(x);
            else if (op == 2) handler.payFit();
            else if (op == 3) handler.poke(x);
            else if (op <= 5) handler.execute(x, y);
            else if (op == 6) handler.buy(x, y);
            else if (op == 7) handler.sell(x);
            else if (op == 8) handler.collect();
            else if (op == 9) handler.advance(x, y & 1 == 1);
            else if (op == 10) handler.warp(x);
            else if (op == 11) handler.giftFit(x);
            else handler.protocolFee(x);
        }
        emit log_named_uint("executes", executes);
        emit log_named_uint("chunks bought", chunksBought);
        emit log_named_uint("stops", stops);
        emit log_named_uint("pokes", pokes);
        for (uint256 k; k < 9; ++k) {
            emit log_named_uint(string.concat("stop reason ", vm.toString(k)), stopReasons[k]);
        }
        emit log_named_decimal_uint("ETH spent", spent, 18);
        emit log_named_decimal_uint("FIT burned", burnedSum, 18);
        assertGe(chunksBought, 8, "chunks bought");
        assertGe(stopReasons[uint8(FitBuybackExecutor.Stop.AtCeiling)], 8, "stops at the band");
        assertGt(pokes, 5, "pokes");
        invariant_AUDIT_U5_budgetIsTheBalanceAndTheBooks();
        invariant_AUDIT_U5_executeAndPokeNeverRevert();
        invariant_AUDIT_U5_chunksWithinTheirBounds();
        invariant_AUDIT_U5_fitOnlyBurnedAndNoteALowerBound();
        invariant_AUDIT_U5_ghostLedger();
    }
}

/// forge-config: default.evm_version = "amsterdam"
contract AuditU5ClaudeExecutorAmsterdamInvariants is AuditU5ClaudeExecutorInvariants {}
