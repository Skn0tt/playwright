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
import type { CallMetadata } from '@protocol/callMetadata';
import type { Server, ServerRequest, ServerRoute, ServerResponse } from '../server';
import type { DispatcherScope } from './dispatcher';
import { Dispatcher, existingDispatcher } from './dispatcher';
import type * as channels from '@protocol/channels';
import { statusText } from '../network';

export class ServerDispatcher extends Dispatcher<Server, channels.ServerChannel, DispatcherScope> implements channels.ServerChannel {
  _type_EventTarget = true;
  _type_Server = true;

  constructor(parentScope: DispatcherScope, server: Server) {
    super(parentScope, server, 'Server', {
      port: server.port,
    });
  }

  async setNetworkInterceptionPatterns(params: channels.ServerSetNetworkInterceptionPatternsParams, metadata?: CallMetadata): Promise<channels.ServerSetNetworkInterceptionPatternsResult> {
    if (params.patterns.length === 0)
      return this._object.setRequestInterceptor(undefined);

    this._object.setRequestInterceptor(async (route, request) => {
      const match = params.patterns.some(pattern => true === request.url);
      if (!match)
        return route.continue();

      this._dispatchEvent('route', { route: null /* TODO: route dispatcher */ });
    });
  }
}

export class ServerRequestDispatcher extends Dispatcher<ServerRequest, channels.RequestChannel, DispatcherScope> implements channels.RequestChannel {
  _type_Request = true;

  static from(scope: DispatcherScope, request: ServerRequest): ServerRequestDispatcher {
    return existingDispatcher<ServerRequestDispatcher>(request) ?? new ServerRequestDispatcher(scope, request);
  }

  constructor(parentScope: DispatcherScope, request: ServerRequest) {
    super(parentScope, request, 'Request', {
      frame: null,
      serviceWorker: null,
      url: request.url,
      resourceType: 'other',
      method: request.method(),
      postData: request.postData(),
      headers: request.headers(),
      isNavigationRequest: false,
      redirectedFrom: null,
    });
  }

  async rawRequestHeaders(params?: channels.RequestRawRequestHeadersParams, metadata?: CallMetadata): Promise<channels.RequestRawRequestHeadersResult> {
    return { headers: await this._object.rawRequestHeaders() };
  }

  async response(params?: channels.RequestResponseParams, metadata?: CallMetadata): Promise<channels.RequestResponseResult> {
    return {
      response: ServerResponseDispatcher.fromNullable(this, await this._object.response())
    };
  }
}

export class ServerResponseDispatcher extends Dispatcher<ServerResponse, channels.ResponseChannel, DispatcherScope> implements channels.ResponseChannel {
  _type_Response = true;

  static from(scope: DispatcherScope, response: ServerResponse): ServerResponseDispatcher {
    return existingDispatcher<ServerResponseDispatcher>(response) ?? new ServerResponseDispatcher(ServerRequestDispatcher.from(scope, response.request()), response);
  }

  static fromNullable(scope: DispatcherScope, response: ServerResponse | null): ServerResponseDispatcher | undefined {
    return response ? ServerResponseDispatcher.from(scope, response) : undefined;
  }

  constructor(scope: ServerRequestDispatcher, response: ServerResponse) {
    super(scope, response, 'Response', {
      request: scope,
      url: response.url(),
      status: response.status(),
      statusText: response.statusText(),
      headers: response.headers(),
      timing: response.timing(),
    });
  }

  async body(params?: channels.ResponseBodyParams, metadata?: CallMetadata): Promise<channels.ResponseBodyResult> {
    return { binary: await this._object.body() };
  }

  securityDetails(params?: channels.ResponseSecurityDetailsParams, metadata?: CallMetadata): Promise<channels.ResponseSecurityDetailsResult> {
    throw new Error('Method not implemented.');
  }

  serverAddr(params?: channels.ResponseServerAddrParams, metadata?: CallMetadata): Promise<channels.ResponseServerAddrResult> {
    throw new Error('Method not implemented.');
  }

  rawResponseHeaders(params?: channels.ResponseRawResponseHeadersParams, metadata?: CallMetadata): Promise<channels.ResponseRawResponseHeadersResult> {
    throw new Error('Method not implemented.');
  }

  async sizes(params?: channels.ResponseSizesParams, metadata?: CallMetadata): Promise<channels.ResponseSizesResult> {
    return { sizes: await this._object.sizes() };
  }
}


export class ServerRouteDispatcher extends Dispatcher<ServerRoute, channels.RouteChannel, DispatcherScope> implements channels.RouteChannel {
  _type_Route = true;

  static from(scope: ServerRequestDispatcher, route: ServerRoute): ServerRouteDispatcher {
    return existingDispatcher<ServerRouteDispatcher>(route) ?? new ServerRouteDispatcher(scope, route);
  }

  constructor(scope: ServerRequestDispatcher, route: ServerRoute) {
    super(scope, route, 'Route', {
      request: scope,
    });
  }

  abort(params: channels.RouteAbortParams, metadata?: CallMetadata): Promise<channels.RouteAbortResult> {
    throw new Error('Method not implemented.');
  }

  fulfill(params: channels.RouteFulfillParams, metadata?: CallMetadata): Promise<channels.RouteFulfillResult> {
    throw new Error('Method not implemented.');
  }

  continue(params: channels.RouteContinueParams, metadata?: CallMetadata): Promise<channels.RouteContinueResult> {
    throw new Error('Method not implemented.');
  }

  redirectNavigationRequest(params: channels.RouteRedirectNavigationRequestParams, metadata?: CallMetadata): Promise<channels.RouteRedirectNavigationRequestResult> {
    throw new Error('Method not implemented.');
  }
}
