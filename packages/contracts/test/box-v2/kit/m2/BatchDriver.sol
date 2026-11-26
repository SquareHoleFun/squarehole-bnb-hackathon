// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolDriver} from "../BoxV2TestBase.sol";
import {HostileToken} from "../HostileToken.sol";
import {IBoxHolderBatchNoticeV2, TradeBatchV2} from "../../../../src/box-v2/interfaces/IBoxHookV2.sol";
import {ReleaseConstantsV2 as C} from "../../../../src/box-v2/interfaces/ReleaseConstantsV2.sol";
import {M2OptionalCall} from "./LedgerTokenMock.sol";

/// @dev TEST ONLY hook double. Owner scripts authenticated fee weights/receipts; no pool-price simulation.
contract BatchDriver {
    address private immutable owner = msg.sender;
    address public ledger;
    uint256 public tradeBatchTotalP;
    uint256 private pair = 1;
    mapping(uint256 => TradeBatchV2) private batches;
    modifier upstream() { require(msg.sender == owner, "fixture owner"); _; }
    function wire(address target) external upstream { require(ledger == address(0)); ledger = target; }
    function currentTradeBatch(bool buy) public view returns (uint256) { return buy ? pair : pair + 1; }
    function tradeBatch(uint256 id) external view returns (TradeBatchV2 memory) { return batches[id]; }
    function trade(bool buy, address swapper, uint256 units, bool protocol, bool notice) external upstream returns (bool ok) {
        uint256 id = currentTradeBatch(buy);
        if (protocol) batches[id].protocolUnits += units;
        else {
            batches[id].tradeUnits += units;
            if (notice && units != 0) ok = M2OptionalCall.run(ledger,
                abi.encodeCall(IBoxHolderBatchNoticeV2.onTradeFeeBatch, (id, swapper, buy, units)),
                C.HOLDER_NOTICE_GAS, C.HOLDER_NOTICE_RESERVE_GAS);
        }
    }
    function receipt(uint256 id, uint256 net) external upstream {
        require(id == pair || id == pair + 1, "active source"); batches[id].netP += net; tradeBatchTotalP += net;
    }
    function close() external upstream { batches[pair].closed = true; batches[pair + 1].closed = true; pair += 2; }
}

/// @dev TEST ONLY final-funding receiver double. Explicit backing inputs, never balance-difference attribution.
/// Records/fixtures are owner-only; allocate and fixed-destination exits are permissionless. No ledger callback.
/// Real production reconciliation remains M2-30. Requested tips are redeemed in a capped isolated self-call.
contract NetFundingMock {
    address private immutable owner = msg.sender;
    IPoolManager public immutable pm;
    BatchDriver public immutable hook;
    HostileToken public immutable p;
    PoolDriver public immutable driver;
    address public ledger;
    address public immutable fitSafe;
    address public immutable platformSafe;
    address public immutable potTo;
    uint256 private immutable asset;
    uint256 public next = 1;
    bool public failed;
    mapping(uint256 => uint256) public backing;
    mapping(uint256 => uint256) public holderBatchPaid;
    mapping(uint256 => bool) public holderBatchClosed;
    uint256 public fit; uint256 public platform; uint256 public depth; uint256 public pot; uint256 public debt;
    uint256 public tips;
    uint256 public reservedBacking;
    bool private locked;
    modifier upstream() { require(msg.sender == owner, "fixture owner"); _; }
    modifier lock() { require(!locked, "locked"); locked = true; _; locked = false; }
    constructor(IPoolManager pm_, BatchDriver hook_, HostileToken p_, PoolDriver d, address f, address s, address c) {
        pm = pm_; hook = hook_; p = p_; driver = d; asset = uint256(uint160(address(p_)));
        fitSafe = f; platformSafe = s; potTo = c;
    }
    function wire(address target) external upstream { require(ledger == address(0)); ledger = target; }
    function _back(uint256 amount) private { p.mint(address(driver), amount); driver.mintClaims(Currency.wrap(address(p)), address(this), amount); }
    function receipt(uint256 id, uint256 amount) external upstream {
        require(id >= next && backing[id] + amount <= hook.tradeBatch(id).netP, "backing");
        backing[id] += amount; reservedBacking += amount; _back(amount);
    }
    function bookDebt(uint256 amount) external upstream { debt += amount; _back(amount); }
    function allocate(uint256 id, uint256 actualTip) external lock {
        require(id == next && hook.tradeBatch(id).closed, "order/close");
        uint256 backed = backing[id]; require(actualTip <= backed / 20 && (id % 2 == 1 || actualTip == 0), "tip");
        if (actualTip != 0 && !M2OptionalCall.run(address(this), abi.encodeCall(this.payTip, (actualTip)),
            C.TIP_GAS, M2OptionalCall.PAYOUT_RESERVE_GAS)) actualTip = 0;
        uint256 net = backed - actualTip; uint256 q = net / 15;
        ++next; backing[id] = 0; reservedBacking -= backed; holderBatchPaid[id] = q * 10; holderBatchClosed[id] = true;
        fit += q * 2; platform += q;
        if (failed) { pot += q * 2; fit += net % 15; } else depth += q * 2 + net % 15;
        require(pm.transfer(ledger, asset, q * 10));
        tips += actualTip;
    }
    function royalty(uint256 amount, bool late) external upstream {
        require(late == failed, "phase"); _back(amount);
        if (late) fit += amount;
        else { uint256 q = amount / 15; fit += 2 * q; platform += q; depth += 12 * q + amount % 15; }
    }
    function setFailed() external upstream { failed = true; }
    function collectLate() external lock {
        require(failed, "failed");
        fit += pm.balanceOf(address(this), asset) - (fit + platform + depth + pot + debt + reservedBacking);
    }
    function _pay(address to, uint256 n) private { if (n != 0) pm.unlock(abi.encode(to, n)); }
    function payTip(uint256 n) external { require(msg.sender == address(this), "self"); _pay(owner, n); }
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "pm"); (address to, uint256 n) = abi.decode(data, (address, uint256));
        pm.burn(address(this), asset, n); pm.take(Currency.wrap(address(p)), to, n); return "";
    }
    function payFit() external lock { uint256 n = fit; fit = 0; _pay(fitSafe, n); }
    function payPlatform() external lock { uint256 n = platform; platform = 0; _pay(platformSafe, n); }
    function flushDepth() external lock { uint256 n = depth; depth = 0; require(pm.transfer(address(hook), asset, n)); }
    function flushPot() external lock { uint256 n = pot; pot = 0; require(pm.transfer(potTo, asset, n)); }
    function payDebt() external lock { uint256 n = debt; debt = 0; _pay(owner, n); }
}
