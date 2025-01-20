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
import type { APIRequestContext, MockingProxy, Request, Response } from 'packages/playwright-test';
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

test('proxy without routes is transparent but generates events', async ({ server, proxiedRequest, mockproxy }) => {
  const events: string[] = [];
  mockproxy.on('request', () => {
    events.push('request');
  });
  mockproxy.on('response', () => {
    events.push('response');
  });
  mockproxy.on('requestfinished', () => {
    events.push('requestfinished');
  });

  const response = await proxiedRequest.get(server.EMPTY_PAGE);
  await expect(response).toBeOK();
  expect(events).toEqual(['request', 'response', 'requestfinished']);
});

test('event properties', async ({ server, proxiedRequest, mockproxy }) => {
  const [
    requestFinished,
    request,
    responseEvent,
    response
  ] = await Promise.all([
    mockproxy.waitForEvent('requestfinished'),
    mockproxy.waitForRequest('**/*'),
    mockproxy.waitForResponse('**/*'),
    proxiedRequest.get(server.EMPTY_PAGE),
  ]);

  await expect(response).toBeOK();
  expect(request).toBe(requestFinished);
  expect(responseEvent.request()).toBe(request);
  expect(await request.response()).toBe(responseEvent);

  expect(request.url()).toBe(server.EMPTY_PAGE);
  expect(responseEvent.url()).toBe(server.EMPTY_PAGE);

  expect(responseEvent.status()).toBe(response.status());
  expect(await responseEvent.headersArray()).toEqual(response.headersArray());
  expect(await responseEvent.body()).toEqual(await response.body());

  expect(await responseEvent.finished()).toBe(null);

  expect(request.serviceWorker()).toBe(null);
  expect(() => request.frame()).toThrowError('Assertion error'); // TODO: improve error message
  expect(() => responseEvent.frame()).toThrowError('Assertion error');

  expect(request.failure()).toBe(null);
  expect(request.isNavigationRequest()).toBe(false);
  expect(request.redirectedFrom()).toBe(null);
  expect(request.redirectedTo()).toBe(null);
  expect(request.resourceType()).toBe(''); // TODO: should this be different?
  expect(request.method()).toBe('GET');

  expect(await request.sizes()).toEqual({
    requestBodySize: 0,
    requestHeadersSize: 164,
    responseBodySize: 0,
    responseHeadersSize: 197,
  });

  expect(request.timing()).toEqual({
    'connectEnd': 0,
    'connectStart': 0,
    'domainLookupEnd': 0,
    'domainLookupStart': 0,
    'requestStart': 0,
    'responseEnd': expect.any(Number),
    'responseStart': 0,
    'secureConnectionStart': 0,
    'startTime': 0,
  });

  expect(await responseEvent.securityDetails()).toBe(null); // TODO: fixme
  expect(await responseEvent.serverAddr()).toBe(null); // TODO: Fixme
});

test.fixme('request with body', async ({ server, proxiedRequest, mockproxy }) => {
  const [
    requestFinished,
    request,
    responseEvent,
    response
  ] = await Promise.all([
    mockproxy.waitForEvent('requestfinished'),
    mockproxy.waitForRequest('**/*'),
    mockproxy.waitForResponse('**/*'),
    proxiedRequest.get(server.EMPTY_PAGE),
  ]);

  await expect(response).toBeOK();
  expect(request).toBe(requestFinished);
  expect(responseEvent.request()).toBe(request);

  expect(request.url()).toBe(server.EMPTY_PAGE);
  expect(responseEvent.url()).toBe(server.EMPTY_PAGE);

  expect(responseEvent.status()).toBe(response.status());
  expect(await responseEvent.headersArray()).toEqual(response.headersArray());
  expect(await responseEvent.body()).toEqual(await response.body());

  expect(await responseEvent.finished()).toBe(null);

  expect(request.serviceWorker()).toBe(null);
  expect(() => request.frame()).toThrowError('Assertion error'); // TODO: improve error message
  expect(() => responseEvent.frame()).toThrowError('Assertion error');

  expect(request.failure()).toBe(null);

});

test.fixme('request failed', async ({ server, proxiedRequest, mockproxy }) => {
  const [
    requestFinished,
    request,
    responseEvent,
    response
  ] = await Promise.all([
    mockproxy.waitForEvent('requestfinished'),
    mockproxy.waitForRequest('**/*'),
    mockproxy.waitForResponse('**/*'),
    proxiedRequest.get(server.EMPTY_PAGE),
  ]);

  await expect(response).toBeOK();
  expect(request).toBe(requestFinished);
  expect(responseEvent.request()).toBe(request);

  expect(request.url()).toBe(server.EMPTY_PAGE);
  expect(responseEvent.url()).toBe(server.EMPTY_PAGE);

  expect(responseEvent.status()).toBe(response.status());
  expect(await responseEvent.headersArray()).toEqual(response.headersArray());
  expect(await responseEvent.body()).toEqual(await response.body());

  expect(await responseEvent.finished()).toBe(null);

  expect(request.serviceWorker()).toBe(null);
  expect(() => request.frame()).toThrowError('Assertion error'); // TODO: improve error message
  expect(() => responseEvent.frame()).toThrowError('Assertion error');

  expect(request.failure()).toBe(null);

});
