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
import test, { expect } from '@playwright/test';
import type { Request, Response } from '@playwright/test';

test.describe('ssr mocking', () => {
  test('fulfill', async ({ page, server }) => {
    await server.route('https://jsonplaceholder.typicode.com/posts', async (route, request) => {
      await route.fulfill({
        json: [
          {
            id: 1,
            title: 'Hello, World!',
          },
          {
            id: 2,
            title: 'Second post',
          },
          {
            id: 2,
            title: 'Third post',
          }
        ]
      });
    });

    await page.goto('http://localhost:3000/posts');

    await expect(page.getByRole('list')).toMatchAriaSnapshot(`
      - list:
        - listitem: Hello, World!
        - listitem: Second post
        - listitem: Third post
    `);
  });

  test('continue', async ({ page, server }) => {
    await server.route('https://jsonplaceholder.typicode.com/posts', async (route, request) => {
      const url = new URL(request.url());
      url.searchParams.set('id', '42');
      await route.continue({ url: url.toString() });
    });

    await page.goto('http://localhost:3000/posts');

    await expect(page.getByRole('list')).toMatchAriaSnapshot(`
      - list:
        - listitem: commodi ullam sint et excepturi error explicabo praesentium voluptas
    `);
  });

  test('abort', async ({ request, server }) => {
    await server.route('https://jsonplaceholder.typicode.com/posts', async (route, request) => {
      await route.abort();
    });

    const response = await request.get('http://localhost:3000/posts');
    await expect(response).not.toBeOK();
  });

  test('manipulate', async ({ page, server }) => {
    await server.route('https://jsonplaceholder.typicode.com/posts', async (route, request) => {
      const response = await route.fetch();
      const json = await response.json();
      console.log(json);
      await route.fulfill({ response, body: json });
    });

    await page.goto('http://localhost:3000/posts');

    await expect(page.getByRole('list')).toMatchAriaSnapshot(`
      - list:
        - listitem: Hello, World!
        - listitem: Second post
        - listitem: Third post
    `);
  });

  test('events', async ({ page, server }) => {
    const requests: Request[] = [];
    const requestsFinished: Request[] = [];
    const requestsFailed: Request[] = [];
    const responses: Response[] = [];
    server.on('request', r => requests.push(r));
    server.on('requestfinished', r => requestsFinished.push(r));
    server.on('requestfailed', r => requestsFailed.push(r));
    server.on('response', r => responses.push(r));

    await page.goto('http://localhost:3000/posts');

    expect(requests).toHaveLength(1);
    expect(requestsFinished).toHaveLength(1);
    expect(responses).toHaveLength(1);
    expect(requestsFailed).toHaveLength(0);
  });
});
