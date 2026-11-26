// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// Default: replay checked-in Python vectors. CQ11_LIVE_FFI=true + --ffi: fresh differential fuzz.
/// Neither mode substitutes Solidity arithmetic or skips a model comparison.
abstract contract ReferenceModel is Test {
    struct Query {
        string[] inputs;
        string operation;
        string[] outputs;
    }

    string private scenario;
    bytes private seeds;
    bytes private replay;
    uint256 private queryIndex;

    modifier checkedModel() {
        _;
        if (!_live()) assertEq(queryIndex, abi.decode(replay, (Query[])).length, "unused model comparison");
    }

    function _live() private view returns (bool) {
        return vm.envOr("CQ11_LIVE_FFI", false);
    }

    /// Live mode keeps every raw fuzz argument. Replay mode samples a recorded case with those arguments.
    function modelCase(string memory name, bytes memory raw) internal returns (bytes memory) {
        scenario = name;
        seeds = raw;
        queryIndex = 0;
        if (_live()) return raw;
        string memory json = vm.readFile(string.concat("test/vectors/cq11-reference/", name, ".json"));
        uint256 count = vm.parseUint(vm.parseJsonString(json, ".count"));
        assertGt(count, 0, "empty model corpus");
        string memory key = string.concat(".cases[", vm.toString(uint256(keccak256(raw)) % count), "]");
        uint256 length = vm.parseUint(vm.parseJsonString(json, ".queryCount"));
        assertGt(length, 0, "empty model comparisons");
        Query[] memory queries = new Query[](length);
        for (uint256 i; i < length; ++i) {
            string memory queryKey = string.concat(key, ".queries[", vm.toString(i), "]");
            // Explicit string parsing avoids Foundry's automatic JSON type inference for decimal words.
            queries[i] = Query(
                vm.parseJsonStringArray(json, string.concat(queryKey, ".inputs")),
                vm.parseJsonString(json, string.concat(queryKey, ".operation")),
                vm.parseJsonStringArray(json, string.concat(queryKey, ".outputs"))
            );
        }
        replay = abi.encode(queries);
        bytes memory selectedInputs =
            abi.encodePacked(_integers(vm.parseJsonStringArray(json, string.concat(key, ".inputs"))));
        assertEq(selectedInputs.length, raw.length, "model case arity");
        return selectedInputs;
    }

    function model(string memory operation, uint256[] memory inputs) internal returns (uint256[] memory) {
        uint256 index = queryIndex++;
        if (!_live()) {
            Query memory query = abi.decode(replay, (Query[]))[index];
            assertEq(query.operation, operation, "model operation mismatch");
            assertEq(_integers(query.inputs), inputs, "model input mismatch");
            return _integers(query.outputs);
        }
        string[] memory command = new string[](inputs.length + 8);
        command[0] = "python3";
        command[1] = "-B";
        command[2] = "script-py/models/cq11_vectors.py";
        command[3] = "query";
        command[4] = scenario;
        command[5] = vm.toString(seeds);
        command[6] = vm.toString(index);
        command[7] = operation;
        for (uint256 i; i < inputs.length; ++i) {
            command[i + 8] = vm.toString(inputs[i]);
        }
        return abi.decode(vm.ffi(command), (uint256[]));
    }

    function _integers(string[] memory values) private pure returns (uint256[] memory result) {
        result = new uint256[](values.length);
        for (uint256 i; i < values.length; ++i) {
            result[i] = vm.parseUint(values[i]);
        }
    }
}
