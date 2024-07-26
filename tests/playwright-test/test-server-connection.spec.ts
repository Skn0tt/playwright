/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { test, expect } from './ui-mode-fixtures';

import { TestServerConnection } from '../../packages/playwright/src/isomorphic/testServerConnection';

test('test the server connection', async ({ runUITest, writeFiles }) => {
  const { page } = await runUITest({
    'a.test.ts': `
      import { test } from '@playwright/test';
      test('foo', () => {});
      `,
  });

  const ws = new URL(page.url()).searchParams.get('ws');
  const wsUrl = new URL(`../${ws}`, page.url());
  wsUrl.protocol = 'ws:';

  const testServerConnection = new TestServerConnection(wsUrl.toString());

  const events: [string, any][] = [];
  testServerConnection.onTestFilesChanged(params => events.push(['testFilesChanged', params]));

  await testServerConnection.watch({ fileNames: ['a.test.ts'] });

  await writeFiles({
    'a.test.ts': `
      import { test } from '@playwright/test';
      test('bar', () => {});
      `,
  });

  await expect.poll(() => events).toEqual([['testFilesChanged', [{ fileNames: ['a.test.ts'] }]]]);
});