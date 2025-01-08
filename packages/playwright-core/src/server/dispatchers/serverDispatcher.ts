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
import type { DispatcherScope } from './dispatcher';
import { Dispatcher } from './dispatcher';
import type * as channels from '@protocol/channels';

export class ServerDispatcher extends Dispatcher<Server, channels.ServerChannel, DispatcherScope> implements channels.ServerChannel {
  _type_EventTarget = true;
  _type_Server = true;

  private readonly _server: Server;

  constructor(parentScope: DispatcherScope, server: Server) {
    super(parentScope, server, 'Server', {
      port: server.port,
    });
    this._server = server;
  }

  async setNetworkInterceptionPatterns(params: channels.ServerSetNetworkInterceptionPatternsParams, metadata?: CallMetadata): Promise<channels.ServerSetNetworkInterceptionPatternsResult> {
    this._server.setNetworkInterceptionPatterns(params.patterns);
  }
}
