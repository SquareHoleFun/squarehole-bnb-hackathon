// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    AuditU7LaneBase,
    ItemReveal,
    IBoxCollection,
    IBoxVault,
    IBoxTickets,
    IERC721TokenReceiver
} from "./AuditU7LaneBase.sol";

/// @notice Accepting receiver in the actor universe, not a substitute for any box component.
contract AuditU7LaneAcceptingReceiver is IERC721TokenReceiver {
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721TokenReceiver.onERC721Received.selector;
    }
}

/// @notice Non-aborting actions, sticky discrepancies and independent custody/principal/reveal ledgers.
/// All economic operations use the factory tickets/vault and actual item stream. No mocks, etches or balance deals.
/// ETH funding and mined backup headers use AuditBox0World's offline chain facilities.
abstract contract AuditU7LaneCampaign is AuditU7LaneBase {
    uint256 public failures;
    uint256[10] public successes;
    uint256 public refused;
    uint256 internal ghostE;
    uint256 internal ghostN;
    uint256 internal ghostTickets;
    uint256 internal ghostHidden;
    uint256 internal ghostReveals;
    uint256[] internal placeholders;
    uint256[] internal touched;
    mapping(uint256 => address) internal ghostOwner;
    mapping(uint256 => bool) internal ghostRevealed;
    AuditU7LaneAcceptingReceiver internal nftReceiver;

    function setUp() public virtual override {
        super.setUp();
        _cacheTree();
        _toBonding();
        nftReceiver = new AuditU7LaneAcceptingReceiver();
        for (uint256 i = 1; i <= 5; ++i) {
            placeholders.push(i);
        }
        ghostE = vault.escrowPrincipal();
        ghostN = vault.inside();
        ghostTickets = vault.pendingTickets();
        ghostHidden = vault.hiddenCount();
        for (uint256 i; i < 6; ++i) {
            _approveT(eoa[i], a.vault);
            _approveT(eoa[i], a.tickets);
            vm.prank(eoa[i]);
            collection.setApprovalForAll(a.vault, true);
        }
        vm.prank(address(nftReceiver));
        collection.setApprovalForAll(a.vault, true);
        targetSelector(FuzzSelector(address(this), _selectors()));
        targetContract(address(this));
    }

    function _selectors() internal pure virtual returns (bytes4[] memory selectors) {
        selectors = new bytes4[](10);
        selectors[0] = this.actTake.selector;
        selectors[1] = this.actHandBack.selector;
        selectors[2] = this.actGraduate.selector;
        selectors[3] = this.actOpen.selector;
        selectors[4] = this.actDraw.selector;
        selectors[5] = this.actPick.selector;
        selectors[6] = this.actReturn.selector;
        selectors[7] = this.actUnrequested.selector;
        selectors[8] = this.actTransfer.selector;
        selectors[9] = this.actReveal.selector;
    }

    function _conversion(bool locking, uint256 k, uint256 p, uint256 f, uint256 beforeSupply) private {
        if (locking) {
            ghostE += p;
            ghostN -= k;
        } else {
            ghostE -= p;
            ghostN += k;
        }
        if (token.totalSupply() != beforeSupply - f) failures |= 1;
    }

    function actTake(uint256 actor, uint256 quantity) public {
        if (vault.gateOpen() || vault.inside() <= 1) return;
        address who = eoa[actor % 6];
        uint256 k = 1 + quantity % 4;
        if (k >= vault.inside() || k > vault.hiddenCount()) return;
        uint256 s = token.totalSupply();
        uint256 p = _ceil(s - ghostE, k, ghostN);
        uint256 f = _fee(p, 100);
        bool affordable = token.balanceOf(who) >= p + f;
        vm.prank(who);
        (bool ok, bytes memory ret) =
            a.tickets.call(abi.encodeCall(tickets.take, (k, type(uint256).max, block.timestamp)));
        if (ok != affordable) failures |= 2;
        if (!ok) {
            ++refused;
            return;
        }
        uint256 first = abi.decode(ret, (uint256));
        for (uint256 i; i < k; ++i) {
            placeholders.push(first + i);
        }
        ghostTickets += k;
        ghostHidden -= k;
        _conversion(true, k, p, f, s);
        ++successes[0];
    }

    function actHandBack(uint256 seed) public {
        if (vault.gateOpen() || placeholders.length == 0) return;
        uint256 pos = seed % placeholders.length;
        uint256 id = placeholders[pos];
        address who = tickets.ownerOf(id);
        uint256 s = token.totalSupply();
        uint256 p = _floor(s - ghostE, 1, ghostN);
        vm.prank(who);
        (bool ok,) = a.tickets.call(abi.encodeCall(tickets.handBack, (_ids(id), 0, block.timestamp)));
        if (!ok) {
            failures |= 4;
            return;
        }
        _removePlaceholder(pos);
        --ghostTickets;
        ++ghostHidden;
        _conversion(false, 1, p, _fee(p, 500), s);
        ++successes[1];
    }

    function _removePlaceholder(uint256 pos) private {
        placeholders[pos] = placeholders[placeholders.length - 1];
        placeholders.pop();
    }

    function actGraduate() public {
        if (vault.gateOpen()) return;
        // Keep one placeholder so the actual graduation word path is always exercised.
        if (placeholders.length == 0) actTake(0, 0);
        (bool ok,) = address(this).call(abi.encodeCall(this.completeGraduation, ()));
        if (!ok) {
            failures |= 8;
            return;
        }
        ++successes[2];
    }

    function completeGraduation() external {
        require(msg.sender == address(this));
        _buyTo(eoa[2], 3 * raise, curve.sqrtPriceLowerX96);
        _warpTo(_requestTimeFor(r0));
        _graduate(keeper);
        _advance(1);
        _post(r0);
        tickets.acceptGraduationWord();
    }

    function actOpen(uint256 seed, bool revealNow) public {
        if (!vault.gateOpen() || placeholders.length == 0) return;
        uint256 pos = seed % placeholders.length;
        uint256 ticket = placeholders[pos];
        uint256 id = tickets.numberOf(ticket);
        address who = tickets.ownerOf(ticket);
        // Before grace the real adapter requires a proof; afterwards leave some items unrevealed for actReveal.
        bool withProof =
            revealNow || block.timestamp < uint256(tickets.status().wordAcceptedAt) + tickets.REVEAL_GRACE();
        ItemReveal memory r;
        if (withProof) r = _data(id);
        vm.prank(who);
        (bool ok,) = a.tickets.call(abi.encodeCall(tickets.open, (ticket, r)));
        if (!ok) {
            failures |= 16;
            return;
        }
        _removePlaceholder(pos);
        --ghostTickets;
        _track(id, who, withProof);
        ++successes[3];
    }

    function actDraw(uint256 actor) public {
        if (!vault.gateOpen() || vault.hiddenCount() == 0 || ghostN <= 1) return;
        address who = eoa[actor % 6];
        uint256 s = token.totalSupply();
        uint256 p = _ceil(s - ghostE, 1, ghostN);
        uint256 f = _fee(p, 100);
        if (token.balanceOf(who) < p + f) {
            ++refused;
            return;
        }
        vm.deal(who, who.balance + AUDIT_DRAW_VALUE);
        vm.prank(who);
        (bool ok, bytes memory ret) =
            a.tickets.call{value: AUDIT_DRAW_VALUE}(abi.encodeCall(tickets.draw, (type(uint256).max, block.timestamp)));
        if (!ok) {
            failures |= 32;
            return;
        }
        _conversion(true, 1, p, f, s);
        ++ghostTickets;
        --ghostHidden;
        uint256 ticket = abi.decode(ret, (uint256));
        (ok, ret) = address(this).call(abi.encodeCall(this.completeDraw, (ticket, who)));
        if (!ok) {
            failures |= 64;
            return;
        }
        --ghostTickets;
        _track(abi.decode(ret, (uint256)), who, true);
        ++successes[4];
    }

    function completeDraw(uint256 ticket, address who) external returns (uint256 id) {
        require(msg.sender == address(this));
        (, uint64 round) = src.requestOf(a.tickets, ticket);
        if (_committed(round)) {
            _warpTo(src.roundTime(round));
            _post(round);
        } else {
            _warpTo(src.roundTime(round) + src.BACKUP_AFTER() + 1);
            _backup(round, keccak256(abi.encode(round)), keeper);
        }
        tickets.settle(1);
        id = tickets.drawTicket(ticket).itemId;
        ItemReveal memory r = _data(id);
        vm.prank(who);
        tickets.openDraw(ticket, who, r);
    }

    function _track(uint256 id, address who, bool revealed) private {
        if (ghostOwner[id] == address(0)) touched.push(id);
        ghostOwner[id] = who;
        if (revealed && !ghostRevealed[id]) {
            ghostRevealed[id] = true;
            ++ghostReveals;
        }
    }

    function actPick(uint256 seed, uint256 actor) public {
        if (touched.length == 0 || ghostN <= 1) return;
        uint256 id = touched[seed % touched.length];
        if (ghostOwner[id] != a.vault || !ghostRevealed[id]) return;
        address who = eoa[actor % 6];
        uint256 s = token.totalSupply();
        uint256 p = _ceil(s - ghostE, 1, ghostN);
        uint256 f = _fee(p, 2500);
        if (token.balanceOf(who) < p + f) {
            ++refused;
            return;
        }
        vm.prank(who);
        (bool ok,) = a.vault.call(abi.encodeCall(vault.withdraw, (id, type(uint256).max, block.timestamp)));
        if (!ok) {
            failures |= 128;
            return;
        }
        _conversion(true, 1, p, f, s);
        ghostOwner[id] = who;
        ++successes[5];
    }

    function actReturn(uint256 seed) public {
        if (touched.length == 0) return;
        uint256 id = touched[seed % touched.length];
        address who = ghostOwner[id];
        if (who == a.vault) return;
        bool eligible = ghostRevealed[id] || block.timestamp >= tickets.returnableFrom(id);
        uint256 s = token.totalSupply();
        uint256 p = _floor(s - ghostE, 1, ghostN);
        vm.prank(who);
        collection.setApprovalForAll(a.vault, true);
        vm.prank(who);
        (bool ok,) = a.vault.call(abi.encodeCall(vault.returnItem, (id, 0, block.timestamp)));
        if (ok != eligible) failures |= 256;
        if (!ok) {
            ++refused;
            return;
        }
        _conversion(false, 1, p, _fee(p, 500), s);
        ghostOwner[id] = a.vault;
        ++successes[6];
    }

    function actUnrequested(uint256 actor, uint256 raw) public {
        address who = eoa[actor % 6];
        uint256 amount = raw % (token.balanceOf(who) + 1);
        uint256 q = ghostN > 1 ? vault.quoteWithdraw(1) : 0;
        vm.prank(who);
        (bool ok,) = a.token.call(abi.encodeCall(token.transfer, (a.vault, amount)));
        if (ok || vault.escrowPrincipal() != ghostE || (ghostN > 1 && vault.quoteWithdraw(1) != q)) failures |= 512;
        ++successes[7];
    }

    function actTransfer(uint256 seed, uint256 actor, uint256 mode) public {
        if (touched.length == 0) return;
        uint256 id = touched[seed % touched.length];
        address from = ghostOwner[id];
        if (from == a.vault) return;
        address to = actor % 7 == 6 ? address(nftReceiver) : eoa[actor % 6];
        address caller = from;
        mode %= 5;
        if (mode == 1) {
            caller = eoa[7];
            vm.prank(from);
            collection.approve(caller, id);
        } else if (mode >= 2) {
            caller = eoa[7];
            vm.prank(from);
            collection.setApprovalForAll(caller, true);
            if (mode == 3) {
                vm.prank(from);
                collection.setApprovalForAll(caller, false);
            }
        }
        bool expected = mode != 3;
        bytes memory callData = mode == 4
            ? abi.encodeWithSignature("safeTransferFrom(address,address,uint256,bytes)", from, to, id, hex"1234")
            : abi.encodeCall(collection.transferFrom, (from, to, id));
        vm.prank(caller);
        (bool ok,) = a.collection.call(callData);
        if (ok != expected) failures |= 1024;
        if (ok) {
            ghostOwner[id] = to;
            if (collection.getApproved(id) != address(0)) failures |= 1024;
            ++successes[8];
        } else {
            ++refused;
        }
        vm.prank(from);
        collection.setApprovalForAll(eoa[7], false);
    }

    function actReveal(uint256 seed) public {
        if (touched.length == 0) return;
        uint256 id = touched[seed % touched.length];
        bool already = ghostRevealed[id];
        vm.prank(eoa[7]);
        (bool ok,) = a.collection.call(_revealCall(id, _data(id)));
        if (ok == already) failures |= 2048;
        if (ok) {
            ghostRevealed[id] = true;
            ++ghostReveals;
        }
        ++successes[9];
    }

    function _checkCampaign() internal view {
        assertEq(failures, 0, "sticky discrepancies; action reverts are caught");
        _assertVault();
        assertEq(vault.escrowPrincipal(), ghostE);
        assertEq(vault.inside(), ghostN);
        assertEq(vault.pendingTickets(), ghostTickets);
        assertEq(vault.hiddenCount(), ghostHidden);
        assertEq(vault.shelfCount() + ghostHidden, ghostN);
        assertEq(collection.revealedCount(), ghostReveals);
        assertEq(stream.outsideCount(), editionSize - ghostN, "real observer books each n change");
        uint256 outside = collection.balanceOf(address(nftReceiver));
        for (uint256 i; i < 8; ++i) {
            outside += collection.balanceOf(eoa[i]);
        }
        assertEq(outside + ghostN + ghostTickets, editionSize);
        assertEq(outside + collection.balanceOf(a.vault), editionSize, "sum of every possible holder balance");
        for (uint256 i; i < touched.length; ++i) {
            uint256 id = touched[i];
            assertEq(collection.ownerOf(id), ghostOwner[id]);
            assertEq(collection.isRevealed(id), ghostRevealed[id]);
            assertEq(vault.isOutside(id), ghostOwner[id] != a.vault);
            if (ghostOwner[id] == a.vault) assertEq(collection.getApproved(id), address(0));
            (address observed,) = stream.pendingOf(id);
            assertEq(observed, ghostOwner[id] == a.vault ? address(0) : ghostOwner[id]);
        }
    }

    function afterInvariant() public view {
        // Full-domain check once per sequence; per-call checks cover all moved ids and all holder balances.
        for (uint256 id = 1; id <= editionSize; ++id) {
            address expected = ghostOwner[id] == address(0) ? a.vault : ghostOwner[id];
            assertEq(collection.ownerOf(id), expected);
            assertEq(collection.isRevealed(id), ghostRevealed[id]);
        }
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneVaultInvariants is AuditU7LaneCampaign {
    function invariant_AUDIT_U7_vaultAccountingAndCustodyAfterEveryCall() public view {
        _checkCampaign();
    }
}

/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneCollectionInvariants is AuditU7LaneCampaign {
    function setUp() public override {
        super.setUp();
        actGraduate();
        actOpen(0, true);
        actOpen(0, true);
        // Grace permits an actual unrevealed exit; random permissionless reveals can succeed, not just repeat.
        vm.warp(uint256(tickets.status().wordAcceptedAt) + tickets.REVEAL_GRACE());
        actOpen(0, false);
    }

    function _selectors() internal pure override returns (bytes4[] memory selectors) {
        selectors = new bytes4[](4);
        selectors[0] = this.actTransfer.selector;
        selectors[1] = this.actReveal.selector;
        selectors[2] = this.actReturn.selector;
        selectors[3] = this.actPick.selector;
    }

    function invariant_AUDIT_U7_collectionOwnersBalancesAndSingleReveal() public view {
        _checkCampaign();
    }
}

/// @notice Deterministic coverage of every action, including a successful reveal and a signature-silent backup draw.
/// forge-config: default.evm_version = "osaka"
contract AuditU7LaneCampaignCoverage is AuditU7LaneCampaign {
    function testProperty_AUDIT_U7_campaignReachesEveryAction() public {
        actTake(0, 2);
        actHandBack(0);
        actUnrequested(0, 17);
        actGraduate();
        actOpen(0, true);
        actReturn(0);
        actPick(0, 4);
        actTransfer(0, 6, 4);
        _checkCampaign();
        actDraw(3);
        _checkCampaign();
        vm.warp(uint256(tickets.status().wordAcceptedAt) + tickets.REVEAL_GRACE());
        actOpen(0, false);
        actReveal(touched.length - 1);
        actReveal(touched.length - 1);
        actDraw(3); // beyond the committed rounds: real backup
        _checkCampaign();
        for (uint256 i; i < successes.length; ++i) {
            assertGt(successes[i], 0);
        }
        afterInvariant();
    }
}
