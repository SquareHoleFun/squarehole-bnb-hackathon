// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {IBoxFactoryV1} from "../../../../src/box/interfaces/IBoxFactoryV1.sol";
import {BoxRegistry} from "../../../../src/box/BoxRegistry.sol";
import {CoreImpls} from "../../conformance/core/CoreBox0Kit.sol";
import {AuditU1ClaudeProbe} from "./AuditU1ClaudeSurfaceKit.sol";
import {AuditU1ClaudeSurfaceBase} from "./AuditU1ClaudeSurfaceWorld.sol";

/// @notice What the handler asks the invariant test for: one of the world's booked actions (trading, keepers, time).
interface AuditU1ClaudeDriver {
    function u1Drive(uint256 action, uint256 x) external;
}

/// @title AuditU1ClaudeSurfaceHandler
/// @notice TEST ONLY (SH-AUDIT-B0 U1, P1.4; BC-010 as an invariant campaign). Three of its four entry points are
/// probes (a random (target, selector, caller, calldata) through `AuditU1ClaudeProbe`); the fourth drives box 0's life
/// through the world's booked helpers (time, buys, sells, a fee batch, placeholders, the closing buy and graduation),
/// so the probes meet many states. Nothing here reverts (fail-safe, as S5M4Handler): a refused drive is counted.
contract AuditU1ClaudeSurfaceHandler is CommonBase {
    AuditU1ClaudeProbe public immutable probe;
    AuditU1ClaudeDriver public immutable driver;
    uint256 public drives;
    uint256 public drivesDone;

    constructor(AuditU1ClaudeProbe probe_, AuditU1ClaudeDriver driver_) {
        probe = probe_;
        driver = driver_;
    }

    function probeA(uint256 t, uint256 s, uint256 c, uint256 n, bytes32[6] memory w) external {
        probe.probe(t, s, c, n, w);
    }

    function probeB(uint256 t, uint256 s, uint256 c, uint256 n, bytes32[6] memory w) external {
        probe.probe(t, s, c, n, w);
    }

    function probeC(uint256 t, uint256 s, uint256 c, uint256 n, bytes32[6] memory w) external {
        probe.probe(t, s, c, n, w);
    }

    function drive(uint256 action, uint256 x) external {
        ++drives;
        try driver.u1Drive(action, x) {
            ++drivesDone;
        } catch {}
    }
}

/// @title AuditU1ClaudeSurfaceInvariantsBase
/// @notice The invariants every U1 campaign checks after every call: (1) BC-010, no probe whose caller is outside the
/// documented table changed any state; (2) BC-012 / ADR-0016 § 2 and § 5, nothing changes a box's code, wiring or
/// record: every box 0 contract, implementation, extension, the factory, planner and registry keep the code hash they
/// had at setUp, the coordinator keeps its hook and box id, every clone its arguments' wiring, and the registry its
/// one record, whose rebuilt record still hashes to the stored hash; (3) BC-064, BC-034: box 0 exists once and every
/// further createBox is refused (Box0Exists), the factory's addresses never move.
abstract contract AuditU1ClaudeSurfaceInvariantsBase is AuditU1ClaudeSurfaceBase, AuditU1ClaudeDriver {
    AuditU1ClaudeSurfaceHandler internal handler;
    address[] internal watched;
    bytes32[] internal codeHashes;
    bytes32 internal box0AddressesHash;
    address internal hookAtSetUp;

    function _setUpCampaign() internal {
        _buildProbe();
        handler = new AuditU1ClaudeSurfaceHandler(probe, AuditU1ClaudeDriver(address(this)));
        targetContract(address(handler));
        CoreImpls memory im = kit.impls();
        address[26] memory w = [
            a.coordinator,
            a.hook,
            a.launchRouter,
            a.receiver,
            a.collection,
            a.vault,
            a.tickets,
            a.itemStream,
            a.royaltyRouter,
            a.token,
            a.executor,
            a.table,
            im.coordinator,
            im.hook,
            im.hookExtension,
            im.launchRouter,
            im.receiver,
            im.receiverExtension,
            im.collection,
            im.vault,
            im.tickets,
            im.itemStream,
            im.royaltyRouter,
            im.planner,
            im.factory,
            im.registry
        ];
        for (uint256 i; i < w.length; ++i) {
            watched.push(w[i]);
            codeHashes.push(w[i].codehash);
        }
        box0AddressesHash = keccak256(abi.encode(factory.box0Addresses()));
        hookAtSetUp = coordinator.hook();
    }

    /// @notice The handler's drive: one booked world action (see the handler's notes).
    function u1Drive(uint256 action, uint256 x) external {
        require(msg.sender == address(handler), "u1: the handler only");
        address who = eoa[x % 6];
        uint256 pick = action % 7;
        if (pick == 0) {
            _advance(1 + x % 300);
        } else if (pick == 1) {
            _buy(who, 0.001 ether + x % 1 ether);
        } else if (pick == 2) {
            uint256 b = token.balanceOf(who);
            require(b != 0, "nothing to sell");
            _sell(who, b / 2 + 1);
        } else if (pick == 3) {
            _collect(keeper, keeper);
        } else if (pick == 4) {
            _take(who, 1 + x % 3);
        } else if (pick == 5) {
            _fundFees(who, 0.01 ether + x % 1 ether);
        } else if (!hook.closed()) {
            _buyTo(eoa[2], 3 * raise, curve.sqrtPriceLowerX96);
        } else {
            _graduate(keeper);
        }
    }

    /// The campaign's reach, measured: 600 handler calls from a fixed seed (one drive in four), with the counts the
    /// evidence reports (probes, restricted probes, drives done, the phase reached) and the three invariants after.
    function testProperty_AUDIT_U1_campaignReach() public {
        vm.pauseGasMetering();
        for (uint256 i; i < 600; ++i) {
            uint256 r = uint256(keccak256(abi.encode("u1.reach", i)));
            if (i % 4 == 3) {
                handler.drive(r, r >> 128);
            } else {
                bytes32[6] memory w;
                for (uint256 j; j < 6; ++j) {
                    w[j] = keccak256(abi.encode("u1.reach.word", i, j));
                }
                handler.probeA(r, r >> 64, r >> 128, r >> 192, w);
            }
        }
        vm.resumeGasMetering();
        emit log_named_uint("probes", probe.probes());
        emit log_named_uint("restricted probes", probe.restricted());
        emit log_named_uint("violations", probe.violations());
        emit log_named_uint("drives", handler.drives());
        emit log_named_uint("drives done", handler.drivesDone());
        emit log_named_uint("hook phase (0 none .. 5 graduated)", uint8(hook.phase()));
        emit log_named_uint("graduated", coordinator.graduated() ? 1 : 0);
        assertGt(handler.drivesDone(), 0, "the drives move the box");
        invariant_AUDIT_U1_noStrangerWrites();
        invariant_AUDIT_U1_codeWiringAndRecordFixed();
        invariant_AUDIT_U1_box0OnceAndAddressesFixed();
    }

    function invariant_AUDIT_U1_noStrangerWrites() public {
        _assertProbeClean();
    }

    function invariant_AUDIT_U1_codeWiringAndRecordFixed() public view {
        for (uint256 i; i < watched.length; ++i) {
            assertEq(watched[i].codehash, codeHashes[i], "a code hash changed");
        }
        assertEq(coordinator.hook(), hookAtSetUp, "the coordinator's hook");
        assertEq(coordinator.boxId(), 0, "the coordinator's box id");
        assertEq(hook.coordinator(), a.coordinator, "hook wiring");
        assertEq(launchRouter.coordinator(), a.coordinator, "router wiring");
        assertEq(receiver.coordinator(), a.coordinator, "receiver wiring");
        assertEq(collection.coordinator(), a.coordinator, "collection wiring");
        assertEq(vault.coordinator(), a.coordinator, "vault wiring");
        assertEq(tickets.coordinator(), a.coordinator, "tickets wiring");
        assertEq(stream.coordinator(), a.coordinator, "stream wiring");
        assertEq(royaltyRouter.coordinator(), a.coordinator, "royalty router wiring");
        BoxRegistry reg = BoxRegistry(factory.registry());
        (address c, uint256 block_, bytes32 templateId, bytes32 specHash, bytes32 recordHash) = reg.entry(0);
        assertEq(c, a.coordinator, "the record's coordinator");
        assertEq(block_, createdAtBlock, "the record's creation block");
        assertEq(templateId, factory.templateIdOf(kit.spec()), "the record's template id");
        assertEq(specHash, coordinator.specHash(), "the record's spec hash");
        assertEq(keccak256(abi.encode(reg.recordOf(0))), recordHash, "the record rebuilt from the chain");
    }

    function invariant_AUDIT_U1_box0OnceAndAddressesFixed() public view {
        BoxRegistry reg = BoxRegistry(factory.registry());
        assertEq(reg.boxCount(), 1, "one box");
        (bool recorded, uint256 id) = reg.boxIdOf(a.coordinator);
        assertTrue(recorded && id == 0, "box 0 recorded");
        assertEq(
            factory.refusal(kit.spec(), address(kit)),
            abi.encodeWithSelector(IBoxFactoryV1.Box0Exists.selector),
            "every further createBox is refused"
        );
        assertEq(keccak256(abi.encode(factory.box0Addresses())), box0AddressesHash, "the addresses never move");
    }
}

/// @title AuditU1ClaudeSurfaceInvariants
/// @notice The campaign from the bonding curve (the world's Bonding phase: window over, trades, placeholders, one fee
/// batch); the drives can close the curve and graduate, so runs cross graduation. osaka.
/// forge-config: default.evm_version = "osaka"
contract AuditU1ClaudeSurfaceInvariants is AuditU1ClaudeSurfaceInvariantsBase {
    function setUp() public override {
        super.setUp();
        _toBonding();
        _setUpCampaign();
    }
}

/// @title AuditU1ClaudeSurfaceDrawingInvariants
/// @notice The campaign from the world's Drawing phase (graduated, the word accepted, two draws settled, items outside,
/// the gate open), osaka.
/// forge-config: default.evm_version = "osaka"
contract AuditU1ClaudeSurfaceDrawingInvariants is AuditU1ClaudeSurfaceInvariantsBase {
    function setUp() public override {
        super.setUp();
        _toDrawing();
        _setUpCampaign();
    }
}
