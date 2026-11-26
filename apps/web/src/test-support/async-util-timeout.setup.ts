// TEST ONLY: loaded by vite.config.ts only while SH_TEST_TIMEOUT is set (SH-195): Testing Library waits a tenth of it.
import { configure } from '@testing-library/react';
import { shAsyncUtilTimeout } from '../../../../vitest.timeouts.mjs';

const asyncUtilTimeout = shAsyncUtilTimeout();
if (asyncUtilTimeout !== undefined) configure({ asyncUtilTimeout });
