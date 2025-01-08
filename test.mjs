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
import { chromium } from 'playwright-core';

const browser = await chromium.launch();
const page = await browser.newPage();
const testId = crypto.randomUUID();
const server = await page.context().newServer(testId);

await server.route('https://jsonplaceholder.typicode.com/posts', async (route, request) => {
  console.log('mocking', request.url());
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

const list = await page.getByRole('list').ariaSnapshot();
console.log(list.substring(0, 500));

process.exit(0);
