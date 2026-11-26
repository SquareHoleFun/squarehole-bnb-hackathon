// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {SquareHoleHook} from "../src/SquareHoleHook.sol";
import {LocalE2EBase} from "./local/LocalE2EBase.sol";

/// @title LocalE2EReport (SH-B2 Build B item 9)
/// @notice READ-ONLY reconciliation of the local chain after `script/LocalE2E.s.sol` (run without --broadcast): for
/// every pair in the registry it prints and `require`s the spec 05 identities against live chain state, and prints
/// every E2E account's position. A failed identity makes the script (and scripts/local-e2e.sh) exit non-zero.
/// Identities: F_Q = protocol + holders + remainder; F_T = burned + pending burn; totalSupply = initial − burned;
/// ledger received = indexed + bootstrap; outstanding = received − claimed ≤ the ledger's Q claims; the collector's
/// Q claims = protocol pending + remainder and its T claims = pending burn; for every currency, the PoolManager holds
/// at least the SUM over all pairs using it of the protocol-owned positions' principal plus every Square Hole claim;
/// NFTs = ⌊balance / unit⌋ with unit = 1e27 / N (F10) and every supply exactly 1e27; tokenURI = baseURI + id + ".json";
/// every pair saw a claim (R = Q paid in Q, R = T converted to T); the treasury holds exactly the protocol payouts in
/// WETH, FIT and USDT-TEST.
contract LocalE2EReport is LocalE2EBase {
    using StateLibrary for IPoolManager;

    function run() external view {
        _requireLocal();
        Stack memory s = _loadStack();
        uint256 n = s.registry.pairCount();
        bytes32[] memory ids = s.registry.pairIds(0, n);
        console.log("== Square Hole local E2E reconciliation (chain 31337) ==");
        console.log("block", block.number);
        console.log("pairs", n);
        // Per currency, summed over every pair that uses it (WETH is the quote of The Misfits; FIT is The Misfits' T
        // and ORCHARD's quote): the PoolManager must hold every pair's principal plus every Square Hole claim.
        address[] memory currencies = new address[](2 * n);
        uint256[] memory required = new uint256[](2 * n);
        uint256 used;
        for (uint256 i; i < n; ++i) {
            Pair memory p = _pair(s.registry, ids[i]);
            _reportPair(s, p);
            (uint256 needT, uint256 needQ) = _requiredInPoolManager(s, p);
            used = _add(currencies, required, used, p.r.token, needT);
            used = _add(currencies, required, used, p.r.quote, needQ);
        }
        _reportPoolManagerSolvency(s, currencies, required, used);
        _reportTreasury(s);
        console.log("RECONCILIATION OK: every identity holds on live chain state");
    }

    function _reportPair(Stack memory s, Pair memory p) internal view {
        console.log("");
        console.log("-- pair", _symbol(p.r.token));
        console.log("   token", p.r.token);
        console.log("   quote", p.r.quote);
        console.log("   reward side (0 = Q, 1 = T)", p.r.rewardSide);
        console.log("   fee receipts", p.collector.receiptCount());
        _reportFees(p);
        _reportLedger(p);
        _reportAccounts(p);
    }

    function _reportFees(Pair memory p) internal view {
        uint256 qReceived = p.collector.totalQReceived();
        uint256 qProtocol = p.collector.totalQProtocol();
        uint256 qHolders = p.collector.totalQHolders();
        uint256 qRemainder = p.collector.qRemainder();
        uint256 tReceived = p.collector.totalTReceived();
        uint256 tBurned = p.collector.totalTBurned();
        uint256 tPending = p.collector.pendingBurnT();
        console.log("   F_Q received (raw)", qReceived);
        console.log("     protocol (1/3)", qProtocol);
        console.log("     holders (2/3)", qHolders);
        console.log("     remainder carried", qRemainder);
        console.log("     protocol paid to treasury", p.collector.totalQToTreasury());
        console.log("     protocol pending", p.collector.protocolQPending());
        console.log("   F_T received (raw)", tReceived);
        console.log("     burned", tBurned);
        console.log("     pending burn", tPending);
        require(qReceived == qProtocol + qHolders + qRemainder, "F_Q != protocol + holders + remainder");
        require(tReceived == tBurned + tPending, "F_T != burned + pending");
        uint256 supply = _totalSupply(p.r.token);
        require(p.r.initialSupply == 1e27, "F10: every launch has exactly 1e9 tokens");
        console.log("   T initial supply", p.r.initialSupply);
        console.log("   T total supply", supply);
        require(supply == p.r.initialSupply - tBurned, "totalSupply != initial - burned");
        require(
            _claims(p, address(p.collector), p.r.quote) == p.collector.protocolQPending() + qRemainder,
            "collector Q claims"
        );
        require(_claims(p, address(p.collector), p.r.token) == tPending, "collector T claims != pending burn");
        require(_balance(p.r.token, address(p.collector)) == 0, "collector holds no T (burned exactly)");
    }

    function _reportLedger(Pair memory p) internal view {
        uint256 received = p.ledger.totalHolderQReceived();
        uint256 indexedQ = p.ledger.totalHolderQIndexed();
        uint256 bootstrap = p.ledger.bootstrapQ();
        uint256 claimed = p.ledger.totalClaimed();
        uint256 outstanding = p.ledger.holderQOutstanding();
        console.log("   ledger holder Q received", received);
        console.log("     indexed", indexedQ);
        console.log("     bootstrap (deferred)", bootstrap);
        console.log("     claimed / converted", claimed);
        console.log("     outstanding", outstanding);
        console.log("   eligible supply", p.ledger.eligibleSupply());
        require(received == p.collector.totalQHolders(), "ledger received != collector holder share");
        require(received == indexedQ + bootstrap, "received != indexed + bootstrap");
        require(outstanding == received - claimed, "outstanding");
        require(_claims(p, address(p.ledger), p.r.quote) >= outstanding, "ledger Q claims < outstanding");
        require(claimed > 0, "every E2E pair saw a claim (R = Q paid in Q, R = T converted to T)");
        require(p.ledger.poolNetOutflow() == 0, "transient outflow must be zero between transactions");
    }

    /// This pair's share of what the PoolManager must hold: the position's principal at the current price plus
    /// every Square Hole claim (collector T and Q, ledger Q), per side.
    function _requiredInPoolManager(Stack memory s, Pair memory p)
        internal
        view
        returns (uint256 needT, uint256 needQ)
    {
        (uint256 principalT, uint256 principalQ) = _principal(s, p);
        console.log("   pool principal T (locked)", principalT);
        console.log("   pool principal Q (locked)", principalQ);
        needT = principalT + _claims(p, address(p.collector), p.r.token);
        needQ = principalQ + _claims(p, address(p.collector), p.r.quote) + _claims(p, address(p.ledger), p.r.quote);
    }

    function _add(address[] memory currencies, uint256[] memory required, uint256 used, address c, uint256 amount)
        internal
        pure
        returns (uint256)
    {
        for (uint256 i; i < used; ++i) {
            if (currencies[i] == c) {
                required[i] += amount;
                return used;
            }
        }
        currencies[used] = c;
        required[used] = amount;
        return used + 1;
    }

    /// The PoolManager's ERC-20 balance of each currency covers the SUM over all pairs of principal + claims.
    function _reportPoolManagerSolvency(
        Stack memory s,
        address[] memory currencies,
        uint256[] memory required,
        uint256 used
    ) internal view {
        console.log("");
        console.log("-- PoolManager solvency per currency (sum over every pair: principal + Square Hole claims)");
        for (uint256 i; i < used; ++i) {
            uint256 held = _balance(currencies[i], s.poolManager);
            console.log("   currency", currencies[i]);
            console.log("     required / held", required[i], held);
            require(held >= required[i], "PoolManager below the summed principal + claims of a currency");
        }
    }

    function _principal(Stack memory s, Pair memory p) internal view returns (uint256 principalT, uint256 principalQ) {
        IPoolManager pm = IPoolManager(s.poolManager);
        PoolId id = PoolId.wrap(p.r.poolId);
        (uint160 sqrtP,,,) = pm.getSlot0(id);
        bytes32 positionId = keccak256(
            abi.encodePacked(p.r.hook, p.r.tickLower, p.r.tickUpper, SquareHoleHook(p.r.hook).POSITION_SALT())
        );
        (uint128 liquidity,,) = pm.getPositionInfo(id, positionId);
        require(liquidity == p.r.liquidity, "launch principal locked: liquidity unchanged");
        uint160 sqrtL = TickMath.getSqrtPriceAtTick(p.r.tickLower);
        uint160 sqrtU = TickMath.getSqrtPriceAtTick(p.r.tickUpper);
        uint160 clamped = sqrtP < sqrtL ? sqrtL : (sqrtP > sqrtU ? sqrtU : sqrtP);
        uint256 a0 = SqrtPriceMath.getAmount0Delta(clamped, sqrtU, liquidity, true);
        uint256 a1 = SqrtPriceMath.getAmount1Delta(sqrtL, clamped, liquidity, true);
        (principalT, principalQ) = p.tIsCurrency0 ? (a0, a1) : (a1, a0);
    }

    function _reportAccounts(Pair memory p) internal view {
        uint256 unit = p.r.mirror == address(0) ? 0 : _nftUnit(p);
        if (unit != 0) console.log("   NFT unit (raw, 1e27 / N)", unit);
        bool uriChecked;
        for (uint32 i = 1; i <= 7; ++i) {
            address a = vm.addr(vm.deriveKey(ANVIL_MNEMONIC, i));
            uint256 balance = _balance(p.r.token, a);
            uint256 owed = p.ledger.claimable(a);
            if (balance == 0 && owed == 0) continue;
            console.log("   account", i, a);
            console.log("     T balance (raw)", balance);
            console.log("     claimable Q (raw)", owed);
            if (p.r.mirror != address(0)) {
                uint256 nfts = _balance(p.r.mirror, a);
                console.log("     NFTs", nfts);
                require(nfts == balance / unit, "NFTs != floor(balance / unit)");
                if (nfts != 0 && !uriChecked) {
                    _checkTokenURI(p, a);
                    uriChecked = true;
                }
            }
        }
    }

    /// tokenURI of one NFT `a` owns: baseURI + decimal(id) + ".json" (ADR-0011 F10 addendum).
    function _checkTokenURI(Pair memory p, address a) internal view {
        (bool ok, bytes memory ret) =
            p.r.token.staticcall(abi.encodeWithSignature("ownedIds(address,uint256,uint256)", a, 0, 1));
        require(ok, "ownedIds");
        uint256 id = abi.decode(ret, (uint256[]))[0];
        (ok, ret) = p.r.mirror.staticcall(abi.encodeWithSignature("tokenURI(uint256)", id));
        require(ok, "tokenURI");
        string memory uri = abi.decode(ret, (string));
        (ok, ret) = p.r.token.staticcall(abi.encodeWithSignature("baseURI()"));
        require(ok, "baseURI");
        string memory expected = string.concat(abi.decode(ret, (string)), vm.toString(id), ".json");
        console.log("   tokenURI", uri);
        require(keccak256(bytes(uri)) == keccak256(bytes(expected)), "tokenURI != baseURI + id + .json");
    }

    function _reportTreasury(Stack memory s) internal view {
        uint256 n = s.registry.pairCount();
        bytes32[] memory ids = s.registry.pairIds(0, n);
        address fit = s.registry.pair(s.misfitsPairId).token;
        uint256 wethToTreasury;
        uint256 usdtToTreasury;
        uint256 fitToTreasury;
        for (uint256 i; i < n; ++i) {
            Pair memory p = _pair(s.registry, ids[i]);
            if (p.r.quote == s.weth) wethToTreasury += p.collector.totalQToTreasury();
            if (p.r.quote == s.usdt) usdtToTreasury += p.collector.totalQToTreasury();
            if (p.r.quote == fit) fitToTreasury += p.collector.totalQToTreasury();
        }
        console.log("");
        console.log("-- treasury", s.treasury);
        console.log("   WETH received from protocol shares", wethToTreasury);
        console.log("   FIT received from protocol shares", fitToTreasury);
        console.log("   USDT-TEST received from protocol shares", usdtToTreasury);
        require(_balance(s.weth, s.treasury) == wethToTreasury, "treasury WETH == protocol payouts");
        require(_balance(s.usdt, s.treasury) == usdtToTreasury, "treasury USDT-TEST == protocol payouts");
        require(_balance(fit, s.treasury) == fitToTreasury, "treasury FIT == protocol payouts");
    }

    function _claims(Pair memory p, address owner, address asset) internal view returns (uint256) {
        (bool ok, bytes memory ret) = address(IPoolManager(_pm(p)))
            .staticcall(abi.encodeWithSignature("balanceOf(address,uint256)", owner, uint256(uint160(asset))));
        require(ok, "claims");
        return abi.decode(ret, (uint256));
    }

    function _pm(Pair memory p) internal view returns (address) {
        return p.ledger.poolManager();
    }

    function _totalSupply(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("totalSupply()"));
        require(ok, "totalSupply");
        return abi.decode(ret, (uint256));
    }

    function _symbol(address token) internal view returns (string memory) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("symbol()"));
        require(ok, "symbol");
        return abi.decode(ret, (string));
    }
}
