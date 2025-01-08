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
import type * as api from '../../types/types';
import type * as channels from '@protocol/channels';
import * as network from './network';
import { ChannelOwner } from './channelOwner';
import type { URLMatch } from '@isomorphic/urlMatch';
import type { BrowserContext } from './browserContext';

export class Server extends ChannelOwner<channels.ServerChannel> implements api.Server {
  _routes: network.RouteHandler[] = [];
  private readonly _port: number;
  private _context: BrowserContext;

  constructor(parent: BrowserContext, type: string, guid: string, initializer: channels.ServerInitializer) {
    super(parent, type, guid, initializer);
    this._port = initializer.port;
    this._context = parent;

    this._channel.on('route', ({ route }) => this._onRoute(network.Route.from(route)));
  }

  static from(server: channels.ServerChannel): Server {
    return (server as any)._object;
  }

  async route(url: URLMatch, handler: network.RouteHandlerCallback, options: { times?: number } = {}): Promise<void> {
    this._routes.unshift(new network.RouteHandler(undefined, url, handler, options.times));
    await this._updateInterceptionPatterns();
  }

  async _onRoute(route: network.Route) {
    route._context = this._context;
    const routeHandlers = this._routes.slice();
    for (const routeHandler of routeHandlers) {
      // If the page or the context was closed we stall all requests right away.
      if (this._context._closeWasCalled)
        return;
      if (!routeHandler.matches(route.request().url()))
        continue;
      const index = this._routes.indexOf(routeHandler);
      if (index === -1)
        continue;
      if (routeHandler.willExpire())
        this._routes.splice(index, 1);
      const handled = await routeHandler.handle(route);
      if (!this._routes.length)
        this._wrapApiCall(() => this._updateInterceptionPatterns(), true).catch(() => {});
      if (handled)
        return;
    }
    // If the page is closed or unrouteAll() was called without waiting and interception disabled,
    // the method will throw an error - silence it.
    await route._innerContinue(true /* isFallback */).catch(() => {});
  }

  private async _updateInterceptionPatterns() {
    const patterns = network.RouteHandler.prepareInterceptionPatterns(this._routes);
    await this._channel.setNetworkInterceptionPatterns({ patterns });
  }
}
