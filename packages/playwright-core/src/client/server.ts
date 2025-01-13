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
import * as network from './network';
import { urlMatchesEqual, type URLMatch } from '../utils/isomorphic/urlMatch';
import type { LocalUtils } from './localUtils';
import type * as channels from '@protocol/channels';
import { EventEmitter } from './eventEmitter';

export class Server extends EventEmitter implements api.Server {
  _routes: network.RouteHandler[] = [];
  private _localUtils: LocalUtils;
  private _scope: string;

  private routeListener = ({ route, scope }: channels.LocalUtilsRouteEvent) => {
    if (scope === this._scope)
      this._onRoute(network.Route.from(route));
  };
  private failedListener = ({ request, scope }: channels.LocalUtilsRequestFailedEvent) => {
    if (scope === this._scope)
      this.emit('requestfailed', network.Request.from(request));
  };
  private finishedListener = ({ request, scope }: channels.LocalUtilsRequestFinishedEvent) => {
    if (scope === this._scope)
      this.emit('requestfinished', network.Request.from(request));
  };
  private responseListener = ({ response, scope }: channels.LocalUtilsResponseEvent) => {
    if (scope === this._scope)
      this.emit('response', network.Response.from(response));
  };
  private requestListener = ({ request, scope }: channels.LocalUtilsRequestEvent) => {
    if (scope === this._scope)
      this.emit('request', network.Request.from(request));
  };

  constructor(localUtils: LocalUtils, scope = '') {
    super();

    this._localUtils = localUtils;
    this._scope = scope;

    this._localUtils._channel.on('route', this.routeListener);
    this._localUtils._channel.on('request', this.requestListener);
    this._localUtils._channel.on('requestFailed', this.failedListener);
    this._localUtils._channel.on('requestFinished', this.finishedListener);
    this._localUtils._channel.on('response', this.responseListener);
  }

  dispose() {
    this._localUtils._channel.off('route', this.routeListener);
    this._localUtils._channel.off('request', this.requestListener);
    this._localUtils._channel.off('requestFailed', this.failedListener);
    this._localUtils._channel.off('requestFinished', this.finishedListener);
    this._localUtils._channel.off('response', this.responseListener);
  }

  override on(type: string | symbol, listener: (...args: any[]) => any): this {
    super.on(type, listener);
    this._updateInterceptionPatterns();
    return this;
  }

  override addListener(type: string | symbol, listener: (...args: any[]) => any): this {
    super.addListener(type, listener);
    this._updateInterceptionPatterns();
    return this;
  }

  async route(url: URLMatch, handler: network.RouteHandlerCallback, options: { times?: number } = {}): Promise<void> {
    this._routes.unshift(new network.RouteHandler(undefined, url, handler, options.times));
    await this._updateInterceptionPatterns();
  }

  async unrouteAll(options?: { behavior?: 'wait'|'ignoreErrors'|'default' }): Promise<void> {
    await this._unrouteInternal(this._routes, [], options?.behavior);
  }

  async unroute(url: URLMatch, handler?: network.RouteHandlerCallback): Promise<void> {
    const removed = [];
    const remaining = [];
    for (const route of this._routes) {
      if (urlMatchesEqual(route.url, url) && (!handler || route.handler === handler))
        removed.push(route);
      else
        remaining.push(route);
    }
    await this._unrouteInternal(removed, remaining, 'default');
  }

  private async _unrouteInternal(removed: network.RouteHandler[], remaining: network.RouteHandler[], behavior?: 'wait'|'ignoreErrors'|'default'): Promise<void> {
    this._routes = remaining;
    await this._updateInterceptionPatterns();
    if (!behavior || behavior === 'default')
      return;
    const promises = removed.map(routeHandler => routeHandler.stop(behavior));
    await Promise.all(promises);
  }

  async _onRoute(route: network.Route) {
    route._context = null as any;
    const routeHandlers = this._routes.slice();
    for (const routeHandler of routeHandlers) {
      if (!routeHandler.matches(route.request().url()))
        continue;
      const index = this._routes.indexOf(routeHandler);
      if (index === -1)
        continue;
      if (routeHandler.willExpire())
        this._routes.splice(index, 1);
      const handled = await routeHandler.handle(route);
      if (!this._routes.length)
        this._updateInterceptionPatterns();
      if (handled)
        return;
    }
    // If the page is closed or unrouteAll() was called without waiting and interception disabled,
    // the method will throw an error - silence it.
    await route._innerContinue(true /* isFallback */).catch(() => {});
  }

  private async _updateInterceptionPatterns() {
    const patterns = this.eventNames().length > 0 ? [{ glob: '**/*' }] : network.RouteHandler.prepareInterceptionPatterns(this._routes);
    await this._localUtils._channel.setServerNetworkInterceptionPatterns({ patterns, scope: this._scope });
  }
}
