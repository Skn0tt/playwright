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

import { PlaywrightServer } from 'packages/playwright-core/lib/remote/playwrightServer';
import { expect, playwrightTest } from '../config/browserTest';

interface TestFixtures {
    browserServer: URL;
}

const test = playwrightTest.extend<TestFixtures>({
  browserServer: async ({}, use) => {
    const browserServer = new PlaywrightServer({ mode: 'launchServerShared', path: '/', maxConnections: Infinity });
    const wsEndpoint = await browserServer.listen(0);
    await use(new URL(`http://${new URL(wsEndpoint).host}`));
    await browserServer.close();
  }
});

test('should allow connecting to existing browser', async ({ playwright, server, browserType, browserServer }) => {
  const request = await playwright.request.newContext({ baseURL: browserServer.toString() });
  expect(await request.get('/json/list').then(r => r.json())).toEqual([]);

  const launchResponse = await request.post('/json/launch', { data: { browserType: browserType.name(), launchOptions: {} } }).then(r => r.json());
  expect(launchResponse).toEqual({
    browserType: browserType.name(),
    wsURL: expect.any(String),
  });

  const browser = await browserType.connect(launchResponse.wsURL);
  const page = await browser.newPage();
  await page.goto(server.EMPTY_PAGE);

  expect(await request.get('/json/list').then(r => r.json())).toEqual([
    { browserType: browserType.name() }
  ]);

  const secondLaunchResponse = await request.post('/json/launch', { data: { browserType: browserType.name(), launchOptions: {} } }).then(r => r.json());
  expect(secondLaunchResponse).toEqual(launchResponse);

  const secondBrowser = await browserType.connect(secondLaunchResponse.wsURL);
  const pages = secondBrowser.contexts().flatMap(c => c.pages().flatMap(p => p.url()));
  expect(pages).toEqual([server.EMPTY_PAGE]);

  const thirdLaunchResponse = await request.post('/json/launch', { data: { browserType: browserType.name(), launchOptions: { assistantMode: true } } }).then(r => r.json());
  expect(thirdLaunchResponse).not.toEqual(launchResponse);

  const assistantModeBrowser = await browserType.connect(thirdLaunchResponse.wsURL);
  expect(assistantModeBrowser.contexts()).toHaveLength(0);
});
