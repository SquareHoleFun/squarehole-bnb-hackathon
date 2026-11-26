// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SetPoolFixture, SetStandardERC721, SetSpecV2} from "./SetPoolFixture.sol";
import {ERC721TokenReceiver} from "solmate/src/tokens/ERC721.sol";
import {ReceiverDeploy} from "../fee-modules/ReceiverDeploy.sol";
import {GasBudget} from "../gas/GasBudget.sol";
import {SetVaultV2} from "../../../src/box-v2/set/SetVaultV2.sol";
import {ISetFactory, SetReleaseFixture} from "./SetReleaseFixture.sol";
import {Vm} from "forge-std/Vm.sol";

/// Valid ERC-721 observations/transfers spending almost every allowed foreign-call unit, without telemetry SSTOREs.
contract SetBudgetERC721 is SetStandardERC721 {
    uint8 public mode;
    bool public expensiveProbes;
    event TransferBudget(uint256 entry, uint256 spent);

    function configure(uint8 mode_, bool probes) external {
        mode = mode_;
        expensiveProbes = probes;
    }

    function _spend() private view {
        if (expensiveProbes) {
            assembly { for {} gt(gas(), 1000) {} {} }
        }
    }

    function supportsInterface(bytes4 id) public view override returns (bool result) {
        result = super.supportsInterface(id) || id == 0xb45a3c0e;
        _spend();
    }

    function locked(uint256) external view returns (bool) {
        _spend();
        return false;
    }

    fallback() external {
        require(msg.sig == bytes4(keccak256("getTransferValidator()")), "absent");
        _spend();
        assembly { return(0, 0) }
    }

    function ownerOf(uint256 id) public view override returns (address owner) {
        owner = super.ownerOf(id);
        _spend();
    }

    function transferFrom(address from, address to, uint256 id) public override {
        uint256 entry = gasleft();
        super.transferFrom(from, to, id);
        _finish(entry);
    }

    function safeTransferFrom(address from, address to, uint256 id) public override {
        uint256 entry = gasleft();
        super.transferFrom(from, to, id);
        require(to.code.length == 0 || ERC721TokenReceiver(to).onERC721Received(msg.sender, from, id, "") == 0x150b7a02);
        _finish(entry);
    }

    function _finish(uint256 entry) private {
        if (mode == 2) {
            assembly { for {} 1 {} {} }
        }
        if (mode == 1) {
            assembly { for {} gt(gas(), 2000) {} {} }
        }
        emit TransferBudget(entry, entry - gasleft());
    }
}

abstract contract SetPoolGasFixture is SetPoolFixture {
    SetBudgetERC721 internal art;
    bytes32[] internal suffix;

    function _stage() internal pure virtual returns (uint256);

    function _count() internal pure virtual returns (uint32) {
        return 96;
    }

    function _erc20() internal pure virtual returns (bool) {
        return false;
    }

    // Preparing state in setUp preserves original nonzero storage for the measured transaction.
    function setUp() public virtual override {
        super.setUp();
        uint32 count = _count();
        if (count == 10000 && gasleft() < 5_000_000_000) vm.skip(true);
        art = new SetBudgetERC721();
        for (uint256 i; i < count; ++i) {
            art.mint(CREATOR, _id(i));
        }
        SetSpecV2 memory s;
        (s, suffix) = _terms(address(art), count);
        if (_erc20()) {
            (SetSpecV2 memory priced,) = _pricing();
            s.pricing = priced.pricing;
            s.raise = priced.raise;
        }
        _start(s);
        uint256 stage = _stage();
        if (stage == 0) return;
        _load(suffix);
        if (stage == 1) return;
        loader.complete();
        vm.warp(box.effectiveOpenAt());
        vm.roll(block.number + 1);
        if (stage == 2) {
            _gift(address(receiver), 15000);
            return;
        }
        if (stage == 6 || stage == 7) {
            _routerBuy(s.raise / 5);
            _gift(address(receiver), 15000);
            receiver.collect(address(0));
            vm.warp(box.deadline());
            if (stage == 7) {
                box.fail();
                vm.prank(ALICE);
                token.approve(address(box), type(uint256).max);
                _gift(address(receiver), 54321);
            }
            return;
        }
        if (stage == 10) {
            vm.warp(box.effectiveOpenAt() + 384);
            vm.roll(block.number + 1);
            for (uint256 i; i < 4; ++i) {
                buyer.swap(hook.poolKey(), true, s.raise / 4, curve.sqrtPriceEndX96);
            }
            assertFalse(hook.closed());
            return;
        }
        _fill();
        if (stage == 3) return;
        box.graduate();
        _fundPicker();
        if (stage == 4) return;
        vm.prank(ALICE);
        vault.withdrawBatch(_ids(0, 32), type(uint256).max, block.timestamp);
        vm.prank(ALICE);
        art.setApprovalForAll(address(vault), true);
    }

    function _cold() internal {
        address[24] memory roles;
        if (address(box) != address(0)) {
            for (uint256 i; i < 24; ++i) {
                roles[i] = box.roleAddress(i);
            }
        }
        address[13] memory deps = _dependencies();
        address validator = address(planner.validator());
        address parts = address(planner.parts());
        address price = address(box) == address(0) ? address(0) : box.q();
        ReceiverDeploy.cool(release.implementations[5]);
        if (price != address(0)) vm.cool(price);
        for (uint256 i; i < 24; ++i) {
            if (roles[i] != address(0)) vm.cool(roles[i]);
            if (release.implementations[i] != address(0)) vm.cool(release.implementations[i]);
        }
        for (uint256 i; i < deps.length; ++i) {
            vm.cool(deps[i]);
        }
        vm.cool(vm.computeCreateAddress(release.implementations[3], 1)); // VaultViews
        vm.cool(validator);
        vm.cool(parts);
        vm.cool(address(planner));
        vm.cool(checks);
        vm.cool(address(factory));
        vm.cool(collection);
        vm.cool(ALICE);
        vm.cool(CREATOR);
        vm.cool(address(buyer));
    }

    function _measure(string memory label, address sender, address target, bytes memory data, uint256 value)
        internal
        returns (bytes memory result)
    {
        _cold();
        vm.prank(sender);
        uint256 before = gasleft();
        bool ok;
        (ok, result) = target.call{gas: 16_000_000, value: value}(data);
        uint256 gross = before - gasleft();
        if (!ok) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
        uint256 total = GasBudget.transaction(gross, data);
        emit log_named_uint(label, total);
        assertLe(total, 16_777_216, "conservative transaction budget, no refund credit");
    }

    function _nearCap() internal {
        art.configure(1, true);
    }

    function _telemetry(uint256 expected) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(art) || logs[i].topics[0] != keccak256("TransferBudget(uint256,uint256)")) {
                continue;
            }
            (uint256 entry, uint256 spent) = abi.decode(logs[i].data, (uint256, uint256));
            assertGe(entry, 449000, "full foreign stipend forwarded");
            assertLe(entry, 450000);
            assertGt(spent, 445000, "near-cap body executed");
            ++count;
        }
        assertEq(count, expected);
    }
}

contract SetPoolLoadGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 0;
    }

    function test_E07_coldLoad32Standard() public {
        _measure("load 32 standard", CREATOR, address(loader), _pageData(0, 32, suffix[32]), 0);
        assertEq(vault.inside(), 32);
    }

    function test_E07_coldLoad8AllCallsNearCap() public {
        _nearCap();
        vm.recordLogs();
        _measure("load 8 all calls near cap", CREATOR, address(loader), _pageData(0, 8, suffix[8]), 0);
        _telemetry(8);
        assertEq(vault.inside(), 8);
    }

    function test_E07_expensive32LoadRefusesAtomicallyWithinEnvelope() public {
        _nearCap();
        bytes memory data = _pageData(0, 32, suffix[32]);
        _cold();
        vm.prank(CREATOR);
        (bool ok, bytes memory reason) = address(loader).call{gas: 16_000_000}(data);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(SetVaultV2.TransferGas.selector));
        (uint32 loaded,,) = loader.progress();
        assertEq(loaded, 0);
        assertEq(vault.inside(), 0);
        assertEq(art.ownerOf{gas: 30000}(0), CREATOR);
        _measure("retry load 8 near cap", CREATOR, address(loader), _pageData(0, 8, suffix[8]), 0);
    }

    function test_E07_coldClosedFailure() public {
        vm.warp(box.openAt() + 14 days);
        _measure("fail closed empty", ALICE, address(box), abi.encodeCall(box.failClosed, ()), 0);
        assertTrue(vault.failed());
    }
}

contract SetPoolOpenGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 1;
    }

    function test_E07_coldComplete() public {
        _measure("complete", ALICE, address(loader), abi.encodeCall(loader.complete, ()), 0);
        assertTrue(box.gateOpen());
    }
}

contract SetPoolTradeGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 2;
    }

    function test_E07_coldRouterBuy() public {
        uint256 amount = box.raise() / 20;
        _measure(
            "router buy",
            ALICE,
            address(router),
            abi.encodeCall(router.buy, (amount, 1, ALICE, block.timestamp)),
            _erc20() ? 0 : amount
        );
        assertGt(token.balanceOf(ALICE), 0);
    }

    function test_E07_coldCollect() public {
        _measure("collect", ALICE, address(receiver), abi.encodeCall(receiver.collect, (address(0))), 0);
        assertEq(receiver.fitOwed(), 2000);
    }
}

contract SetPoolGraduateGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 3;
    }

    function test_E07_coldGraduate() public {
        _measure("graduate", ALICE, address(box), abi.encodeCall(box.graduate, ()), 0);
        assertTrue(vault.gateOpen());
    }

    function test_E07_coldFilledTimeout() public {
        vm.warp(hook.closedAt() + 7 days);
        _measure("fail filled timeout", ALICE, address(box), abi.encodeCall(box.fail, ()), 0);
        assertTrue(vault.failed());
    }
}

contract SetPoolPickGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 4;
    }

    function test_E07_coldPick32Standard() public {
        _pick("pick 32 standard", 32);
    }

    function test_E07_coldPick8AllCallsNearCap() public {
        _nearCap();
        vm.recordLogs();
        _pick("pick 8 all calls near cap", 8);
        _telemetry(8);
    }

    function test_E09C_expensive32PickRefusesAtomically() public {
        _nearCap();
        bytes memory data = abi.encodeCall(vault.withdrawBatch, (_ids(0, 32), type(uint256).max, block.timestamp));
        _cold();
        vm.prank(ALICE);
        (bool ok,) = address(vault).call{gas: 16_000_000}(data);
        assertFalse(ok);
        assertEq(vault.inside(), 96);
        assertEq(vault.escrowPrincipal(), 0);
        _pick("retry pick 8 near cap", 8);
    }

    function _pick(string memory label, uint256 count) private {
        _measure(
            label,
            ALICE,
            address(vault),
            abi.encodeCall(vault.withdrawBatch, (_ids(0, count), type(uint256).max, block.timestamp)),
            0
        );
        assertEq(vault.inside(), 96 - count);
    }
}

contract SetPoolReturnGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 5;
    }

    function test_E07_coldReturn32Standard() public {
        _return("return 32 standard", 32);
    }

    function test_E07_coldReturn8AllCallsNearCap() public {
        _nearCap();
        vm.recordLogs();
        _return("return 8 all calls near cap", 8);
        _telemetry(8);
    }

    function test_E07_expensive32ReturnRefusesAtomicallyWithinEnvelope() public {
        _nearCap();
        uint256 e = vault.escrowPrincipal();
        uint256 supply = token.totalSupply();
        uint256 balance = token.balanceOf(ALICE);
        bytes memory data = abi.encodeCall(vault.returnItems, (_ids(0, 32), 0, block.timestamp));
        _cold();
        vm.prank(ALICE);
        (bool ok, bytes memory reason) = address(vault).call{gas: 16_000_000}(data);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(SetVaultV2.TransferGas.selector));
        assertEq(vault.escrowPrincipal(), e);
        assertEq(vault.inside(), 64);
        assertEq(token.totalSupply(), supply);
        assertEq(token.balanceOf(ALICE), balance);
        assertEq(art.ownerOf{gas: 30000}(0), ALICE);
        _return("retry return 8 near cap", 8);
    }

    function _return(string memory label, uint256 count) private {
        _measure(
            label, ALICE, address(vault), abi.encodeCall(vault.returnItems, (_ids(0, count), 0, block.timestamp)), 0
        );
        assertEq(vault.inside(), 64 + count);
    }
}

contract SetPoolFailGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 6;
    }

    function test_E07_coldDeadlineFailure() public {
        _measure("fail deadline", ALICE, address(box), abi.encodeCall(box.fail, ()), 0);
        assertTrue(vault.failed());
    }
}

contract SetPoolRecoveryGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 7;
    }

    function test_E07_coldRecovery32Standard() public {
        _release("recover 32 standard", 32, 32);
    }

    function test_E07_coldRecovery8AllCallsNearCap() public {
        _nearCap();
        vm.recordLogs();
        _release("recover 8 all calls near cap", 8, 8);
        _telemetry(8);
    }

    function test_E07_coldRecovery8ExhaustedTransfers() public {
        art.configure(2, true);
        _release("recover 8 exhausted transfers", 8, 0);
    }

    function test_E09C_expensive32RecoveryRefusesAtomically() public {
        _nearCap();
        bytes memory data = abi.encodeCall(vault.releaseToCreator, (_ids(0, 32)));
        _cold();
        (bool ok, bytes memory reason) = address(vault).call{gas: 16_000_000}(data);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(SetVaultV2.TransferGas.selector));
        assertEq(vault.inside(), 96);
        _release("retry recover 8 near cap", 8, 8);
    }

    function test_E09C_recoveryFloorWithBothOwnerReadsNearCap() public {
        _nearCap();
        bytes memory data = abi.encodeCall(vault.releaseToCreator, (_ids(0, 1)));
        _cold();
        (bool ok, bytes memory reason) = address(vault).call{gas: 2_000_000}(data);
        assertFalse(ok);
        assertEq(reason, abi.encodeWithSelector(SetVaultV2.TransferGas.selector));
        assertEq(vault.inside(), 96);
        _cold();
        vm.recordLogs();
        (ok, reason) = address(vault).call{gas: 2_200_000}(data);
        assertTrue(ok);
        assertEq(abi.decode(reason, (uint256)), 1);
        _telemetry(1);
    }

    function _release(string memory label, uint256 requested, uint256 count) private {
        bytes memory result =
            _measure(label, ALICE, address(vault), abi.encodeCall(vault.releaseToCreator, (_ids(0, requested))), 0);
        assertEq(abi.decode(result, (uint256)), count);
        assertEq(vault.inside(), 96 - count);
    }

    function test_E07_coldFinalClaimWithLateReceipt() public {
        uint256 held = token.balanceOf(ALICE);
        uint256 quote = box.quoteClaim(held);
        bytes memory result = _measure(
            "claim final with late receiver P", ALICE, address(box), abi.encodeCall(box.claim, (held, ALICE)), 0
        );
        assertEq(abi.decode(result, (uint256)), quote);
        (, uint256 left) = box.claimState();
        assertEq(left, 0);
    }
}

contract SetPoolFillGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 10;
    }

    function test_E07_coldClosingFill() public {
        _measure(
            "closing fill",
            ALICE,
            address(buyer),
            abi.encodeCall(buyer.swap, (hook.poolKey(), true, box.raise() / 4, curve.sqrtPriceEndX96)),
            0
        );
        assertTrue(hook.closed());
    }
}

contract SetPoolERC20TradeGasTest is SetPoolTradeGasTest {
    function _erc20() internal pure override returns (bool) {
        return true;
    }
}

contract SetPoolERC20GraduateGasTest is SetPoolGraduateGasTest {
    function _erc20() internal pure override returns (bool) {
        return true;
    }
}

contract SetPoolERC20FailGasTest is SetPoolFailGasTest {
    function _erc20() internal pure override returns (bool) {
        return true;
    }
}

contract SetPoolCreateGasTest is SetPoolGasFixture {
    function _stage() internal pure override returns (uint256) {
        return 0;
    }

    function setUp() public override {
        SetReleaseFixture.setUp();
        collection = address(nft);
    }

    function test_E07_coldMaxSpecCreateThroughRelease() public {
        SetBudgetERC721 largeSet = new SetBudgetERC721();
        (SetSpecV2 memory s,) = _terms(address(largeSet), 10000);
        s.tokenName = "SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS";
        s.tokenSymbol = "SSSSSSSSSSS";
        bytes memory description = new bytes(1024);
        for (uint256 i; i < description.length; ++i) {
            description[i] = "x";
        }
        s.description = string(description);
        s.creatorBuy = s.raise / 4;
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 payment = factory.boxQParameters(0, s.raise).bootstrapQ + s.creatorBuy;
        collection = address(largeSet);
        largeSet.configure(1, true);
        _measure(
            "first create max spec and near-cap probes",
            CREATOR,
            address(factory),
            abi.encodeCall(ISetFactory.createBox, (s, cs, hs)),
            payment
        );
        assertEq(registry.boxCount(), 1);
    }

    function test_E07_coldFirstCreateThroughRelease() public {
        SetSpecV2 memory s = _spec();
        (bytes32 cs, bytes32 hs) = _salts(s);
        uint256 payment = factory.boxQParameters(0, s.raise).bootstrapQ;
        _measure("first create", CREATOR, address(factory), abi.encodeCall(ISetFactory.createBox, (s, cs, hs)), payment);
        assertEq(registry.boxCount(), 1);
    }
}
