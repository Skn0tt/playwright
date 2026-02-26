/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';

import { HttpServer } from 'playwright-core/lib/utils';
import { ws } from 'playwright-core/lib/utilsBundle';

import http from 'http';
import { createClientInfo, Registry } from './registry';
import { Session } from './session';

import type { ClientInfo, SessionFile } from './registry';
import type { SessionStatus } from '@devtools/sessionModel';
import type { Transport } from 'playwright-core/lib/utils';

function readBody(request: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString();
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    request.on('error', reject);
  });
}

async function parseRequest(request: http.IncomingMessage): Promise<{ sessionFile: SessionFile, args?: any }> {
  const body = await readBody(request);
  if (!body.sessionFile)
    throw new Error('Dashboard app is too old, please close it and open again');
  return { sessionFile: body.sessionFile };
}

function sendJSON(response: http.ServerResponse, data: any, statusCode = 200) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(data));
}

async function handleApiRequest(clientInfo: ClientInfo, httpServer: HttpServer, request: http.IncomingMessage, response: http.ServerResponse) {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const apiPath = url.pathname;

  if (apiPath === '/api/sessions/list' && request.method === 'GET') {
    const registry = await Registry.load();
    const sessions: SessionStatus[] = [];
    for (const [, files] of registry.entryMap()) {
      for (const file of files) {
        const session = new Session(file);
        const canConnect = await session.canConnect();
        if (canConnect || file.config.cli.persistent)
          sessions.push({ file: file, canConnect });
      }
    }
    sendJSON(response, { sessions, clientInfo });
    return;
  }

  if (apiPath === '/api/sessions/close' && request.method === 'POST') {
    const { sessionFile } = await parseRequest(request);
    await new Session(sessionFile).stop();
    sendJSON(response, { success: true });
    return;
  }

  if (apiPath === '/api/sessions/delete-data' && request.method === 'POST') {
    const { sessionFile } = await parseRequest(request);
    await new Session(sessionFile).deleteData();
    sendJSON(response, { success: true });
    return;
  }

  if (apiPath === '/api/sessions/run' && request.method === 'POST') {
    const { sessionFile, args } = await parseRequest(request);
    if (!args)
      throw new Error('Missing "args" parameter');
    const result = await new Session(sessionFile).run(clientInfo, args);
    sendJSON(response, { result });
    return;
  }

  if (apiPath === '/api/sessions/devtools-start' && request.method === 'POST') {
    const { sessionFile } = await parseRequest(request);
    const result = await new Session(sessionFile).run(clientInfo, { _: ['devtools-start'] });
    const match = result.text.match(/Server is listening on: (.+)/);
    if (!match)
      throw new Error('Failed to parse screencast URL from: ' + result.text);
    const backendWsUrl = match[1];
    const wsPath = `/${httpServer.wsGuid()}?target=${encodeURIComponent(backendWsUrl)}`;
    sendJSON(response, { path: wsPath });
    return;
  }

  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'Not found' }));
}

class WebSocketProxyTransport implements Transport {
  private _backendWs: InstanceType<typeof ws> | null = null;
  private _backendReady: Promise<void> | undefined;
  private _lastId = 0;
  private _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  sendEvent?: (method: string, params: any) => void;
  close?: () => void;

  constructor(private readonly _backendUrl: string) {}

  onconnect() {
    this._backendWs = new ws(this._backendUrl);
    this._backendReady = new Promise<void>((resolve, reject) => {
      this._backendWs!.once('open', resolve);
      this._backendWs!.once('error', reject);
    });
    this._backendWs.on('message', (data: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const pending = this._pending.get(msg.id);
        if (pending) {
          this._pending.delete(msg.id);
          if (msg.error)
            pending.reject(new Error(msg.error));
          else
            pending.resolve(msg.result);
        }
      } else if (msg.method) {
        this.sendEvent?.(msg.method, msg.params);
      }
    });
    this._backendWs.on('close', () => this.close?.());
    this._backendWs.on('error', () => this.close?.());
  }

  async dispatch(method: string, params: any): Promise<any> {
    await this._backendReady;
    if (!this._backendWs || this._backendWs.readyState !== ws.OPEN)
      throw new Error('Backend connection not open');
    const id = ++this._lastId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._backendWs!.send(JSON.stringify({ id, method, params }));
    });
  }

  onclose() {
    this._backendWs?.close();
    for (const { reject } of this._pending.values())
      reject(new Error('Connection closed'));
    this._pending.clear();
  }
}

export async function startDevToolsServer(port?: number, host?: string): Promise<HttpServer> {
  const httpServer = new HttpServer();
  const libDir = require.resolve('playwright-core/package.json');
  const devtoolsDir = path.join(path.dirname(libDir), 'lib/vite/devtools');
  const clientInfo = createClientInfo();

  httpServer.createWebSocket((url: URL) => {
    const target = url.searchParams.get('target');
    if (!target)
      throw new Error('Missing target parameter');
    const backendUrl = new URL(target);
    for (const [key, value] of url.searchParams) {
      if (key !== 'target')
        backendUrl.searchParams.set(key, value);
    }
    return new WebSocketProxyTransport(backendUrl.toString());
  });

  httpServer.routePrefix('/api/', (request: http.IncomingMessage, response: http.ServerResponse) => {
    handleApiRequest(clientInfo, httpServer, request, response).catch(e => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: e.message }));
    });
    return true;
  });

  httpServer.routePrefix('/', (request: http.IncomingMessage, response: http.ServerResponse) => {
    const pathname = new URL(request.url!, `http://${request.headers.host}`).pathname;
    const filePath = pathname === '/' ? 'index.html' : pathname.substring(1);
    const resolved = path.join(devtoolsDir, filePath);
    if (!resolved.startsWith(devtoolsDir))
      return false;
    return httpServer.serveFile(request, response, resolved);
  });
  await httpServer.start({ port, host });
  return httpServer;
}
