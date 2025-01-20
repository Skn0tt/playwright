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
import type { APIRequestContext, MockingProxy } from 'packages/playwright-test';
import { playwrightTest as baseTest, expect } from '../config/browserTest';

const test = baseTest.extend<{ proxiedRequest: APIRequestContext }, { mockproxy: MockingProxy }>({
  mockproxy: [async ({ playwright }, use, testInfo) => {
    const port = 32181 + testInfo.parallelIndex;
    const proxy = await playwright.mockingProxy.newProxy(port);
    await use(proxy);
  }, { scope: 'worker' }],
  proxiedRequest: async ({ request, mockproxy }, use) => {
    const originalFetch = request.fetch;
    request.fetch = function(urlOrRequest, options) {
      if (typeof urlOrRequest !== 'string')
        throw new Error('not supported in this test');
      urlOrRequest = `http://localhost:${mockproxy.port()}/${urlOrRequest}`;
      return originalFetch.call(this, urlOrRequest, options);
    };
    await use(request);
  },
});

test.beforeEach(async ({ mockproxy }) => {
  await mockproxy.unrouteAll();
});

test.only('proxy without routes is transparent', async ({ server, proxiedRequest }) => {
  const response = await proxiedRequest.get(server.EMPTY_PAGE);
  await expect(response).toBeOK();
});

test.only('proxy without routes doesnt generate events', async ({ server, proxiedRequest, mockproxy }) => {
  const events: string[] = [];
  mockproxy.on('request', () => events.push('request'));
  mockproxy.on('response', () => events.push('response'));
  mockproxy.on('requestfinished', () => events.push('requestfinished'));
  const response = await proxiedRequest.get(server.EMPTY_PAGE);
  await expect(response).toBeOK();
  expect(events).toEqual([]);
});

test('proxy generates events', async ({ server, proxiedRequest, mockproxy }) => {
  const events: string[] = [];
  const requests = [];
  const responses = [];
  const requestFinished = [];
  mockproxy.on('request', request => {
    events.push('request');
    requests.push(request);
  });
  mockproxy.on('response', response => {
    events.push('response');
    responses.push(response);
  });
  mockproxy.on('requestfinished', request => {
    events.push('requestfinished');
    requestFinished.push(request);
  });

  const response = await proxiedRequest.get(server.EMPTY_PAGE);
  await expect(response).toBeOK();

  expect(events).toEqual(['request', 'response', 'requestfinished']);
});
