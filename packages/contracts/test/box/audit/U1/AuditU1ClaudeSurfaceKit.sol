// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CommonBase} from "forge-std/Base.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {BoxClones} from "../../../../src/box/libraries/BoxClones.sol";
import {AuditU1ClaudeSurfaceTable as T} from "./AuditU1ClaudeSurfaceTable.sol";

/// @notice TEST ONLY: a stranger's clone factory. It CREATEs any runtime (here: the exact runtime of one of box 0's
/// clones, so the stranger's clone runs the version's implementation with box 0's own arguments) at an address that is
/// not box 0's.
contract AuditU1ClaudeCloner {
    function deploy(bytes memory runtime) external returns (address a) {
        a = BoxClones.create(BoxClones.initCode(runtime));
    }
}

/// @title AuditU1ClaudeProbe
/// @notice TEST ONLY (SH-AUDIT-B0 U1, P1.4; BC-010 "every state-changing function is fuzzed from random callers"). One
/// probe = one call of (target, selector, caller, calldata) with the caller pranked and the whole call's state diff
/// recorded (`vm.startStateDiffRecording`). The documented caller table (`AuditU1ClaudeSurfaceTable`) decides whether
/// the caller may call: when it may not (or the selector is unknown, or a view), the call must revert or change
/// nothing: no storage slot of any account may end with another value (net of every non-reverted write), and no ETH may
/// move. A call the table allows is not checked (it is that function's own unit's property). Counters record what ran.
contract AuditU1ClaudeProbe is CommonBase {
    struct Target {
        address at;
        uint8 kind;
    }

    Target[] internal _targets;
    address[] internal _callers;
    /// @dev Per kind: the selectors of its ABI and their classes.
    mapping(uint8 => bytes4[]) internal _sels;
    mapping(uint8 => mapping(bytes4 => uint8)) internal _class;
    mapping(uint8 => mapping(bytes4 => bool)) internal _known;
    /// @dev Per target and class: the addresses the target's own wiring names for that class.
    mapping(address => mapping(uint8 => address[])) internal _allowed;

    uint256 public probes;
    uint256 public restricted;
    uint256 public restrictedReverted;
    uint256 public restrictedNoOp;
    uint256 public allowedSkipped;
    uint256 public violations;
    bytes public firstViolation;
    /// @dev Restricted probes per kind (for the evidence's per-contract counts).
    mapping(uint8 => uint256) public restrictedOfKind;

    constructor() {
        for (uint8 k; k < 18; ++k) {
            (string[] memory s, uint8[] memory c) = T.table(k);
            for (uint256 i; i < s.length; ++i) {
                bytes4 sel = bytes4(keccak256(bytes(s[i])));
                _sels[k].push(sel);
                _class[k][sel] = c[i];
                _known[k][sel] = true;
            }
        }
    }

    // ------------------------------------------------------------------------------------------------ setup

    function addTarget(address at, uint8 kind) external {
        _targets.push(Target(at, kind));
    }

    function addCaller(address c) external {
        _callers.push(c);
    }

    function allow(address target, uint8 class_, address caller) external {
        _allowed[target][class_].push(caller);
    }

    function targetCount() external view returns (uint256) {
        return _targets.length;
    }

    function callerCount() external view returns (uint256) {
        return _callers.length;
    }

    function targetAt(uint256 i) external view returns (address, uint8) {
        return (_targets[i].at, _targets[i].kind);
    }

    function selectorsOf(uint8 kind) external view returns (bytes4[] memory) {
        return _sels[kind];
    }

    // ------------------------------------------------------------------------------------------------ the probe

    /// @notice One probe. `selSeed` picks one of the target kind's selectors, or (1 in 8) a random selector, or (1 in
    /// 16) empty calldata; `callerSeed` picks a listed caller or (1 in 4) a fresh address; `words` (0 to 6 of them) are
    /// the arguments, each a dictionary value or raw.
    function probe(uint256 targetSeed, uint256 selSeed, uint256 callerSeed, uint256 nWords, bytes32[6] memory words)
        public
        returns (bool violated)
    {
        Target memory t = _targets[targetSeed % _targets.length];
        address caller = callerSeed % 4 == 0
            ? address(uint160(uint256(keccak256(abi.encode("u1.probe.caller", callerSeed)))))
            : _callers[(callerSeed >> 2) % _callers.length];
        (bytes4 sel, bool empty) = _selector(t.kind, selSeed);
        bytes memory data = empty ? bytes("") : _calldata(sel, nWords % 7, words, t.at, caller);
        return probeExact(t.at, t.kind, data, caller);
    }

    /// @notice One probe of exactly `data` from `caller` on `at` (of `kind`).
    function probeExact(address at, uint8 kind, bytes memory data, address caller) public returns (bool) {
        bool empty = data.length == 0;
        bytes4 sel = empty ? bytes4(0) : bytes4(data);
        uint8 class_ = empty ? T.receiveClass(kind) : _classOf(kind, sel);
        ++probes;
        if (class_ == T.ANYONE || _isAllowed(at, class_, caller)) {
            ++allowedSkipped;
            return false;
        }
        ++restricted;
        ++restrictedOfKind[kind];
        vm.startStateDiffRecording();
        vm.prank(caller);
        (bool ok,) = at.call(data);
        VmSafe.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        if (!ok) {
            ++restrictedReverted;
            return false;
        }
        (bool wrote, address where, bytes32 slot) = _netWrite(acc);
        bool moved = _ethMoved(acc);
        if (!wrote && !moved) {
            ++restrictedNoOp;
            return false;
        }
        ++violations;
        if (firstViolation.length == 0) firstViolation = abi.encode(at, kind, sel, caller, data, where, slot, moved);
        return true;
    }

    function _selector(uint8 kind, uint256 seed) internal view returns (bytes4 sel, bool empty) {
        if (seed % 16 == 0) return (bytes4(0), true);
        bytes4[] storage list = _sels[kind];
        if (seed % 8 == 1 || list.length == 0) return (bytes4(uint32(seed >> 8)), false);
        return (list[(seed >> 4) % list.length], false);
    }

    function _classOf(uint8 kind, bytes4 sel) internal view returns (uint8) {
        if (kind == T.K_TABLE || !_known[kind][sel]) return T.NOBODY;
        return _class[kind][sel];
    }

    function _isAllowed(address target, uint8 class_, address caller) internal view returns (bool) {
        address[] storage list = _allowed[target][class_];
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == caller) return true;
        }
        return false;
    }

    /// @dev selector ++ `n` words; each word a dictionary value (by its low byte) or the raw word.
    function _calldata(bytes4 sel, uint256 n, bytes32[6] memory w, address target, address caller)
        internal
        view
        returns (bytes memory data)
    {
        data = abi.encodePacked(sel);
        for (uint256 i; i < n; ++i) {
            data = bytes.concat(data, _word(w[i], target, caller));
        }
    }

    function _word(bytes32 raw, address target, address caller) internal view returns (bytes32) {
        uint256 r = uint256(raw);
        uint256 pick = r % 12;
        if (pick == 0) return bytes32(0);
        if (pick == 1) return bytes32(uint256(1));
        if (pick == 2) return bytes32(uint256(0x20));
        if (pick == 3) return bytes32(uint256(0x40));
        if (pick == 4) return bytes32((r >> 8) % 4_096);
        if (pick == 5) return bytes32(type(uint256).max);
        if (pick == 6) return bytes32(uint256(uint160(caller)));
        if (pick == 7) return bytes32(uint256(uint160(target)));
        if (pick == 8) return bytes32(uint256(uint160(_targets[(r >> 8) % _targets.length].at)));
        if (pick == 9) return bytes32(uint256(uint160(_callers[(r >> 8) % _callers.length])));
        if (pick == 10) return bytes32((r >> 8) % 1e18);
        return raw;
    }

    /// @dev Whether any account's storage slot ends with another value than it started with (non-reverted writes).
    function _netWrite(VmSafe.AccountAccess[] memory acc)
        internal
        pure
        returns (bool wrote, address where, bytes32 slot)
    {
        uint256 m;
        for (uint256 i; i < acc.length; ++i) {
            m += acc[i].storageAccesses.length;
        }
        address[] memory a = new address[](m);
        bytes32[] memory s = new bytes32[](m);
        bytes32[] memory first = new bytes32[](m);
        bytes32[] memory last = new bytes32[](m);
        uint256 k;
        for (uint256 i; i < acc.length; ++i) {
            for (uint256 j; j < acc[i].storageAccesses.length; ++j) {
                VmSafe.StorageAccess memory x = acc[i].storageAccesses[j];
                if (!x.isWrite || x.reverted) continue;
                uint256 at = k;
                for (uint256 y; y < k; ++y) {
                    if (a[y] == x.account && s[y] == x.slot) {
                        at = y;
                        break;
                    }
                }
                if (at == k) {
                    (a[k], s[k], first[k]) = (x.account, x.slot, x.previousValue);
                    ++k;
                }
                last[at] = x.newValue;
            }
        }
        for (uint256 y; y < k; ++y) {
            if (first[y] != last[y]) return (true, a[y], s[y]);
        }
    }

    /// @dev Whether any non-reverted frame carried value or changed a balance.
    function _ethMoved(VmSafe.AccountAccess[] memory acc) internal pure returns (bool) {
        for (uint256 i; i < acc.length; ++i) {
            if (acc[i].reverted) continue;
            VmSafe.AccountAccessKind k = acc[i].kind;
            bool frame = k == VmSafe.AccountAccessKind.Call || k == VmSafe.AccountAccessKind.Create
                || k == VmSafe.AccountAccessKind.CallCode;
            if (frame && acc[i].value != 0) return true;
        }
        return false;
    }
}
