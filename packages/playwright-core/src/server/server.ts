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

import type { AddressInfo } from 'net';
import type { BrowserContext } from './browserContext';
import { SdkObject } from './instrumentation';
import http from 'http';
import type * as channels from '@protocol/channels';

export class MockingProxy {
  private _httpServer = http.createServer(this._handleRequest.bind(this));

  private _singleServer?: Server;
  private _servers = new Map<string, Server>();

  async _initialize() {
    this._httpServer = http.createServer(this._handleRequest.bind(this));
    await new Promise((resolve, reject) => {
      this._httpServer.on('listening', resolve);
      this._httpServer.on('error', reject);
      this._httpServer.listen(0);
    });
  }

  async close() {
    await new Promise<void>((resolve, reject) => {
      this._httpServer.close(err => err ? reject(err) : resolve());
    });
  }

  get address() {
    const address = this._httpServer.address() as AddressInfo;
    return `http://localhost:${address.port}`; // TODO: fix host
  }

  register(token: string | undefined, server: Server) {
    if (typeof token === 'string')
      this._servers.set(token, server);
    else
      this._singleServer = server;
  }

  unregister(token: string | undefined) {
    if (typeof token === 'string')
      this._servers.delete(token);
    else
      this._singleServer = undefined;
  }

  private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    function proxy() {}
    const server = typeof req.headers['x-pw-correlation'] === 'string' ? this._servers.get(req.headers['x-pw-correlation']!) : this._singleServer;
    if (!server)
      return proxy();
    const handled = await server._handleRequest(req, res);
    if (!handled)
      proxy();
  }
}

export class Server extends SdkObject {
  static Events = {
    Request: 'request',
    Response: 'response',
    RequestFailed: 'requestfailed',
    RequestFinished: 'requestfinished',
    RequestAborted: 'requestaborted',
    RequestFulfilled: 'requestfulfilled',
    RequestContinued: 'requestcontinued',
  };

  private _correlationToken: string | undefined;
  private _context: BrowserContext;
  private _proxy: MockingProxy;
  private _patterns: channels.ServerSetNetworkInterceptionPatternsParams['patterns'] = [];

  constructor(context: BrowserContext, proxy: MockingProxy, correlationToken?: string) {
    super(context, 'server');
    this._context = context;
    this._proxy = proxy;
    this._correlationToken = correlationToken;

    if (this._correlationToken) {
      proxy.register(this._correlationToken, this);

      // TODO: make this reversible
      this._context.setExtraHTTPHeaders([
        { name: 'x-pw-correlation', value: this._correlationToken },
        { name: 'x-pw-address', value: this._proxy.address },
      ]);
    } else {
      proxy.register(undefined, this);
    }
  }

  dispose() {
    this._proxy.unregister(this._correlationToken);
  }

  setNetworkInterceptionPatterns(patterns: channels.ServerSetNetworkInterceptionPatternsParams['patterns']) {
    this._patterns = patterns;
  }

  async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    this.emit(Server.Events.Request, 'todo');
    const pattern = this._patterns.find(pattern => true /* TODO */);
    if (!pattern)
      return false;
    return true;
  }
}
