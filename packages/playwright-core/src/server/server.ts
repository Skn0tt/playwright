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
import type { HeadersArray, NormalizedContinueOverrides } from './types';
import type { GetResponseBodyCallback, ResourceTiming } from './network';
import { Request, Route } from './network';
import type { RouteDelegate } from './network';
import { Response } from './network';

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

  get port() {
    const address = this._httpServer.address() as AddressInfo;
    return address.port;
  }

  get address() {
    return `http://localhost:${this.port}`;
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
    async function proxy(overrides?: NormalizedContinueOverrides) {
      throw new Error('not implemented');
    }

    const server = typeof req.headers['x-pw-correlation'] === 'string' ? this._servers.get(req.headers['x-pw-correlation']!) : this._singleServer;
    if (!server)
      return proxy();

    const url = req.url ?? 'no-url';
    const method = req.method ?? 'GET';
    const postData = Buffer.from('Mock');
    const headers: HeadersArray = [];
    const request = new ServerRequest(server._context, method, url, postData, headers);
    server.emit(Server.Events.Request, request);

    const route = new ServerRoute(request, {
      async abort(errorCode) {
        req.socket.end();
      },
      async continue(overrides) {
        await proxy(overrides);
      },
      async fulfill(params) {
        res.statusCode = params.status ?? 200;
        for (const { name, value } of params.headers ?? [])
          res.appendHeader(name, value);
        if (params.body)
          res.write(Buffer.from(params.body, params.isBase64 ? 'base64' : 'utf-8'));
        res.end();
      }
    });
    server.emit(Server.Events.Route, route);

    if (!server._interceptor)
      return route.continue({ isFallback: false });
    await server._interceptor(route, request);
  }
}

export class Server extends SdkObject {
  static Events = { // TODO: implement all of this
    Route: 'route',
    Request: 'request',
    Response: 'response',
    RequestFailed: 'requestfailed',
    RequestFinished: 'requestfinished',
    RequestAborted: 'requestaborted',
    RequestFulfilled: 'requestfulfilled',
    RequestContinued: 'requestcontinued',
  };

  private _correlationToken: string | undefined;
  _context: BrowserContext;
  private _proxy: MockingProxy;
  _interceptor?: (route: ServerRoute, request: ServerRequest) => Promise<void>;

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

  get port() {
    return this._proxy.port;
  }

  dispose() {
    this._interceptor = undefined;
    this._updateRequestInterception();
  }

  _updateRequestInterception() {
    if (!this._interceptor) {
      // remove all registrations
      if (this._correlationToken)
        this._proxy.unregister(this._correlationToken);
      else
        this._proxy.unregister(undefined);
      return;
    }

    if (this._correlationToken) {
      this._proxy.register(this._correlationToken, this);
      this._context.setExtraHTTPHeaders([
        { name: 'x-pw-correlation', value: this._correlationToken },
        { name: 'x-pw-address', value: this._proxy.address },
      ]);
    } else {
      this._proxy.register(undefined, this);
    }
  }

  setRequestInterceptor(interceptor?: (route: ServerRoute, request: ServerRequest) => Promise<void>) {
    this._interceptor = interceptor;
    this._updateRequestInterception();
  }
}

export class ServerRoute extends Route {
  constructor(request: ServerRequest, delegate: RouteDelegate) {
    super(request, delegate);
  }
}

export class ServerRequest extends Request {
  constructor(context: BrowserContext, url: string, method: string, postData: Buffer | null, headers: HeadersArray) {
    super(context, null, null, null, undefined, url, '', method, postData, headers);
  }
}

export class ServerResponse extends Response {
  constructor(request: ServerRequest, status: number, statusText: string, headers: HeadersArray, timing: ResourceTiming, getResponseBodyCallback: GetResponseBodyCallback, httpVersion?: string) {
    super(request, status, statusText, headers, timing, getResponseBodyCallback, false, httpVersion);
  }
}
