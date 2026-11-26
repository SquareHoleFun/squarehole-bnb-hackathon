// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/console.sol";
import {BoxSpecV1} from "../../../src/box/BoxSpecV1.sol";
import {DeployCoreV1} from "../../../script/DeployCoreV1.s.sol";
import {SepoliaBox0TestSet} from "../../../script/lib/SepoliaBox0TestSet.sol";
import {BoxS7Base} from "../s7/BoxS7Base.sol";
import {DeployCoreV1Harness} from "../s7/BoxFactoryV1Deploy.t.sol";

/// @notice Box 0's spec for the Sepolia rehearsal of core v1 (docs/runbooks/sepolia-core-v1.md), as committed in
/// script/config/box0-spec.11155111.json (desk question Z3's default: the testnet deployer as the platform address) and
/// box0-spec.11155111.safe.json (Z3's alternative: the mainnet Safe's address, which has no code on Sepolia), written by
/// packages/box-spec/src/sepolia-box0-spec.test.ts:
/// - each file's `.encoded` decodes to a BoxSpec whose hash is the file's `specHash`, valid under version 1
///   (`BoxSpecV1.validate`) and accepted by the planner's template-0 rules for its own platform address only;
/// - it is box 0's fixture with exactly the Sepolia changes (neutral names and texts, the test set's commitment, table
///   and generator, openAt (F80: the clock time the founder picks on deploy day, written by `pnpm sepolia-spec:write`;
///   checked as a time, never pinned), the platform), each checked here, and nothing else;
/// - the deploy script reads the same spec from the file (`DeployCoreV1._planFor`) on Sepolia only (both files are
///   refused on mainnet, whatever the platform address), refuses a platform address the spec does not name, and holds
///   every Sepolia run (the dry run too) to the Glamsterdam guard: the hour before the fork closed, and after it the
///   acknowledgement plus measured state gas;
/// - creating box 0 with the neutral twin table costs what the real round-7 table costs (the table's size is F75 W1's).
/// forge-config: default.evm_version = "osaka"
contract SepoliaBox0SpecTest is BoxS7Base {
    string internal constant DEFAULT_FILE = "script/config/box0-spec.11155111.json";
    string internal constant SAFE_FILE = "script/config/box0-spec.11155111.safe.json";
    /// @notice A committed JSON file with no `.chainId` (box 0's fixture vectors).
    string internal constant NO_CHAIN_FILE = "test/vectors/box-spec/box-spec-v1.json";
    string internal constant TEST_SET = "test/vectors/box/sepolia-box0-test-set.json";
    string internal constant R7 = "test/vectors/box/misfits-trait-table-r7.json";
    address internal constant TESTNET_DEPLOYER = 0x1F1481667Ef20928d55524dfE4640f96Bd9b4eeE;

    function _file(string memory path) internal view returns (BoxSpecV1.BoxSpec memory s, bytes32 hash, address p) {
        string memory json = vm.readFile(path);
        bytes memory encoded = vm.parseJsonBytes(json, ".encoded");
        s = abi.decode(encoded, (BoxSpecV1.BoxSpec));
        hash = vm.parseJsonBytes32(json, ".specHash");
        p = vm.parseJsonAddress(json, ".platform");
        assertEq(keccak256(encoded), hash, "the file's spec hash is keccak256(.encoded)");
        assertEq(keccak256(abi.encode(s)), hash, "canonical ABI encoding");
        assertEq(vm.parseJsonUint(json, ".chainId"), 11_155_111);
    }

    /// Both files: valid under version 1, template 0 for their own platform address and refused for the other one
    /// (NotTemplate0(marketplaceOwner)), so desk question Z3 is one file name.
    function test_bothFilesValidateAndAreTemplate0ForTheirPlatformOnly() public view {
        (BoxSpecV1.BoxSpec memory s, bytes32 h, address p) = _file(DEFAULT_FILE);
        (BoxSpecV1.BoxSpec memory t, bytes32 hs, address ps) = _file(SAFE_FILE);
        assertEq(p, TESTNET_DEPLOYER, "Z3 default: the testnet deployer");
        assertEq(ps, SAFE, "Z3 alternative: the mainnet Safe's address");
        assertEq(s.marketplaceOwner, p);
        assertEq(t.marketplaceOwner, ps);
        (uint16 reason, uint16 field) = BoxSpecV1.validate(s, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK, string.concat("field ", vm.toString(field)));
        (reason, field) = BoxSpecV1.validate(t, BoxSpecV1.contextV1());
        assertEq(reason, BoxSpecV1.REASON_OK, string.concat("field ", vm.toString(field)));
        assertEq(planner.refusal(s, p).length, 0, "template 0 with the testnet deployer as platform");
        assertEq(planner.refusal(t, ps).length, 0, "template 0 with the Safe as platform");
        assertEq(planner.refusal(s, SAFE), _notTemplate0(BoxSpecV1.FIELD_MARKETPLACE_OWNER), "a mismatch is refused");
        assertEq(planner.refusal(t, p), _notTemplate0(BoxSpecV1.FIELD_MARKETPLACE_OWNER), "both ways");
        // The template id does not follow the platform address (data, not structure: BC-013).
        bytes32 v = keccak256("any version code hash");
        assertEq(planner.templateIdOf(s, v, bytes32(uint256(1))), planner.templateIdOf(t, v, bytes32(uint256(1))));
        console.log("SEPOLIA|spec hash (Z3 default, testnet deployer)", vm.toString(h));
        console.log("SEPOLIA|spec hash (Z3 alternative, mainnet Safe address)", vm.toString(hs));
    }

    /// Box 0's fixture with the Sepolia changes only: applying exactly them to the fixture gives the file's spec.
    function test_theSpecIsBox0sFixtureWithTheSepoliaChangesOnly() public view {
        (BoxSpecV1.BoxSpec memory s,,) = _file(DEFAULT_FILE);
        BoxSpecV1.BoxSpec memory f = _fixture();
        string memory set = vm.readFile(TEST_SET);
        // The declared changes, each checked for its value.
        assertEq(s.tokenName, "Rehearsal Token 3");
        assertEq(s.tokenSymbol, "RHT3");
        assertEq(s.collectionName, "Rehearsal Collection 2");
        assertEq(s.collectionSymbol, "RHC2");
        // F80: a clock time (not Now, not a block count), as the file's own fields say; both files carry the same one.
        assertGe(s.openAt, BoxSpecV1.MIN_OPEN_AT, "a clock time, UTC");
        assertEq(vm.parseJsonUint(vm.readFile(DEFAULT_FILE), ".openAt"), s.openAt, "the file's openAt is the spec's");
        (BoxSpecV1.BoxSpec memory t,,) = _file(SAFE_FILE);
        assertEq(t.openAt, s.openAt, "Z3's twin opens at the same time");
        assertEq(s.revealRoot, vm.parseJsonBytes32(set, ".root"), "the test set's root");
        assertEq(s.metadataTable, vm.parseJsonBytes(set, ".metadataTable"), "the neutral twin table");
        assertEq(s.metadataTable.length, 3_341, "F75 W1's size");
        assertEq(s.generatorHash, SepoliaBox0TestSet.GENERATOR_HASH, "no generator behind test data");
        assertEq(s.marketplaceOwner, TESTNET_DEPLOYER);
        (string memory pName, string memory pSymbol,, string memory hidden, string memory svg) =
            abi.decode(_addOnParams(s, BoxSpecV1.ADD_ON_PLACEHOLDERS), (string, string, string, string, string));
        assertEq(pName, "Rehearsal placeholder 2");
        assertEq(pSymbol, "RHC2-P");
        assertTrue(vm.contains(hidden, "Test data only"), "the neutral hidden text");
        assertTrue(vm.contains(svg, "#9ca3af"), "the neutral grey tile");
        string[3] memory labels = ["Series A", "Series B", "Series C"];
        uint256 series;
        for (uint256 i; i < s.addOns.length; ++i) {
            assertEq(s.addOns[i].id, f.addOns[i].id, "the fixture's add-ons, in order");
            if (s.addOns[i].id != BoxSpecV1.ADD_ON_EDITION_SPECIALS) continue;
            (string memory label, uint32 count) = abi.decode(s.addOns[i].params, (string, uint32));
            (, uint32 fixtureCount) = abi.decode(f.addOns[i].params, (string, uint32));
            assertEq(label, labels[series++], "a neutral series label");
            assertEq(count, fixtureCount, "the series' count kept (12, 69, 26)");
        }
        assertEq(series, 3);
        // Nothing else: the fixture with these fields copied over is the file's spec, byte for byte.
        f.tokenName = s.tokenName;
        f.tokenSymbol = s.tokenSymbol;
        f.collectionName = s.collectionName;
        f.collectionSymbol = s.collectionSymbol;
        f.description = s.description;
        f.openAt = s.openAt;
        f.revealRoot = s.revealRoot;
        f.metadataTable = s.metadataTable;
        f.generatorHash = s.generatorHash;
        f.marketplaceOwner = s.marketplaceOwner;
        for (uint256 i; i < s.addOns.length; ++i) {
            uint16 id = s.addOns[i].id;
            if (id == BoxSpecV1.ADD_ON_PLACEHOLDERS || id == BoxSpecV1.ADD_ON_EDITION_SPECIALS) {
                f.addOns[i].params = s.addOns[i].params;
            }
        }
        assertEq(keccak256(abi.encode(f)), keccak256(abi.encode(s)), "only the declared fields differ");
        // Kept from the fixture, named for the reader: N, the final cover and banner hashes, royalties.
        assertEq(s.n, 4_269);
        assertEq(s.collectionCoverSha256, 0x41cf86fd8bf4bf185534477e35ca01b8183316adc947a92f9c3d8933a90f11fb, "Sorter");
        (bytes32 banner,,) =
            abi.decode(_addOnParams(s, BoxSpecV1.ADD_ON_COLLECTION_METADATA), (bytes32, bytes32[], string));
        assertEq(banner, 0xa8202b6917194146c6d2c9ddb53529dd9f064089d9019d9989dfb722dd921afe, "banner A");
    }

    /// The spec's commitment is the Solidity derivation's too (the library recomputes the root from the label).
    function test_theRevealRootIsTheLibrarysRoot() public view {
        (BoxSpecV1.BoxSpec memory s,,) = _file(DEFAULT_FILE);
        assertEq(s.revealRoot, SepoliaBox0TestSet.root());
    }

    /// What the deploy script reads: the same spec, on Sepolia's PoolManager and WETH, with the platform address the spec
    /// names; any other platform address is refused before anything is planned.
    function test_theDeployScriptReadsTheFile() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        (, bytes32 hash, address p) = _file(DEFAULT_FILE);
        vm.chainId(11_155_111);
        vm.warp(h.GLAMSTERDAM_SEPOLIA() - 1 days);
        DeployCoreV1.Plan memory plan = h.planFor(TESTNET_DEPLOYER, p, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        assertEq(keccak256(abi.encode(plan.spec)), hash, "the script's spec is the file's");
        assertFalse(plan.fixture);
        assertFalse(plan.sending);
        assertEq(address(plan.poolManager), h.POOL_MANAGER_SEPOLIA());
        assertEq(plan.weth, h.WETH_SEPOLIA());
        assertEq(plan.platformSafe, TESTNET_DEPLOYER);
        assertEq(plan.box0Creator, TESTNET_DEPLOYER);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.PlatformSafeMismatch.selector, TESTNET_DEPLOYER, SAFE));
        h.planFor(TESTNET_DEPLOYER, SAFE, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        (, bytes32 safeHash,) = _file(SAFE_FILE);
        plan = h.planFor(TESTNET_DEPLOYER, SAFE, TESTNET_DEPLOYER, SAFE_FILE, false);
        assertEq(keccak256(abi.encode(plan.spec)), safeHash, "Z3's alternative file");
    }

    /// Mainnet never reads a Sepolia spec file (review finding 1). The finding's case: the Safe twin on chain 1 with the
    /// default platform (the mainnet Safe, which the twin names) planned box 0 before; now the file's `.chainId` must be
    /// the run's chain (the first check, before the platform's), for either file and any platform address; a spec file
    /// without `.chainId` is refused on every chain; on mainnet a spec carrying the rehearsal's test commitment is
    /// refused even under another file.
    function test_aSepoliaSpecFileIsRefusedOnMainnet() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        (BoxSpecV1.BoxSpec memory s,,) = _file(DEFAULT_FILE);
        (BoxSpecV1.BoxSpec memory t,,) = _file(SAFE_FILE);
        vm.chainId(1);
        bytes memory wrongChain = abi.encodeWithSelector(DeployCoreV1.SpecFileForAnotherChain.selector, 11_155_111, 1);
        vm.expectRevert(wrongChain);
        h.planFor(TESTNET_DEPLOYER, SAFE, TESTNET_DEPLOYER, SAFE_FILE, false);
        vm.expectRevert(wrongChain);
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        vm.expectRevert(wrongChain);
        h.planFor(TESTNET_DEPLOYER, SAFE, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.SpecFileWithoutChainId.selector, NO_CHAIN_FILE));
        h.planFor(TESTNET_DEPLOYER, SAFE, TESTNET_DEPLOYER, NO_CHAIN_FILE, false);
        // Every public test commitment, including box 0's fixture, is refused on mainnet.
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, s.revealRoot));
        h.checkSpecForChain(1, s);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, t.revealRoot));
        h.checkSpecForChain(1, t);
        BoxSpecV1.BoxSpec memory fixture = _fixture();
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, fixture.revealRoot));
        h.checkSpecForChain(1, fixture);
        h.checkSpecForChain(11_155_111, t);
        // Mainnet's default fixture is refused; Sepolia's files still pass before the fork's hour.
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.TestCommitmentRefused.selector, fixture.revealRoot));
        h.planFor(TESTNET_DEPLOYER, SAFE, TESTNET_DEPLOYER, "", false);
        vm.chainId(11_155_111);
        vm.warp(h.GLAMSTERDAM_SEPOLIA() - 1 days);
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        h.planFor(TESTNET_DEPLOYER, SAFE, TESTNET_DEPLOYER, SAFE_FILE, false);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.SpecFileWithoutChainId.selector, NO_CHAIN_FILE));
        h.planFor(TESTNET_DEPLOYER, SAFE, TESTNET_DEPLOYER, NO_CHAIN_FILE, false);
    }

    /// Desk question Z1: before the fork (the default) a run passes until an hour before it; in that hour every Sepolia
    /// run is refused, acknowledged or not (review finding 4); after the fork every Sepolia run, the dry run included, is
    /// refused without SH_CORE_V1_GLAMSTERDAM_ACK=true.
    function test_everySepoliaRunIsHeldToTheGlamsterdamGuard() public {
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        uint256 g = h.GLAMSTERDAM_SEPOLIA();
        assertEq(h.GLAMSTERDAM_MARGIN(), 1 hours);
        vm.chainId(11_155_111);
        vm.warp(g - 1 hours - 1);
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, true);
        vm.warp(g - 1 hours);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamTooClose.selector, g - 1 hours, g));
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        vm.warp(g - 10 minutes);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamTooClose.selector, g - 10 minutes, g));
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, true);
        vm.warp(g - 1);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamTooClose.selector, g - 1, g));
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, true);
        vm.warp(g);
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamNotAcknowledged.selector, g));
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, false);
        h.planFor(TESTNET_DEPLOYER, TESTNET_DEPLOYER, TESTNET_DEPLOYER, DEFAULT_FILE, true);
        h.checkGlamsterdamWindow(1, g - 10 minutes, false);
        h.checkGlamsterdamWindow(1, g, false);
    }

    /// After the fork the acknowledgement is measured, not trusted (review finding 4): the script refuses unless a deployed
    /// code byte costs EIP-8037's state gas in the EVM forge simulates with. Today's rules (osaka): 200 a byte, refused;
    /// Foundry's `amsterdam`: accepted. Before the fork nothing is refused; on mainnet the chain's own figure decides
    /// (its RPC's estimate, set here: test/box/sepolia/GlamsterdamAfter.t.sol).
    function test_afterGlamsterdamTheScriptMeasuresStateGas() public {
        vm.setEvmVersion("osaka"); // Pin both schedules even when the CLI selects Amsterdam.
        DeployCoreV1Harness h = new DeployCoreV1Harness();
        uint256 g = h.GLAMSTERDAM_SEPOLIA();
        uint256 min = h.STATE_GAS_PER_CODE_BYTE_MIN();
        uint256 today = h.codeByteGas();
        assertEq(today, 200, "the code deposit before EIP-8037");
        vm.expectRevert(abi.encodeWithSelector(DeployCoreV1.GlamsterdamNotSimulated.selector, today, min));
        h.checkGlamsterdamSimulated(11_155_111, g);
        h.checkGlamsterdamSimulated(11_155_111, g - 1);
        h.setChainCodeByteGas(201);
        h.checkGlamsterdamSimulated(1, g);
        vm.setEvmVersion("amsterdam");
        uint256 glamsterdam = h.codeByteGas();
        h.checkGlamsterdamSimulated(11_155_111, g);
        vm.setEvmVersion("osaka");
        console.log("SEPOLIA|gas per deployed code byte (osaka)", today);
        console.log("SEPOLIA|gas per deployed code byte (amsterdam)", glamsterdam);
        assertEq(glamsterdam, 1_530, "EIP-8037 code deposit, beside Osaka's 200");
    }

    /// Creation gas (F75 W1's point): box 0 with the neutral twin table costs what it costs with the real round-7 table,
    /// today and under Glamsterdam (Foundry's `amsterdam`), on the factory of this test's world (platform: the Safe, so
    /// the Z3 alternative file is the one created here; the default differs only in a 20-byte address).
    function test_creationGas_theTwinTableCostsWhatTheRealTableCosts() public {
        (BoxSpecV1.BoxSpec memory twin,,) = _file(SAFE_FILE);
        BoxSpecV1.BoxSpec memory real = _copy(twin);
        real.metadataTable = vm.parseJsonBytes(vm.readFile(R7), ".table");
        for (uint256 k; k < 2; ++k) {
            string memory evm = k == 0 ? "osaka" : "amsterdam";
            uint256 a = _measure(twin, evm);
            uint256 b = _measure(real, evm);
            console.log(string.concat("SEPOLIA|createBox gas (", evm, "), neutral twin table"), a);
            console.log(string.concat("SEPOLIA|createBox gas (", evm, "), real round-7 table"), b);
            assertEq(a, b, "the same creation gas: the table's size and byte classes are the real table's");
        }
    }

    function _measure(BoxSpecV1.BoxSpec memory s, string memory evm) internal returns (uint256 g) {
        assertEq(factory.refusal(s, address(this)).length, 0, "accepted");
        uint256 snap = vm.snapshotState();
        bytes memory callData = abi.encodeCall(factory.createBox, (s, _salt(s), _executorCode()));
        vm.deal(address(this), 1 ether);
        vm.setEvmVersion(evm);
        vm.cool(address(factory));
        vm.cool(address(registry));
        vm.cool(address(planner));
        vm.cool(address(pm));
        g = this.measureCreate(callData);
        vm.setEvmVersion("osaka");
        vm.revertToState(snap);
    }

    function measureCreate(bytes calldata callData) external returns (uint256 g) {
        uint256 g0 = gasleft();
        (bool ok,) = address(factory).call{value: BoxSpecV1.BOOTSTRAP_ETH}(callData);
        g = g0 - gasleft();
        require(ok, "createBox");
    }
}
