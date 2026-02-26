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

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import net from 'net';

import { chromium } from 'playwright-core';
import { gracefullyProcessExitDoNotHang } from 'playwright-core/lib/utils';
import { findChromiumChannelBestEffort, registryDirectory } from 'playwright-core/lib/server/registry/index';

import { startDevToolsServer } from './devtoolsServer';
import type { Page } from 'playwright-core';

async function openDevToolsApp(): Promise<Page> {
  const devtoolsServer = await startDevToolsServer();
  const { page } = await launchApp('devtools');
  await page.goto(devtoolsServer.urlPrefix('human-readable'));
  return page;
}

async function launchApp(appName: string) {
  const channel = findChromiumChannelBestEffort('javascript');
  const context = await chromium.launchPersistentContext('', {
    ignoreDefaultArgs: ['--enable-automation'],
    channel,
    headless: false,
    args: [
      '--app=data:text/html,',
      '--test-type=',
      `--window-size=1280,800`,
      `--window-position=100,100`,
    ],
    viewport: null,
  });

  const [page] = context.pages();
  // Chromium on macOS opens a new tab when clicking on the dock icon.
  // See https://github.com/microsoft/playwright/issues/9434
  if (process.platform === 'darwin') {
    context.on('page', async newPage => {
      if (newPage.mainFrame().url() === 'chrome://new-tab-page/') {
        await page.bringToFront();
        await newPage.close();
      }
    });
  }

  page.on('close', () => {
    gracefullyProcessExitDoNotHang(0);
  });

  const image = await fs.promises.readFile(path.join(__dirname, 'appIcon.png'));
  await (page as any)._setDockTile(image);
  await syncLocalStorageWithSettings(page, appName);
  return { context, page };
}

export async function syncLocalStorageWithSettings(page: Page, appName: string) {
  const settingsFile = path.join(registryDirectory, '.settings', `${appName}.json`);

  await page.exposeBinding('_saveSerializedSettings', (_, settings) => {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, settings);
  });

  const settings = await fs.promises.readFile(settingsFile, 'utf-8').catch(() => ('{}'));
  await page.addInitScript(
      `(${String((settings: any) => {
        // iframes w/ snapshots, etc.
        if (location && location.protocol === 'data:')
          return;
        if (window.top !== window)
          return;
        Object.entries(settings).map(([k, v]) => localStorage[k] = v);
        (window as any).saveSettings = () => {
          (window as any)._saveSerializedSettings(JSON.stringify({ ...localStorage }));
        };
      })})(${settings});
  `);
}

function socketsDirectory() {
  return process.env.PLAYWRIGHT_DAEMON_SOCKETS_DIR || path.join(os.tmpdir(), 'playwright-cli');
}

function devtoolsSocketPath() {
  const suffix = process.env.PLAYWRIGHT_DAEMON_SESSION_DIR ? crypto.createHash('sha256').update(process.env.PLAYWRIGHT_DAEMON_SESSION_DIR).digest('hex').substring(0, 8) : '';
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\playwright-devtools-${process.env.USERNAME || 'default'}${suffix}`
    : path.join(socketsDirectory(), `devtools${suffix}.sock`);
}

async function acquireSingleton(): Promise<net.Server | string> {
  const socketPath = devtoolsSocketPath();
  await fs.promises.mkdir(path.dirname(socketPath), { recursive: true });

  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(socketPath, () => resolve(server));
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EADDRINUSE')
        return reject(err);
      const client = net.connect(socketPath, () => {
        client.write('bringToFront');
      });
      let data = '';
      client.on('data', chunk => { data += chunk.toString(); });
      client.on('end', () => {
        resolve(data);
      });
      client.on('error', () => {
        if (process.platform !== 'win32')
          fs.unlinkSync(socketPath);
        server.listen(socketPath, () => resolve(server));
      });
    });
  });
}

async function main() {
  const result = await acquireSingleton();
  let status = typeof result === 'string' ? result : 'Starting';

  if (typeof result !== 'string') {
    const server = result;
    process.on('exit', () => server.close());

    let page: Page | undefined = undefined;
    server.on('connection', socket => {
      socket.on('data', data => {
        if (data.toString() === 'bringToFront')
          page?.bringToFront().catch(() => {});
        socket.end(status);
      });
    });

    page = await openDevToolsApp();
    status = `DevTools pid ${process.pid} listening`;
  }


  // eslint-disable-next-line no-console
  console.log(status);
  // eslint-disable-next-line no-console
  console.log('<EOF>');
}

void main().catch(e => {
  // eslint-disable-next-line no-console
  console.log(e);
  throw e;
});
