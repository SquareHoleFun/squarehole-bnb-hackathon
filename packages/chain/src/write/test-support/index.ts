// TEST SUPPORT ONLY (never imported by app code): the fake EIP-1193 chain, wallet and Square Hole deployment used by
// the write side's unit tests and the web app's chain-flow tests.
export { ACCOUNT_A, ACCOUNT_B, FakeChain, FakeRpcError, FakeWallet, fakeHash, revertData, revertError, type FakeBlock, type FakeTx, type SendBehaviour } from './fake-chain';
export { FAKE, FakeSquareHole, fakeDeployment } from './fake-square-hole';
export { TEST_FEE_READER, TEST_SEND_FEE_FIELDS, sendFeeRpcAnswer, testFeeReader, type TestFeeReader, type TestFeeReaderOptions } from './fee-reader';
