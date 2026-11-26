// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployCoreV2} from "../../../script/DeployCoreV2.s.sol";
import {CoreV2SafeChecks} from "../../../script/lib/CoreV2SafeChecks.sol";
import {SafeProxyFixture} from "../m1-63/offchain/SafeProxyFixture.sol";
import {WSafe} from "./CQ11WDeployment.t.sol";

/// SH-188: DeployCoreV2's Safe preflight only, with namespaced settings (the host environment is shared by suites).
contract SafePinsHarness is DeployCoreV2 {
    string private _prefix;

    constructor(string memory prefix) {
        _prefix = prefix;
    }

    function _environmentKey(string memory key) internal view override returns (string memory) {
        return string.concat(_prefix, key);
    }

    function safePins(address fit, address platform) external returns (string memory safes, string memory owners) {
        Config memory c;
        c.fitSafe = fit;
        c.platformSafe = platform;
        return (_safePins(c), _ownerRoles());
    }

    function platformCustody(address founder, address bot) external view returns (address[] memory, uint256) {
        return _platformCustody(founder, bot);
    }
}

/// F151 R68-SAFE: the mainnet platform Safe is 2-of-3, the founder and the two owners he names, taken from
/// CORE_V2_PLATFORM_SECOND_OWNER and CORE_V2_PLATFORM_THIRD_OWNER (refused when missing) and never the bot (F164 D2).
/// Sepolia keeps the founder alone at threshold 1. Mutable Safe state is reset in each test; settings are namespaced.
contract PlatformSafeCustodyTest is Test {
    address internal constant BOT = address(0xB07);
    address internal constant FOUNDER = address(0xF00);
    address internal constant BACKUP = address(0xBAC);
    address internal constant SECOND = address(0x5EC0);
    address internal constant THIRD = address(0x7D1);
    WSafe internal fit;
    WSafe internal platform;
    SafePinsHarness internal script;
    string internal prefix;

    function setUp() public {
        address singleton = address(new WSafe(new address[](0), 0));
        WSafe platformSingleton = new WSafe(new address[](0), 0);
        platformSingleton.setVersion("1.5.0");
        address[] memory fitOwners = new address[](3);
        (fitOwners[0], fitOwners[1], fitOwners[2]) = (BOT, FOUNDER, BACKUP);
        fit = _proxy(singleton, fitOwners, 2, "1.4.1");
        // Safe's getOwners() lists the newest owner first: after step 6's two additions the founder is last.
        platform = _proxy(address(platformSingleton), _list(THIRD, SECOND, FOUNDER), 2, "1.5.0");
    }

    /// Foundry runs this contract's tests concurrently in one process, so each test gets its own settings namespace.
    function _use(string memory tag) internal {
        prefix = string.concat("SH188_", tag, "_");
        _configure(prefix, true);
        script = new SafePinsHarness(prefix);
    }

    function _proxy(address singleton, address[] memory owners, uint256 threshold, string memory version)
        internal
        returns (WSafe safe)
    {
        safe = WSafe(payable(address(new SafeProxyFixture(singleton))));
        safe.setOwners(owners);
        safe.setThreshold(threshold);
        safe.setVersion(version);
    }

    function _list(address a, address b, address c) internal pure returns (address[] memory owners) {
        owners = new address[](3);
        (owners[0], owners[1], owners[2]) = (a, b, c);
    }

    function _one(address a) internal pure returns (address[] memory owners) {
        owners = new address[](1);
        owners[0] = a;
    }

    function _set(string memory space, string memory key, string memory value) internal {
        vm.setEnv(string.concat(space, key), value);
    }

    function _configure(string memory space, bool withPlatformOwners) internal {
        bytes32 proxyHash = keccak256(type(SafeProxyFixture).runtimeCode);
        _set(space, "CORE_V2_BOT", vm.toString(BOT));
        _set(space, "CORE_V2_FOUNDER", vm.toString(FOUNDER));
        _set(space, "CORE_V2_BACKUP", vm.toString(BACKUP));
        _set(space, "CORE_V2_SAFE_VERSION", "1.4.1");
        _set(space, "CORE_V2_PINNED_FIT_SAFE", vm.toString(address(fit)));
        _set(space, "CORE_V2_SAFE_SINGLETON", vm.toString(fit.masterCopy()));
        _set(space, "CORE_V2_SAFE_SINGLETON_CODEHASH", vm.toString(fit.masterCopy().codehash));
        _set(space, "CORE_V2_SAFE_GUARD", vm.toString(address(0)));
        _set(space, "CORE_V2_SAFE_HANDLER", vm.toString(address(0)));
        _set(space, "CORE_V2_SAFE_PROXY_CODEHASH", vm.toString(proxyHash));
        _set(space, "CORE_V2_PINNED_PLATFORM_SAFE", vm.toString(address(platform)));
        _set(space, "CORE_V2_PLATFORM_SAFE_VERSION", "1.5.0");
        _set(space, "CORE_V2_PLATFORM_SAFE_SINGLETON", vm.toString(platform.masterCopy()));
        _set(space, "CORE_V2_PLATFORM_SAFE_SINGLETON_CODEHASH", vm.toString(platform.masterCopy().codehash));
        _set(space, "CORE_V2_PLATFORM_SAFE_GUARD", vm.toString(address(0)));
        _set(space, "CORE_V2_PLATFORM_SAFE_HANDLER", vm.toString(address(0)));
        _set(space, "CORE_V2_PLATFORM_SAFE_PROXY_CODEHASH", vm.toString(proxyHash));
        if (withPlatformOwners) {
            _set(space, "CORE_V2_PLATFORM_SECOND_OWNER", vm.toString(SECOND));
            _set(space, "CORE_V2_PLATFORM_THIRD_OWNER", vm.toString(THIRD));
        }
    }

    function _unsafe() internal view returns (bytes memory) {
        return abi.encodeWithSelector(CoreV2SafeChecks.UnsafeSafe.selector, address(platform));
    }

    // --- mainnet (chain 1) ---------------------------------------------------------------------------------------

    function test_mainnetPolicyIsTwoOfThreeWithTheFounderAndBothConfiguredOwners() public {
        _use("test_mainnetPolicyIsTwoOfThreeWithTheFounderAndBothConfiguredOwners");
        vm.chainId(1);
        (address[] memory owners, uint256 threshold) = script.platformCustody(FOUNDER, BOT);
        assertEq(threshold, 2);
        assertEq(owners.length, 3);
        assertEq(owners[0], FOUNDER);
        assertEq(owners[1], SECOND);
        assertEq(owners[2], THIRD);
    }

    function test_mainnetAcceptsTheTwoOfThreePlatformSafeWithTheFounderAnywhere() public {
        _use("test_mainnetAcceptsTheTwoOfThreePlatformSafeWithTheFounderAnywhere");
        vm.chainId(1);
        address[3][3] memory orders = [[THIRD, SECOND, FOUNDER], [FOUNDER, SECOND, THIRD], [SECOND, FOUNDER, THIRD]];
        for (uint256 i; i < orders.length; ++i) {
            platform.setOwners(_list(orders[i][0], orders[i][1], orders[i][2]));
            (string memory safes, string memory roles) = script.safePins(address(fit), address(platform));
            assertEq(vm.parseJsonString(safes, ".platform.threshold"), "2");
            address[] memory pinned = vm.parseJsonAddressArray(safes, ".platform.owners");
            assertEq(pinned.length, 3);
            assertEq(pinned[0], orders[i][0]);
            assertEq(vm.parseJsonString(safes, ".fit.threshold"), "2");
            assertEq(vm.parseJsonAddress(roles, ".founder"), FOUNDER);
            assertEq(vm.parseJsonAddress(roles, ".bot"), BOT);
            assertEq(vm.parseJsonAddress(roles, ".backup"), BACKUP);
        }
    }

    function test_mainnetRefusesTheOneOfOnePlatformSafe() public {
        _use("test_mainnetRefusesTheOneOfOnePlatformSafe");
        vm.chainId(1);
        platform.setOwners(_one(FOUNDER));
        platform.setThreshold(1);
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
    }

    function test_mainnetRefusesAWrongThreshold() public {
        _use("test_mainnetRefusesAWrongThreshold");
        vm.chainId(1);
        platform.setThreshold(1);
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
        platform.setThreshold(3);
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
    }

    function test_mainnetRefusesAWrongOwnerCount() public {
        _use("test_mainnetRefusesAWrongOwnerCount");
        vm.chainId(1);
        address[] memory two = new address[](2);
        (two[0], two[1]) = (SECOND, FOUNDER);
        platform.setOwners(two);
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
        address[] memory four = new address[](4);
        (four[0], four[1], four[2], four[3]) = (address(0xF04), THIRD, SECOND, FOUNDER);
        platform.setOwners(four);
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
    }

    function test_mainnetRefusesAnOwnerOtherThanTheConfiguredOnes() public {
        _use("test_mainnetRefusesAnOwnerOtherThanTheConfiguredOnes");
        vm.chainId(1);
        platform.setOwners(_list(address(0xBAD), SECOND, FOUNDER));
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
        // The founder missing, the two configured owners and one stranger.
        platform.setOwners(_list(THIRD, SECOND, address(0xBAD)));
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
    }

    function test_mainnetFailsClosedWhenTheTwoOwnersAreNotConfigured() public {
        _use("test_mainnetFailsClosedWhenTheTwoOwnersAreNotConfigured");
        vm.chainId(1);
        string memory bare = string.concat(prefix, "BARE_");
        _configure(bare, false);
        SafePinsHarness unconfigured = new SafePinsHarness(bare);
        vm.expectRevert();
        unconfigured.safePins(address(fit), address(platform));
        vm.expectRevert();
        unconfigured.platformCustody(FOUNDER, BOT);
        // One of two is not enough.
        _set(bare, "CORE_V2_PLATFORM_SECOND_OWNER", vm.toString(SECOND));
        vm.expectRevert();
        unconfigured.safePins(address(fit), address(platform));
        // An empty value is not an address.
        _set(bare, "CORE_V2_PLATFORM_THIRD_OWNER", "");
        vm.expectRevert();
        unconfigured.safePins(address(fit), address(platform));
    }

    function test_mainnetRefusesTheBotAsAPlatformOwner() public {
        _use("test_mainnetRefusesTheBotAsAPlatformOwner");
        vm.chainId(1);
        platform.setOwners(_list(BOT, SECOND, FOUNDER));
        _set(prefix, "CORE_V2_PLATFORM_THIRD_OWNER", vm.toString(BOT));
        vm.expectRevert(DeployCoreV2.PlatformOwnerIsBot.selector);
        script.safePins(address(fit), address(platform));
        _set(prefix, "CORE_V2_PLATFORM_THIRD_OWNER", vm.toString(THIRD));
        _set(prefix, "CORE_V2_PLATFORM_SECOND_OWNER", vm.toString(BOT));
        vm.expectRevert(DeployCoreV2.PlatformOwnerIsBot.selector);
        script.platformCustody(FOUNDER, BOT);
        _set(prefix, "CORE_V2_PLATFORM_SECOND_OWNER", vm.toString(SECOND));
    }

    function test_mainnetRefusesARepeatedOrZeroConfiguredOwner() public {
        _use("test_mainnetRefusesARepeatedOrZeroConfiguredOwner");
        vm.chainId(1);
        _set(prefix, "CORE_V2_PLATFORM_SECOND_OWNER", vm.toString(FOUNDER));
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
        _set(prefix, "CORE_V2_PLATFORM_SECOND_OWNER", vm.toString(THIRD));
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
        _set(prefix, "CORE_V2_PLATFORM_SECOND_OWNER", vm.toString(address(0)));
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
        _set(prefix, "CORE_V2_PLATFORM_SECOND_OWNER", vm.toString(SECOND));
    }

    // --- Sepolia (unchanged) ---------------------------------------------------------------------------------------

    function test_sepoliaKeepsTheFounderAloneAtThresholdOne() public {
        _use("test_sepoliaKeepsTheFounderAloneAtThresholdOne");
        vm.chainId(11_155_111);
        (address[] memory owners, uint256 threshold) = script.platformCustody(FOUNDER, BOT);
        assertEq(threshold, 1);
        assertEq(owners.length, 1);
        assertEq(owners[0], FOUNDER);
        platform.setOwners(_one(FOUNDER));
        platform.setThreshold(1);
        (string memory safes,) = script.safePins(address(fit), address(platform));
        assertEq(vm.parseJsonString(safes, ".platform.threshold"), "1");
        assertEq(vm.parseJsonAddressArray(safes, ".platform.owners")[0], FOUNDER);
    }

    function test_sepoliaRefusesATwoOfThreePlatformSafe() public {
        _use("test_sepoliaRefusesATwoOfThreePlatformSafe");
        vm.chainId(11_155_111);
        vm.expectRevert(_unsafe());
        script.safePins(address(fit), address(platform));
    }

    function test_sepoliaNeverReadsTheMainnetOwnerSettings() public {
        _use("test_sepoliaNeverReadsTheMainnetOwnerSettings");
        vm.chainId(11_155_111);
        string memory bare = string.concat(prefix, "SEP_");
        _configure(bare, false);
        SafePinsHarness unconfigured = new SafePinsHarness(bare);
        platform.setOwners(_one(FOUNDER));
        platform.setThreshold(1);
        (string memory safes,) = unconfigured.safePins(address(fit), address(platform));
        assertEq(vm.parseJsonString(safes, ".platform.threshold"), "1");
    }
}
