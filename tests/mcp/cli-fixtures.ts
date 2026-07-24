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

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { test as baseTest, expect } from './fixtures';
import { killProcessGroup } from '../config/commonFixtures';
import { inheritAndCleanEnv } from '../config/utils';

import type { Page, Browser } from 'playwright-core';
import type { CommonFixtures } from '../config/commonFixtures';

export { expect } from './fixtures';
export const test = baseTest.extend<{
  boundBrowser: Browser,
  cliEnv: Record<string, string>,
  startDashboardServer: (options?: { cwd?: string, session?: string }) => Promise<Page>,
  connectToDashboard: (bindTitle: string) => Promise<Browser>;
  cli: (...args: any[]) => Promise<{
    output: string,
    error: string,
    exitCode: number | undefined,
    inlineSnapshot?: string,
    snapshot?: string,
    attachments?: { name: string, data: Buffer | null }[],
    daemonPid?: number,
    dashboardPid?: number,
  }>;
}>({
  cliEnv: async ({}, use) => {
    await use(cliEnv());
  },
  startDashboardServer: async ({ childProcess, page }, use) => {
    await use(async (options?: { cwd?: string, session?: string }) => {
      const serverProcess = spawnDashboardServer(childProcess, options);
      await serverProcess.waitForOutput('Listening on ');
      await page.goto(serverProcess.output.match(/Listening on (http:\/\/\S+)/)![1]);
      return page;
    });
  },
  connectToDashboard: async ({ cli, playwright }, use) => {
    await use(async (bindTitle: string) => {
      let endpoint = '';
      await expect(async () => {
        const { output } = await cli('list', '--all', '--json');
        const { servers } = JSON.parse(output);
        const server = servers.find(s => s.title === bindTitle);
        endpoint = server.endpoint;
      }).toPass();
      return await playwright.chromium.connect(endpoint);
    });
    const slowBrowserGaps = findSlowBrowserGaps(startupTracePath());
    if (slowBrowserGaps.length)
      await waitForChromiumStartupTrace(slowBrowserGaps);
    await cli('show', '--kill');
  },

  cli: async ({ mcpBrowser, mcpHeadless, childProcess }, use, testInfo) => {
    await fs.promises.mkdir(testInfo.outputPath('.playwright'), { recursive: true });
    const tracePath = startupTracePath();
    const chromiumTraceDir = chromiumStartupTraceDir();
    appendStartupTrace(tracePath, 'fixture.start', { title: testInfo.title });
    const tracedPids = new Set<number>();
    const ownedPids = new Set<number>();
    const emergencyTeardown = () => {
      const slowBrowserGaps = findSlowBrowserGaps(tracePath);
      appendStartupTrace(tracePath, 'fixture.emergency-chromium-trace-retention', { slowBrowserGaps });
      collectTracedPids(tracePath, tracedPids, ownedPids);
      tracedPids.delete(process.pid);
      appendStartupTrace(tracePath, 'fixture.emergency-teardown.before-kill', {
        processes: processStates(tracedPids),
        ownedProcesses: processStates(ownedPids),
      });
      for (const pid of ownedPids)
        killProcessGroup(pid);
      appendStartupTrace(tracePath, 'fixture.emergency-teardown.after-kill', {
        processes: processStates(tracedPids),
        ownedProcesses: processStates(ownedPids),
      });
      if (slowBrowserGaps.length)
        appendStartupTrace(tracePath, 'fixture.emergency-chromium-trace-recovery', recoverChromiumStartupTracesSync(chromiumTraceDir));
    };
    process.once('exit', emergencyTeardown);

    await use(async (...args: string[]) => {
      const cliArgs = args.filter(arg => typeof arg === 'string');
      const cliOptions = args.findLast(arg => typeof arg === 'object') || {};
      const result = await test.step(
          `cli ${cliArgs.join(' ')}`,
          () => runCli(childProcess, cliArgs, cliOptions, { mcpBrowser, mcpHeadless })
      );
      if (result.daemonPid)
        ownedPids.add(result.daemonPid);
      if (result.dashboardPid)
        ownedPids.add(result.dashboardPid);
      return result;
    });

    const slowBrowserGaps = findSlowBrowserGaps(tracePath);
    appendStartupTrace(tracePath, 'fixture.chromium-trace-retention', { slowBrowserGaps });
    if (slowBrowserGaps.length)
      await waitForChromiumStartupTrace(slowBrowserGaps);

    collectTracedPids(tracePath, tracedPids, ownedPids);
    tracedPids.delete(process.pid);
    appendStartupTrace(tracePath, 'fixture.teardown.before-kill', {
      processes: processStates(tracedPids),
      ownedProcesses: processStates(ownedPids),
    });
    for (const pid of ownedPids)
      killProcessGroup(pid);
    for (let i = 0; i < 20 && processStates(ownedPids).some(state => state.alive); ++i)
      await new Promise(resolve => setTimeout(resolve, 50));
    appendStartupTrace(tracePath, 'fixture.teardown.after-kill', {
      processes: processStates(tracedPids),
      ownedProcesses: processStates(ownedPids),
    });

    const daemonDir = testInfo.outputPath('daemon');
    for (const dir of await fs.promises.readdir(daemonDir).catch<string[]>(() => [])) {
      if (dir.startsWith('ud-')) {
        await fs.promises.rm(path.join(daemonDir, dir), { recursive: true, force: true }).catch(() => {});
        continue;
      }
    }
    const chromiumTraceFiles = await recoverChromiumStartupTraces(chromiumTraceDir);
    if (slowBrowserGaps.length) {
      if (!chromiumTraceFiles.length)
        appendStartupTrace(tracePath, 'fixture.chromium-trace-missing');
      for (const file of chromiumTraceFiles)
        await testInfo.attach(`chromium-startup-${file}`, { path: path.join(chromiumTraceDir, file), contentType: 'application/octet-stream' });
    } else {
      await fs.promises.rm(chromiumTraceDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    await testInfo.attach('mcp-startup-timeline', { path: tracePath, contentType: 'application/jsonl' });
    process.off('exit', emergencyTeardown);
  },
  boundBrowser: async ({ mcpBrowser, playwright }, use) => {
    const browserName = (mcpBrowser === 'chrome' || mcpBrowser === 'msedge') ? 'chromium' : mcpBrowser;
    const channel = (mcpBrowser === 'chrome' || mcpBrowser === 'msedge') ? mcpBrowser : undefined;
    const browser = await playwright[browserName].launch({ channel, headless: true });
    for (const [name, value] of Object.entries(cliEnv()))
      process.env[name] = value;
    await browser.bind('default');
    await use(browser);
    for (const name of Object.keys(cliEnv()))
      delete process.env[name];
    await browser.close();
  },
});

export function spawnDashboardServer(childProcess: CommonFixtures['childProcess'], options?: { cwd?: string, session?: string }) {
  const showArgs = options?.session ? [`-s=${options.session}`, 'show'] : ['show'];
  return childProcess({
    command: [process.execPath, require.resolve('../../packages/playwright-core/lib/tools/cli-client/cli.js'), ...showArgs, '--port=0'],
    cwd: options?.cwd ?? test.info().outputPath(),
    env: inheritAndCleanEnv(cliEnv()),
  });
}

function cliEnv() {
  return {
    PWTEST_SERVER_REGISTRY: test.info().outputPath('registry'),
    PWTEST_DASHBOARD_SETTINGS_FILE: test.info().outputPath('dashboard.settings.json'),
    PWTEST_DAEMON_SESSION_DIR: test.info().outputPath('daemon'),
    PWTEST_SOCKETS_DIR: path.join(os.tmpdir(), 'ds-' + crypto.createHash('sha1').update(test.info().outputDir).digest('hex').slice(0, 16)),
    PWTEST_CLI_CHANNEL_SCAN_DISABLED_FOR_TEST: '1',
    PWTEST_MCP_STARTUP_TRACE: startupTracePath(),
    PWTEST_MCP_CHROMIUM_TRACE_DIR: chromiumStartupTraceDir(),
  };
}

function startupTracePath(): string {
  const testInfo = test.info();
  const traceDir = path.join(testInfo.project.outputDir, 'mcp-startup-timelines');
  fs.mkdirSync(traceDir, { recursive: true });
  const traceId = crypto.createHash('sha1').update(`${testInfo.testId}-${testInfo.retry}`).digest('hex');
  return path.join(traceDir, `${traceId}.jsonl`);
}

function chromiumStartupTraceDir(): string {
  const testInfo = test.info();
  const traceId = crypto.createHash('sha1').update(`${testInfo.testId}-${testInfo.retry}`).digest('hex');
  return path.join(testInfo.project.outputDir, 'mcp-chromium-traces', traceId);
}

function appendStartupTrace(tracePath: string, phase: string, data: Record<string, unknown> = {}) {
  fs.appendFileSync(tracePath, JSON.stringify({
    timestamp: new Date().toISOString(),
    monotonicTime: Number(process.hrtime.bigint() / 1_000_000n),
    pid: process.pid,
    ppid: process.ppid,
    phase,
    ...data,
  }) + '\n');
}

function collectTracedPids(tracePath: string, tracedPids: Set<number>, ownedPids: Set<number>): void {
  for (const event of readStartupTraceEvents(tracePath)) {
    for (const key of ['pid', 'childPid', 'browserPid', 'daemonPid', 'dashboardPid']) {
      if (typeof event[key] === 'number')
        tracedPids.add(event[key]);
    }
    for (const key of ['daemonPid', 'dashboardPid']) {
      if (typeof event[key] === 'number')
        ownedPids.add(event[key]);
    }
  }
}

type StartupTraceEvent = {
  monotonicTime?: number,
  phase?: string,
  pid?: number,
  tracePath?: string,
};

type SlowBrowserGap = {
  phase: string,
  duration: number,
  pid: number,
  completed: boolean,
  traceConfiguredAt: number,
};

const browserPhasePairs = new Map([
  ['browser.launch-process.start', 'browser.process.spawned'],
  ['browser.transport-connect.start', 'browser.transport-connect.end'],
  ['browser.launch-persistent-context.start', 'browser.launch-persistent-context.end'],
  ['chromium.browser-get-version.start', 'chromium.browser-get-version.end'],
  ['chromium.target-set-auto-attach.start', 'chromium.target-set-auto-attach.end'],
  ['chromium.target-get-target-info.start', 'chromium.target-get-target-info.end'],
  ['chromium.wait-for-pages.start', 'chromium.wait-for-pages.end'],
  ['navigation.command.start', 'navigation.command.end'],
  ['navigation.lifecycle-wait.start', 'navigation.lifecycle-ready'],
  ['dashboard.browser.launch-persistent-context.start', 'dashboard.browser.launch-persistent-context.end'],
  ['dashboard.page-goto.start', 'dashboard.page-goto.end'],
]);

function readStartupTraceEvents(tracePath: string): StartupTraceEvent[] {
  const events: StartupTraceEvent[] = [];
  for (const line of fs.readFileSync(tracePath, 'utf-8').split('\n')) {
    if (!line)
      continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      appendStartupTrace(tracePath, 'fixture.trace-parse-error', { error: String(error), line });
    }
  }
  return events;
}

function findSlowBrowserGaps(tracePath: string): SlowBrowserGap[] {
  const events = readStartupTraceEvents(tracePath);
  const retentionThreshold = Number(process.env.PWTEST_MCP_CHROMIUM_TRACE_THRESHOLD_MS || 5_000);
  const configuredAt = new Map<number, number>();
  const starts = new Map<string, StartupTraceEvent[]>();
  const gaps: SlowBrowserGap[] = [];
  for (const event of events) {
    if (event.phase === 'chromium.perfetto-trace.configured' && event.pid && event.monotonicTime)
      configuredAt.set(event.pid, event.monotonicTime);
    const endPhase = event.phase ? browserPhasePairs.get(event.phase) : undefined;
    if (endPhase && event.pid) {
      const key = `${event.pid}:${endPhase}`;
      const pending = starts.get(key) || [];
      pending.push(event);
      starts.set(key, pending);
      continue;
    }
    if (!event.phase || !event.pid || !event.monotonicTime)
      continue;
    const key = `${event.pid}:${event.phase}`;
    const start = starts.get(key)?.shift();
    if (!start?.phase || !start.monotonicTime)
      continue;
    const duration = event.monotonicTime - start.monotonicTime;
    const traceConfiguredAt = configuredAt.get(event.pid);
    if (duration >= retentionThreshold && traceConfiguredAt !== undefined)
      gaps.push({ phase: start.phase, duration, pid: event.pid, completed: true, traceConfiguredAt });
  }
  const now = Number(process.hrtime.bigint() / 1_000_000n);
  for (const pending of starts.values()) {
    for (const start of pending) {
      if (!start.phase || !start.pid || !start.monotonicTime)
        continue;
      const duration = now - start.monotonicTime;
      const traceConfiguredAt = configuredAt.get(start.pid);
      if (duration >= retentionThreshold && traceConfiguredAt !== undefined)
        gaps.push({ phase: start.phase, duration, pid: start.pid, completed: false, traceConfiguredAt });
    }
  }
  return gaps;
}

async function waitForChromiumStartupTrace(slowBrowserGaps: SlowBrowserGap[]): Promise<void> {
  const traceCompletionTime = Math.max(...slowBrowserGaps.map(gap => gap.traceConfiguredAt)) + 37_000;
  while (Number(process.hrtime.bigint() / 1_000_000n) < traceCompletionTime)
    await new Promise(resolve => setTimeout(resolve, 100));
}

async function recoverChromiumStartupTraces(traceDir: string): Promise<string[]> {
  let files: string[];
  try {
    files = await fs.promises.readdir(traceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return [];
    throw error;
  }
  const traces = files.filter(file => file.endsWith('.pftrace'));
  for (const file of files) {
    if (file.endsWith('.pftrace'))
      continue;
    const source = path.join(traceDir, file);
    let size: number;
    try {
      size = (await fs.promises.stat(source)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        continue;
      throw error;
    }
    if (!size)
      continue;
    const target = `recovered-${crypto.randomUUID()}.pftrace`;
    try {
      await fs.promises.rename(source, path.join(traceDir, target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        continue;
      throw error;
    }
    traces.push(target);
  }
  return traces;
}

function recoverChromiumStartupTracesSync(traceDir: string): { traces: string[], errors: string[] } {
  const traces: string[] = [];
  const errors: string[] = [];
  let files: string[];
  try {
    files = fs.readdirSync(traceDir);
  } catch (error) {
    return { traces, errors: [String(error)] };
  }
  for (const file of files) {
    if (file.endsWith('.pftrace')) {
      traces.push(file);
      continue;
    }
    const source = path.join(traceDir, file);
    try {
      if (!fs.statSync(source).size)
        continue;
      const target = `emergency-recovered-${crypto.randomUUID()}.pftrace`;
      fs.renameSync(source, path.join(traceDir, target));
      traces.push(target);
    } catch (error) {
      errors.push(`${file}: ${String(error)}`);
    }
  }
  return { traces, errors };
}

function processStates(pids: Iterable<number>): { pid: number, alive: boolean }[] {
  return [...pids].map(pid => ({ pid, alive: isAlive(pid) }));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runCli(childProcess: CommonFixtures['childProcess'], args: string[], cliOptions: { cwd?: string, env?: Record<string, string>, bindTitle?: string }, options: { mcpBrowser: string, mcpHeadless: boolean }) {
  const testInfo = test.info();
  const cli = childProcess({
    command: [process.execPath, require.resolve('../../packages/playwright-core/lib/tools/cli-client/cli.js'), ...args],
    cwd: cliOptions.cwd ?? testInfo.outputPath(),
    env: inheritAndCleanEnv({
      ...cliEnv(),
      PLAYWRIGHT_MCP_BROWSER: options.mcpBrowser,
      PLAYWRIGHT_MCP_HEADLESS: String(options.mcpHeadless),
      PWTEST_PRINT_DASHBOARD_PID_FOR_TEST: '1',
      PWTEST_DASHBOARD_APP_BIND_TITLE: cliOptions.bindTitle,
      ...cliOptions.env,
    }),
  });

  // Wait for the CLI to exit so stdout is complete before we parse it.
  const exitCode = await cli.exitCode;

  let snapshot: string | undefined;
  let inlineSnapshot: string | undefined;
  if (cli.stdout.includes('### Snapshot'))
    ({ snapshot, inlineSnapshot } = await loadSnapshot(cli.stdout));
  const attachments = loadAttachments(cli.stdout);

  const browserMatches = cli.stdout.includes('### Browser') ? cli.stdout.match(/Browser `(.+)` opened with pid (\d+)\./) : undefined;
  const daemonPid = browserMatches?.[2] ?? parseJsonPid(cli.stdout);
  const dashboardMatches = cli.stdout.includes('### Dashboard') ? cli.stdout.match(/Dashboard opened with pid (\d+)\./) : undefined;
  const dashboardPid = dashboardMatches?.[1];

  return {
    exitCode,
    output: cli.stdout.trim(),
    error: cli.stderr.trim(),
    snapshot,
    inlineSnapshot,
    attachments,
    daemonPid: daemonPid ? +daemonPid : undefined,
    dashboardPid: dashboardPid ? +dashboardPid : undefined,
  };
}

function parseJsonPid(stdout: string) {
  try {
    return JSON.parse(stdout).pid;
  } catch {
  }
}

function loadAttachments(output: string) {
  // attachments look like md links  - [Page as pdf](.playwright-cli/page-2026-01-22T23-13-56-347Z.pdf)
  const match = output.match(/- \[(.+)\]\((.+)\)/g);
  if (!match)
    return [];

  return match.map(m => {
    const [, name, path] = m.match(/- \[(.+)\]\((.+)\)/)!;
    try {
      const data = fs.readFileSync(test.info().outputPath(path));
      return { name, data };
    } catch (e) {
      return { name, data: null };
    }
  });
}

async function loadSnapshot(output: string): Promise<{ snapshot?: string, inlineSnapshot?: string }> {
  const lines = output.split('\n');
  if (!lines.includes('### Snapshot'))
    throw new Error('Snapshot file not found');
  const snapshotIndex = lines.indexOf('### Snapshot') + 1;
  const fileLine = lines[snapshotIndex];
  if (fileLine.startsWith('```yaml'))
    return { inlineSnapshot: lines.slice(snapshotIndex + 1, lines.indexOf('```', snapshotIndex)).join('\n') };
  const fileName = fileLine.match(/- \[(.+)\]\((.+)\)/)![2];
  try {
    return { snapshot: await fs.promises.readFile(test.info().outputPath(fileName), 'utf8').catch(() => undefined) };
  } catch (e) {
    return {};
  }
}

export const eventsPage = `<!DOCTYPE html>
<html>
  <body style="width: 400px; height: 400px; margin: 0; padding: 0;">
    <div id='square'style="width: 100px; height: 100px;"></div>
    <div id='log'></div>
    <script>
      const logElement = document.querySelector('#log');

      const log = (...args) => {
        const el = document.createElement('div');
        el.textContent = args.join(' ');
        logElement.appendChild(el);
      };
      document.body.addEventListener('mousemove', (event) => {
        log('mouse move', event.clientX, event.clientY);
      });
      document.body.addEventListener('mousedown', () => {
        log('mouse down');
      });
      document.body.addEventListener('mouseup', () => {
        log('mouse up');
      });
      document.body.addEventListener('wheel', (event) => {
        log('wheel', event.deltaX, event.deltaY);
      });
      document.body.addEventListener('click', () => {
        log('click', event.button);
      });
      document.body.addEventListener('dblclick', (event) => {
        log('dblclick', event.button);
      });
    </script>
  </body>
</html>
`;

export async function findDefaultSession() {
  const daemonDir = await daemonFolder();
  const fileName = path.join(daemonDir, 'default.session');
  return await fs.promises.readFile(fileName, 'utf-8').then(JSON.parse).catch(() => null);
}

export async function daemonFolder() {
  const daemonDir = test.info().outputPath('daemon');
  const folders = await fs.promises.readdir(daemonDir);
  for (const folder of folders) {
    const fullName = path.join(daemonDir, folder);
    if (fs.lstatSync(path.join(fullName)).isDirectory())
      return fullName;
  }
  return null;
}

export async function installSaveFilePickerMock(page: import('playwright-core').Page): Promise<() => Promise<Buffer>> {
  await page.evaluate(() => {
    (window as any).__testCaptureBytes = undefined as string | undefined;
    (window as any).showSaveFilePicker = async () => ({
      createWritable: async () => {
        const chunks: Uint8Array[] = [];
        return {
          write: async (chunk: Blob | BufferSource) => {
            const buf = chunk instanceof Blob
              ? new Uint8Array(await chunk.arrayBuffer())
              : new Uint8Array(chunk instanceof ArrayBuffer ? chunk : (chunk as ArrayBufferView).buffer);
            chunks.push(buf);
          },
          close: async () => {
            const total = chunks.reduce((n, c) => n + c.byteLength, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              merged.set(c, offset);
              offset += c.byteLength;
            }
            (window as any).__testCaptureBytes = (merged as any).toBase64();
          },
        };
      },
    });
  });
  return async () => {
    await expect.poll(() => page.evaluate(() => !!(window as any).__testCaptureBytes), { timeout: 10000 }).toBe(true);
    const b64: string = await page.evaluate(() => (window as any).__testCaptureBytes);
    return Buffer.from(b64, 'base64');
  };
}

export async function mockAbortingFilePicker(page: import('playwright-core').Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).showSaveFilePicker = async () => {
      throw new DOMException('The user aborted a request.', 'AbortError');
    };
  });
}
