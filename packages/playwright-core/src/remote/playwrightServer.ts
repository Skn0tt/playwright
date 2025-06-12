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

import { launchOptionsHash, PlaywrightConnection } from './playwrightConnection';
import { createPlaywright } from '../server/playwright';
import { debugLogger } from '../server/utils/debugLogger';
import { Semaphore } from '../utils/isomorphic/semaphore';
import { DEFAULT_PLAYWRIGHT_LAUNCH_TIMEOUT } from '../utils/isomorphic/time';
import { WSServer } from '../server/utils/wsServer';
import { wrapInASCIIBox } from '../server/utils/ascii';
import { getPlaywrightVersion } from '../server/utils/userAgent';
import { serverSideCallMetadata } from '../server';

import type { ClientType } from './playwrightConnection';
import type { SocksProxy } from '../server/utils/socksProxy';
import type { AndroidDevice } from '../server/android/android';
import type { Browser } from '../server/browser';
import type { Playwright } from '../server/playwright';
import type  { LaunchOptions } from '../server/types';


type ServerOptions = {
  path: string;
  maxConnections: number;
  mode: 'default' | 'launchServer' | 'launchServerShared' | 'extension';
  preLaunchedBrowser?: Browser;
  preLaunchedAndroidDevice?: AndroidDevice;
  preLaunchedSocksProxy?: SocksProxy;
};

const kBrowserName = Symbol('browserName');

export class PlaywrightServer {
  private _preLaunchedPlaywright: Playwright | undefined;
  private _options: ServerOptions;
  private _wsServer: WSServer;

  constructor(options: ServerOptions) {
    this._options = options;
    if (options.preLaunchedBrowser)
      this._preLaunchedPlaywright = options.preLaunchedBrowser.attribution.playwright;
    if (options.preLaunchedAndroidDevice)
      this._preLaunchedPlaywright = options.preLaunchedAndroidDevice._android.attribution.playwright;

    const browserSemaphore = new Semaphore(this._options.maxConnections);
    const controllerSemaphore = new Semaphore(1);
    const reuseBrowserSemaphore = new Semaphore(1);

    this._wsServer = new WSServer({
      onUpgrade: (request, socket) => {
        const uaError = userAgentVersionMatchesErrorMessage(request.headers['user-agent'] || '');
        if (uaError)
          return { error: `HTTP/${request.httpVersion} 428 Precondition Required\r\n\r\n${uaError}` };
      },

      onHeaders: headers => {
        if (process.env.PWTEST_SERVER_WS_HEADERS)
          headers.push(process.env.PWTEST_SERVER_WS_HEADERS!);
      },

      onListBrowsers: () => {
        if (!this._preLaunchedPlaywright)
          return [];
        return this._preLaunchedPlaywright.allBrowsers().map(browser => ({
          name: (browser as any)[kBrowserName],
          browserType: browser.options.name,
          channel: browser.options.channel,
        }));
      },

      onLaunchBrowser: async request => {
        if (!this._preLaunchedPlaywright)
          this._preLaunchedPlaywright = createPlaywright({ sdkLanguage: 'javascript', isServer: true });
        const playwright = this._preLaunchedPlaywright;
        const existingBrowser = playwright.allBrowsers().find(browser => {
          return browser.options.name === request.browserType && launchOptionsHash(request.launchOptions) === launchOptionsHash(browser.options.originalLaunchOptions); // TODO: also compare launch options
        });
        const browserType = playwright[request.browserType as 'chromium' | 'firefox' | 'webkit'];
        const browser = existingBrowser ?? await browserType.launch(serverSideCallMetadata(), request.launchOptions);
        (browser as any)[kBrowserName] = request.name;
        const wsURL = new URL(this._options.path, this._wsServer.baseURL());
        wsURL.searchParams.set('guid', browser.guid);
        return {
          name: (browser as any)[kBrowserName],
          browserType: browser.options.name,
          channel: browser.options.channel,
          wsURL,
        };
      },

      onConnection: (request, url, ws, id) => {
        const browserHeader = request.headers['x-playwright-browser'];
        const browserName = url.searchParams.get('browser') || (Array.isArray(browserHeader) ? browserHeader[0] : browserHeader) || null;
        const proxyHeader = request.headers['x-playwright-proxy'];
        const proxyValue = url.searchParams.get('proxy') || (Array.isArray(proxyHeader) ? proxyHeader[0] : proxyHeader);

        const launchOptionsHeader = request.headers['x-playwright-launch-options'] || '';
        const launchOptionsHeaderValue = Array.isArray(launchOptionsHeader) ? launchOptionsHeader[0] : launchOptionsHeader;
        const launchOptionsParam = url.searchParams.get('launch-options');
        let launchOptions: LaunchOptions = { timeout: DEFAULT_PLAYWRIGHT_LAUNCH_TIMEOUT };
        try {
          launchOptions = JSON.parse(launchOptionsParam || launchOptionsHeaderValue);
        } catch (e) {
        }

        let preLaunchedBrowser = this._options.preLaunchedBrowser;
        if (url.searchParams.has('guid')) {
          const guid = url.searchParams.get('guid');
          const browser = this._preLaunchedPlaywright?.allBrowsers().find(browser => browser.guid === guid);

          if (!browser)
            throw new Error(`No browser with guid "${guid}" found.`);

          preLaunchedBrowser = browser;
          this._options.mode = 'launchServerShared';
        }

        // Instantiate playwright for the extension modes.
        const isExtension = this._options.mode === 'extension';
        if (isExtension) {
          if (!this._preLaunchedPlaywright)
            this._preLaunchedPlaywright = createPlaywright({ sdkLanguage: 'javascript', isServer: true });
        }

        let clientType: ClientType = 'launch-browser';
        let semaphore: Semaphore = browserSemaphore;
        if (isExtension && url.searchParams.has('debug-controller')) {
          clientType = 'controller';
          semaphore = controllerSemaphore;
        } else if (isExtension) {
          clientType = 'reuse-browser';
          semaphore = reuseBrowserSemaphore;
        } else if (this._options.mode === 'launchServer' || this._options.mode === 'launchServerShared') {
          clientType = 'pre-launched-browser-or-android';
          semaphore = browserSemaphore;
        }

        return new PlaywrightConnection(
            semaphore.acquire(),
            clientType, ws,
            {
              socksProxyPattern: proxyValue,
              browserName,
              launchOptions,
              allowFSPaths: this._options.mode === 'extension',
              sharedBrowser: this._options.mode === 'launchServerShared',
            },
            {
              playwright: this._preLaunchedPlaywright,
              browser: preLaunchedBrowser,
              androidDevice: this._options.preLaunchedAndroidDevice,
              socksProxy: this._options.preLaunchedSocksProxy,
            },
            id, () => semaphore.release());
      },

      onClose: async () => {
        debugLogger.log('server', 'closing browsers');
        if (this._preLaunchedPlaywright)
          await Promise.all(this._preLaunchedPlaywright.allBrowsers().map(browser => browser.close({ reason: 'Playwright Server stopped' })));
        debugLogger.log('server', 'closed browsers');
      }
    });
  }

  async listen(port: number = 0, hostname?: string): Promise<string> {
    return this._wsServer.listen(port, hostname, this._options.path);
  }

  async close() {
    await this._wsServer.close();
  }
}

function userAgentVersionMatchesErrorMessage(userAgent: string) {
  const match = userAgent.match(/^Playwright\/(\d+\.\d+\.\d+)/);
  if (!match) {
    // Cannot parse user agent - be lax.
    return;
  }
  const received = match[1].split('.').slice(0, 2).join('.');
  const expected = getPlaywrightVersion(true);
  if (received !== expected) {
    return wrapInASCIIBox([
      `Playwright version mismatch:`,
      `  - server version: v${expected}`,
      `  - client version: v${received}`,
      ``,
      `If you are using VSCode extension, restart VSCode.`,
      ``,
      `If you are connecting to a remote service,`,
      `keep your local Playwright version in sync`,
      `with the remote service version.`,
      ``,
      `<3 Playwright Team`
    ].join('\n'), 1);
  }
}
