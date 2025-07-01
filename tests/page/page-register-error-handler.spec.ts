/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { test, expect } from './pageTest';

test.beforeEach(async ({ page, server }) => {
  await page.goto(server.PREFIX + '/input/handle-locator.html');
  await page.evaluate(() => {
    (window as any).clicked = 0;
    (window as any).setupAnnoyingInterstitial('mouseover', 1);
  });
});

test('should work', async ({ page }) => {
  const errors: Error[] = [];
  await page.registerErrorHandler(async error => {
    errors.push(error);
    await page.locator('#close').click();
    return 'continue';
  });

  const secondErrors: Error[] = [];
  await page.registerErrorHandler(async error => {
    secondErrors.push(error);
  });

  await page.locator('#target').click();

  expect(errors).toHaveLength(1);
  expect(secondErrors).toHaveLength(1);
  expect(errors[0].message).toEqual(secondErrors[0].message);
  expect(errors[0].message).toContain('Error attempting click action.');
  expect(errors[0].message).toContain(`Call log:`);
  expect(errors[0].message).toContain(`waiting for locator('#target')`);
});
