// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Script} from "forge-std/Script.sol";
import {CoreV2GasRules} from "./CoreV2GasRules.sol";
import {RegisterAlchemistV21} from "../RegisterAlchemistV21.s.sol";
import {AlchemistFeeModuleV21} from "../../src/box-v2/modules/AlchemistFeeModuleV21.sol";
import {AlchemistHopV21} from "../../src/box-v2/modules/AlchemistRouteV21.sol";
import {FeeModuleDirectoryV21} from "../../src/box-v2/FeeModuleDirectoryV21.sol";
import {IFeeModulesV21} from "../../src/box-v2/interfaces/IFeeModulesV21.sol";

interface AlchemistTestCoinMetadata {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice SH-EX-L4: rc8 Sepolia tPEPE -> native ETH -> tGOLD, with an unsigned platform Safe registration.
/// Default is simulation. Only the founder may opt into the shared script's address-only broadcast recording.
/// Coin addresses, positive dust and trigger are required inputs; there are no guessed deployment addresses.
contract DeploySepoliaAlchemist is Script, CoreV2GasRules {
    address public constant MANAGER = 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
    address public constant RECEIVER = 0x3dE38b84592d3B633905c96a2cef08740e4b72E0;
    address public constant COORDINATOR = 0xe93B776a256d54dB2ABEcA4bBa68e44703dDB2C7;
    address public constant DIRECTORY = 0xF856948cEc46e79249Ba4E3Fdb9796CB5f182c93;
    address public constant SAFE = 0x9432380a67745b453886698F9539aC035DF80B34;
    // Recorded rc8 deployment, reviewed-plan.directory-time.json. Directory immutables include its creation time.
    bytes32 public constant RECEIVER_HASH = 0x0d93d4eec07dadf572b2eca5cae9ab5d76a53ba1876edc7e0830b57b836b363c;
    bytes32 public constant COORDINATOR_HASH = 0xfe5347d5e4dc20b780026740f9bdaee457259ea5bf9a1904943fda58d522cab9;
    bytes32 public constant DIRECTORY_HASH = 0x846c54958a4a6e7564eed649a64ec755c61b6075398ce0b1d402e1b9709955fa;
    // rc8 uses the unchanged RC5 module/helper creation bytecode; runtime hashes include this deployment's immutables.
    bytes32 public constant MODULE_INIT_HASH = 0xc866b823bb11a39459edd551183f365035e8ff55b4f41d0f7ed2d6cf22fae9af;
    bytes32 public constant EXECUTOR_INIT_HASH = 0x02137a9a21f6f79e35947094c5e3766724caeaf92459b943a556f7fa9c3791df;
    uint256 public constant INPUT_CAP = 1_000e18;
    // At TA-30's initial price, one wei of ETH is 1e6 raw tPEPE. Founder chooses a positive dust <= this raw scale.
    uint256 public constant MAX_DUST = 1e6;
    event SafeCall(address indexed safe, address indexed to, uint256 value, bytes data);
    event RoutePrepared(address indexed pepe, address indexed gold, uint256 inputCap, uint256 dust, address trigger);

    /// @notice Read public environment inputs, simulate a CREATE, and emit the exact Safe register call.
    function run() external returns (address action, bytes memory safeData) {
        return prepare(vm.envAddress("CORE_V2_DEPLOYER"), vm.envAddress("ALCHEMIST_PEPE"),
            vm.envAddress("ALCHEMIST_GOLD"), vm.envUint("ALCHEMIST_DUST_RAW"), vm.envAddress("ALCHEMIST_TRIGGER"));
    }

    /// @notice Anyone can simulate. No directory write, approval, swap or private-key read occurs here.
    function prepare(address deployer, address pepe, address gold, uint256 dust, address trigger)
        public returns (address action, bytes memory safeData)
    {
        require(block.chainid == RULES_SEPOLIA || block.chainid == 31337, "testnet only");
        require(deployer != address(0) && trigger != address(0), "sender and trigger");
        require(dust > 0 && dust <= MAX_DUST && 2 * dust < INPUT_CAP, "reviewed dust scale");
        require(pepe != gold && pepe.code.length != 0 && gold.code.length != 0, "distinct deployed coins");
        require(AlchemistTestCoinMetadata(pepe).decimals() == 18 && AlchemistTestCoinMetadata(gold).decimals() == 18, "18-decimal coins");
        require(keccak256(bytes(AlchemistTestCoinMetadata(pepe).symbol())) == keccak256("tPEPE")
            && keccak256(bytes(AlchemistTestCoinMetadata(gold).symbol())) == keccak256("tGOLD"), "test coin symbols");
        _checkRelease();
        (,,address directory) = IFeeModulesV21(RECEIVER).receiverCode();
        require(directory == DIRECTORY && FeeModuleDirectoryV21(directory).lister() == SAFE
            && !FeeModuleDirectoryV21(directory).renounced(), "rc8 directory authority");
        require(keccak256(vm.getCode("AlchemistFeeModuleV21.sol:AlchemistFeeModuleV21")) == MODULE_INIT_HASH
            && keccak256(vm.getCode("AlchemistRouteV21.sol:AlchemistRouteV21")) == EXECUTOR_INIT_HASH, "rc8 creation code");
        if (block.chainid == RULES_SEPOLIA) {
            _checkGlamsterdamWindow(block.chainid, block.timestamp);
            _checkGlamsterdamSimulated(block.chainid, block.timestamp);
        }
        if (vm.envOr("ALCHEMIST_BROADCAST", false)) require(msg.sender == deployer, "deployer");
        AlchemistHopV21[] memory route = new AlchemistHopV21[](2);
        route[0] = AlchemistHopV21(4, pepe, address(0), MANAGER, 3000, 60);
        route[1] = AlchemistHopV21(4, address(0), gold, MANAGER, 3000, 60);
        // Reuse the release script's CREATE gas/state-gas/size checks and runtime hash event.
        (action, safeData) = new RegisterAlchemistV21().run(deployer, MANAGER, RECEIVER, COORDINATOR, route, INPUT_CAP, dust, trigger);
        _checkModule(action, pepe, gold, dust, trigger);
        emit RoutePrepared(pepe, gold, INPUT_CAP, dust, trigger);
        emit SafeCall(SAFE, DIRECTORY, 0, safeData);
    }

    function _checkRelease() internal view virtual {
        require(MANAGER.code.length != 0 && RECEIVER.codehash == RECEIVER_HASH
            && COORDINATOR.codehash == COORDINATOR_HASH && DIRECTORY.codehash == DIRECTORY_HASH, "rc8 release code hashes");
    }

    function _checkModule(address action, address pepe, address gold, uint256 dust, address trigger) private view {
        AlchemistFeeModuleV21 m = AlchemistFeeModuleV21(action);
        require(address(m.poolManager()) == MANAGER && m.receiverImplementation() == RECEIVER
            && m.coordinatorImplementation() == COORDINATOR && m.priceCoin() == pepe && m.pileCoin() == gold
            && m.inputCap() == INPUT_CAP && m.dustMax() == dust && m.conversionTrigger() == trigger, "module immutables");
        require(m.executorCodeHash() == address(m.executor()).codehash && m.executor().module() == action
            && address(m.executor().manager()) == MANAGER && m.executor().dustMax() == dust
            && m.executor().length() == 2, "executor immutables");
        for (uint256 i; i < 2; ++i) {
            AlchemistHopV21 memory h = m.executor().hop(i);
            require(h.kind == 4 && h.pool == MANAGER && h.fee == 3000 && h.tickSpacing == 60
                && h.tokenIn == (i == 0 ? pepe : address(0)) && h.tokenOut == (i == 0 ? address(0) : gold), "route immutables");
        }
    }
}
