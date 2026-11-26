// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {BoxLayoutV1} from "../../../../src/box/BoxLayoutV1.sol";
import {BoxSpecV1} from "../../../../src/box/BoxSpecV1.sol";
import {BoxBuildV1 as RehearsalBuildV1} from "../../../../src/box/build/rehearsal/BoxBuildV1.sol";
import {BoxBuildV1} from "sh-box-build/BoxBuildV1.sol";
import {AuditU9ClaudeTwinVectors as TV} from "./AuditU9ClaudeTwinVectors.sol";

/// @title AuditU9ClaudeRehearsalTest (SH-AUDIT-B0-U9, Claude; P9.1, P9.7 on both builds; lenses L1, L7, L8)
/// @notice The two builds of core v1 (F78; foundry.toml `rehearsal` maps `sh-box-build/` to src/box/build/rehearsal/):
/// written to pass under either profile, each assertion naming the build it expects. The default run checks the
/// mainnet build; `FOUNDRY_PROFILE=rehearsal` (run once, evidence) the testnet build Sepolia's box 0 runs.
contract AuditU9ClaudeRehearsalTest is Test {
    uint256 internal constant R = 4_206_980_085_000_000_000;

    /// P9.1 under the active build: its raise lays out exactly (removal pays the raise, the least liquidity, a full
    /// cross pays at least it), and box 0's Sepolia spec files validate exactly under their own build.
    function testProperty_AUDIT_U9_activeBuildRaiseLaysOutExactly() public view {
        uint256 raise = BoxBuildV1.RAISE;
        assertEq(raise, BoxBuildV1.REHEARSAL ? R / 10 : R, "the build's raise");
        assertEq(BoxSpecV1.qListV1()[0].raisePresets[0], raise, "validate()'s preset is the build's raise");
        BoxLayoutV1.Curve memory c = BoxLayoutV1.curve(raise, false);
        assertEq(c.tickLower, BoxBuildV1.REHEARSAL ? int24(200_220) : int24(177_180));
        assertEq(c.tickUpper - c.tickLower, 26_880);
        assertEq(c.curveT + c.poolShare, BoxSpecV1.ISSUANCE);
        string memory file = BoxBuildV1.REHEARSAL
            ? "/script/config/box0-spec.11155111.rehearsal.sepolia-safe.json"
            : "/script/config/box0-spec.11155111.safe.json";
        BoxSpecV1.BoxSpec memory s = abi.decode(
            vm.parseJsonBytes(vm.readFile(string.concat(vm.projectRoot(), file)), ".encoded"), (BoxSpecV1.BoxSpec)
        );
        (uint16 reason,) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK, file);
    }

    // W3-U9-2, accepted as built (FQ-35, F147): build-profile.ts says so (f7a16611b); scaling comes with version 2.
    /// @notice Proof test 02 (P9.7 / BC-001 on the rehearsal build; a twin disagreement, no effect on box 0).
    /// - Property: the TypeScript twin gives Solidity's verdict for a spec "as a given build checks it"
    ///   (packages/box-spec/src/build-profile.ts:1-6, `contextForBuild`; F78), BC-001 (both accept and refuse exactly
    ///   the same specs). Solidity's add-on 5 check compares capPerEpoch with the build's presets
    ///   (BoxSpecV1.sol:625, BoxBuildV1.CREATOR_FEE_CAP_PRESET_0-4: 1, 4, 8, 16, 32 ETH on mainnet, 0.1 to 3.2 ETH in
    ///   the rehearsal build, src/box/build/rehearsal/BoxBuildV1.sol:38-46).
    /// - Expected: under the rehearsal context the twin accepts the rehearsal presets and refuses the mainnet ones, as
    ///   the rehearsal build's validate() does.
    /// - Observed: the twin's check hard-codes the mainnet presets (packages/box-spec/src/generated/box-spec.v1.ts:955,
    ///   `checkCreatorFeeCap`) and `contextForBuild` maps only the raise (build-profile.ts:12-21): with the rehearsal
    ///   context (the token-only demo at R / 10, add-on 5 with excess BURN) the twin refuses all five rehearsal presets
    ///   (NOT_A_MEMBER at field 501) and accepts the five mainnet ones; the rehearsal build's validate() answers the
    ///   opposite for all ten (run under FOUNDRY_PROFILE=rehearsal: 10 of 10 disagree; the default build: 10 of 10
    ///   agree).
    /// - Steps: the vectors `AuditU9ClaudeTwinVectors.buildVectors()` (the twin's verdicts); here each spec rebuilt and
    ///   validated under the active build. Amounts: the caps above, in wei; raise 420,698,008,500,000,000.
    /// - Reach: version 2 only (add-on 5 is version 2's; factory v1 validates under version 1's context and creates
    ///   only box 0), on the testnet build only.
    function testAccepted_AUDIT_U9_02_twinIgnoresTheRehearsalCapPresets() public pure {
        uint256[5] memory rehearsal = [
            RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_0,
            RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_1,
            RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_2,
            RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_3,
            RehearsalBuildV1.CREATOR_FEE_CAP_PRESET_4
        ];
        BoxSpecV1.VersionContext memory ctx = abi.decode(TV.context(6), (BoxSpecV1.VersionContext));
        assertEq(ctx.qList[0].raisePresets[0], R / 10, "the twin's rehearsal context (contextForBuild)");
        bytes memory d = TV.buildVectors();
        uint256 agree;
        uint256 tsRefusesRehearsalPreset;
        for (uint256 i; i < TV.BUILD_VECTORS; ++i) {
            uint256 cap = uint256(bytes32(_slice(d, 36 * i, 32)));
            uint256 tsReason = (uint256(uint8(d[36 * i + 32])) << 8) | uint8(d[36 * i + 33]);
            uint256 tsField = (uint256(uint8(d[36 * i + 34])) << 8) | uint8(d[36 * i + 35]);
            bool rehearsalPreset = cap == rehearsal[0] || cap == rehearsal[1] || cap == rehearsal[2]
                || cap == rehearsal[3] || cap == rehearsal[4];
            if (rehearsalPreset && tsReason == BoxSpecV1.REASON_NOT_A_MEMBER) {
                assertEq(tsField, BoxSpecV1.FIELD_ADD_ON_CREATOR_FEE_CAP_CAP_PER_EPOCH);
                ++tsRefusesRehearsalPreset;
            }
            BoxSpecV1.BoxSpec memory s = abi.decode(TV.base(3), (BoxSpecV1.BoxSpec));
            s.raise = R / 10;
            s.creatorBuy = 0;
            s.addOns = new BoxSpecV1.AddOn[](1);
            s.addOns[0] = BoxSpecV1.AddOn({id: BoxSpecV1.ADD_ON_CREATOR_FEE_CAP, params: abi.encode(cap, uint8(2))});
            (uint16 r, uint16 f) = BoxSpecV1.validate(s, ctx);
            if (r == tsReason && f == tsField) ++agree;
        }
        assertEq(tsRefusesRehearsalPreset, 5, "the twin refuses every preset of the rehearsal build");
        // The rehearsal build's own validate() disagrees on all ten; the mainnet build's agrees on all ten.
        assertEq(agree, BoxBuildV1.REHEARSAL ? 0 : 10, "the active build against the twin");
    }

    function _slice(bytes memory d, uint256 at, uint256 len) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; ++i) {
            out[i] = d[at + i];
        }
    }
}
