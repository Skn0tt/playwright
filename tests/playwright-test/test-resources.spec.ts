/**
 * Copyright Microsoft Corporation. All rights reserved.
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

import { test, expect } from './playwright-test-fixtures';

test('should serialize tests using the macOS system pasteboard', async ({ runInlineTest }) => {
  test.skip(process.platform !== 'darwin', 'macOS only');

  // Once test-runner-stable is updated, every ttest needs to acquire the same locks as the inline test.
  const result = await runInlineTest({
    'playwright.config.ts': `
      export default { use: { browserName: 'webkit' } };
    `,
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import { execFileSync } from 'child_process';

      type SystemPasteboard = {
        read(): string;
        write(text: string): void;
      };

      const test = base.extend<{ systemPasteboard: SystemPasteboard }>({
        systemPasteboard: [async ({}, use) => {
          const read = () => execFileSync('pbpaste', { encoding: 'utf8' });
          const write = (text: string) => execFileSync('pbcopy', { input: text });
          const original = read();
          await use({ read, write });
          write(original);
        }, { resources: ['system-pasteboard'] }],
      });

      test.describe.configure({ mode: 'parallel' });
      for (const value of ['one', 'two']) {
        test(value, async ({ page, systemPasteboard }) => {
          await page.setContent('<input id="source"><input id="target">');
          const source = page.locator('#source');
          const target = page.locator('#target');

          await source.fill('copied-' + value);
          await source.selectText();
          await source.press('Meta+C');
          expect(systemPasteboard.read()).toBe('copied-' + value);

          systemPasteboard.write('pasted-' + value);
          await target.press('Meta+V');
          await expect(target).toHaveValue('pasted-' + value);
        });
      }
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
});

test('should acquire multiple fixture resources atomically and refill idle workers', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ holder: void, a: void, b: void }>({
        holder: [undefined, { resources: ['a', 'b'] }],
        a: [undefined, { resources: ['a'] }],
        b: [undefined, { resources: ['b'] }],
      });

      const rendezvous = async (name: string, other: string) => {
        fs.writeFileSync(name + '.ready', '');
        await expect.poll(() => fs.existsSync(other + '.ready')).toBe(true);
      };

      test.describe.configure({ mode: 'parallel' });
      test('holder', async ({ holder }) => {
        void holder;
        console.log('\\n%%holder-begin');
        console.log('\\n%%holder-end');
      });
      test('a', async ({ a }) => {
        void a;
        console.log('\\n%%a-begin');
        await rendezvous('a', 'b');
        console.log('\\n%%a-end');
      });
      test('b', async ({ b }) => {
        void b;
        console.log('\\n%%b-begin');
        await rendezvous('b', 'a');
        console.log('\\n%%b-end');
      });
    `,
  }, { workers: 3 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(3);
  expect(result.outputLines.slice(0, 2)).toEqual(['holder-begin', 'holder-end']);
  expect(result.outputLines.slice(2, 4).sort()).toEqual(['a-begin', 'b-begin']);
  expect(result.outputLines.slice(4).sort()).toEqual(['a-end', 'b-end']);
});

test('should collect resources from the used fixture graph', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ outer: void, inner: void, unused: void }>({
        outer: [async ({}, use) => use(), { resources: ['database'] }],
        inner: async ({ outer }, use) => {
          void outer;
          await use();
        },
        unused: [undefined, { resources: ['unused'] }],
      });

      test.describe.configure({ mode: 'parallel' });
      for (const name of ['a', 'b']) {
        test('protected ' + name, async ({ inner }) => {
          void inner;
          const fd = fs.openSync('database.lock', 'wx');
          try {
            await expect.poll(() => fs.existsSync('signal.ready')).toBe(true);
          } finally {
            fs.closeSync(fd);
            fs.unlinkSync('database.lock');
          }
        });
      }
      test('unprotected signal', async () => fs.writeFileSync('signal.ready', ''));
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(3);
});

test('inefficient case: should preserve resources conservatively through option overrides', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      export default {
        fullyParallel: true,
        use: { account: 'override' },
      };
    `,
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ direct: string, database: void, account: string }>({
        direct: ['default', { option: true, resources: ['direct'] }],
        database: [undefined, { resources: ['database'] }],
        account: [async ({ database }, use) => {
          void database;
          await use('default');
        }, { option: true }],
      });
      test.use({ direct: 'override' });

      const hold = async (resource: string, signal: string) => {
        const fd = fs.openSync(resource + '.lock', 'wx');
        try {
          await expect.poll(() => fs.existsSync(signal + '.ready')).toBe(true);
        } finally {
          fs.closeSync(fd);
          fs.unlinkSync(resource + '.lock');
        }
      };
      for (const name of ['a', 'b']) {
        test('direct ' + name, async ({ direct }) => {
          void direct;
          await hold('direct', 'direct-signal');
        });
      }
      test('direct signal', async () => fs.writeFileSync('direct-signal.ready', ''));
      test('overridden account', async ({ account }) => {
        void account;
        await hold('database', 'database-signal');
      });
      test('database', async ({ database }) => {
        void database;
        await hold('database', 'database-signal');
      });
      test('database signal', async () => fs.writeFileSync('database-signal.ready', ''));
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(6);
});

test('should include resources used by automatic fixtures and hooks', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a-auto.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ automatic: void }>({
        automatic: [async ({}, use) => {
          const fd = fs.openSync('automatic.lock', 'wx');
          try {
            await use();
          } finally {
            fs.closeSync(fd);
            fs.unlinkSync('automatic.lock');
          }
        }, { auto: true, resources: ['automatic'] }],
      });

      test.describe.configure({ mode: 'parallel' });
      for (const name of ['a', 'b']) {
        test(name, async () => await expect.poll(() => fs.existsSync('automatic-signal.ready')).toBe(true));
      }
    `,
    'b-auto-signal.test.ts': `
      import { test } from '@playwright/test';
      import fs from 'fs';

      test('signal', async () => fs.writeFileSync('automatic-signal.ready', ''));
    `,
    'c-hook.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ hooked: void }>({
        hooked: [async ({}, use) => {
          const fd = fs.openSync('hooked.lock', 'wx');
          try {
            await use();
          } finally {
            fs.closeSync(fd);
            fs.unlinkSync('hooked.lock');
          }
        }, { resources: ['hooked'] }],
      });

      test.describe.configure({ mode: 'parallel' });
      test.beforeEach(async ({ hooked }) => void hooked);
      for (const name of ['a', 'b']) {
        test(name, async () => await expect.poll(() => fs.existsSync('hooked-signal.ready')).toBe(true));
      }
    `,
    'd-hook-signal.test.ts': `
      import { test } from '@playwright/test';
      import fs from 'fs';

      test('signal', async () => fs.writeFileSync('hooked-signal.ready', ''));
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(6);
});

test('should coordinate fixture resources globally across projects', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      export default {
        projects: [
          { name: 'one', grep: /@protected/ },
          { name: 'two', grep: /@protected/ },
          { name: 'signal', grep: /@signal/ },
        ],
      };
    `,
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ database: void }>({
        database: [undefined, { resources: ['database'] }],
      });
      test('protected @protected', async ({ database }) => {
        void database;
        const fd = fs.openSync('database.lock', 'wx');
        try {
          await expect.poll(() => fs.existsSync('signal.ready')).toBe(true);
        } finally {
          fs.closeSync(fd);
          fs.unlinkSync('database.lock');
        }
      });
      test('signal @signal', async () => {
        fs.writeFileSync('signal.ready', '');
      });
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(3);
});

test('should reserve the fixture resource union for a non-parallel group', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ database: void }>({
        database: [undefined, { resources: ['database'] }],
      });
      test('uses resource before fixture declaration', async () => {
        const fd = fs.openSync('database.lock', 'wx');
        try {
          fs.writeFileSync('a.ready', '');
          await expect.poll(() => fs.existsSync('signal.ready')).toBe(true);
        } finally {
          fs.closeSync(fd);
          fs.unlinkSync('database.lock');
        }
      });
      test('declares resource', async ({ database }) => void database);
    `,
    'b.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ database: void }>({
        database: [undefined, { resources: ['database'] }],
      });
      test('competing test', async ({ database }) => {
        void database;
        const fd = fs.openSync('database.lock', 'wx');
        try {
          await expect.poll(() => fs.existsSync('a.ready')).toBe(true);
        } finally {
          fs.closeSync(fd);
          fs.unlinkSync('database.lock');
        }
      });
    `,
    'c.test.ts': `
      import { test, expect } from '@playwright/test';
      import fs from 'fs';

      test('signal', async () => {
        fs.writeFileSync('signal.ready', '');
        await expect.poll(() => fs.existsSync('a.ready')).toBe(true);
      });
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(4);
});

test('should not retain failed test resources in the remaining job', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'playwright.config.ts': `
      export default { retries: 1, retryStrategy: 'isolated' };
    `,
    'a.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ a: void, b: void }>({
        a: [undefined, { resources: ['a'] }],
        b: [undefined, { resources: ['b'] }],
      });
      test('flaky', async ({ a }, testInfo) => {
        void a;
        expect(testInfo.retry).toBe(1);
      });
      test('remaining', async ({ b }) => {
        void b;
        fs.writeFileSync('remaining.ready', '');
        await expect.poll(() => fs.existsSync('competing.ready')).toBe(true);
      });
    `,
    'b.test.ts': `
      import { test as base, expect } from '@playwright/test';
      import fs from 'fs';

      const test = base.extend<{ a: void }>({
        a: [undefined, { resources: ['a'] }],
      });
      test('competing', async ({ a }) => {
        void a;
        fs.writeFileSync('competing.ready', '');
        await expect.poll(() => fs.existsSync('remaining.ready')).toBe(true);
      });
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(0);
  expect(result.passed).toBe(2);
  expect(result.flaky).toBe(1);
});

test('should release fixture resources when a worker crashes', async ({ runInlineTest }) => {
  const result = await runInlineTest({
    'a.test.ts': `
      import { test as base } from '@playwright/test';

      const test = base.extend<{ database: void }>({
        database: [undefined, { resources: ['database'] }],
      });
      test.describe.configure({ mode: 'parallel' });
      test('crashes', async ({ database }) => {
        void database;
        process.exit(1);
      });
      test('runs after crash', async ({ database }) => {
        void database;
        console.log('\\n%%survived');
      });
    `,
  }, { workers: 2 });
  expect(result.exitCode).toBe(1);
  expect(result.failed).toBe(1);
  expect(result.passed).toBe(1);
  expect(result.outputLines).toEqual(['survived']);
});

test('should validate fixture resources', async ({ runInlineTest }) => {
  const worker = await runInlineTest({
    'a.test.js': `
      const { test: base } = require('@playwright/test');
      const test = base.extend({
        fixture: [undefined, { scope: 'worker', resources: ['database'] }],
      });
      test('test', async ({ fixture }) => {});
    `,
  });
  expect(worker.exitCode).toBe(1);
  expect(worker.output).toContain('cannot specify resources because it has worker scope');

  const empty = await runInlineTest({
    'a.test.js': `
      const { test: base } = require('@playwright/test');
      const test = base.extend({
        fixture: [undefined, { resources: [''] }],
      });
      test('test', async ({ fixture }) => {});
    `,
  });
  expect(empty.exitCode).toBe(0);

  const nonString = await runInlineTest({
    'a.test.js': `
      const { test: base } = require('@playwright/test');
      const test = base.extend({
        fixture: [undefined, { resources: [42] }],
      });
      test('test', async ({ fixture }) => {});
    `,
  });
  expect(nonString.exitCode).toBe(1);
  expect(nonString.output).toContain('must contain only strings');
});
