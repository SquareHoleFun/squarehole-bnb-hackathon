// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

contract CoinFake {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address to, uint256 amount) external returns (bool) { allowance[msg.sender][to] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; move(from, to, amount); return true;
    }
    function move(address from, address to, uint256 amount) internal { balanceOf[from] -= amount; balanceOf[to] += amount; }
    function deposit() external payable { balanceOf[msg.sender] += msg.value; }
    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount; (bool ok,) = msg.sender.call{value: amount}(""); require(ok);
    }
}

contract RouterFake {
    struct ExactInput { bytes path; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; }
    uint256 public output;
    address public weth;
    function configure(address w, uint256 out) external { weth = w; output = out; }
    receive() external payable {}
    function exactInput(ExactInput calldata p) external payable returns (uint256) {
        require(block.timestamp <= p.deadline, "deadline"); require(output >= p.amountOutMinimum, "minimum");
        address input = address(bytes20(p.path[:20])); address out = address(bytes20(p.path[p.path.length - 20:]));
        CoinFake(input).transferFrom(msg.sender, address(0xBEEF), p.amountIn);
        CoinFake(out).mint(p.recipient, output); return output;
    }
    function unwrapWETH9(uint256 minimum, address recipient) external payable {
        uint256 amount = CoinFake(weth).balanceOf(address(this)); require(amount >= minimum, "minimum");
        CoinFake(weth).withdraw(amount); (bool ok,) = recipient.call{value: amount}(""); require(ok);
    }
    function multicall(bytes[] calldata data) external payable returns (bytes[] memory result) { return multi(data); }
    function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory result) {
        require(block.timestamp <= deadline, "deadline"); return multi(data);
    }
    function multi(bytes[] calldata data) internal returns (bytes[] memory result) {
        result = new bytes[](data.length);
        for (uint256 i; i < data.length; ++i) {
            (bool ok, bytes memory out) = address(this).delegatecall(data[i]); require(ok, "router leg"); result[i] = out;
        }
    }
}

contract CallOnlyFake {
    function multiSend(bytes calldata data) external payable {
        uint256 cursor;
        while (cursor < data.length) {
            require(uint8(data[cursor]) == 0, "CALL only");
            address to = address(bytes20(data[cursor + 1:cursor + 21]));
            uint256 value = uint256(bytes32(data[cursor + 21:cursor + 53]));
            uint256 size = uint256(bytes32(data[cursor + 53:cursor + 85]));
            cursor += 85;
            (bool ok,) = to.call{value: value}(data[cursor:cursor + size]); require(ok, "batch leg"); cursor += size;
        }
    }
}

// Execution-context fake only: production Safe signature/threshold proof remains a live pinned-fork gate.
contract SafeContextFake {
    receive() external payable {}
    function run(address to, uint256 value, bytes calldata data, uint256 operation) external {
        bool ok;
        if (operation == 1) (ok,) = to.delegatecall(data);
        else (ok,) = to.call{value: value}(data);
        require(ok, "Safe batch reverted");
    }
}

contract BotBatchTest is Test {
    string internal vectors;
    function setUp() public { vectors = vm.readFile("test/fixtures/calldata.json"); vm.warp(100000); }
    function testAllRoutesPayOnlyOriginatingSafe() public {
        run("coin_eth", false, false); run("weth_eth", false, false);
    }
    function testStalePriceRollsBackInputAndApprovals() public { run("coin_eth", true, false); }
    function testEveryRouteEnforcesDeadlineAtomically() public {
        run("coin_eth", false, true); run("weth_eth", false, true);
    }
    // FABLE item 13: execute the bot's replacement calldata and prove no funds/approvals move.
    // This context fake does not certify real Safe signatures or nonce semantics; TS tests cover journal recovery.
    function testCancellationSelfCallHasNoMoneyEffects() public {
        address safe = a("cancellation", "safe");
        vm.etch(safe, address(new SafeContextFake()).code); vm.deal(safe, 1000);
        CoinFake coin = new CoinFake(); coin.mint(safe, 1000);
        address to = a("cancellation", "to");
        bytes memory data = vm.parseJsonBytes(vectors, ".cancellation.data");
        uint256 value = vm.parseUint(vm.parseJsonString(vectors, ".cancellation.value"));
        uint256 operation = vm.parseUint(vm.parseJsonString(vectors, ".cancellation.operation"));
        assertEq(to, safe); assertEq(value, 0); assertEq(data.length, 0); assertEq(operation, 0);
        assertEq(vm.parseJsonString(vectors, ".cancellation.safeTxGas"), "0");
        assertEq(vm.parseJsonString(vectors, ".cancellation.nonce"), "0");
        SafeContextFake(payable(safe)).run(to, value, data, operation);
        assertEq(safe.balance, 1000); assertEq(coin.balanceOf(safe), 1000);
        assertEq(coin.allowance(safe, to), 0);
    }
    function a(string memory id, string memory key) internal view returns (address) { return vm.parseJsonAddress(vectors, string.concat(".", id, ".", key)); }
    function run(string memory id, bool badPrice, bool expired) internal {
        // Isolate each vector's fake storage as well as code.
        uint256 snap = vm.snapshotState();
        address safe = a(id, "safe"); address input = a(id, "input"); address output = a(id, "output");
        address weth = a(id, "weth"); address router = a(id, "router"); address helper = a(id, "helper");
        vm.etch(safe, address(new SafeContextFake()).code); vm.etch(helper, address(new CallOnlyFake()).code);
        vm.etch(router, address(new RouterFake()).code); vm.etch(weth, address(new CoinFake()).code);
        if (input != address(0) && input != weth) vm.etch(input, address(new CoinFake()).code);
        if (output != address(0) && output != weth) vm.etch(output, address(new CoinFake()).code);
        vm.deal(safe, 1000); vm.deal(weth, 10000);
        if (input != address(0)) CoinFake(input).mint(safe, 1000);
        uint256 out = vm.parseUint(vm.parseJsonString(vectors, string.concat(".", id, ".amountOut")));
        RouterFake(payable(router)).configure(weth, badPrice ? 197 : out);
        if (expired) vm.warp(100201);
        bytes memory data = vm.parseJsonBytes(vectors, string.concat(".", id, ".data"));
        uint256 operation = vm.parseUint(vm.parseJsonString(vectors, string.concat(".", id, ".operation")));
        if (expired || badPrice) vm.expectRevert();
        SafeContextFake(payable(safe)).run(a(id, "to"), 0, data, operation);
        uint256 inputAfter = input == address(0) ? safe.balance : CoinFake(input).balanceOf(safe);
        assertEq(inputAfter, expired || badPrice ? 1000 : 900, "input conserved");
        if (!expired && !badPrice) {
            if (output == address(0)) assertEq(safe.balance, 1000 + out, "ETH only to Safe");
            else assertEq(CoinFake(output).balanceOf(safe), out, "P only to Safe");
        }
        assertEq(CoinFake(input == address(0) ? weth : input).allowance(safe, router), 0, "no standing approval");
        assertEq(router.balance, 0, "no stranded router ETH");
        assertEq(CoinFake(weth).balanceOf(router), 0, "no stranded output WETH");
        vm.revertToState(snap);
    }
}
