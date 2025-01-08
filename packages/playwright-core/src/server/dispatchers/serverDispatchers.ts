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
import type { Server } from '../server';
import { Dispatcher } from './dispatcher';
import type * as channels from '@protocol/channels';
import { RequestDispatcher, RouteDispatcher } from './networkDispatchers';
import type { BrowserContextDispatcher } from './browserContextDispatcher';

export class ServerDispatcher extends Dispatcher<Server, channels.ServerChannel, BrowserContextDispatcher> implements channels.ServerChannel {
  _type_EventTarget = true;
  _type_Server = true;

  constructor(scope: BrowserContextDispatcher, server: Server) {
    super(scope, server, 'Server', {
      port: server.port,
    });
  }

  async setNetworkInterceptionPatterns(params: channels.ServerSetNetworkInterceptionPatternsParams, metadata?: CallMetadata): Promise<channels.ServerSetNetworkInterceptionPatternsResult> {
    if (params.patterns.length === 0)
      return this._object.setRequestInterceptor(undefined);

    this._object.setRequestInterceptor(async (route, request) => {
      const match = params.patterns.find(pattern => true);
      if (!match)
        return route.continue({ isFallback: false });

      this._dispatchEvent('route', { route: RouteDispatcher.from(RequestDispatcher.from(this.parentScope(), request), route) });
    });
  }
}
